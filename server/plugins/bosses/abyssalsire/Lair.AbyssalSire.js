/**
 * The Sire's four chambers in the Abyssal Nexus (Wiki: Abyssal Nexus), each an Area:
 * - each holds a sleeping Sire, its four respiratory systems on their wheezing vents and six
 *   tentacles, spawned here rather than from npc-spawns.json so the chamber can reset them all;
 * - one player fights a Sire at a time (Wiki: solo-only, in a multi-combat area); the others are
 *   told "Someone else is fighting that.", the engine's single-combat line;
 * - only a player on an abyssal demon or Sire task wakes it: "The Sire takes no interest in
 *   you." (captured);
 * - leaving the chamber (a teleport, death, logging out) ends the fight and puts the chamber
 *   back as it was, as a kill does a tick after the Sire is gone (captured).
 */
const Common = require("./Common.AbyssalSire");
const Fight = require("./Fight.AbyssalSire");

const TENTACLE_FORM = { north: "tentacleNorth", south: "tentacleSouth", upright: "tentacleUpright" };
const SINGLE_COMBAT = "Someone else is fighting that.";

/** Every lair, in the data's order. */
const lairs = [];

class Lair {
  constructor(def, index) {
    this.def = def;
    this.index = index;
    this.name = def.name;
    const [minX, maxX, minY, maxY] = def.bounds;
    this.bounds = { minX, maxX, minY, maxY };
    this.sireTile = Common.toLocation([def.sire[0], def.sire[1], 0]);
    this.sire = null;
    this.lungs = [];
    this.tentacles = [];
    this.fight = null;
    /** Game tick the chamber last had a player in it, for the eyes (0: never). */
    this.lastOccupiedAt = 0;
    this.area = null;
  }

  contains(location) {
    const { minX, maxX, minY, maxY } = this.bounds;
    const x = location.getX();
    const y = location.getY();
    return location.getZ() === 0 && x >= minX && x <= maxX && y >= minY && y <= maxY;
  }

  players() {
    return this.area ? this.area.getPlayers() : [];
  }

  /** A tile offset from the Sire's sleeping tile. */
  offset([dx, dy]) {
    return this.sireTile.transform(dx, dy);
  }

  spawnNpc(id, location, face) {
    const npc = Common.api.spawnNpc({ id, x: location.getX(), y: location.getY(), z: location.getZ(), wanderRadius: 0 });
    if (!npc) return null;
    npc.__skipDefaultRespawn = true;
    npc.__sireLair = this;
    npc.setMultiCombat?.(true);
    npc.getMovementQueue().setBlockMovement(true);
    if (face != null) npc.setFace(face);
    return npc;
  }

  /** The chamber as the Sire wakes in it: everything fresh, the vents wheezing. */
  spawn() {
    const { npcs, locs } = Common.data;
    const { Direction, GameObject, ObjectManager } = Common.core;
    this.sire = this.spawnNpc(npcs.sleeping, this.sireTile, Direction.SOUTH);
    if (this.sire) {
      this.sire.setFlag("combat:no-regen");
      this.sire.setFlag("combat:no-retaliate");
      this.sire.setFlag("interaction:keep");
    }
    this.lungs = this.def.lungs.map(([x, y, rotation]) => {
      const tile = Common.toLocation([x, y, 0]);
      const npc = this.spawnNpc(npcs.lung, tile, null);
      npc?.setFlag("combat:no-regen");
      npc?.setFlag("combat:no-retaliate");
      const vent = new GameObject(locs.ventAlive, tile, locs.ventShape, rotation, null);
      ObjectManager.register(vent, true);
      return { npc, tile, rotation, vent, dead: false };
    });
    this.tentacles = this.def.tentacles.map(([x, y, kind]) => {
      const npc = this.spawnNpc(npcs[TENTACLE_FORM[kind]], Common.toLocation([x, y, 0]), Direction.SOUTH);
      return { npc, kind, state: "sleeping" };
    });
  }

  /** Everything the chamber spawned goes: the Sire, its lungs and tentacles. */
  despawn() {
    const { ObjectManager } = Common.core;
    if (this.sire) Common.api.removeNpc(this.sire);
    for (const lung of this.lungs) {
      if (lung.npc) Common.api.removeNpc(lung.npc);
      if (lung.vent) ObjectManager.deregister(lung.vent, true);
    }
    for (const tentacle of this.tentacles) if (tentacle.npc) Common.api.removeNpc(tentacle.npc);
    this.sire = null;
    this.lungs = [];
    this.tentacles = [];
  }

  /** The chamber back as it was, `afterTicks` from now (a kill: 1, captured). */
  reset(afterTicks = 0) {
    const fight = this.fight;
    this.fight = null;
    fight?.stop();
    const respawn = () => {
      if (this.fight) return;
      this.despawn();
      this.spawn();
    };
    if (afterTicks > 0) Common.later(afterTicks, respawn);
    else respawn();
  }

