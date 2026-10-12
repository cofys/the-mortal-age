"use strict";

/**
 * CaravanJourney — the VISIBLE layer for inter-kingdom trade caravans.
 *
 * CitizenTradeCaravans runs the data-tier phase machine (mustering ->
 * traveling -> arrived -> returning -> done) with an abstracted 3h journey.
 * This module makes the journey physical when a road exists: the caravan
 * walks real waypoints from data/caravan-routes.json, crew roster records
 * track the caravan tile-by-tile (so the LOD materializes them on the road
 * when Jon approaches), and the brain's caravanWalk action walks each
 * materialized crew member toward the caravan's current waypoint.
 *
 * Keldagrim routes are marked "abstracted": true (underground, no walkable
 * path) — those caravans keep the existing timer behavior untouched.
 *
 * Bandit ambushes are real but cheap: entering a dangerSegments leg rolls
 * the route's existing riskFor() chance; on a hit 2-4 bandit NPCs spawn
 * near the caravan (only when a real player is near enough to see it —
 * otherwise spawning is wasted). Guard crew fight with real combat. If the
 * merchant leader dies the run fails (cargo lost); if the bandits die the
 * caravan walks on. Everything notable is journaled.
 *
 * Wiring: onCaravanDepart / onCaravanReturn are called from advanceCaravan
 * on the mustering->traveling and arrived->returning transitions;
 * tickVisibleCaravans runs on the slow director tick right after
 * tickCaravans' per-route processing. Zero LLM, real engine APIs only.
 * Plain-node testable: CaravanJourney.test.js.
 */

const path = require("path");
const fs = require("fs");
const { getJournal } = require("./CitizenJournal");
const { agentRng } = require("./humanizer");
const { normalizeName } = require("./CitizenBonds");
const { ATTR_CARAVAN_DUTY } = require("../constants");

// === Tuning: all magic numbers here ===
// Data-tier advance per slow tick (~60s): ~100 tiles/min matches OSRS walk
// speed (1 tile / 600ms tick), so the data anchor tracks the walking crew
// instead of teleporting ahead of them. A 300-tile route walks in ~3 min.
const TILES_PER_SLOW_TICK = 100;
const ARRIVE_RADIUS = 3; // tiles — data-tier "reached the waypoint"
const BANDIT_NPC_ID = 6605;
const BANDIT_MIN = 2;
const BANDIT_MAX = 4;
const AMBUSH_PLAYER_RADIUS = 50; // tiles — no player in earshot, no ambush spawn
const AMBUSH_SPAWN_SPREAD = 4; // tiles around the caravan the bandits appear
const AMBUSH_WANDER_RADIUS = 6; // tiles — bandits hold the ambush site

function journalEvent(citizenName, text, kind) {
  try {
    getJournal().log(citizenName, kind ?? "trade", text);
  } catch {
    // Non-fatal.
  }
}

function deathCountFor(username) {
  try {
    return require("./CitizenDeathRespawn").deathCountFor(username) ?? 0;
  } catch {
    return 0;
  }
}

// ============================================================================
// Route table — data/caravan-routes.json, built by the route worker.
// Missing file => every route reads as abstracted (existing behavior).
// ============================================================================

const ROUTES_PATH = path.join(__dirname, "..", "data", "caravan-routes.json");
let routeTable = null; // null = not loaded yet

function loadRouteTable() {
  if (routeTable !== null) return routeTable;
  routeTable = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(ROUTES_PATH, "utf8"));
    for (const r of raw?.routes ?? []) {
      if (r && typeof r.key === "string") routeTable.set(r.key, r);
    }
  } catch {
    // Not landed yet — all routes stay abstracted until it does.
  }
  return routeTable;
}

/** Route entry for a route key, or null. */
function routeFor(routeKey) {
  return loadRouteTable().get(routeKey) ?? null;
}

/** True when the route has a walkable road (not abstracted, 2+ waypoints). */
function walkable(route) {
  return (
    !!route &&
    route.abstracted !== true &&
    Array.isArray(route.waypoints) &&
    route.waypoints.length >= 2
  );
}

/** Normalize a [x, y, z] waypoint array to {x, y, z}. */
function normWaypoint(w) {
  if (Array.isArray(w)) return { x: w[0] ?? 0, y: w[1] ?? 0, z: w[2] ?? 0 };
  return { x: w?.x ?? 0, y: w?.y ?? 0, z: w?.z ?? 0 };
}

