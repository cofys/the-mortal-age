/**
 * One Araxxor lair per player, following the Elvarg/Vorkath private-area pattern: whoever
 * walks into the lair (through the webbed tunnels) gets a personal instance with Araxxor,
 * the nine eggs and the fight. Leaving, logging out or disconnecting destroys it; NPCs,
 * acid pools and drops go with it. After a kill the corpse lingers for its harvest, then the
 * encounter resets on the lair's timer.
 *
 * As captured: boss and all nine eggs spawn together, the boss holds for 6 ticks after its
 * spawn animation (11482) before its first attack, and the egg pattern is one of the three
 * fixed layouts (the first egg's colour picks the fight's special).
 */
const Shared = require("./Shared.Araxxor");
const Hud = require("./Hud.Araxxor");
const Minions = require("./Minions.Araxxor");
const Specials = require("./Specials.Araxxor");

const ATTR_AREA = "araxxor:instance-area";

let api = null;
let core = null;
let AraxxorPrivateArea = null;
/** player -> session for the player's live lair. */
const sessions = new Map();

function lairBoundary() {
  return new core.Boundary(Shared.LAIR.minX, Shared.LAIR.maxX, Shared.LAIR.minY, Shared.LAIR.maxY, 0);
}

function insideLair(location) {
  if (!location || location.getZ?.() !== 0) return false;
  const x = location.getX();
  const y = location.getY();
  return x >= Shared.LAIR.minX && x <= Shared.LAIR.maxX && y >= Shared.LAIR.minY && y <= Shared.LAIR.maxY;
}

function defineAreaClass() {
  class AraxxorArea extends core.PrivateArea {
    constructor(ownerName) {
      super([lairBoundary()]);
      this.ownerName = ownerName ?? "unknown";
    }

    destroy() {
      if (this.isDestroyed?.() === true) {
        return;
      }
      const addQueue = core.World.getAddNPCQueue();
      const removeQueue = core.World.getRemoveNPCQueue();
      for (const entity of this.entities) {
        if (!entity?.isNpc?.() || !entity?.getAsNpc) {
          continue;
        }
        const npc = entity.getAsNpc();
        for (let index = addQueue.indexOf(npc); index !== -1; index = addQueue.indexOf(npc)) {
          addQueue.splice(index, 1);
        }
        if (npc.isRegistered?.() && !removeQueue.includes(npc)) {
          removeQueue.push(npc);
        }
      }
      super.destroy();
    }

    postLeave(mobile) {
      if (mobile?.isPlayer?.()) {
        clearSession(mobile.getAsPlayer(), this);
      }
      super.postLeave(mobile);
    }

    /** The whole lair is one fight. */
    isMulti() {
      return true;
    }
  }
  AraxxorPrivateArea = AraxxorArea;
}

function areaOf(player) {
  const area = player.getAttribute?.(ATTR_AREA);
  return area instanceof AraxxorPrivateArea && area.isDestroyed?.() !== true ? area : null;
}

function clearSession(player, sourceArea) {
  if (!player) return;
  const session = sessions.get(player);
  if (session && (sourceArea == null || session.area === sourceArea || session.area?.isDestroyed?.() === true)) {
    Specials.endFight(session.npc ?? {});
    sessions.delete(player);
  }
  const assigned = player.getAttribute?.(ATTR_AREA);
  if (sourceArea == null || assigned === sourceArea || assigned?.isDestroyed?.() === true) {
    player.setAttribute?.(ATTR_AREA, null);
  }
}

function destroyArea(player) {
  Hud.dropFor(player);
  const area = player.getAttribute?.(ATTR_AREA);
  clearSession(player, area);
  if (area instanceof AraxxorPrivateArea && area.isDestroyed?.() !== true) {
    area.destroy();
  }
  // Shots already in flight die with the instance: nothing follows the player out.
  player.getCombat?.().getHitQueue?.().clear?.();
}

function moveIntoArea(player, area) {
  const currentArea = player.getArea?.();
  if (currentArea && currentArea !== area) {
    currentArea.leave(player, false);
    currentArea.postLeave(player, false);
  }
  if (player.getArea?.() !== area) {
    area.enter(player);
  }
}

function createSession(player, area) {
  const pattern = Shared.PATTERNS[Math.floor(Math.random() * Shared.PATTERNS.length)];
  const session = {
    player,
    area,
    npc: null,
    eggs: [],
    minions: [],
    pattern,
    fighter: player,
    stash: [],
    pendingPet: [],
    corpse: null,
    respawnAt: 0,
  };
  sessions.set(player, session);
  return session;
}

