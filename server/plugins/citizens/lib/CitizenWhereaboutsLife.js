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
 * Wiring: CitizenDirector calls tickWhereabouts(this, nowMs) in the slow
 * tick inside try/catch. Never throws — every record is guarded.
 */

const { pickDestination, arrivedAt } = require("../brain/CitizenDestinations");
const { agentRng, personalSpot } = require("./humanizer");

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
};