// ============================================================================
// Crew tagging — roster records carry the duty; materialized bots get the
// attribute directly, and spawnCitizen stamps it from the record for crew
// who materialize mid-journey.
// ============================================================================

/** Leader + hired guards, in walk order. */
function crewUsernames(caravan) {
  return [caravan.leader, ...(caravan.guards ?? [])].filter(Boolean);
}

function recordFor(director, username) {
  try {
    return director?.roster?.get?.(normalizeName(username)) ?? null;
  } catch {
    return null;
  }
}

function botFor(director, record) {
  try {
    return director?.getBot?.(record) ?? null;
  } catch {
    return null;
  }
}

/** Stamp the duty on every crew record (and live bot). */
function tagCrew(director, caravan) {
  for (const username of crewUsernames(caravan)) {
    const record = recordFor(director, username);
    if (!record) continue;
    try {
      record.position = { ...caravan.position };
      record.caravanDuty = caravan.id;
    } catch {
      // Record unwritable — the bot tag below still applies when online.
    }
    const bot = botFor(director, record);
    try {
      bot?.setAttribute?.(ATTR_CARAVAN_DUTY, caravan.id);
    } catch {
      // Non-fatal.
    }
  }
}

/** Clear the duty from every crew record (and live bot). */
function untagCrew(director, caravan) {
  for (const username of crewUsernames(caravan)) {
    const record = recordFor(director, username);
    if (!record) continue;
    try {
      record.caravanDuty = null;
    } catch {
      // Non-fatal.
    }
    const bot = botFor(director, record);
    try {
      bot?.setAttribute?.(ATTR_CARAVAN_DUTY, null);
    } catch {
      // Non-fatal.
    }
  }
}

/** Keep crew data-tier positions glued to the caravan. Cheap: 3-5 records. */
function syncCrewPositions(director, caravan) {
  for (const username of crewUsernames(caravan)) {
    const record = recordFor(director, username);
    if (!record) continue;
    try {
      record.position = { ...caravan.position };
    } catch {
      // Non-fatal.
    }
  }
}

// ============================================================================
// Depart / return — called from advanceCaravan's phase transitions.
// ============================================================================

/**
 * Mustering -> traveling: start the visible walk when the route has a road.
 * Returns true when the caravan is now walking visibly.
 */
function onCaravanDepart(director, caravan) {
  const route = routeFor(caravan.routeKey);
  if (!walkable(route)) return false; // abstracted — existing timer behavior
  caravan.walkPath = route.waypoints.map(normWaypoint);
  caravan.waypointIndex = 1; // walking TOWARD walkPath[1]
  caravan.position = { ...caravan.walkPath[0] };
  caravan.visible = true;
  caravan.ambushLegsRolled = [];
  caravan.ambush = null;
  caravan.leaderDeathSeq = deathCountFor(caravan.leader);
  tagCrew(director, caravan);
  journalEvent(
    caravan.leader,
    `The caravan is on the road — walking the ${route.key} route.`,
    "trade"
  );
  // The caravan starts on leg 0 immediately.
  maybeAmbush(director, caravan, 0, Date.now());
  return true;
}

/**
 * Arrived -> returning: walk the same road back, waypoints reversed.
 * Returns true when the caravan is now walking visibly.
 */
function onCaravanReturn(director, caravan) {
  const route = routeFor(caravan.routeKey);
  if (!walkable(route)) return false; // abstracted — existing timer behavior
  caravan.walkPath = route.waypoints.map(normWaypoint).reverse();
  caravan.waypointIndex = 1;
  caravan.position = { ...caravan.walkPath[0] };
  caravan.visible = true;
  caravan.ambushLegsRolled = [];
  caravan.ambush = null;
  caravan.leaderDeathSeq = deathCountFor(caravan.leader);
  tagCrew(director, caravan);
  journalEvent(caravan.leader, "The caravan turns for home, wagons creaking.", "trade");
  maybeAmbush(director, caravan, 0, Date.now());
  return true;
}

