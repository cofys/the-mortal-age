"use strict";

/**
 * CitizenWhereaboutsLife — data-tier want-driven movement (slice 1 of
 * emergent citizen distribution, Jon 2026-10-13).
 *
 * The brain moves ONLINE citizens through real engine APIs (brain/actions).
 * Offline citizens have no entity — but they still live as data. This tick
 * advances each offline citizen's roster `record.position` toward a
 * destination picked from their wants (brain/CitizenDestinations).
 * Materialization (spawnCitizen) spawns at record.position, so the visible
 * world fills with travelers, gatherers, and visitors — distribution that
 * emerges from what citizens are doing, not from anchor assignments.
 *
 * Pacing is honest: short trips complete within a slow tick; long hauls
 * interpolate over multiple ticks at human walking speed (~100 tiles/min),
 * so a mid-route traveler materializes ON the road. Data tier, zero LLM,
 * pure arithmetic over roster records.
 *
 * Slice 3 — inter-kingdom visits: settling somewhere new stamps
 * record.visit; short visits keep record.kingdomId/townId (visiting, like
 * a player would). A visit that outlasts its deterministic length (2–8h)
 * while a settling goal (work/friends) still wins becomes a relocation:
 * kingdomId + townId/settlementId flip, home re-anchors. Anything else
 * ends with a trip home. No pathfinding invented — the slice-1 enRoute
 * mechanism already interpolates the long hauls.
 *
 * Wiring: CitizenDirector calls tickWhereabouts(this, nowMs) in the slow
 * tick inside try/catch. Never throws — every record is guarded.
 */

const { pickDestination, arrivedAt } = require("../brain/CitizenDestinations");
const { agentRng, personalSpot } = require("./humanizer");
// Jon 2026-10-13 (Catherby water tiles): settled positions snap to walkable
// tiles so the data tier never records a position on water/inside a wall.
const CitizenTiles = require("./CitizenTiles");
const {
  GOAL_SAVE_GOLD,
  GOAL_MASTER_TRADE,
  GOAL_MAKE_FRIENDS,
} = require("./goals");

// Human walking speed, tiles per minute. The slow tick runs ~60s, so a
// citizen covers ~WALK_TILES_PER_TICK tiles per whereabouts tick.
const WALK_TILES_PER_MIN = 100;
const WALK_TILES_PER_TICK = WALK_TILES_PER_MIN;
// Trips longer than this interpolate over multiple ticks (en-route).
// Everything shorter just arrives — an offline citizen walks at human
// speed, so anything inside one tick's walking range is done by next tick.
const ARRIVE_RADIUS = 6;
// Cross-town trips get journaled this often (a player would note the trip).
const TRIP_JOURNAL_CHANCE = 0.25;
// Inter-kingdom visits (slice 3). A visit is a fixed-length stay, decided
// once per visit, deterministic per citizen: 2–8h. A player visits another
// kingdom for a session; they only put down roots when the same wants keep
// winning past it.
const VISIT_MIN_MS = 2 * 60 * 60 * 1000;
const VISIT_MAX_MS = 8 * 60 * 60 * 1000;
// How close to the visit tile counts as "still settled there" when the
// visit matures (a player who already left doesn't relocate).
const VISIT_SETTLED_RADIUS = 40;
// Goals that make a player put down roots: work and friends. (Marriage
// follows the same social axis via make_friends; spouse-driven moves are a
// follow-up.) Anything else — the trip ends and they head home.
const SETTLING_GOALS = new Set([GOAL_SAVE_GOLD, GOAL_MASTER_TRADE, GOAL_MAKE_FRIENDS]);

/** Visit length, deterministic per citizen per visit (agentRng seed). */
function visitLengthFor(username, since) {
  const rng = agentRng(`visitlen:${username ?? "unknown"}:${since}`);
  return Math.round(VISIT_MIN_MS + rng() * (VISIT_MAX_MS - VISIT_MIN_MS));
}

function visitExpired(record, now) {
  const v = record?.visit;
  return !!(
    v &&
    Number.isFinite(v.since) &&
    Number.isFinite(v.len) &&
    now - v.since >= v.len
  );
}

