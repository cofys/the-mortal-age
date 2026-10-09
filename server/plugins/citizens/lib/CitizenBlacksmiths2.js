"use strict";

/**
 * CitizenBlacksmiths2 — the smithfolk: village farriers, blade honers,
 * implement tinkerers and forge apprentices who shoe the village horses,
 * keep the farm blades keen, mend plowshares and learn the trade at the
 * community smithies.
 *
 * WHAT IT DOES (data tier, free):
 *   Hash-derived smithfolk types, per-day community smithies, per-day jobs
 *   derived from date + hash, rare masterwork unveilings (~8%/smithy/day)
 *   seeded into CitizenRumors, 7-day-TTL player ledgers for repair
 *   requests, buying simple iron goods and smithing lessons.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players,
 * 06:00-18:00 local): scripted hammering/shoeing/honing emotes, finished-
 * work callouts, masterwork fanfare as the crowd moment, repair and lesson
 * offers.
 *
 * NO OVERLAP (by design):
 *   - CitizenBlacksmiths owns the PROFESSIONAL trade (weaponsmiths,
 *     armorsmiths, farriers, bladesmiths; the named forges, shifts,
 *     commissions). Professional smiths are EXCLUDED from
 *     smithfolkTypeOf.
 *   - CitizenMenders owns REPAIR of small tools (tinker: hatchet, knife,
 *     saw) and household goods (handyman: kettle, bucket, hinge, latch).
 *     This module's honers MAINTAIN farm blades (scythes, sickles, shears)
 *     and its tinkerers mend FARM IMPLEMENTS (plowshares, harrow teeth,
 *     cart fittings) — different items, documented here.
 *   - Metal names reuse the real METALS table from CitizenBlacksmiths
 *     (static fallback when absent).
 *
 * Zero LLM: all lines from scripted pools; the journal feeds the LLM mouth.
 *
 * Visibility throttle: chance + 3h cooldown (couriers/healers2/watchmen2/
 * fisherfolk/minerfolk/cookfolk precedent) — deliberately NO new
 * primary-hobby key, so adding this module does not reshuffle every
 * citizen's primary hobby.
 *
 * Wired into the director tick right after the cookfolk block.
 * Plain-node testable: CitizenBlacksmiths2.test.js.
 */

const { normalizeName } = require("./CitizenBonds");
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");


// Top-level safeRequire (potters perf lesson): the pro-smith exclusion
// check runs per citizen per tick, so no lazy requires in that path.
function safeRequire(path) {
  try {
    return require(path);
  } catch {
    return null;
  }
}
const ProSmiths = safeRequire("./CitizenBlacksmiths");
const METALS = (ProSmiths && ProSmiths.METALS) || [
  "bronze",
  "iron",
  "steel",
  "mithril",
  "adamant",
  "rune",
];

// === Tuning: all magic numbers here ===
const SMITHFOLK_RADIUS = 14; // tiles — close enough to see/hear
const SMITHFOLK_CITIZEN_COOLDOWN_MS = 3 * 60 * 60 * 1000; // a citizen fires at most every 3h
const SMITHFOLK_CHANCE = 0.15; // per eligible citizen per tick
// Nominal share of commoners who work the village smithies.
const SMITHFOLK_SHARE = 40;
const FORGE_START_HOUR = 6; // 06:00 local
const FORGE_END_HOUR = 18; // 18:00 local
const MASTERWORK_CHANCE = 0.08; // masterwork unveiling, per smithy per day
const LEDGER_TTL_MS = 7 * 24 * 3600 * 1000;

// === Smithfolk types ===
const SMITHFOLK_FARRIER = "village farrier";
const SMITHFOLK_HONER = "blade honer";
const SMITHFOLK_TINKERER = "implement tinkerer";
const SMITHFOLK_APPRENTICE = "forge apprentice";
const SMITHFOLK_TYPES = [
  SMITHFOLK_FARRIER,
  SMITHFOLK_HONER,
  SMITHFOLK_TINKERER,
  SMITHFOLK_APPRENTICE,
];
const SMITHFOLK_WEIGHTS = {
  [SMITHFOLK_FARRIER]: 30,
  [SMITHFOLK_HONER]: 30,
  [SMITHFOLK_TINKERER]: 25,
  [SMITHFOLK_APPRENTICE]: 15,
};

