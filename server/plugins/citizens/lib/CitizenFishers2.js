"use strict";

/**
 * CitizenFishers2 — the dockside fishing folk: net casters, line anglers,
 * crabbers and community fishmongers who fish the piers and shallows for
 * food, fun and fellowship.
 *
 * WHAT IT DOES (data tier, free):
 *   Hash-derived fisherfolk types, per-day community spots, per-day catches
 *   derived from date + hash, rare big-catch events (~8%/spot/day) seeded
 *   into CitizenRumors, 7-day-TTL player ledgers for fishing alongside,
 *   buying fresh catch and learning techniques.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players,
 * 05:00-20:00 local): scripted casting/mending emotes, catch callouts,
 * big-catch fanfare as the crowd moment, technique-teaching offers,
 * fishmonger stall hawking.
 *
 * NO OVERLAP (by design):
 *   - CitizenFishers owns the PROFESSIONAL trade (deep-sea, river, ice,
 *     pearl diver; commercial spots, weather, hawking their own catch).
 *     Professional fishers are EXCLUDED from fisherfolkTypeOf.
 *   - CitizenFishingTournaments owns the weekly competition (registration,
 *     weigh-in, prizes). This module owns daily dockside life only.
 *   - CitizenSailors own boats — fisherfolk fish from piers, jetties and
 *     shore; no boats here.
 *   - The fishmonger here runs the COMMUNITY stall (donated surplus,
 *     shared catch); professionals hawk their own commercial catch.
 *
 * Zero LLM: all lines from scripted pools; the journal feeds the LLM mouth.
 *
 * Visibility throttle: chance + 3h cooldown (couriers/healers2/watchmen2
 * precedent) — deliberately NO new primary-hobby key, so adding this
 * module does not reshuffle every citizen's primary hobby.
 *
 * Wired into the director tick right after the watchmen block.
 * Plain-node testable: CitizenFishers2.test.js.
 */

const { normalizeName } = require("./CitizenBonds");
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");


// Top-level safeRequire (potters perf lesson): the pro-fisher exclusion
// check runs per citizen per tick, so no lazy requires in that path.
function safeRequire(path) {
  try {
    return require(path);
  } catch {
    return null;
  }
}
const ProFishers = safeRequire("./CitizenFishers");
const CATCHES = (ProFishers && ProFishers.CATCHES) || {
  sea: ["cod", "bass", "mackerel"],
  river: ["trout", "salmon", "pike"],
};

// === Tuning: all magic numbers here ===
const FISHERFOLK_RADIUS = 14; // tiles — close enough to see/hear
const FISHERFOLK_CITIZEN_COOLDOWN_MS = 3 * 60 * 60 * 1000; // a citizen fires at most every 3h
const FISHERFOLK_CHANCE = 0.15; // per eligible citizen per tick
// Nominal share of commoners who fish the docks for food/fun.
const FISHERFOLK_SHARE = 45;
const DAWN_HOUR = 5; // 05:00 local
const DUSK_HOUR = 20; // 20:00 local
// (BIG_CATCH_CHANCE removed 2026-10-08 with the big-catch fabrication.)
const LEDGER_TTL_MS = 7 * 24 * 3600 * 1000;

// === Fisherfolk types ===
const FISHERFOLK_NET = "net caster";
const FISHERFOLK_LINE = "line angler";
const FISHERFOLK_CRAB = "crabber";
const FISHERFOLK_STALL = "fishmonger";
const FISHERFOLK_TYPES = [
  FISHERFOLK_NET,
  FISHERFOLK_LINE,
  FISHERFOLK_CRAB,
  FISHERFOLK_STALL,
];
const FISHERFOLK_WEIGHTS = {
  [FISHERFOLK_NET]: 30,
  [FISHERFOLK_LINE]: 35,
  [FISHERFOLK_CRAB]: 20,
  [FISHERFOLK_STALL]: 15,
};

// === Community spots (piers, jetties, shore — not commercial grounds) ===
const COMMUNITY_SPOTS = [
  { name: "the Varrock river pier", kingdom: "misthalin", kind: "river" },
  { name: "the Lumbridge mill jetty", kingdom: "misthalin", kind: "river" },
  { name: "the Entrana landing jetty", kingdom: "misthalin", kind: "sea" },
  { name: "the Port Sarim south pier", kingdom: "asgarnia", kind: "sea" },
  { name: "the Falador park lake pier", kingdom: "asgarnia", kind: "river" },
  { name: "the Ardougne fishing pier", kingdom: "kandarin", kind: "sea" },
  { name: "the Catherby rock pools", kingdom: "kandarin", kind: "sea" },
  { name: "the Keldagrim thaw pools", kingdom: "keldagrim", kind: "river" },
  { name: "the Darkmeyer still pools", kingdom: "morytania", kind: "river" },
  { name: "the Al Kharid oasis pier", kingdom: "kharidian", kind: "river" },
];