/** True when the citizen is still hanging around the visit tile. */
function settledNearVisit(record) {
  const v = record?.visit;
  if (!v || !record?.position) return false;
  return (
    (record.position.z ?? 0) === (v.z ?? 0) &&
    cheby(record.position.x, record.position.y, v.x, v.y) <= VISIT_SETTLED_RADIUS
  );
}

/**
 * Record an inter-kingdom (or cross-town) visit on settle. Short visits
 * keep record.kingdomId/townId — the citizen belongs to their kingdom,
 * they're just visiting, like a player would. Settling back on home turf
 * (or a dest with no placement) clears any visit.
 */
function noteVisit(record, dest, now) {
  try {
    const pk = dest?.kingdomId ?? null;
    const pt = dest?.townId ?? null;
    const ps = dest?.settlementId ?? null;
    const sameKingdom = pk && record.kingdomId && pk === record.kingdomId;
    const sameSpot =
      (pt ?? null) === (record.townId ?? null) &&
      (ps ?? null) === (record.settlementId ?? null);
    if (!pk || (sameKingdom && sameSpot)) {
      record.visit = null;
      return;
    }
    const v = record.visit;
    if (
      v &&
      v.kingdomId === pk &&
      (v.townId ?? null) === (pt ?? null) &&
      (v.settlementId ?? null) === (ps ?? null)
    ) {
      // Same visit continues — keep the original since/len.
      v.x = record.position.x;
      v.y = record.position.y;
      v.placeId = dest.placeId ?? v.placeId;
      return;
    }
    const since = Number.isFinite(now) ? now : Date.now();
    record.visit = {
      kingdomId: pk,
      townId: pt,
      settlementId: ps,
      placeId: dest.placeId ?? null,
      x: record.position.x,
      y: record.position.y,
      z: record.position.z ?? 0,
      since,
      len: visitLengthFor(record.username, since),
    };
  } catch {
    // visits never block settling
  }
}

/**
 * Pure record flip for a relocation (used directly when the director
 * offers no relocateCitizen — e.g. test doubles). The director's method
 * also fixes the kingdom index and housing.
 */
function applyRelocation(record, placement) {
  if (!record || !placement || typeof placement.kingdomId !== "string") return false;
  record.kingdomId = placement.kingdomId;
  record.townId = placement.townId ?? null;
  record.settlementId = placement.settlementId ?? null;
  if (placement.home && Number.isFinite(placement.home.x) && Number.isFinite(placement.home.y)) {
    record.home = {
      x: Math.round(placement.home.x),
      y: Math.round(placement.home.y),
      z: placement.home.z ?? 0,
    };
  }
  return true;
}

function journalRelocation(record, visit) {
  try {
    const where = visit.townId ?? visit.settlementId ?? visit.kingdomId ?? "a new home";
    const { getJournal } = require("./CitizenJournal");
    getJournal().log(record.username, "travel", `moved to ${where} for good.`);
  } catch {
    // journaling never moves anyone
  }
}

/**
 * A visit matured: the citizen stayed past the threshold and their goal is
 * a settling one — they relocate. Flip kingdomId + townId/settlementId,
 * re-anchor home to the visit tile, keep the roster index and housing
 * honest through the director. Waypoints need nothing new: the trip here
 * already interpolated through the slice-1 enRoute road mechanism.
 */
function relocateOnVisit(director, record, visit) {
  const placement = {
    kingdomId: visit.kingdomId,
    townId: visit.townId ?? null,
    settlementId: visit.settlementId ?? null,
    home: { x: visit.x, y: visit.y, z: visit.z ?? 0 },
  };
  let done = false;
  if (director && typeof director.relocateCitizen === "function") {
    try {
      done = !!director.relocateCitizen(record.username, placement);
    } catch {
      done = false;
    }
  }
  if (!done) applyRelocation(record, placement);
  journalRelocation(record, visit);
}

/**
 * The trip's over without relocation: point the citizen home like a
 * player ending a visit. advance() turns the long haul into an en-route
 * road trip — no pathfinding invented.
 */