// === Community smithies (village forges — not the pro trade forges) ===
const COMMUNITY_SMITHIES = [
  { name: "the Varrock village smithy", kingdom: "misthalin", kind: "village" },
  { name: "the Lumbridge cartwright's forge", kingdom: "misthalin", kind: "cartwright" },
  { name: "the Draynor stableyard forge", kingdom: "misthalin", kind: "stableyard" },
  { name: "the Rimmington shore smithy", kingdom: "asgarnia", kind: "village" },
  { name: "the Falador farm forge", kingdom: "asgarnia", kind: "farm" },
  { name: "the Ardougne market smithy", kingdom: "kandarin", kind: "market" },
  { name: "the Hemenster dairy forge", kingdom: "kandarin", kind: "farm" },
  { name: "the Keldagrim lower smithy", kingdom: "keldagrim", kind: "village" },
  { name: "the Darkmeyer back-alley forge", kingdom: "morytania", kind: "alley" },
  { name: "the Al Kharid date-farm smithy", kingdom: "kharidian", kind: "farm" },
];

// === Scripted lines ===
const WORK_LINES = {
  [SMITHFOLK_FARRIER]: [
    "Easy now, lad — nearly done.",
  ],
  [SMITHFOLK_HONER]: [
    "She'll cut clean now — mind your fingers.",
  ],
  [SMITHFOLK_TINKERER]: [
    "Cart'll roll true again by supper.",
  ],
  [SMITHFOLK_APPRENTICE]: [
    "One day I'll swing the hammer proper.",
  ],
};

// (DONE_LINES removed 2026-10-08 with fabrication branches.)

// (GOODS_LINES removed 2026-10-08 with fabrication branches.)

const MASTERWORK_LINES = [
  "Behold! {piece} — the finest work to leave {smithy}!",
  "Three days at the anvil — {piece}, and I'd stake my name on it!",
  "{piece}! Come see what a village forge can do!",
];

const REPAIR_LINES = [
  "Bring me your bent and broken iron — I'll set it right.",
  "Plowshares, cart fittings, tired old tools — I mend them all.",
];