/** End the visible leg: crew stand down, the phase machine proceeds alone. */
function endVisibleLeg(director, caravan, arrived) {
  caravan.visible = false;
  caravan.ambush = null;
  untagCrew(director, caravan);
  if (arrived) {
    const route = routeFor(caravan.routeKey);
    journalEvent(
      caravan.leader,
      `The caravan reached the end of the ${route?.key ?? caravan.routeKey} road.`,
      "trade"
    );
  }
}

/**
 * The run failed (leader slain): journal it, stand the crew down, despawn
 * any bandits, and delete the caravan — cargo lost, no settlement.
 */
function failCaravan(director, caravan, reason) {
  const { removeCaravan } = require("./CitizenTradeCaravans");
  journalEvent(
    caravan.leader,
    `The caravan is lost — ${reason}. The cargo is gone with it.`,
    "trade"
  );
  for (const g of caravan.guards ?? []) {
    journalEvent(g, `The caravan fell apart on the road — ${reason}.`, "trade");
  }
  despawnAmbush(director, caravan);
  untagCrew(director, caravan);
  caravan.visible = false;
  try {
    removeCaravan(caravan.routeKey);
  } catch {
    // Non-fatal.
  }
}

// ============================================================================
// Ambushes — real, but cheap.
// ============================================================================

/** Remove any live ambush bandits. */
function despawnAmbush(director, caravan) {
  const npcs = caravan?.ambush?.npcs ?? [];
  caravan.ambush = null;
  const api = director?.api;
  for (const npc of npcs) {
    try {
      if (npc && !npc.isDead?.() && !npc.isDying?.() && npc.isRegistered?.() !== false) {
        api?.removeNpc?.(npc);
      }
    } catch {
      // Non-fatal.
    }
  }
}

/** True when every ambush bandit is dead or gone. */
function ambushOver(caravan) {
  const npcs = caravan?.ambush?.npcs ?? [];
  if (npcs.length === 0) return true;
  return npcs.every((npc) => {
    try {
      return !npc || npc.isDead?.() || npc.isDying?.() || npc.isRegistered?.() === false;
    } catch {
      return true;
    }
  });
}

function realPlayerNear(director, pos) {
  try {
    const positions = director?.realPlayerPositions?.() ?? [];
    return director?.anyRealPlayerNear?.(pos.x, pos.y, pos.z ?? 0, AMBUSH_PLAYER_RADIUS, positions) === true;
  } catch {
    return false;
  }
}

/**
 * Entering a dangerSegments leg: roll the route's bandit risk once. On a
 * hit, spawn 2-4 bandits near the caravan — but only when a real player is
 * close enough to see the fight.
 */
function maybeAmbush(director, caravan, leg, nowMs) {
  if ((caravan.ambushLegsRolled ?? []).includes(leg)) return;
  caravan.ambushLegsRolled = [...(caravan.ambushLegsRolled ?? []), leg];
  const route = routeFor(caravan.routeKey);
  const danger = route?.dangerSegments ?? [];
  if (!danger.includes(leg)) return;
  const { riskFor } = require("./CitizenTradeCaravans");
  const rng = agentRng(`caravan:ambush:${caravan.id}:${leg}`);
  if (rng() >= riskFor(caravan.routeKey)) return; // the road was quiet
  if (!realPlayerNear(director, caravan.position)) return; // nobody to see it — skip the spawn
  const n = BANDIT_MIN + Math.floor(rng() * (BANDIT_MAX - BANDIT_MIN + 1));
  const npcs = [];
  for (let i = 0; i < n; i++) {
    const dx = Math.round((rng() * 2 - 1) * AMBUSH_SPAWN_SPREAD);
    const dy = Math.round((rng() * 2 - 1) * AMBUSH_SPAWN_SPREAD);
    try {
      const npc = director?.api?.spawnNpc?.({
        id: BANDIT_NPC_ID,
        x: Math.round(caravan.position.x) + dx,
        y: Math.round(caravan.position.y) + dy,
        z: caravan.position.z ?? 0,
        wanderRadius: AMBUSH_WANDER_RADIUS,
      });
      if (npc) npcs.push(npc);
    } catch {
      // One bad spawn never breaks the journey.
    }
  }
  if (npcs.length === 0) return;
  caravan.ambush = { leg, npcs, startedAt: nowMs };
  journalEvent(caravan.leader, `Bandits on the road! ${npcs.length} of them — guards, to arms!`, "trade");
  for (const g of caravan.guards ?? []) {
    journalEvent(g, "Bandit ambush on the caravan road — steel out!", "trade");
  }
  // The leader shouts it if they're materialized where Jon can hear.
  try {
    const record = recordFor(director, caravan.leader);
    const bot = botFor(director, record);
    if (bot) {
      const { sayPublic } = require("../chat/CitizenSayPublic");
      sayPublic(bot, "Ambush! To arms — guard the wagons!");
    }
  } catch {
    // Cosmetic only.
  }
}