function endVisitHome(record) {
  const home = record?.home;
  if (!home || !Number.isFinite(home.x) || !Number.isFinite(home.y)) return;
  record.dest = {
    x: home.x,
    y: home.y,
    z: home.z ?? 0,
    placeId: "home",
    kind: "home",
    reason: "heading home",
    kingdomId: record.kingdomId ?? null,
    townId: record.townId ?? null,
    settlementId: record.settlementId ?? null,
  };
  record.enRoute = null;
  try {
    const { getJournal } = require("./CitizenJournal");
    getJournal().log(record.username, "travel", "heading home after the trip.");
  } catch {
    // journaling never moves anyone
  }
}

/**
 * Visit lifecycle, checked before each destination pick. A matured visit
 * either becomes a relocation (settling goals, still there) or ends with
 * a trip home. Mid-trip citizens are left alone — the visit matures when
 * they settle. Never throws.
 */
function maybeMatureVisit(director, record, now) {
  try {
    if (!record?.visit || !visitExpired(record, now)) return;
    const dest = record.dest;
    if (destValid(dest) && !arrivedAt(record, dest, ARRIVE_RADIUS)) return;
    const visit = record.visit;
    const settled = settledNearVisit(record);
    record.visit = null;
    if (!settled) return; // wandered off — normal wants decide
    if (SETTLING_GOALS.has(record?.goal?.type)) {
      relocateOnVisit(director, record, visit);
    } else {
      endVisitHome(record);
    }
  } catch {
    // a broken visit never stalls the roster
  }
}

function cheby(ax, ay, bx, by) {
  return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
}

/** Roster records as an array. Defensive across director shapes. */
function rosterRecords(director) {
  try {
    const roster = director?.roster;
    if (!roster) return [];
    if (Array.isArray(roster)) return roster;
    if (typeof roster.values === "function") return [...roster.values()];
    if (typeof roster === "object") return Object.values(roster);
    return [];
  } catch {
    return [];
  }
}

function isOnline(director, record) {
  try {
    if (typeof director?.isOnline === "function") return !!director.isOnline(record);
  } catch {
    // fall through to the record flag
  }
  return !!record?.online;
}

/**
 * Sleep check, mirroring the director's desiredPhase window
 * (sleepStart + sleepHours). Sleeping citizens stay where they logged out.
 */
function isAsleep(record, nowMs) {
  const start = record?.sleepStart;
  const hours = record?.sleepHours ?? 7;
  if (!Number.isFinite(start)) return false;
  const hour = new Date(nowMs).getHours();
  const end = (start + hours) % 24;
  return start <= end ? hour >= start && hour < end : hour >= start || hour < end;
}

/** CitizenTravel owns journeying citizens — never fight it. */
function hasJourney(record) {
  try {
    const Travel = require("./CitizenTravel");
    const username = record?.username;
    if (!username || typeof Travel?.journeyOf !== "function") return false;
    return !!Travel.journeyOf(username);
  } catch {
    return false;
  }
}

function destValid(dest) {
  return (
    dest &&
    Number.isFinite(dest.x) &&
    Number.isFinite(dest.y) &&
    typeof dest.placeId === "string"
  );
}

function journalTrip(record, dest) {
  try {
    const rng = agentRng(`wbl:${record.username}:${Math.floor(Date.now() / 3600000)}`);
    if (rng() > TRIP_JOURNAL_CHANCE) return;
    const { getJournal } = require("./CitizenJournal");
    getJournal().log(
      record.username,
      "travel",
      `headed ${dest.reason} (${dest.placeId}).`
    );
  } catch {
    // journaling never moves anyone
  }
}

/** Settle at the destination: personal spot jitter (destack law — never
 *  N citizens on one tile), destination cleared so the next tick re-picks.
 *  Stamps record.arrived so the brain can seed arrival behavior when the
 *  citizen materializes (whereabouts slice 2): kind + tile + time, consumed
 *  once by the spawn hook. */
