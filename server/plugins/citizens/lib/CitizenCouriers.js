"use strict";

/**
 * CitizenCouriers — the private delivery underworld: pigeon keepers, parcel
 * runners, letter carriers and message runners-for-hire.
 *
 * WHAT IT DOES (data tier, free):
 *   Every courier citizen gets a hash-stable courier type. Per-day delivery
 *   runs (pickup, drop-off, cargo) are derived from date + hash — zero disk
 *   state. Carrier-pigeon flights are scheduled the same way, with a
 *   deterministic weather gate. Player-hired deliveries and pigeon messages
 *   live in in-memory ledgers (7-day TTL, pruned). Couriers overhear where
 *   private messages are bound and gossip about it; the juicy bits are
 *   seeded into CitizenRumors (lazy require, best-effort). Everything is
 *   journaled so the LLM mouth can riff on it later
 *   ("your parcel reached the Varrock tanner at noon").
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players):
 *   Couriers sprint past with delivery callouts, offer their services at
 *   street corners, and announce arrivals. Pigeon keepers release birds with
 *   fanfare as the crowd moment. The work is journaled once per loop.
 *
 * Zero LLM: every line is scripted from pools; the LLM mouth only reads
 * the journal and the public data API (hireCourier, hireFor,
 * sendPigeonMessage, pigeonFor, trackOfficialPost).
 *
 * NO OVERLAP with CitizenMessengers: messengers own the OFFICIAL post —
 * post offices, scheduled routes, proclamations. Couriers are the private
 * side — hand-to-hand notes, freelance parcel running, errands and carrier
 * pigeons, hired off the street, not at a counter. trackOfficialPost is a
 * thin read-only bridge to the messengers' real letterFor so a courier can
 * tell a player where their official mail got to.
 *
 * Wired into the director tick in tickProximity(), right after the menders
 * block. Plain-node testable: CitizenCouriers.test.js.
 */

// === Tuning: all magic numbers here ===
const COURIER_RADIUS = 14; // tiles — a real player must be near to see/hear
const DELIVERY_COOLDOWN_MS = 3 * 60 * 60 * 1000; // a courier runs at most this often
const PIGEON_COOLDOWN_MS = 4 * 60 * 60 * 1000; // a pigeon keeper flies at most this often
const PIGEON_FANFARE_COOLDOWN_MS = 6 * 60 * 60 * 1000; // the release fanfare crowd moment
const DELIVERY_HOUR_START = 7; // street couriers work 07:00-19:00 server time
const DELIVERY_HOUR_END = 19;
const PIGEON_HOUR_START = 6; // pigeons fly 06:00-18:00 server time
const PIGEON_HOUR_END = 18;
const HIRE_LEDGER_TTL_MS = 7 * 24 * 60 * 60 * 1000; // hired deliveries linger a week
const COURIER_CHANCE = 0.45; // ~45% of commoners take courier work (activity system)
const INTERCEPT_CHANCE = 0.08; // ~8% of runs yield overheard gossip
const COURIER_TYPES = Object.freeze([
  "pigeon_keeper", // 30% — carrier-pigeon loft, private bird messages
  "parcel_runner", // 30% — freelance foot-runners, packages and errands
  "letter_carrier", // 25% — private hand-delivered notes (off the official post)
  "message_runner", // 15% — urgent dispatches, fastest feet in town
]);
const TYPE_WEIGHTS = Object.freeze([30, 30, 25, 15]);

// === Cooldown state ===
const lastFiredByCitizen = new Map(); // username -> timestamp
const lastPigeonFanfareByCitizen = new Map(); // username -> timestamp

// Memory-leak plug: prune entries older than a day, at most hourly.
let lastPruneAt = 0;
function pruneCooldowns(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, at] of lastFiredByCitizen) {
    if (at < cutoff) lastFiredByCitizen.delete(k);
  }
  for (const [k, at] of lastPigeonFanfareByCitizen) {
    if (at < cutoff) lastPigeonFanfareByCitizen.delete(k);
  }
}

// === Player ledgers (7-day TTL) ===
const hires = new Map(); // normPlayerName -> { hire }
const pigeonMsgs = new Map(); // normPlayerName -> { msg }

let lastLedgerPruneAt = 0;
function pruneLedgers(nowMs) {
  if (nowMs - lastLedgerPruneAt < 3600 * 1000) return;
  lastLedgerPruneAt = nowMs;
  for (const [k, v] of hires) {
    if (v.until <= nowMs) hires.delete(k);
  }
  for (const [k, v] of pigeonMsgs) {
    if (v.until <= nowMs) pigeonMsgs.delete(k);
  }
}