const LESSON_LINES = [
  "Want to learn the hammer? Start with the bellows, like I did.",
  "I'll teach you the basics — grip, stance, and respect for hot iron.",
];

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
const repairLedger = new Map(); // normName -> { item, at }
const goodsLedger = new Map(); // normName -> { good, price, at }
const lessonLedger = new Map(); // normName -> { lesson, at }
let lastLedgerPrune = 0;
function pruneLedgers(nowMs) {
  if (nowMs - lastLedgerPrune < 3600 * 1000) return;
  lastLedgerPrune = nowMs;
  for (const map of [repairLedger, goodsLedger, lessonLedger]) {
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

/** Weighted pick of a smithfolk type from a 0..99 roll. */
function smithfolkTypeFromRoll(roll) {
  let acc = 0;
  for (const t of SMITHFOLK_TYPES) {
    acc += SMITHFOLK_WEIGHTS[t];
    if (roll < acc) return t;
  }
  return SMITHFOLK_FARRIER;
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

/** True during forge hours (06:00-18:00 server-local time). */
function isForgeHour(nowMs) {
  const h = new Date(nowMs).getHours();
  return h >= FORGE_START_HOUR && h < FORGE_END_HOUR;
}

// ============================================================================
// Smithfolk identity — hash-derived, stable across restarts, no storage.
// ============================================================================

/**
 * The smithfolk type for a roster record, or null.
 * Excludes professional smiths (CitizenBlacksmiths owns the trade) so no
 * citizen belongs to both the commercial forges and the village smithies.
 * Activity system: any other commoner may work the village forge.
 */
function smithfolkTypeOf(record) {
  try {
    const role = record?.role ?? record?.attributes?.role;
    if (role && role !== "commoner" && role !== "COMMONER") return null;
    const username = record?.username;
    const name = normalizeName(username);
    if (!name) return null;
    // No overlap: professional smiths own the trade.
    try {
      if (ProSmiths && typeof ProSmiths.smithTypeFor === "function" && ProSmiths.smithTypeFor(username)) {
        return null;
      }
    } catch {
      /* pro module absent or threw — treat as non-pro */
    }
    const roll = hashStr("smithfolk:" + name) % 100;
    if (roll >= SMITHFOLK_SHARE) return null;
    // Note: name-first salt avoids FNV-1a correlation with the "smithfolk:"
    // share-gate salt above (shared prefixes correlate badly).
    return smithfolkTypeFromRoll(hashStr(name + "|smithfolk-type") % 100);
  } catch {
    return null;
  }
}

/** Kingdom-preferred community smithy, stable across restarts. */
function smithyFor(record) {
  const kid = record?.kingdomId;
  const local = COMMUNITY_SMITHIES.filter((s) => s.kingdom === kid);
  const pool = local.length ? local : COMMUNITY_SMITHIES;
  const name = normalizeName(record?.username) || "anon";
  return pool[hashStr("smithfolksmithy:" + name) % pool.length];
}

// (metalForToday removed 2026-10-08: hash-derived fabrication, no production callers.)

// === Per-type job pools ===
const FARRIER_JOBS = [
  "a set of four shoes",
  "a pony's front pair",
  "a draft horse's hind shoes",
  "a loose shoe, reset proper",
];
const HONER_JOBS = [
  "a scythe, honed keen",
  "a pair of shears, edged true",
  "a sickle, sharp as spite",
  "a hedge bill, ground fine",
];
const TINKERER_JOBS = [
  "a plowshare, straightened and edged",
  "a harrow tooth, reforged",
  "a set of cart fittings",
  "a wagon tire, shrunk on hot",
];
const APPRENTICE_JOBS = [
  "a bundle of nails",
  "a bucket of coal, fetched",
  "the forge floor, swept clean",
  "the bellows, pumped steady",
];
const JOB_POOLS = {
  [SMITHFOLK_FARRIER]: FARRIER_JOBS,
  [SMITHFOLK_HONER]: HONER_JOBS,
  [SMITHFOLK_TINKERER]: TINKERER_JOBS,
  [SMITHFOLK_APPRENTICE]: APPRENTICE_JOBS,
};

// (jobsFor removed 2026-10-08: hash-derived fabrication.)

// === Simple iron goods for sale ===
const IRON_GOODS = [
  "a bundle of nails",
  "a pair of horseshoes",
  "a sturdy hinge",
  "a fire poker",
  "a set of tent pegs",
  "a horseshoe, lucky",
];

// (goodForToday removed 2026-10-08: hash-derived fabrication.)

// (priceFor removed 2026-10-08: hash-derived fabrication, no production callers.)

// === Masterworks ===
const MASTERWORK_PIECES = [
  "a matched set of silver-shod shoes",
  "a plowshare that'll outlive us all",
  "a weathervane shaped like a dragon",
  "a gate latch forged like ivy",
];

// (masterworkFor removed 2026-10-08: hash-derived fabrication.)

// ============================================================================
// Player ledgers (data tier, zero LLM) — exported for the LLM dialogue tier.
// ============================================================================

/** Record that a player requested a repair. */
function requestRepair(playerName, item, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name || !item) return null;
  pruneLedgers(nowMs);
  repairLedger.set(name, { item: String(item), at: nowMs });
  return item;
}

/** The item a player last asked to have repaired, or null. */
function repairFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = repairLedger.get(name);
  return rec ? rec.item : null;
}

/** Record that a player bought an iron good. */
function buyGoods(playerName, good, price, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name || !good) return null;
  pruneLedgers(nowMs);
  goodsLedger.set(name, { good: String(good), price: Number(price) || 0, at: nowMs });
  return good;
}

/** The last iron good a player bought, or null. */
function goodsFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = goodsLedger.get(name);
  return rec ? { good: rec.good, price: rec.price } : null;
}

/** Record that a player asked for a smithing lesson. */
function learnSmithing(playerName, lesson, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name || !lesson) return null;
  pruneLedgers(nowMs);
  lessonLedger.set(name, { lesson: String(lesson), at: nowMs });
  return lesson;
}

/** The lesson a player last requested, or null. */
function smithingFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = lessonLedger.get(name);
  return rec ? rec.lesson : null;
}

// ============================================================================
// Journal + rumor helpers.
// ============================================================================

// === Journal access (lazy require — CitizenJournal may not load in tests) ===
// Canonical: getJournal().log(name, kind, text). The appendEntry/addEntry
// probe pattern is dead — CitizenJournal only exports getJournal() with a
// log() method (blacksmiths rung audit 2026-10-08).
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

// Canonical rumor seed: seedRumor(rng, event). The bare-string call is dead —
// CitizenRumors.seedRumor (lib/CitizenRumors.js:101) requires event.kind +
// event.what and returns null otherwise (blacksmiths rung audit 2026-10-08).
function seedRumor(event) {
  try {
    const rumors = require("./CitizenRumors");
    if (typeof rumors.seedRumor === "function") rumors.seedRumor(Math.random, event);
  } catch {
    /* rumors absent */
  }
}