const CRAB_CATCHES = ["crab", "edible crab", "mud crab", "red crab"];

// === Scripted lines ===
const CAST_LINES = {
  [FISHERFOLK_NET]: [
    "Easy... let her settle... NOW!",
  ],
  [FISHERFOLK_LINE]: [
    "Shhh... you'll scare them off.",
  ],
  [FISHERFOLK_CRAB]: [
    "Mind the nippers on that one!",
  ],
  [FISHERFOLK_STALL]: [
    "Fresh as the tide, friend — caught this morning!",
  ],
};

// (CATCH_LINES, BIG_CATCH_LINES, STALL_LINES, SHARE_LINES removed 2026-10-08
// with the catch/big-catch/stall/share fabrication branches.)

const TEACH_LINES = [
  "Fishing's about patience, friend. Watch the water, not the float.",
  "Dawn's the hour — fish bite best when the mist's still on.",
  "Keep your shadow off the water and your hook in the deep.",
  "Crabs like the rocks at low tide. Mind your fingers.",
];

// (STALL_LINES, SHARE_LINES removed 2026-10-08 with the fabrication branches.)

// === Cooldown state ===
const lastFiredByCitizen = new Map(); // username -> timestamp

// Memory-leak plug: prune entries older than a day, at most hourly.
let lastPruneAt = 0;
function pruneCooldowns(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, at] of lastFiredByCitizen) {
    if (at < cutoff) lastFiredByCitizen.delete(k);
  }
}

// === Player ledgers (7-day TTL) ===
const fishAlongLedger = new Map(); // normName -> { with, at }
const buyCatchLedger = new Map(); // normName -> { fish, price, at }
const techniqueLedger = new Map(); // normName -> { tip, at }
let lastLedgerPrune = 0;
function pruneLedgers(nowMs) {
  if (nowMs - lastLedgerPrune < 3600 * 1000) return;
  lastLedgerPrune = nowMs;
  for (const [map] of [[fishAlongLedger], [buyCatchLedger], [techniqueLedger]]) {
    for (const [k, v] of map) {
      if (nowMs - v.at > LEDGER_TTL_MS) map.delete(k);
    }
  }
}

// ============================================================================
// Pure helpers — testable with plain node, no engine.
// ============================================================================