  /** The tentacles' form for their state: sleeping as placed, awake or stunned. */
  setTentacles(state) {
    const { npcs, anims } = Common.data;
    const { Animation } = Common.core;
    for (const tentacle of this.tentacles) {
      if (!tentacle.npc || tentacle.state === state) continue;
      const previous = tentacle.state;
      tentacle.state = state;
      if (state === "sleeping") {
        tentacle.npc.setNpcTransformationId(npcs[TENTACLE_FORM[tentacle.kind]]);
        continue;
      }
      tentacle.npc.setNpcTransformationId(state === "active" ? npcs.tentacleActive : npcs.tentacleStunned);
      let anim = anims.tentacleStunned;
      if (state === "active" && previous === "sleeping") {
        // Captured: each row wakes its own way.
        anim = tentacle.kind === "north" ? anims.tentacleWakingReversed : tentacle.kind === "south" ? anims.tentacleWaking : anims.tentacleUnstunned;
      } else if (state === "active") {
        anim = anims.tentacleUnstunned;
      }
      tentacle.npc.performAnimation(new Animation(anim));
    }
  }

  isOwnNpc(npc) {
    return npc?.__sireLair === this;
  }
}

function lairOf(npc) {
  return npc?.__sireLair ?? null;
}

function lairAt(location) {
  return lairs.find((lair) => lair.contains(location)) ?? null;
}

function onTask(player, npc) {
  const request = { player, npc, onTask: false };
  Common.api.emitCustomEvent("slayer:on-task", request);
  return request.onTask === true;
}

function createArea(lair) {
  const { Area, Boundary } = Common.core;
  const { minX, maxX, minY, maxY } = lair.bounds;
  class SireLair extends Area {
    constructor() {
      super([new Boundary(minX, maxX, minY, maxY, 0)]);
      this.lair = lair;
    }

    getName() {
      return `Abyssal Sire (${lair.name})`;
    }

    isMulti() {
      return true;
    }

    postEnter(mobile) {
      if (mobile.isPlayer()) lair.lastOccupiedAt = Common.core.World.getProcessCycle();
    }

    postLeave(mobile) {
      if (!mobile.isPlayer()) return;
      lair.lastOccupiedAt = Common.core.World.getProcessCycle();
      if (lair.fight && lair.fight.player === mobile) lair.reset();
    }

    canAttack(attacker, target) {
      if (!attacker?.isPlayer?.() || !lair.isOwnNpc(target)) return null;
      const player = attacker.getAsPlayer();
      const fight = lair.fight;
      if (fight && fight.player !== player) {
        player.sendMessage(SINGLE_COMBAT);
        return false;
      }
      if (target === lair.sire && !fight) {
        if (!onTask(player, target)) {
          player.sendMessage(Common.message("noTask"));
          return false;
        }
        return null;
      }
      // Until the Sire wakes, the vents are walled off from attacks (captured: an invisible
      // projectile wall round each one, gone as it wakes).
      if (!fight) return false;
      return null;
    }
  }
  return new SireLair();
}

/** The world spawns of the chambers' own NPCs are left out: each Lair spawns its own. */
function blockWorldSpawns(event) {
  const { npcs } = Common.data;
  const own = [npcs.sleeping, npcs.lung, npcs.tentacleNorth, npcs.tentacleSouth, npcs.tentacleUpright, npcs.tentacleActive];
  if (!own.includes(event.npcId) || !event.location) return;
  if (lairAt(event.location)) event.allow = false;
}

function spawnLairs() {
  for (const lair of lairs) lair.spawn();
}

/** The first hit on a sleeping Sire, by a player the chamber lets attack it, starts the fight. */
function wake(lair, player, spell = null) {
  if (lair.fight || !lair.sire) return null;
  lair.fight = Fight.begin(lair, player, spell);
  return lair.fight;
}

/** onNpcHitModify: a hit on a Sire wakes it if it sleeps, then its fight decides what it does. */
function sireHit({ npc, hit }) {
  if (!Common.isSire(npc)) return;
  const lair = lairOf(npc);
  if (!lair || lair.sire !== npc) return;
  const attacker = hit.getAttacker?.();
  if (!lair.fight) {
    if (!attacker?.isPlayer?.() || !onTask(attacker.getAsPlayer(), npc)) {
      Fight.setDamage(hit, 0);
      return;
    }
    wake(lair, attacker.getAsPlayer(), Fight.shadowSpellOf(hit));
  }
  lair.fight.hitSire(hit);
}

function attach(api) {
  Common.data.lairs.forEach((def, index) => lairs.push(new Lair(def, index)));
  for (const lair of lairs) {
    lair.area = createArea(lair);
    api.registerArea(lair.area);
  }
  api.onCanSpawnNpc(blockWorldSpawns);
  api.onServerStartup(spawnLairs);
  api.onNpcHitModify(sireHit);
}

module.exports = { attach, lairs, lairOf, lairAt, wake, onTask, Lair };