// ============================================================================
// Pure helpers — testable with plain node, no engine.
// ============================================================================

/** FNV-1a hash, 32-bit. */
function fnv1a(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function normalizeName(name) {
  return String(name ?? "").trim().toLowerCase();
}

/** Deterministic pick from an array using an injected rng. */
function pickOne(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

/** True only for real human players (not bots, not logged-out). */
function isRealPlayer(player) {
  if (!player) return false;
  try {
    if (player.isPlayerBot?.() === true) return false;
    if (player.getHostAddress?.() === "bot") return false;
    return typeof player.getUsername === "function";
  } catch {
    return false;
  }
}

/** Cheap Chebyshev distance check (same plane). */
function withinTiles(a, b, radius) {
  try {
    const la = a.getLocation?.();
    const lb = b.getLocation?.();
    if (!la || !lb || la.getZ() !== lb.getZ()) return false;
    return Math.max(Math.abs(la.getX() - lb.getX()), Math.abs(la.getY() - lb.getY())) <= radius;
  } catch {
    return false;
  }
}

/** Substitute {tokens} in a line template. */
function fillLine(line, vars) {
  return String(line).replace(/\{(\w+)\}/g, (m, k) =>
    vars[k] !== undefined ? String(vars[k]) : m
  );
}

// ============================================================================
// Courier identity — hash-derived, stable across restarts, no storage.
// ACTIVITY SYSTEM: no professional exclusions — any commoner may courier.
// ============================================================================

function courierTypeFromRoll(roll) {
  let acc = 0;
  for (let i = 0; i < TYPE_WEIGHTS.length; i++) {
    acc += TYPE_WEIGHTS[i];
    if (roll < acc) return COURIER_TYPES[i];
  }
  return COURIER_TYPES[COURIER_TYPES.length - 1];
}

function courierTypeFor(username) {
  const name = normalizeName(username);
  if (!name) return null;
  const h = fnv1a("courier:" + name);
  if ((h % 100) / 100 >= COURIER_CHANCE) return null;
  return courierTypeFromRoll(fnv1a("couriertype:" + name) % 100);
}

function isCourier(record) {
  try {
    const role = record?.role ?? record?.attributes?.role;
    if (role && role !== "commoner" && role !== "COMMONER") return null;
    return courierTypeFor(record?.username);
  } catch {
    return null;
  }
}

// ============================================================================
// Data tier: per-day runs, pigeon flights, schedules. All deterministic,
// derived from date + username hash. Zero storage.
// ============================================================================

const PICKUP_POINTS = Object.freeze([
  "the market square",
  "the tavern door",
  "the city gate",
  "the docks",
  "the temple steps",
  "the baker's stall",
  "the smithy's yard",
  "the fountain",
]);

const CARGOS = Object.freeze([
  "a sealed letter",
  "a small parcel",
  "a bundle of cloth",
  "a basket of bread",
  "a stack of invoices",
  "a medicine satchel",
  "a repaired boot",
  "a bottle of ink",
]);

const LOFT_NAMES = Object.freeze([
  "the rooftop loft",
  "the church-tower coop",
  "the mill loft",
  "the old dovecote",
]);

/** Per-day delivery run for a courier. Deterministic from date + username. */
function runFor(username, dateMs) {
  const name = normalizeName(username);
  const d = new Date(dateMs);
  const dayKey = d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate();
  const h = (salt) => fnv1a("courierrun:" + salt + ":" + name + ":" + dayKey);
  const type = courierTypeFor(name);
  return {
    pickup: PICKUP_POINTS[h("p") % PICKUP_POINTS.length],
    cargo: CARGOS[h("c") % CARGOS.length],
    legs: 1 + (h("l") % 3), // 1-3 deliveries today
    urgent: type === "message_runner" || h("u") % 100 < 20,
    loft: LOFT_NAMES[h("f") % LOFT_NAMES.length],
  };
}

/** Carrier-pigeon flight for a pigeon keeper today. Deterministic. */
function pigeonFlightFor(username, dateMs) {
  const name = normalizeName(username);
  const d = new Date(dateMs);
  const dayKey = d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate();
  const h = (salt) => fnv1a("pigeon:" + salt + ":" + name + ":" + dayKey);
  const bird = ["Swift", "Dart", "Feather", "Storm", "Cloud", "Pip"][h("b") % 6];
  // Deterministic "weather" gate — rain grounds the birds.
  const rainChance = h("w") % 100;
  const grounded = rainChance < 25;
  return {
    bird,
    loft: LOFT_NAMES[h("f") % LOFT_NAMES.length],
    destination: ["Varrock", "Falador", "Ardougne", "the coast", "Lumbridge"][h("d") % 5],
    grounded,
    intercepted: h("i") % 100 < INTERCEPT_CHANCE * 100,
  };
}

/** Street-courier working hours (server-local). */
function inDeliveryHours(dateMs) {
  const h = new Date(dateMs).getHours();
  return h >= DELIVERY_HOUR_START && h < DELIVERY_HOUR_END;
}

function inPigeonHours(dateMs) {
  const h = new Date(dateMs).getHours();
  return h >= PIGEON_HOUR_START && h < PIGEON_HOUR_END;
}

// ============================================================================
// Player ledgers — hired deliveries and pigeon messages (7-day TTL).
// The LLM dialogue tier performs these using the data-tier state.
// ============================================================================

/**
 * Hire a courier for a private delivery.
 * kind: "letter" | "parcel" | "errand" | "urgent"
 */
function hireCourier(playerName, courierName, kind, note, nowMs) {
  pruneLedgers(nowMs);
  const p = normalizeName(playerName);
  const c = normalizeName(courierName);
  if (!p || !c) return false;
  const k = String(kind || "parcel");
  const durationMs = k === "urgent" ? 30 * 60 * 1000 : 3 * 60 * 60 * 1000;
  hires.set(p, {
    hire: {
      player: String(playerName),
      courier: String(courierName),
      kind: k,
      note: String(note || "").slice(0, 140),
      hiredAt: nowMs,
      durationMs,
      until: nowMs + HIRE_LEDGER_TTL_MS,
    },
  });
  return true;
}

/** The player's outstanding hired delivery, or null. */
function hireFor(playerName, nowMs) {
  pruneLedgers(nowMs);
  const e = hires.get(normalizeName(playerName));
  return e && e.hire.until > nowMs ? { ...e.hire } : null;
}

/** Deterministic delivery status from elapsed time. */
function deliveryStatus(hire, nowMs) {
  if (!hire) return "none";
  const elapsed = nowMs - hire.hiredAt;
  if (elapsed < 0) return "booked";
  if (elapsed < hire.durationMs * 0.25) return "picked up";
  if (elapsed < hire.durationMs) return "en route";
  return "delivered";
}

/**
 * Send a private message by carrier pigeon.
 * Pigeons are the fastest private channel but weather can ground them.
 */
function sendPigeonMessage(playerName, toKingdom, text, nowMs) {
  pruneLedgers(nowMs);
  const p = normalizeName(playerName);
  if (!p) return false;
  pigeonMsgs.set(p, {
    msg: {
      player: String(playerName),
      to: String(toKingdom || "a far kingdom").slice(0, 60),
      text: String(text || "").slice(0, 140),
      sentAt: nowMs,
      until: nowMs + HIRE_LEDGER_TTL_MS,
    },
  });
  return true;
}

/** The player's outstanding pigeon message, or null. */
function pigeonFor(playerName, nowMs) {
  pruneLedgers(nowMs);
  const e = pigeonMsgs.get(normalizeName(playerName));
  return e && e.msg.until > nowMs ? { ...e.msg } : null;
}

/** Reset all in-memory state (tests). */
function _resetState() {
  hires.clear();
  pigeonMsgs.clear();
  lastFiredByCitizen.clear();
  lastPigeonFanfareByCitizen.clear();
  lastPruneAt = 0;
  lastLedgerPruneAt = 0;
}

// --- Lazy bridge to CitizenMessengers (official post) ---
let _letterFor = null;
function letterForFn() {
  if (_letterFor !== null) return _letterFor;
  try {
    _letterFor = require("./CitizenMessengers").letterFor || false;
  } catch {
    _letterFor = false;
  }
  return _letterFor;
}

/**
 * Read-only bridge: where did the player's OFFICIAL mail get to?
 * Couriers know the postmaster, so they can check for you. Returns the
 * messengers' letterFor payload, or null. Never throws.
 */
function trackOfficialPost(playerName, nowMs) {
  try {
    const fn = letterForFn();
    if (!fn) return null;
    return fn(playerName, nowMs);
  } catch {
    return null;
  }
}

// --- Journal + rumor access (lazy require — may not load in tests) ---
let _journalEvent = null;
function journalEvent() {
  if (_journalEvent !== null) return _journalEvent;
  try {
    _journalEvent = require("./CitizenJournal").getJournal() || false;
  } catch {
    _journalEvent = false;
  }
  return _journalEvent;
}

let _seedRumor = null;
function seedRumorFn() {
  if (_seedRumor !== null) return _seedRumor;
  try {
    _seedRumor = require("./CitizenRumors").seedRumor || false;
  } catch {
    _seedRumor = false;
  }
  return _seedRumor;
}

/** Best-effort journal write; never throws. */
function journalize(citizen, text) {
  try {
    const j = journalEvent();
    const name = citizen?.getUsername?.() ?? citizen?.username;
    if (j && name) j.addEntry?.(name, text);
  } catch { /* cosmetic */ }
}

/** Best-effort rumor seed; never throws. */
function seedRumor(text) {
  try {
    const fn = seedRumorFn();
    if (fn) fn(text);
  } catch { /* cosmetic */ }
}

// ============================================================================
// Interaction tier — scripted lines, zero LLM.
// ============================================================================

const RUNBY_LINES = Object.freeze([
  "Out of the way — message coming through!",
  "Delivery for the {pickup}, make way!",
  "Late already... why do I always take the long jobs...",
  "One more drop and I'm done for the day.",
  "If it's not nailed down, I've probably delivered it.",
]);

const HIRE_LINES = Object.freeze([
  "Need something carried? I'm quick and I keep my mouth shut.",
  "Parcel, letter, urgent word — I run it all, friend.",
  "Cheaper than the post office and twice as fast. Probably.",
  "I've got legs and I've got time. What's the job?",
]);

const DELIVERY_LINES = Object.freeze([
  "Delivered! {cargo} at the {pickup}, safe and sound.",
  "That's the {cargo} dropped off. Told you I was quick.",
  "One {cargo} delivered. Anything else need running?",
]);

const PIGEON_RELEASE_LINES = Object.freeze([
  "Fly, {bird}, fly! {destination} awaits!",
  "There she goes — {bird} is off to {destination}!",
  "Another message on the wing. {bird} never misses.",
]);

const PIGEON_GROUNDED_LINES = Object.freeze([
  "Rain's grounded the birds. {bird} stays home today.",
  "No flying in this weather — the pigeons refuse, and honestly, so do I.",
]);

const OVERHEARD_LINES = Object.freeze([
  "Heard a whisper — a message bound for {destination} changed hands at the {pickup}.",
  "Word is someone paid double for a sealed letter to {destination}.",
]);

// ============================================================================
// The tick function — called from the director tick.
// Gate order: cooldown (cheapest) -> courier identity -> citizen exists ->
// hours -> real player near -> work.
// ============================================================================

/**
 * @param {object} director - the CitizenDirector instance
 * @param {number} nowMs - Date.now()
 */
function tickCouriers(director, nowMs) {
  pruneCooldowns(nowMs);
  try {
    for (const record of director.roster?.values?.() ?? []) {
      // 1. Courier identity gate (cheap hash lookup)
      const type = isCourier(record);
      if (!type) continue;

      // 2. Cooldown gate — O(1), skips almost everyone
      const cd = type === "pigeon_keeper" ? PIGEON_COOLDOWN_MS : DELIVERY_COOLDOWN_MS;
      const last = lastFiredByCitizen.get(record.username) || 0;
      if (nowMs - last < cd) continue;

      // 3. Citizen must be materialized (near a player already)
      const citizen = director.playerFor?.(record);
      if (!citizen) continue;

      // 4. Working hours
      const hoursOk = type === "pigeon_keeper" ? inPigeonHours(nowMs) : inDeliveryHours(nowMs);
      if (!hoursOk) continue;

      // 5. A real player must be within earshot/eyeshot
      if (!anyRealPlayerNear(director, citizen, COURIER_RADIUS)) continue;

      // 6. Do the thing (scripted, zero LLM)
      doCourierLoop(director, record, citizen, type, nowMs);
      lastFiredByCitizen.set(record.username, nowMs);
    }
  } catch (e) {
    // Never crash the director tick.
    console.warn("[citizen-couriers] tick failed:", e?.message ?? e);
  }
}

function doCourierLoop(director, record, citizen, type, nowMs) {
  const rng = Math.random;
  const run = runFor(record.username, nowMs);
  try {
    if (type === "pigeon_keeper") {
      doPigeonKeeper(director, record, citizen, run, nowMs);
    } else if (type === "parcel_runner") {
      const line = rng() < 0.5 ? pickOne(rng, RUNBY_LINES) : pickOne(rng, HIRE_LINES);
      citizen.forceChat?.(fillLine(line, run));
      journalize(citizen, "ran parcels through the city");
    } else if (type === "letter_carrier") {
      const line = rng() < 0.5 ? pickOne(rng, DELIVERY_LINES) : pickOne(rng, HIRE_LINES);
      citizen.forceChat?.(fillLine(line, run));
      journalize(citizen, "delivered private letters by hand");
    } else {
      // message_runner — urgent dispatches
      citizen.forceChat?.(fillLine(pickOne(rng, RUNBY_LINES), run));
      journalize(citizen, "sprinted an urgent dispatch across town");
    }

    // Couriers overhear things — the juicy bits become rumors.
    const flight = pigeonFlightFor(record.username, nowMs);
    if ((flight.intercepted || fnv1a("intercept:" + normalizeName(record.username) + ":" + nowMs) % 100 < INTERCEPT_CHANCE * 100) && inDeliveryHours(nowMs)) {
      seedRumor(fillLine(pickOne(Math.random, OVERHEARD_LINES), {
        destination: flight.destination,
        pickup: run.pickup,
      }));
    }
  } catch { /* never crash */ }
}

function doPigeonKeeper(director, record, citizen, run, nowMs) {
  const flight = pigeonFlightFor(record.username, nowMs);
  const rng = Math.random;
  if (flight.grounded) {
    citizen.forceChat?.(fillLine(pickOne(rng, PIGEON_GROUNDED_LINES), flight));
    journalize(citizen, "kept the pigeons grounded in the rain");
    return;
  }
  const last = lastPigeonFanfareByCitizen.get(record.username) || 0;
  if (nowMs - last >= PIGEON_FANFARE_COOLDOWN_MS && rng() < 0.5) {
    // Crowd moment: the release fanfare.
    citizen.forceChat?.(fillLine(pickOne(rng, PIGEON_RELEASE_LINES), flight));
    journalize(citizen, `released ${flight.bird} with a message for ${flight.destination}`);
    seedRumor(`${flight.bird}, a carrier pigeon from ${run.loft}, was seen winging toward ${flight.destination}.`);
    lastPigeonFanfareByCitizen.set(record.username, nowMs);
  } else {
    citizen.forceChat?.("Pigeons fed, wings checked. Who needs a message flown?");
    journalize(citizen, "tended the carrier pigeons");
  }
}

/** True if any real (non-bot) player is within radius tiles of the citizen. */
function anyRealPlayerNear(director, citizen, radius) {
  try {
    const players = director.onlinePlayers?.() ?? [];
    for (const p of players) {
      if (!isRealPlayer(p)) continue;
      if (withinTiles(citizen, p, radius)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

module.exports = {
  tickCouriers,
  // Player-facing data API (LLM dialogue tier):
  hireCourier,
  hireFor,
  deliveryStatus,
  sendPigeonMessage,
  pigeonFor,
  trackOfficialPost,
  // Export pure helpers for tests:
  pickOne,
  fillLine,
  isRealPlayer,
  withinTiles,
  fnv1a,
  normalizeName,
  courierTypeFor,
  courierTypeFromRoll,
  isCourier,
  runFor,
  pigeonFlightFor,
  inDeliveryHours,
  inPigeonHours,
  _resetState,
  // Tuning (tests pin the documented behavior):
  COURIER_RADIUS,
  DELIVERY_COOLDOWN_MS,
  PIGEON_COOLDOWN_MS,
  PIGEON_FANFARE_COOLDOWN_MS,
  DELIVERY_HOUR_START,
  DELIVERY_HOUR_END,
  PIGEON_HOUR_START,
  PIGEON_HOUR_END,
  HIRE_LEDGER_TTL_MS,
  COURIER_CHANCE,
  INTERCEPT_CHANCE,
  // Data (non-empty checks):
  COURIER_TYPES,
  TYPE_WEIGHTS,
  PICKUP_POINTS,
  CARGOS,
  LOFT_NAMES,
  // Line pools (non-empty checks):
  RUNBY_LINES,
  HIRE_LINES,
  DELIVERY_LINES,
  PIGEON_RELEASE_LINES,
  PIGEON_GROUNDED_LINES,
  OVERHEARD_LINES,
};
