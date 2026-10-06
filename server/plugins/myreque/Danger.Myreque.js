"use strict";

/**
 * Danger.Myreque — where the reputation track gets teeth.
 *
 * Two areas, registered with api.registerArea (AGENTS.md rule 7: no global
 * hooks):
 *
 *   Canifis patrol zone (3450-3540, 3440-3520, z0):
 *     Three vyrewatch patrols walk the town. They are naturally aggressive;
 *     the area's canAttack gates them: they may ONLY attack players at
 *     Hollow-Trusted (+200) or above. Everyone else gets engine-level
 *     immunity — including Oathbound players, who the patrols salute.
 *     Retaliation still works both ways (you hit a patrol, it hits back).
 *     Killing a patrol is a Myreque deed (+60 standing, rumor).
 *     Sworn players get a warning whisper on entry.
 *
 *   The swamp hollow (3480-3530, 3420-3460, z0):
 *     The courier respawn check (Actors.ensureCourier) and the exposed
 *     operative event: every 45-75 min, if a quest-complete Myreque-leaning
 *     player is in the swamp, a runner spawns on the south road, exposed.
 *     Talk them into the tunnel within 5 min (+80). If the timer runs out
 *     they're taken: rumor + tension. Never spawns for Drakan-locked
 *     players, and Favored+ players can't hide them.
 */

const Rep = require("./Reputation.Myreque");
const Actors = require("./Actors.Myreque");
const Tension = require("../kingdoms/Tension.Kingdoms");

let api = null;
let core = null;

// --- zones ------------------------------------------------------------------------

const CANIFIS = { x1: 3450, y1: 3440, x2: 3540, y2: 3520, z: 0 };
const SWAMP = { x1: 3480, y1: 3420, x2: 3530, y2: 3460, z: 0 };

const PATROL_POSTS = [
  { x: 3490, y: 3478, z: 0 },
  { x: 3500, y: 3486, z: 0 },
  { x: 3494, y: 3468, z: 0 },
];
const PATROL_RESPAWN_MS = 5 * 60 * 1000;

const OPERATIVE_SPAWN = { x: 3500, y: 3435, z: 0 };
const OPERATIVE_WINDOW_MS = 5 * 60 * 1000;
const OPERATIVE_MIN_MS = 45 * 60 * 1000;
const OPERATIVE_MAX_MS = 75 * 60 * 1000;
const OPERATIVE_STANDING = 80;

// --- state --------------------------------------------------------------------------

const patrols = []; // { npc, post, respawnAt }
let operative = null; // { npc, until }
let nextOperativeAt = Date.now() + OPERATIVE_MIN_MS;
let processCounter = 0;

// --- helpers --------------------------------------------------------------------------

function npcLoc(mobile) {
  try {
    return mobile?.getLocation?.() ?? null;
  } catch {
    return null;
  }
}

function xy(loc) {
  if (!loc) return null;
  try {
    return { x: loc.getX?.() ?? loc.x, y: loc.getY?.() ?? loc.y, z: loc.getZ?.() ?? loc.z ?? 0 };
  } catch {
    return null;
  }
}

function inRect(loc, r) {
  const p = xy(loc);
  return (
    p !== null &&
    p.x >= r.x1 && p.x <= r.x2 &&
    p.y >= r.y1 && p.y <= r.y2 &&
    p.z === r.z
  );
}

function aliveNpc(npc) {
  try {
    return !!npc && npc.isDead?.() !== true && npc.isDying?.() !== true;
  } catch {
    return false;
  }
}

function isPatrol(npc) {
  return patrols.some((record) => record.npc === npc);
}

function spawnPatrol(post) {
  try {
    const id = core.NpcIdentifiers.VYREWATCH;
    const npc = api.spawnNpc({ id, x: post.x, y: post.y, z: post.z, wanderRadius: 8 });
    return npc ?? null;
  } catch (error) {
    console.warn("[myreque] patrol spawn failed", error?.message);
    return null;
  }
}