/** FNV-1a 32-bit hash of a string. */
function hashStr(s) {
  s = String(s ?? "");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic pick from an array using an injected rng. */
function pickOne(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

/** Fill {slots} in a template string. */
function fill(template, slots) {
  let out = String(template);
  for (const [k, v] of Object.entries(slots ?? {})) {
    out = out.split("{" + k + "}").join(String(v));
  }
  return out;
}

/** Weighted pick of a fisherfolk type from a 0..99 roll. */
function fisherfolkTypeFromRoll(roll) {
  let acc = 0;
  for (const t of FISHERFOLK_TYPES) {
    acc += FISHERFOLK_WEIGHTS[t];
    if (roll < acc) return t;
  }
  return FISHERFOLK_LINE;
}

/** Cheap rng from a seed (LCG). */
function seededRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Chance check with injected rng. */
function chance(rng, p) {
  return rng() < p;
}

/** Day number since epoch — for daily rhythms. */
function dayNumber(nowMs) {
  return Math.floor(nowMs / 86400000);
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

/** True when the player object is a citizen bot. */
function isCitizenBot(player) {
  try {
    return player?.isPlayerBot?.() === true || player?.getHostAddress?.() === "bot";
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

/** True during fishing hours (05:00-20:00 server-local time). */
function isFishingHour(nowMs) {
  const h = new Date(nowMs).getHours();
  return h >= DAWN_HOUR && h < DUSK_HOUR;
}

// ============================================================================
// Fisherfolk identity — hash-derived, stable across restarts, no storage.
// ============================================================================

/**
 * The fisherfolk type for a roster record, or null.
 * Excludes professional fishers (CitizenFishers owns the trade) so no
 * citizen belongs to both the commercial fishery and the dockside folk.
 * Activity system: any other commoner may fish the piers.
 */
function fisherfolkTypeOf(record) {
  try {
    const role = record?.role ?? record?.attributes?.role;
    if (role && role !== "commoner" && role !== "COMMONER") return null;
    const username = record?.username;
    const name = normalizeName(username);
    if (!name) return null;
    // No overlap: professional fishers own the trade.
    try {
      if (ProFishers && typeof ProFishers.fisherTypeFor === "function" && ProFishers.fisherTypeFor(username)) {
        return null;
      }
    } catch {
      /* pro module absent or threw — treat as non-pro */
    }
    const roll = hashStr("fisherfolk:" + name) % 100;
    if (roll >= FISHERFOLK_SHARE) return null;
    return fisherfolkTypeFromRoll(hashStr("fisherfolktype:" + name) % 100);
  } catch {
    return null;
  }
}

/** Kingdom-preferred community spot, stable across restarts. */
function spotFor(record) {
  const kid = record?.kingdomId;
  const local = COMMUNITY_SPOTS.filter((s) => s.kingdom === kid);
  const pool = local.length ? local : COMMUNITY_SPOTS;
  const name = normalizeName(record?.username) || "anon";
  return pool[hashStr("fisherfolkspot:" + name) % pool.length];
}

/** The catch pool for a fisherfolk type at a spot kind. */
function catchPoolFor(type, kind) {
  if (type === FISHERFOLK_CRAB) return CRAB_CATCHES;
  const pool = CATCHES[kind];
  if (Array.isArray(pool) && pool.length) return pool;
  return CATCHES.river || [];
}

// (Hash-derived "today's catch", big-catch fanfare, and dockside prices
// removed 2026-10-08: the citizen never actually caught those fish, so
// deriving them from date+hash and speaking/journalizing them was
// fabrication. catchPoolFor remains as honest data: which fish CAN be
// caught at a spot type.)

// ============================================================================
// Player ledgers (data tier, zero LLM) — exported for the LLM dialogue tier.
// ============================================================================

/** Record that a player fished alongside a fisherfolk citizen. */
function fishAlongside(playerName, fisherName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name || !fisherName) return null;
  pruneLedgers(nowMs);
  fishAlongLedger.set(name, { with: String(fisherName), at: nowMs });
  return fisherName;
}

/** The fisher a player last fished alongside, or null. */
function fishAlongFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = fishAlongLedger.get(name);
  return rec ? rec.with : null;
}

/** Record that a player bought fresh catch from the community stall. */
function buyCatch(playerName, fish, price, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name || !fish) return null;
  pruneLedgers(nowMs);
  buyCatchLedger.set(name, { fish: String(fish), price: Number(price) || 0, at: nowMs });
  return fish;
}

/** The last catch a player bought, or null. */
function boughtCatchFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = buyCatchLedger.get(name);
  return rec ? { fish: rec.fish, price: rec.price } : null;
}

/** Record that a player learned a fishing technique. */
function learnTechnique(playerName, tip, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name || !tip) return null;
  pruneLedgers(nowMs);
  techniqueLedger.set(name, { tip: String(tip), at: nowMs });
  return tip;
}

/** The last technique a player learned, or null. */
function techniqueFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = techniqueLedger.get(name);
  return rec ? rec.tip : null;
}

// ============================================================================
// Journal + rumor helpers.
// ============================================================================

// === Journal access (lazy require — CitizenJournal may not load in tests) ===
// Canonical: getJournal().log(name, kind, text). The appendEntry/addEntry
// probe pattern is dead — CitizenJournal only exports getJournal() with a
// log() method (fishers rung audit 2026-10-08).
let _journal = null;
function journal() {
  if (_journal === null) {
    try {
      _journal = require("./CitizenJournal").getJournal();
    } catch {
      _journal = false;
    }
  }
  return _journal || null;
}

function journalize(citizenName, text) {
  try {
    journal()?.log(citizenName, "work", text);
  } catch {
    /* journal is best-effort; never break the tick */
  }
}

// (seedBigCatchRumor removed 2026-10-08 with the big-catch fabrication.)

// ============================================================================
// The tick function — called from the director tick.
// Gate order: cooldown (cheapest) → fisherfolk? → materialized → fishing
// hours → real player near → chance → work.
// ============================================================================

