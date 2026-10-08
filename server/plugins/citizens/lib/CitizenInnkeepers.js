"use strict";

/**
 * CitizenInnkeepers — innkeeper citizens who run the inns: lodging, stables,
 * food, and a warm hearth for travelers.
 *
 * WHAT IT DOES (data tier, free):
 *   Every kingdom gets named inns with a room registry. Guests check in at
 *   dusk and out at dawn (derived per-day from hashes — no storage); regulars
 *   have favorite rooms and return on a rhythm. The inn's meal of the day is
 *   read from CitizenCooks' real tables (lazy require, fallback); innkeepers
 *   seed rumors into CitizenRumors so the "heard it at the inn" fiction is
 *   real. Player lodging is a small in-memory ledger (rentRoom / checkOut).
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players):
 *   Hosts greet arrivals with scripted welcome lines and room offers,
 *   stablehands offer stabling, cooks hawk the inn's meal, bards sing
 *   scripted evening verses. Check-ins and room rentals are journaled so
 *   the LLM tier can answer "is there a room free?" truthfully.
 *
 * Zero LLM: every forceChat line comes from the curated pools below.
 *
 * Integration: CitizenCooks (mealOfTheDayFor), CitizenRumors (seedRumor),
 * CitizenTavernGames (inns are the game-night venue; this module owns the
 * lodging, that one owns the games — no overlap).
 *
 * Wired into tickProximity() right after the bankers block. Plain-node
 * testable: CitizenInnkeepers.test.js.
 */

// === Tuning: all magic numbers here ===
const INN_RADIUS = 14; // tiles — close enough to see/hear
const INN_CITIZEN_COOLDOWN_MS = 3 * 60 * 60 * 1000; // an innkeeper fires at most every 3h
const INN_OFFER_COOLDOWN_MS = 60 * 60 * 1000; // room/stable offers at most hourly per citizen
const INN_CHANCE = 0.35; // per eligible citizen per ~60s tick

// === Cooldown state ===
const lastFiredByCitizen = new Map(); // username -> timestamp
const lastOfferByCitizen = new Map(); // username -> timestamp

// Memory-leak plug: prune entries older than a day, at most hourly.
let lastPruneAt = 0;
function pruneCooldowns(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, at] of lastFiredByCitizen) {
    if (at < cutoff) lastFiredByCitizen.delete(k);
  }
  for (const [k, at] of lastOfferByCitizen) {
    if (at < cutoff) lastOfferByCitizen.delete(k);
  }
}

// ============================================================================
// Pure helpers — testable with plain node, no engine.
// ============================================================================