function buildPatrols() {
  for (const post of PATROL_POSTS) {
    patrols.push({ npc: spawnPatrol(post), post, respawnAt: 0 });
  }
  console.info("[myreque] vyre patrols walking Canifis", { count: patrols.length });
}

// --- the Canifis patrol zone ---------------------------------------------------------------
// Classes extend core.Area, so they're defined inside createZones() — core is
// only set once registerDanger runs (same pattern as SunkenHollow).

function createZones() {
  class CanifisPatrolZone extends core.Area {
    process() {
      // Respawn dead patrols (cheap timestamp check; the aggro itself is
      // engine-driven and gated by canAttack below).
      if ((processCounter++ % 20) !== 0) return;
      const now = Date.now();
      for (const record of patrols) {
        if (!aliveNpc(record.npc) && now >= record.respawnAt) {
          record.npc = spawnPatrol(record.post);
          record.respawnAt = 0;
        }
      }
    }

    postEnter(mobile) {
      if (!Rep.isRealPlayer(mobile)) return;
      if (Rep.getStanding(mobile) < 600) return;
      const last = Number(mobile.getAttribute?.("myreque:warned-at")) || 0;
      if (Date.now() - last < 5 * 60 * 1000) return;
      try {
        mobile.setAttribute("myreque:warned-at", Date.now());
      } catch {
        // best-effort
      }
      mobile.sendMessage("The vyres' heads turn as you pass. They know your face, Sworn of the Hollow.");
    }

    /**
     * The patrols hunt the Hollow's friends and no one else. Engine
     * aggression proposes the attack; this gate disposes. Retaliation
     * bypasses the gate (Combat.attack directly), so patrols still fight
     * back when struck — and striking one is a Myreque deed.
     */
    canAttack(attacker, target) {
      if (!attacker || !target) return null;
      if (!isPatrol(attacker)) return null;
      if (!Rep.isRealPlayer(target)) return null;
      return Rep.getStanding(target) >= 200;
    }
  }

  class SwampHollowZone extends core.Area {
    process() {
      if ((processCounter++ % 20) !== 0) return;
      try {
        Actors.ensureCourier();
      } catch {
        // best-effort
      }
      try {
        operativeTick(this);
      } catch (error) {
        console.warn("[myreque] operative tick failed", error?.message);
      }
    }
  }

  return {
    canifis: new CanifisPatrolZone([new core.Boundary(CANIFIS.x1, CANIFIS.x2, CANIFIS.y1, CANIFIS.y2, CANIFIS.z)]),
    swamp: new SwampHollowZone([new core.Boundary(SWAMP.x1, SWAMP.x2, SWAMP.y1, SWAMP.y2, SWAMP.z)]),
  };
}

function onPatrolDeath(event) {
  const { npc, killer } = event ?? {};
  if (!npc || !isPatrol(npc)) return;
  for (const record of patrols) {
    if (record.npc === npc) {
      record.npc = null;
      record.respawnAt = Date.now() + PATROL_RESPAWN_MS;
    }
  }
  if (!Rep.isRealPlayer(killer)) return;
  Rep.addStanding(killer, 60, "patrol-slain");
  Rep.markDeed(
    killer,
    `${killer.getUsername?.() ?? "Someone"} slew a vyre patrol in Canifis.`,
    "A vyre patrol was found dead in Canifis. Sarev wants answers — the Hollow wants the killer's name."
  );
  killer.sendMessage("[Myreque] The patrol lies broken in the street. The Hollow will remember this. (+60 standing)");
}

// --- the exposed operative (swamp) -----------------------------------------------------------------

function spawnOperative() {
  try {
    const id = core.NpcIdentifiers.MAN;
    const npc = api.spawnNpc({
      id,
      x: OPERATIVE_SPAWN.x,
      y: OPERATIVE_SPAWN.y,
      z: OPERATIVE_SPAWN.z,
      wanderRadius: 0,
    });
    if (!npc) return null;
    try {
      npc.forceChat("Please... the patrols are everywhere...");
    } catch {
      // best-effort
    }
    return npc;
  } catch (error) {
    console.warn("[myreque] operative spawn failed", error?.message);
    return null;
  }
}