function tickFisherfolk(director, nowMs, desync = 0) {
  pruneCooldowns(nowMs);
  const now = nowMs + desync * 1000;
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Cooldown gate — O(1), skips almost everyone
        const last = lastFiredByCitizen.get(record.username) || 0;
        if (nowMs - last < FISHERFOLK_CITIZEN_COOLDOWN_MS) continue;

        // 2. Must be dockside fisherfolk (hash-derived, cheap)
        const type = fisherfolkTypeOf(record);
        if (!type) continue;

        // 3. Citizen must be materialized (near a player already)
        const citizen = materializedBot(director, record);
        if (!citizen) continue;

        // 4. Fishing hours only (dawn to dusk, server-local)
        if (!isFishingHour(now)) continue;

        // 5. A real player must be within earshot
        if (!anyRealPlayerNear(director, citizen, FISHERFOLK_RADIUS)) continue;

        // 6. Chance gate
        if (!chance(Math.random, FISHERFOLK_CHANCE)) continue;

        // 7. Do the thing (scripted, zero LLM)
        doFisherfolkWork(director, record, citizen, type, nowMs);
        lastFiredByCitizen.set(record.username, nowMs);
      } catch (e) {
        // Per-citizen: never let one bad record kill the tick.
        console.warn("[citizen-fisherfolk] citizen failed:", e?.message ?? e);
      }
    }
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-fisherfolk] tick failed:", e?.message ?? e);
  }
}

/**
 * The materialized player-bot for a roster record, or null when the citizen
 * isn't online. Canonical director API: isOnline(record) + getBot(record)
 * (CitizenDirector.js:1374/1379). director.playerFor / director.onlinePlayers
 * do NOT exist — never call them (fishers rung audit 2026-10-08).
 */
function materializedBot(director, record) {
  try {
    if (director.isOnline?.(record)) return director.getBot?.(record) ?? null;
    return null;
  } catch {
    return null;
  }
}

/** True if any real (non-bot) player is within radius tiles of the citizen. */
function anyRealPlayerNear(director, citizen, radius) {
  void director;
  try {
    // Try director's realPlayerPositions first (production)
    if (typeof director.realPlayerPositions === 'function') {
      const positions = director.realPlayerPositions();
      const loc = citizen.getLocation?.();
      if (!loc) return false;
      const cx = loc.getX?.() ?? loc.x ?? 0;
      const cy = loc.getY?.() ?? loc.y ?? 0;
      const cz = loc.getZ?.() ?? loc.z ?? 0;
      for (const p of positions) {
        if ((p.z ?? 0) !== cz) continue;
        const d = Math.max(Math.abs((p.x ?? 0) - cx), Math.abs((p.y ?? 0) - cy));
        if (d <= radius) return true;
      }
      return false;
    }
    // Fallback: check roster citizens (for tests)
    const players = [...(director.roster?.values() ?? [])].filter(r => director.isOnline(r)).map(r => director.getBot(r)).filter(Boolean);
    for (const p of players) {
      if (!isRealPlayer(p)) continue;
      if (withinTiles(citizen, p, radius)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function doFisherfolkWork(director, record, citizen, type, nowMs) {
  const spot = spotFor(record);

  // Routine: honest ambient chatter only — casting, teaching, mending.
  // (Hash-derived "today's catch" / big-catch fanfare removed: the citizen
  // never actually caught those fish, so speaking them was fabrication.)
  const roll = Math.random();
  if (roll < 0.5) {
    const line = pickOne(Math.random, CAST_LINES[type]);
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
    journalize(record.username, `fished at ${spot.name}`);
  } else if (roll < 0.75) {
    const line = pickOne(Math.random, TEACH_LINES);
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
    journalize(record.username, `shared fishing wisdom at ${spot.name}`);
  } else {
    const line = pickOne(Math.random, CAST_LINES[type]);
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
    journalize(record.username, `kept fishing at ${spot.name}`);
  }
}

module.exports = {
  tickFisherfolk,
  // Public API (data tier, zero LLM) for the LLM dialogue tier:
  fisherfolkTypeOf,
  spotFor,
  // (catchFor, bigCatchFor, priceFor removed 2026-10-08: hash-fiction.)
  catchPoolFor,
  fishAlongside,
  fishAlongFor,
  buyCatch,
  boughtCatchFor,
  learnTechnique,
  techniqueFor,
  // Pure helpers for tests:
  hashStr,
  pickOne,
  fill,
  fisherfolkTypeFromRoll,
  isRealPlayer,
  isCitizenBot,
  withinTiles,
  isFishingHour,
  dayNumber,
  chance,
  seededRng,
  FISHERFOLK_TYPES,
  FISHERFOLK_NET,
  FISHERFOLK_LINE,
  FISHERFOLK_CRAB,
  FISHERFOLK_STALL,
  COMMUNITY_SPOTS,
  CRAB_CATCHES,
  // Test seam:
  _resetState() {
    lastFiredByCitizen.clear();
    fishAlongLedger.clear();
    buyCatchLedger.clear();
    techniqueLedger.clear();
    lastPruneAt = 0;
    lastLedgerPrune = 0;
  },
};