/** FNV-1a 32-bit hash, hex string. Deterministic across restarts. */
function hashStr(s) {
  let h = 0x811c9dc5;
  const str = String(s ?? "");
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/** Deterministic 0..1 from one or more seed strings. */
function hashChance(...parts) {
  const h = parseInt(hashStr(parts.join("|")), 16);
  return (h % 100000) / 100000;
}

/** Deterministic pick from an array using an injected rng. */
function pickOne(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

/** Materialized citizen bot for a roster record, or null when offline. */
function materializedBot(director, record) {
  try {
    if (!director?.isOnline?.(record)) return null;
    return director.getBot?.(record) ?? null;
  } catch {
    return null;
  }
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

// === Innkeeper types ===
const INN_TYPES = ["host", "cook", "stablehand", "bard"];
const INN_TYPE_WEIGHTS = { host: 0.3, cook: 0.3, stablehand: 0.2, bard: 0.2 };

/** Hash-derived innkeeper type for a username (~35% of commoners are innkeepers). */
function innTypeFor(username) {
  // Primary-profession partition: exactly one early profession per citizen.
  const { primaryProfessionFor } = require("./CitizenPrimaryProfession");
  if (primaryProfessionFor(username) !== "innkeeper") return null;
  const r = hashChance("inntype", username);
  let acc = 0;
  for (const t of INN_TYPES) {
    acc += INN_TYPE_WEIGHTS[t];
    if (r < acc) return t;
  }
  return "host";
}

// === Inns ===
const INNS = [
  { name: "the Blue Moon Inn", kingdom: "varrock", rooms: 8, tier: "city" },
  { name: "the Jolly Boar Inn", kingdom: "varrock", rooms: 5, tier: "city" },
  { name: "the Rising Sun Inn", kingdom: "asgarnia", rooms: 7, tier: "city" },
  { name: "the Rusty Anchor Inn", kingdom: "kandarin", rooms: 6, tier: "port" },
  { name: "the Dead Man's Chest", kingdom: "kandarin", rooms: 5, tier: "port" },
  { name: "the Gilded Stag", kingdom: "misthalin", rooms: 6, tier: "city" },
  { name: "the Sleeping Dragon", kingdom: "morytania", rooms: 4, tier: "dark" },
  { name: "the Deep Hearth", kingdom: "keldagrim", rooms: 6, tier: "deep" },
  { name: "the Prancing Wyvern", kingdom: "asgarnia", rooms: 5, tier: "city" },
  { name: "the Wayfarer's Rest", kingdom: "misthalin", rooms: 4, tier: "village" },
];

/** Inn assignment: prefers the citizen's kingdom, falls back to any inn. */
function innFor(username, kingdom) {
  const k = String(kingdom ?? "").toLowerCase();
  const local = INNS.filter((i) => i.kingdom === k);
  const pool = local.length ? local : INNS;
  return pool[parseInt(hashStr(`inn|${username}`), 16) % pool.length];
}

// === Rooms (data tier, derived per-day) ===
function dayKey(dateMs) {
  return new Date(dateMs).toISOString().slice(0, 10);
}

/**
 * Room registry for an inn on a given day: which rooms are occupied and by
 * whom (regulars have favorite rooms). Derived from hashes — zero storage.
 */
function roomsFor(inn, dateMs) {
  const day = dayKey(dateMs);
  const rooms = [];
  for (let n = 1; n <= inn.rooms; n++) {
    const r = hashChance("room", inn.name, day, n);
    const occupied = r < 0.55; // inns run a bit over half full
    rooms.push({
      number: n,
      occupied,
      // Regulars: ~1 in 4 occupied rooms holds a returning regular.
      regular: occupied && hashChance("regular", inn.name, day, n) < 0.25,
    });
  }
  return rooms;
}

function freeRooms(inn, dateMs) {
  return roomsFor(inn, dateMs).filter((r) => !r.occupied).length;
}

// === Player lodging ledger (in-memory, pruned) ===
const lodgingLedger = new Map(); // playerName -> { inn, room, since }
let lastLedgerPruneAt = 0;

function pruneLedger(nowMs) {
  if (nowMs - lastLedgerPruneAt < 3600 * 1000) return;
  lastLedgerPruneAt = nowMs;
  const cutoff = nowMs - 7 * 24 * 3600 * 1000; // week-long stays max
  for (const [k, v] of lodgingLedger) {
    if (v.since < cutoff) lodgingLedger.delete(k);
  }
}

/** Rent a room for a player. Returns the booking or null if the inn is full. */
function rentRoom(playerName, innName, dateMs = Date.now()) {
  const inn = INNS.find((i) => i.name === innName);
  if (!inn) return null;
  const existing = lodgingLedger.get(playerName);
  if (existing) return existing;
  const free = roomsFor(inn, dateMs).filter((r) => !r.occupied);
  if (!free.length) return null;
  const booking = { inn: inn.name, room: free[0].number, since: dateMs };
  lodgingLedger.set(playerName, booking);
  return booking;
}

function checkOut(playerName) {
  return lodgingLedger.delete(playerName);
}

function bookingFor(playerName) {
  return lodgingLedger.get(playerName) ?? null;
}

// === Meal tie-in (CitizenCooks, lazy) ===
let _cooks = null;
function cooks() {
  if (!_cooks) {
    try {
      _cooks = require("./CitizenCooks");
    } catch {
      _cooks = {};
    }
  }
  return _cooks;
}

function innMealFor(username, kingdom, dateMs) {
  try {
    const m = cooks().mealOfTheDayFor?.(username, kingdom, dateMs);
    if (m && m.meal) return m.meal;
  } catch {
    // fall through
  }
  return "a hearty stew";
}

// === Rumor seeding (CitizenRumors, lazy) ===
let _rumors = null;
function rumors() {
  if (!_rumors) {
    try {
      _rumors = require("./CitizenRumors");
    } catch {
      _rumors = {};
    }
  }
  return _rumors;
}

/** Seed an "heard at the inn" rumor. Best-effort, never throws. */
function seedInnRumor(rng, innName, text) {
  try {
    // Canonical seedRumor shape: (rng, { kind, who, what, where }).
    // Without `what` the seed is silently dropped (CitizenRumors.js:102).
    rumors().seedRumor?.(rng, {
      kind: "inn-talk",
      who: innName,
      what: text,
      where: innName,
    });
  } catch {
    // Rumors are garnish.
  }
}

// === Scripted lines ===
const WELCOME_LINES = [
  "Welcome to {inn}! A room for the night?",
  "Evening, traveler. {inn} has warm beds and warmer stew.",
  "Come in, come in — the fire's lit at {inn}.",
  "You look road-weary. {inn} can fix that.",
  "Welcome! We've {free} rooms free tonight at {inn}.",
];
const ROOM_OFFER_LINES = [
  "A clean room, {price} coins a night — interested?",
  "Room {room} just opened up. Yours for {price} coins.",
  "Stay the night? The beds at {inn} are the softest in the kingdom.",
];
const STABLE_LINES = [
  "I'll see your mount gets grain and a dry stall.",
  "Stables are round the back — I'll take good care of {mount}.",
  "Your horse will eat better than most travelers here.",
];
const MEAL_LINES = [
  "Tonight's meal: {meal}. Fresh from the kitchen!",
  "Sit, sit — we're serving {meal} tonight.",
  "You haven't lived till you've tried our {meal}.",
];
const BARD_VERSES = [
  "Oh, the road is long and the night is deep, but the inn-fire's warm for those who sleep...",
  "A king once slept in room number three, and left his crown for the likes of me...",
  "Drink deep, sing loud, the morning's far — the road can wait, here's to the star...",
  "The dragon's gold, the sailor's sea, all tales are told right here by me...",
];
const CHECKIN_LINES = [
  "Room {room} is yours. Sleep well, traveler.",
  "Here's your key — room {room}, up the stairs.",
];
const CHECKOUT_LINES = [
  "Safe travels! Come back to {inn} any time.",
  "The road is kinder to a rested traveler. Farewell!",
];
const FULL_LINES = [
  "Sorry, friend — we're full up tonight at {inn}.",
  "Not a bed free, I'm afraid. Try back tomorrow.",
];

function fill(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);
}

function welcomeLine(rng, inn, free) {
  return fill(pickOne(rng, WELCOME_LINES), { inn: inn.name, free });
}
function roomOfferLine(rng, inn, room, price) {
  return fill(pickOne(rng, ROOM_OFFER_LINES), { inn: inn.name, room, price });
}
function stableLine(rng) {
  return fill(pickOne(rng, STABLE_LINES), { mount: "your mount" });
}
function mealLine(rng, meal) {
  return fill(pickOne(rng, MEAL_LINES), { meal });
}
function bardVerse(rng) {
  return pickOne(rng, BARD_VERSES);
}
function checkinLine(rng, room) {
  return fill(pickOne(rng, CHECKIN_LINES), { room });
}
function checkoutLine(rng, inn) {
  return fill(pickOne(rng, CHECKOUT_LINES), { inn: inn.name });
}
function fullLine(rng, inn) {
  return fill(pickOne(rng, FULL_LINES), { inn: inn.name });
}

function roomPrice(inn) {
  return inn.tier === "village" ? 10 : inn.tier === "port" ? 15 : inn.tier === "deep" ? 20 : inn.tier === "dark" ? 25 : 12;
}

// === Journal access (lazy require — CitizenJournal may not load in tests) ===
let _journal = null;
function journal() {
  if (!_journal) {
    try {
      _journal = require("./CitizenJournal").getJournal();
    } catch {
      _journal = { log() {} };
    }
  }
  return _journal;
}

function logWork(username, kind, text) {
  try {
    journal().log(username, kind, text);
  } catch {
    // Journal must never break the inn.
  }
}

function forceSay(bot, line) {
  try {
    bot.forceChat?.(String(line).slice(0, 120));
  } catch {
    // Cosmetic only.
  }
}

/** True if any real (non-bot) player is within radius tiles of the citizen. */
function anyRealPlayerNear(director, citizen, radius) {
  void director;
  try {
    const players = citizen?.getLocalPlayers?.() ?? [];
    for (const p of players) {
      if (!isRealPlayer(p)) continue;
      if (withinTiles(citizen, p, radius)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Nearest real player within radius, or null. */
function nearestRealPlayer(director, citizen, radius) {
  void director;
  try {
    const players = citizen?.getLocalPlayers?.() ?? [];
    let best = null;
    let bestD = Infinity;
    for (const p of players) {
      if (!isRealPlayer(p)) continue;
      try {
        const la = citizen.getLocation?.();
        const lb = p.getLocation?.();
        if (!la || !lb || la.getZ() !== lb.getZ()) continue;
        const d = Math.max(Math.abs(la.getX() - lb.getX()), Math.abs(la.getY() - lb.getY()));
        if (d <= radius && d < bestD) {
          best = p;
          bestD = d;
        }
      } catch {
        // skip
      }
    }
    return best;
  } catch {
    return null;
  }
}

/**
 * Decide whether this innkeeper should fire now.
 * Pure: (rng, lastFiredMs, nowMs) => boolean. Test this.
 */
function shouldFire(rng, lastFiredMs, nowMs) {
  if (nowMs - (lastFiredMs || 0) < INN_CITIZEN_COOLDOWN_MS) return false;
  return rng() < INN_CHANCE;
}

function shouldOffer(lastOfferMs, nowMs) {
  return nowMs - (lastOfferMs || 0) >= INN_OFFER_COOLDOWN_MS;
}

// === Hour helpers (server local time) ===
function hourOf(dateMs) {
  return new Date(dateMs).getHours();
}
function isEvening(dateMs) {
  const h = hourOf(dateMs);
  return h >= 17 || h < 5; // inns come alive at dusk
}

// ============================================================================
// The tick function — called from tickProximity().
// Gate order: cooldown (cheapest) → eligible type → materialized → real
// player near → work. Data tier runs free; only the visible layer gates on
// players.
// ============================================================================

/**
 * @param {object} director - the CitizenDirector instance
 * @param {number} nowMs - Date.now()
 * @param {object} [desync] - optional timing-desync gate (unused, kept for
 *   signature parity with sibling modules)
 */
function tickInnkeepers(director, nowMs, desync) {
  void desync;
  pruneCooldowns(nowMs);
  pruneLedger(nowMs);
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Cooldown gate — O(1), skips almost everyone
        const last = lastFiredByCitizen.get(record.username) || 0;
        if (nowMs - last < INN_CITIZEN_COOLDOWN_MS) continue;

        // 2. Eligibility: hash-derived innkeeper type
        const type = innTypeFor(record.username);
        if (!type) continue;

        // 3. Citizen must be materialized (near a player already)
        const citizen = materializedBot(director, record);
        if (!citizen) continue;

        // 4. A real player must be within earshot
        if (!anyRealPlayerNear(director, citizen, INN_RADIUS)) continue;

        // 5. Chance gate + do the work (scripted, zero LLM)
        if (!shouldFire(Math.random, last, nowMs)) continue;
        workInn(director, record, citizen, type, nowMs);
        lastFiredByCitizen.set(record.username, nowMs);
      } catch {
        // Per-citizen: never let one bad record break the loop.
      }
    }
  } catch (e) {
    // Never crash the director tick.
    console.warn("[citizen-innkeepers] tick failed:", e?.message ?? e);
  }
}

function workInn(director, record, citizen, type, nowMs) {
  const kingdom = record.kingdom ?? record[Object.keys(record).find((k) => /kingdom/i.test(k)) ?? ""] ?? "varrock";
  const inn = innFor(record.username, kingdom);
  const free = freeRooms(inn, nowMs);
  const rng = Math.random;

  if (type === "host") {
    const player = nearestRealPlayer(director, citizen, INN_RADIUS);
    const pname = player?.getUsername?.() ?? "traveler";
    const existing = bookingFor(pname);
    if (existing) {
      // Regular guest already has a room: greet them warmly.
      forceSay(citizen, `Welcome back, ${pname}! Room ${existing.room} is just as you left it.`);
    } else if (free > 0 && shouldOffer(lastOfferByCitizen.get(record.username), nowMs)) {
      forceSay(citizen, welcomeLine(rng, inn, free));
      lastOfferByCitizen.set(record.username, nowMs);
      logWork(record.username, "work", `Welcomed ${pname} at ${inn.name} (${free} rooms free).`);
    } else if (free === 0) {
      forceSay(citizen, fullLine(rng, inn));
    } else {
      forceSay(citizen, welcomeLine(rng, inn, free));
    }
    // Hosts seed the occasional inn rumor so "heard it at the inn" is real.
    if (rng() < 0.25) {
      seedInnRumor(rng, inn.name, "a merchant caravan is due through at dawn.");
    }
  } else if (type === "cook") {
    const meal = innMealFor(record.username, kingdom, nowMs);
    forceSay(citizen, mealLine(rng, meal));
    logWork(record.username, "work", `Served ${meal} at ${inn.name}.`);
  } else if (type === "stablehand") {
    if (shouldOffer(lastOfferByCitizen.get(record.username), nowMs)) {
      forceSay(citizen, stableLine(rng));
      lastOfferByCitizen.set(record.username, nowMs);
    } else {
      forceSay(citizen, "Easy there... easy. Good beast.");
    }
    logWork(record.username, "work", `Tended the stables at ${inn.name}.`);
  } else if (type === "bard") {
    if (isEvening(nowMs)) {
      forceSay(citizen, bardVerse(rng));
      logWork(record.username, "work", `Sang the evening set at ${inn.name}.`);
    } else {
      forceSay(citizen, "Evenings are for songs, friend. Come back at dusk.");
    }
  }
}

// === Public API for the LLM dialogue tier (rent/checkout are data, zero LLM) ===

/** Attempt to rent a room for a player at an inn. Returns booking or null. */
function rentRoomFor(playerName, innName, nowMs = Date.now()) {
  const booking = rentRoom(playerName, innName, nowMs);
  if (booking) {
    logWork("innkeeper", "lodging", `${playerName} rented room ${booking.room} at ${booking.inn}.`);
  }
  return booking;
}

/** Check a player out of their room. */
function checkOutOf(playerName) {
  const had = checkOut(playerName);
  if (had) logWork("innkeeper", "lodging", `${playerName} checked out.`);
  return had;
}

/** Read-only view of the inn ledger for the LLM tier. */
function lodgingFor(playerName) {
  return bookingFor(playerName);
}

/** Test seam: clear all state. */
function resetForTests() {
  lastFiredByCitizen.clear();
  lastOfferByCitizen.clear();
  lodgingLedger.clear();
  lastPruneAt = 0;
  lastLedgerPruneAt = 0;
  _journal = null;
  _cooks = null;
  _rumors = null;
}

module.exports = {
  tickInnkeepers,
  // Public API (data tier, zero LLM):
  innTypeFor,
  innFor,
  roomsFor,
  freeRooms,
  rentRoomFor,
  checkOutOf,
  lodgingFor,
  innMealFor,
  seedInnRumor,
  // Pure helpers for tests:
  hashStr,
  hashChance,
  pickOne,
  isRealPlayer,
  withinTiles,
  shouldFire,
  shouldOffer,
  isEvening,
  roomPrice,
  welcomeLine,
  roomOfferLine,
  stableLine,
  mealLine,
  bardVerse,
  checkinLine,
  checkoutLine,
  fullLine,
  // Tuning:
  INN_TYPES,
  INNS,
  INN_RADIUS,
  INN_CITIZEN_COOLDOWN_MS,
  INN_CHANCE,
  // Test seam:
  resetForTests,
};