function spawnEncounter(session) {
  const area = session.area;
  if (area?.isDestroyed?.() === true) return;
  const boss = core.NPC.create(Shared.BOSS_ID, new core.Location(Shared.SPAWN_TILE[0], Shared.SPAWN_TILE[1], Shared.SPAWN_TILE[2]));
  boss.__skipDefaultRespawn = true;
  boss.setHitpoints?.(Shared.MAX_HITPOINTS);
  // Roams the lair to melee; without a radius she holds position and never closes.
  boss.getMovementCoordinator?.().setRadius?.(30);
  // Wiki: out of melee range he closes the distance, attacking with magic/ranged on the
  // way. The engine otherwise stands its ground once in range (Combat.ts); this is the
  // same combat:close-in flag ToA's Akkha uses to keep walking in while attacking.
  boss.setFlag?.("combat:close-in");
  // The lair is multiway: the boss and her brood may attack together.
  boss.setMultiCombat?.(true);
  boss.performAnimation(new core.Animation(11482));
  boss.setAttribute?.(Shared.ATTR_ENCOUNTER, session);
  boss.setAttribute?.(Shared.ATTR_ARMED_AT, core.World.getProcessCycle() + Shared.ARM_TICKS);
  boss.setAttribute?.(Shared.ATTR_SPECIAL, Shared.SPECIAL_FOR_PRIMARY[session.pattern[0]] ?? "ball");
  area.add(boss);
  core.World.getAddNPCQueue().push(boss);
  session.npc = boss;
  session.respawnAt = 0;
  session.corpse = null;
  Specials.initFight(boss);
  Minions.spawnEggs(session);
  Hud.show(boss, session.player);
  core.TaskManager.submit(new (class extends core.Task {
    constructor() {
      super(Math.max(1, Shared.ARM_TICKS), null, false);
    }
    execute() {
      this.stop();
      if (!boss.isRegistered?.() || (boss.getHitpoints?.() ?? 1) <= 0) return;
      if (!session.player?.isRegistered?.()) return;
      boss.getCombat?.().attack?.(session.player);
    }
  })());
}

function ensureEncounter(player, area) {
  let session = sessions.get(player);
  const now = core.World.getProcessCycle();
  // A dying boss stays registered through its corpse (remains), so only removal counts.
  const bossGone = !session?.npc?.isRegistered?.();
  if (session && bossGone) {
    if (!session.respawnAt || now >= session.respawnAt) {
      sessions.delete(player);
      session = null;
    } else {
      return;
    }
  }
  if (!session) {
    spawnEncounter(createSession(player, area));
  }
}

function enterLair({ player }) {
  if (!player) return;
  if (!insideLair(player.getLocation?.())) {
    // Only a player who had a lair leaves one: tearing down for everyone else every tick
    // cleared every player's incoming hits.
    if (player.getAttribute?.(ATTR_AREA) || sessions.has(player)) destroyArea(player);
    return;
  }
  let area = areaOf(player);
  if (!area) {
    area = new AraxxorPrivateArea(player.getUsername?.());
    player.setAttribute?.(ATTR_AREA, area);
  }
  moveIntoArea(player, area);
  ensureEncounter(player, area);
}

/** Players fight only their own instance's spiders. */
function denyForeignAttack(event) {
  const target = event.target;
  if (!target?.isNpc?.()) return;
  const id = target.getId?.();
  if (![Shared.BOSS_ID, Shared.CORPSE_ID, Shared.BALL_ID, Shared.MINION_ID.mirrorback, Shared.MINION_ID.ruptura,
    Shared.MINION_ID.acidic, Shared.EGG_ID.mirrorback, Shared.EGG_ID.ruptura, Shared.EGG_ID.acidic].includes(id)) {
    return;
  }
  const attacker = event.attacker;
  if (!attacker?.isPlayer?.()) return;
  if (attacker.getPrivateArea?.() !== target.getPrivateArea?.()) {
    event.allow = false;
  }
}

function leaveWorld({ player }) {
  if (!player) return;
  destroyArea(player);
}

function attach(pluginApi) {
  api = pluginApi;
  core = pluginApi.core;
  defineAreaClass();
  pluginApi.onPlayerProcess(enterLair);
  pluginApi.onCanAttack(denyForeignAttack);
  pluginApi.onPlayerLogout(leaveWorld);
  pluginApi.onPlayerDisconnect(leaveWorld);
}

module.exports = {
  attach,
  insideLair,
  areaOf,
  sessions,
  spawnEncounter,
  ensureEncounter,
  destroyArea,
  _test: { insideLair },
};