/**
 * The materialized player-bot for a roster record, or null when the citizen
 * isn't online. Canonical director API: isOnline(record) + getBot(record)
 * (CitizenDirector.js:1374/1379). director.playerFor / director.onlinePlayers
 * do NOT exist — the blacksmiths rung audit (2026-10-08) found them dead and
 * the smithfolk interaction tier dead-on-arrival because of it. Never call them.
 */
function materializedBot(director, record) {
  try {
    if (director.isOnline?.(record)) return director.getBot?.(record) ?? null;
    return null;
  } catch {
    return null;
  }
}

// ============================================================================
// The tick function — called from the director tick.
// Gate order: cooldown (cheapest) → smithfolk? → materialized → forge
// hours → real player near → chance → work.
// ============================================================================

function tickSmithfolk(director, nowMs, desync = 0) {
  pruneCooldowns(nowMs);
  const now = nowMs + desync * 1000;
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Cooldown gate — O(1), skips almost everyone
        const last = lastFiredByCitizen.get(record.username) || 0;
        if (nowMs - last < SMITHFOLK_CITIZEN_COOLDOWN_MS) continue;

        // 2. Must be village smithfolk (hash-derived, cheap)
        const type = smithfolkTypeOf(record);
        if (!type) continue;

        // 3. Citizen must be materialized (near a player already)
        const citizen = materializedBot(director, record);
        if (!citizen) continue;

        // 4. Forge hours only (dawn to dusk, server-local)
        if (!isForgeHour(now)) continue;

        // 5. A real player must be within earshot
        if (!anyRealPlayerNear(director, citizen, SMITHFOLK_RADIUS)) continue;

        // 6. Chance gate
        if (!chance(Math.random, SMITHFOLK_CHANCE)) continue;

        // 7. Do the thing (scripted, zero LLM)
        doSmithfolkWork(director, record, citizen, type, nowMs);
        lastFiredByCitizen.set(record.username, nowMs);
      } catch (e) {
        // Per-citizen: never let one bad record kill the tick.
        console.warn("[citizen-smithfolk] citizen failed:", e?.message ?? e);
      }
    }
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-smithfolk] tick failed:", e?.message ?? e);
  }
}

/** True if any real (non-bot) player is within radius tiles of the citizen. */
function anyRealPlayerNear(director, citizen, radius) {
  void director;
  try {
    // Real engine API: Player.getLocalPlayers() (Player.ts:796). The citizen
    // bot's local players are the only players that can possibly be near.
    const players = citizen.getLocalPlayers?.() ?? [];
    for (const p of players) {
      if (!isRealPlayer(p)) continue;
      if (withinTiles(citizen, p, radius)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function doSmithfolkWork(director, record, citizen, type, nowMs) {
  const smithy = smithyFor(record);

  // Masterwork unveiling: once per smithy per day, the crowd moment.
  // (Crowd-moment fabrication block removed 2026-10-08: masterworkFor was hash-derived.)

  // Routine: honest ambient chatter only — work, repairs, lessons.
  // (jobsFor/goodForToday branches removed 2026-10-08: hash-derived "finished
  // job" and hawked goods were fabrication.)
  const roll = Math.random();
  if (roll < 0.5) {
    const line = pickOne(Math.random, WORK_LINES[type]);
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
    journalize(record.username, `worked at ${smithy.name}`);
  } else if (roll < 0.75) {
    const line = pickOne(Math.random, REPAIR_LINES);
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
    journalize(record.username, `offered repairs at ${smithy.name}`);
  } else {
    const line = pickOne(Math.random, LESSON_LINES);
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
    journalize(record.username, `offered smithing lessons at ${smithy.name}`);
  }
}

module.exports = {
  tickSmithfolk,
  // Public API (data tier, zero LLM) for the LLM dialogue tier:
  smithfolkTypeOf,
  smithyFor,
  requestRepair,
  repairFor,
  buyGoods,
  goodsFor,
  learnSmithing,
  smithingFor,
  // Pure helpers for tests:
  hashStr,
  pickOne,
  fill,
  smithfolkTypeFromRoll,
  seededRng,
  chance,
  dayNumber,
  isRealPlayer,
  isCitizenBot,
  withinTiles,
  isForgeHour,
  SMITHFOLK_TYPES,
  SMITHFOLK_FARRIER,
  SMITHFOLK_HONER,
  SMITHFOLK_TINKERER,
  SMITHFOLK_APPRENTICE,
  COMMUNITY_SMITHIES,
  // Test seam:
  _resetState() {
    lastFiredByCitizen.clear();
    repairLedger.clear();
    goodsLedger.clear();
    lessonLedger.clear();
    lastPruneAt = 0;
    lastLedgerPrune = 0;
  },
};