function qualifyingPlayerInSwamp(zone) {
  for (const p of zone.getPlayers()) {
    if (!Rep.isRealPlayer(p)) continue;
    if (!Rep.hasMetMyreque(p)) continue;
    if (Rep.getStanding(p) < 1) continue;
    return p;
  }
  return null;
}

function operativeTick(zone) {
  const now = Date.now();
  if (operative) {
    if (!aliveNpc(operative.npc)) {
      operative = null;
      nextOperativeAt = now + OPERATIVE_MIN_MS + Math.random() * (OPERATIVE_MAX_MS - OPERATIVE_MIN_MS);
      return;
    }
    if (now >= operative.until) {
      // Taken.
      try {
        operative.npc.forceChat("No — please —!");
      } catch {
        // best-effort
      }
      try {
        api.removeNpc(operative.npc);
      } catch {
        // best-effort
      }
      operative = null;
      nextOperativeAt = now + OPERATIVE_MIN_MS + Math.random() * (OPERATIVE_MAX_MS - OPERATIVE_MIN_MS);
      try {
        api.emitCustomEvent("kingdom:rumor", {
          kingdomId: "morytania",
          text: "The patrol took a Myreque runner on the south road. Nobody saw them again.",
        });
        Tension.addTension("morytania", Rep.hottestRival(), 1);
      } catch {
        // cosmetic
      }
      console.info("[myreque] operative caught on the south road");
    }
    return;
  }
  if (now < nextOperativeAt) return;
  const witness = qualifyingPlayerInSwamp(zone);
  if (!witness) {
    nextOperativeAt = now + 5 * 60 * 1000; // nobody to save them — check again soon
    return;
  }
  const npc = spawnOperative();
  if (!npc) {
    nextOperativeAt = now + 5 * 60 * 1000;
    return;
  }
  operative = { npc, until: now + OPERATIVE_WINDOW_MS };
  witness.sendMessage("A ragged runner stumbles out of the reeds south of the tunnel — exposed, and the patrols are out.");
  console.info("[myreque] operative exposed on the south road");
}

function hideOperative(player) {
  if (!operative || !aliveNpc(operative.npc)) return;
  if (!Rep.hasMetMyreque(player) || Rep.getStanding(player) < 1 || Rep.myrequeLocked(player)) {
    player.sendMessage("The runner flinches away from you. Wrong hands.");
    return;
  }
  try {
    api.removeNpc(operative.npc);
  } catch {
    // best-effort
  }
  operative = null;
  nextOperativeAt = Date.now() + OPERATIVE_MIN_MS + Math.random() * (OPERATIVE_MAX_MS - OPERATIVE_MIN_MS);
  Rep.addStanding(player, OPERATIVE_STANDING, "operative-hidden");
  Rep.markDeed(
    player,
    `${player.getUsername?.() ?? "Someone"} hid a Myreque runner from the patrol.`,
    "A Myreque runner vanished into the swamp under the patrol's nose."
  );
  player.sendMessage("You pull the runner into the reeds and point them at the tunnel. \"The Hollow remembers,\" they breathe, and they're gone.");
  player.sendMessage(`(+${OPERATIVE_STANDING} standing)`);
}

function onOperativeTalk(event) {
  const { player, npc } = event ?? {};
  if (!Rep.isRealPlayer(player)) return false;
  if (!operative || npc !== operative.npc) return false;
  hideOperative(player);
}

// --- wiring -----------------------------------------------------------------------

function registerDanger(pluginApi) {
  api = pluginApi;
  core = pluginApi.core;

  api.onServerStartup(buildPatrols);

  const zones = createZones();
  api.registerArea(zones.canifis);
  api.registerArea(zones.swamp);

  // The operative's Talk-to: registered after Actors' "Man" hook, which
  // returns false for them (not its NPC), so this runs.
  api.onNpcInteraction("Man", { "Talk-to": onOperativeTalk });
  api.onNpcDeath(onPatrolDeath);

  console.info("[myreque] danger live — patrols hunt at +200, the swamp hides runners");
}

module.exports = registerDanger;