// ============================================================================
// Slow tick — advance every visible caravan along its road.
// ============================================================================

function atTile(pos, wp) {
  return (
    Math.max(Math.abs(pos.x - wp.x), Math.abs(pos.y - wp.y)) <= ARRIVE_RADIUS &&
    (pos.z ?? 0) === (wp.z ?? 0)
  );
}

/** Move pos toward wp by up to TILES_PER_SLOW_TICK (per axis). */
function stepToward(pos, wp) {
  for (const axis of ["x", "y"]) {
    const d = wp[axis] - pos[axis];
    if (d === 0) continue;
    pos[axis] += Math.sign(d) * Math.min(TILES_PER_SLOW_TICK, Math.abs(d));
  }
  pos.z = wp.z ?? 0;
}

function tickOneCaravan(director, caravan, nowMs) {
  // Defensive: visible only makes sense while traveling or returning.
  if (caravan.phase !== "traveling" && caravan.phase !== "returning") {
    endVisibleLeg(director, caravan, false);
    return;
  }
  // The merchant leader died on the road: the run fails.
  if (deathCountFor(caravan.leader) > (caravan.leaderDeathSeq ?? 0)) {
    failCaravan(director, caravan, `${caravan.leader} was slain on the road`);
    return;
  }
  // An ambush in progress: the caravan holds until the fight resolves.
  if (caravan.ambush) {
    if (ambushOver(caravan)) {
      journalEvent(
        caravan.leader,
        "The bandits are dead — the caravan walks on, a little poorer in arrows.",
        "trade"
      );
      despawnAmbush(director, caravan);
    } else {
      syncCrewPositions(director, caravan);
      return; // fight's not over — hold position
    }
  }
  const path = caravan.walkPath;
  if (!Array.isArray(path) || path.length === 0) {
    endVisibleLeg(director, caravan, false);
    return;
  }
  if (caravan.waypointIndex >= path.length) {
    endVisibleLeg(director, caravan, true);
    return;
  }
  const target = path[caravan.waypointIndex];
  stepToward(caravan.position, target);
  if (atTile(caravan.position, target)) {
    caravan.waypointIndex += 1;
    if (caravan.waypointIndex >= path.length) {
      endVisibleLeg(director, caravan, true);
      return;
    }
    // Now walking leg (waypointIndex - 1): roll its ambush if dangerous.
    maybeAmbush(director, caravan, caravan.waypointIndex - 1, nowMs);
  }
  syncCrewPositions(director, caravan);
}

/**
 * Slow-tick entry: advance every visible caravan. Early-outs when none
 * are walking (the usual case — 0-2 at a time), so the tick is free.
 */
function tickVisibleCaravans(director, nowMs) {
  const { visibleCaravanList } = require("./CitizenTradeCaravans");
  let list = [];
  try {
    list = visibleCaravanList();
  } catch {
    return;
  }
  if (list.length === 0) return;
  for (const caravan of list) {
    try {
      tickOneCaravan(director, caravan, nowMs);
    } catch (e) {
      console.warn("[caravan-journey] caravan failed:", caravan?.id, e?.message ?? e);
    }
  }
}

module.exports = {
  onCaravanDepart,
  onCaravanReturn,
  tickVisibleCaravans,
  failCaravan,
  // Pure-ish helpers for tests:
  routeFor,
  walkable,
  crewUsernames,
  tagCrew,
  untagCrew,
  TILES_PER_SLOW_TICK,
  BANDIT_NPC_ID,
  // Test seams (not part of the public contract):
  _resetForTests: () => {
    routeTable = null;
  },
  _setRouteTable: (routes) => {
    routeTable = new Map();
    for (const r of routes ?? []) {
      if (r && typeof r.key === "string") routeTable.set(r.key, r);
    }
  },
};