function settle(record, dest, now) {
  let x = dest.x;
  let y = dest.y;
  try {
    const spot = personalSpot(record.username, dest.x, dest.y, 2, 8);
    if (spot && Number.isFinite(spot.x) && Number.isFinite(spot.y)) {
      x = spot.x;
      y = spot.y;
    }
  } catch {
    // jitter is cosmetic
  }
  // Jon 2026-10-13 (Catherby water tiles): the personal-spot ring around a
  // dock can land in the sea — snap to the nearest walkable tile so the
  // recorded position is always somewhere a citizen can actually stand.
  try {
    const snapped = CitizenTiles.snapToWalkableTile(x, y, dest.z ?? 0, 12);
    if (snapped) {
      x = snapped.x;
      y = snapped.y;
    }
  } catch {
    // snap is best-effort; never blocks settling
  }
  record.position = { x: Math.round(x), y: Math.round(y), z: dest.z ?? 0 };
  try {
    record.arrived = {
      kind: dest.kind ?? null,
      placeId: dest.placeId ?? null,
      x: record.position.x,
      y: record.position.y,
      z: record.position.z,
      at: Number.isFinite(now) ? now : Date.now(),
    };
  } catch {
    // the stamp is advisory — arrival never blocks settling
  }
  record.dest = null;
  record.enRoute = null;
  noteVisit(record, dest, now);
}

/** Advance record.position toward dest: arrive, or go en-route for long hauls. */
function advance(record, dest, now) {
  const p = record.position;
  const dist = cheby(p.x, p.y, dest.x, dest.y);
  if (dist <= ARRIVE_RADIUS) {
    settle(record, dest, now);
    return;
  }
  // Resume an in-progress long haul.
  const en = record.enRoute;
  if (en && en.arriveAt > now && Number.isFinite(en.arriveAt)) {
    const total = en.arriveAt - en.departAt;
    if (total > 0) {
      const t = Math.min(1, Math.max(0, (now - en.departAt) / total));
      p.x = Math.round(en.from.x + (en.to.x - en.from.x) * t);
      p.y = Math.round(en.from.y + (en.to.y - en.from.y) * t);
      p.z = en.from.z ?? 0;
      return;
    }
  }
  record.enRoute = null;
  if (dist <= WALK_TILES_PER_TICK) {
    // Human walking speed covers this inside one slow tick — arrive now.
    settle(record, dest, now);
    return;
  }
  // Long haul: interpolate at walking speed across multiple slow ticks, so
  // the traveler is really on the road when they materialize.
  const durationMs = Math.round((dist / WALK_TILES_PER_MIN) * 60 * 1000);
  record.enRoute = {
    from: { x: p.x, y: p.y, z: p.z ?? 0 },
    to: { x: dest.x, y: dest.y, z: dest.z ?? 0 },
    departAt: now,
    arriveAt: now + durationMs,
  };
}

function stepRecord(director, record, now) {
  if (!record || !record.username) return;
  if (isOnline(director, record)) return; // the live engine owns them
  if (isAsleep(record, now)) return; // sleeping citizens stay put
  if (hasJourney(record)) return; // CitizenTravel owns journeys
  if (record.caravanDuty) return; // the caravan walk owns them

  if (
    !record.position ||
    !Number.isFinite(record.position.x) ||
    !Number.isFinite(record.position.y)
  ) {
    const home = record.home ?? { x: 3200, y: 3200, z: 0 };
    record.position = {
      x: Math.round(home.x),
      y: Math.round(home.y),
      z: home.z ?? 0,
    };
  }

  let dest = record.dest;
  // Inter-kingdom visit lifecycle (slice 3): matured visits become
  // relocations or end with a trip home, before the next pick.
  maybeMatureVisit(director, record, now);
  dest = record.dest;
  if (!destValid(dest) || arrivedAt(record, dest, ARRIVE_RADIUS)) {
    dest = pickDestination(record, now);
    record.dest = dest;
    record.enRoute = null;
    journalTrip(record, dest);
  }
  advance(record, dest, now);
}

/**
 * The slow-tick entry point. Advances every eligible offline citizen.
 * Never throws — the director wraps in try/catch anyway.
 */
function tickWhereabouts(director, nowMs) {
  const now = nowMs ?? Date.now();
  for (const record of rosterRecords(director)) {
    try {
      stepRecord(director, record, now);
    } catch {
      // one broken record never stalls the roster
    }
  }
}

module.exports = {
  tickWhereabouts,
  // Slice-3 visit/relocation surface (exported for tests):
  applyRelocation,
  visitLengthFor,
  visitExpired,
  maybeMatureVisit,
  VISIT_MIN_MS,
  VISIT_MAX_MS,
};
