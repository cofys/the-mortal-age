"use strict";

/**
 * CitizenMiners2 — the mining folk: amateur prospectors, claim diggers, ore
 * carriers and gem hunters who work community claims and share the riches
 * from the hills.
 *
 * WHAT IT DOES (data tier, free):
 *   Hash-derived mining-folk types, per-day community claims, per-day
 *   ore finds derived from date + hash, rare rich-vein strikes (~8%/claim/
 *   day) seeded into CitizenRumors, 7-day-TTL player ledgers for staking
 *   claims, hiring miners and buying ore.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players,
 * 06:00-20:00 local): scripted prospecting/digging/hauling emotes, vein-
 * strike fanfare as the crowd moment, claim-sharing and hire offers.
 *
 * NO OVERLAP (by design):
 *   - CitizenMiners owns the PROFESSIONAL trade (prospectors, diggers,
 *     smelters, gem cutters; the named mines, shifts, veins, hazards).
 *     Professional miners are EXCLUDED from minerfolkTypeOf.
 *   - CitizenJewelers owns gem cutting, jewelry crafting and the gem
 *     trade. Gem hunters here seek RAW stones in the hills — the supply
 *     side, never cutting or trading them.
 *   - CitizenSmelters (if present) own smelting; this module owns surface
 *     digging, hauling and prospecting only.
 *   - Ore pools reuse the real ORES table from CitizenMiners; gem names
 *     reuse the real GEMS table from CitizenJewelers (static fallbacks
 *     when those modules are absent).
 *
 * Zero LLM: all lines from scripted pools; the journal feeds the LLM mouth.
 *
 * Visibility throttle: chance + 3h cooldown (couriers/healers2/watchmen2/
 * fisherfolk precedent) — deliberately NO new primary-hobby key, so adding
 * this module does not reshuffle every citizen's primary hobby.
 *
 * Wired into the director tick right after the fisherfolk block.
 * Plain-node testable: CitizenMiners2.test.js.
 */

const { normalizeName } = require("./CitizenBonds");
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");


// Top-level safeRequire (potters perf lesson): the pro-miner exclusion
// check runs per citizen per tick, so no lazy requires in that path.
function safeRequire(path) {
  try {
    return require(path);
  } catch {
    return null;
  }
}
const ProMiners = safeRequire("./CitizenMiners");
const ProJewelers = safeRequire("./CitizenJewelers");
const ORES = (ProMiners && ProMiners.ORES) || [
  "copper",
  "tin",
  "iron",
  "coal",
  "silver",
  "gold",
  "mithril",
  "adamant",
];
const GEMS = (() => {
  const g = ProJewelers && ProJewelers.GEMS;
  if (Array.isArray(g) && g.length) {
    return g.map((x) => (x && typeof x === "object" ? x.name : String(x))).filter(Boolean);
  }
  return ["opal", "jade", "red topaz", "sapphire", "emerald", "ruby", "diamond"];
})();

// === Tuning: all magic numbers here ===
const MINERFOLK_RADIUS = 14; // tiles — close enough to see/hear
const MINERFOLK_CITIZEN_COOLDOWN_MS = 3 * 60 * 60 * 1000; // a citizen fires at most every 3h
const MINERFOLK_CHANCE = 0.15; // per eligible citizen per tick
// Nominal share of commoners who work the community claims for food/fun.
const MINERFOLK_SHARE = 40;
const DAWN_HOUR = 6; // 06:00 local
const DUSK_HOUR = 20; // 20:00 local
const STRIKE_CHANCE = 0.08; // rich-vein strike, per claim per day
const LEDGER_TTL_MS = 7 * 24 * 3600 * 1000;

// === Mining-folk types ===
const MINERFOLK_PROSPECTOR = "prospector";
const MINERFOLK_DIGGER = "digger";
const MINERFOLK_CARRIER = "ore carrier";
const MINERFOLK_GEMHUNTER = "gem hunter";
const MINERFOLK_TYPES = [
  MINERFOLK_PROSPECTOR,
  MINERFOLK_DIGGER,
  MINERFOLK_CARRIER,
  MINERFOLK_GEMHUNTER,
];
const MINERFOLK_WEIGHTS = {
  [MINERFOLK_PROSPECTOR]: 30,
  [MINERFOLK_DIGGER]: 35,
  [MINERFOLK_CARRIER]: 20,
  [MINERFOLK_GEMHUNTER]: 15,
};

// === Community claims (hills, creek beds, old diggings — not the pro mines) ===
const COMMUNITY_CLAIMS = [
  { name: "the Varrock copper diggings", kingdom: "misthalin", kind: "hills" },
  { name: "the Lumbridge creek pans", kingdom: "misthalin", kind: "creek" },
  { name: "the Draynor old quarry", kingdom: "misthalin", kind: "quarry" },
  { name: "the Rimmington cliff face", kingdom: "asgarnia", kind: "hills" },
  { name: "the Falador chalk pits", kingdom: "asgarnia", kind: "quarry" },
  { name: "the Ardougne gravel beds", kingdom: "kandarin", kind: "creek" },
  { name: "the Feldip flint hills", kingdom: "kandarin", kind: "hills" },
  { name: "the Keldagrim tailings", kingdom: "keldagrim", kind: "quarry" },
  { name: "the Darkmeyer slag heaps", kingdom: "morytania", kind: "quarry" },
  { name: "the Al Kharid granite cuts", kingdom: "kharidian", kind: "quarry" },
];

// === Scripted lines ===
const WORK_LINES = {
  [MINERFOLK_PROSPECTOR]: [
    "Color here... I can smell the copper in this dirt.",
  ],
  [MINERFOLK_DIGGER]: [
    "Mind your head — she's a low seam.",
  ],
  [MINERFOLK_CARRIER]: [
    "Heavy as sin, this one. Good sign.",
  ],
  [MINERFOLK_GEMHUNTER]: [
    "Sparkle in the pan — could be something!",
  ],
};

const FIND_LINES = [
  "Ha! A fine chunk of {ore}!",
  "This one's rich — look at the {ore} in it!",
  "Another sack of {ore} for the pile.",
  "{ore}! The claim's paying today!",
];

const GEM_FIND_LINES = [
  "Would you look at that — a raw {gem}!",
  "{gem}, rough as it comes. The jewelers will want this.",
  "Held it to the light — {gem}, no question!",
];

const STRIKE_LINES = [
  "STRIKE! {ore} — a vein thick as my arm at {claim}!",
  "We've hit it! Pure {ore}, lads — {claim} is paying out!",
  "Get the barrows! {ore} coming out of {claim} like water!",
];

const HIRE_LINES = [
  "Need a strong back at the diggings? My pick's for hire.",
  "I'll haul, dig or pan — fair day's wage, honest work.",
];

const CLAIM_LINES = [
  "This claim's open to all, friend — swing a pick, keep what you find.",
  "The community works these diggings together. There's room for you.",
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
const stakeLedger = new Map(); // normName -> { claim, at }
const hireLedger = new Map(); // normName -> { miner, at }
const buyOreLedger = new Map(); // normName -> { ore, price, at }
let lastLedgerPrune = 0;
function pruneLedgers(nowMs) {
  if (nowMs - lastLedgerPrune < 3600 * 1000) return;
  lastLedgerPrune = nowMs;
  for (const [map] of [[stakeLedger], [hireLedger], [buyOreLedger]]) {
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

/** Weighted pick of a minerfolk type from a 0..99 roll. */
function minerfolkTypeFromRoll(roll) {
  let acc = 0;
  for (const t of MINERFOLK_TYPES) {
    acc += MINERFOLK_WEIGHTS[t];
    if (roll < acc) return t;
  }
  return MINERFOLK_DIGGER;
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

/** True during mine hours (06:00-20:00 server-local time). */
function isMineHour(nowMs) {
  const h = new Date(nowMs).getHours();
  return h >= DAWN_HOUR && h < DUSK_HOUR;
}

// ============================================================================
// Mining-folk identity — hash-derived, stable across restarts, no storage.
// ============================================================================

/**
 * The minerfolk type for a roster record, or null.
 * Excludes professional miners (CitizenMiners owns the trade) so no citizen
 * belongs to both the commercial mines and the community diggings.
 * Activity system: any other commoner may work the claims.
 */
function minerfolkTypeOf(record) {
  try {
    const role = record?.role ?? record?.attributes?.role;
    if (role && role !== "commoner" && role !== "COMMONER") return null;
    const username = record?.username;
    const name = normalizeName(username);
    if (!name) return null;
    // No overlap: professional miners own the trade.
    try {
      if (ProMiners && typeof ProMiners.minerTypeFor === "function" && ProMiners.minerTypeFor(username)) {
        return null;
      }
    } catch {
      /* pro module absent or threw — treat as non-pro */
    }
    const roll = hashStr("minerfolk:" + name) % 100;
    if (roll >= MINERFOLK_SHARE) return null;
    return minerfolkTypeFromRoll(hashStr("minerfolktype:" + name) % 100);
  } catch {
    return null;
  }
}

/** Kingdom-preferred community claim, stable across restarts. */
function claimFor(record) {
  const kid = record?.kingdomId;
  const local = COMMUNITY_CLAIMS.filter((c) => c.kingdom === kid);
  const pool = local.length ? local : COMMUNITY_CLAIMS;
  const name = normalizeName(record?.username) || "anon";
  return pool[hashStr("minerfolkclaim:" + name) % pool.length];
}

/** The ore a minerfolk citizen is working today. */
function oreForToday(username, dateMs) {
  const name = (normalizeName(username) || "anon").toLowerCase();
  const day = dayNumber(dateMs);
  return ORES[hashStr("minerfolkore:" + name + ":" + day) % ORES.length];
}

/** The gem a gem hunter might find today (raw stone, never cut here). */
function gemForToday(username, dateMs) {
  const name = (normalizeName(username) || "anon").toLowerCase();
  const day = dayNumber(dateMs);
  return GEMS[hashStr("minerfolkgem:" + name + ":" + day) % GEMS.length];
}

/**
 * Today's finds for a minerfolk citizen: 1-3 ore chunks (or raw gems for
 * gem hunters). Derived from date + hash; zero storage.
 */
function findsFor(username, type, dateMs) {
  const name = normalizeName(username) || "anon";
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr("minerfolkfinds:" + name + ":" + day));
  const count = 1 + Math.floor(rng() * 3); // 1-3
  const out = [];
  for (let i = 0; i < count; i++) {
    if (type === MINERFOLK_GEMHUNTER) {
      out.push(gemForToday(name + ":" + i, dateMs));
    } else {
      out.push(oreForToday(name + ":" + i, dateMs));
    }
  }
  return out;
}

/**
 * Today's rich-vein strike at a claim (~8%/day), or null.
 * { ore } — the crowd moment.
 */
function strikeFor(claim, dateMs) {
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr("minerfolkstrike:" + claim.name + ":" + day));
  if (rng() >= STRIKE_CHANCE) return null;
  const ore = ORES[Math.floor(rng() * ORES.length)];
  return { ore };
}

/** A fair dockside price for a chunk of ore (5-60 coins by rarity). */
function priceFor(ore, dateMs) {
  const rng = seededRng(hashStr("minerfolkprice:" + ore + ":" + dayNumber(dateMs)));
  const idx = ORES.indexOf(ore);
  const base = idx >= 0 ? 5 + idx * 7 : 10;
  return base + Math.floor(rng() * 15);
}

// ============================================================================
// Player ledgers (data tier, zero LLM) — exported for the LLM dialogue tier.
// ============================================================================

/** Record that a player staked a community claim. */
function stakeClaim(playerName, claim, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name || !claim) return null;
  pruneLedgers(nowMs);
  stakeLedger.set(name, { claim: String(claim), at: nowMs });
  return claim;
}

/** The claim a player last staked, or null. */
function claimForPlayer(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = stakeLedger.get(name);
  return rec ? rec.claim : null;
}

/** Record that a player hired a minerfolk miner. */
function hireMiner(playerName, minerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name || !minerName) return null;
  pruneLedgers(nowMs);
  hireLedger.set(name, { miner: String(minerName), at: nowMs });
  return minerName;
}

/** The miner a player last hired, or null. */
function hiredMinerFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = hireLedger.get(name);
  return rec ? rec.miner : null;
}

/** Record that a player bought ore from the community pile. */
function buyOre(playerName, ore, price, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name || !ore) return null;
  pruneLedgers(nowMs);
  buyOreLedger.set(name, { ore: String(ore), price: Number(price) || 0, at: nowMs });
  return ore;
}

/** The last ore purchase a player made, or null. */
function boughtOreFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = buyOreLedger.get(name);
  return rec ? { ore: rec.ore, price: rec.price } : null;
}

// ============================================================================
// Journal + rumor helpers.
// ============================================================================

// === Journal access (lazy require — CitizenJournal may not load in tests) ===
// Canonical: getJournal().log(name, kind, text). The appendEntry/addEntry
// probe pattern is dead — CitizenJournal only exports getJournal() with a
// log() method (miners rung audit 2026-10-08).
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

// Canonical rumor seed: seedRumor(rng, event) with
// event: { kind, who, whoDisplay, what, where, whereDisplay, amount }.
// Calling it with a bare string silently no-ops (returns null) — miners
// rung audit 2026-10-08.
function seedStrikeRumor(who, text, where) {
  try {
    const rumors = require("./CitizenRumors");
    if (typeof rumors.seedRumor === "function") {
      rumors.seedRumor(Math.random, { kind: "strike", who, what: text, where });
    }
  } catch {
    /* rumors absent */
  }
}

// ============================================================================
// The tick function — called from the director tick.
// Gate order: cooldown (cheapest) → minerfolk? → materialized → mine
// hours → real player near → chance → work.
// ============================================================================

function tickMinerfolk(director, nowMs, desync = 0) {
  pruneCooldowns(nowMs);
  const now = nowMs + desync * 1000;
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Cooldown gate — O(1), skips almost everyone
        const last = lastFiredByCitizen.get(record.username) || 0;
        if (nowMs - last < MINERFOLK_CITIZEN_COOLDOWN_MS) continue;

        // 2. Must be community mining folk (hash-derived, cheap)
        const type = minerfolkTypeOf(record);
        if (!type) continue;

        // 3. Citizen must be materialized (near a player already)
        const citizen = materializedBot(director, record);
        if (!citizen) continue;

        // 4. Mine hours only (dawn to dusk, server-local)
        if (!isMineHour(now)) continue;

        // 5. A real player must be within earshot
        if (!anyRealPlayerNear(director, citizen, MINERFOLK_RADIUS)) continue;

        // 6. Chance gate
        if (!chance(Math.random, MINERFOLK_CHANCE)) continue;

        // 7. Do the thing (scripted, zero LLM)
        doMinerfolkWork(director, record, citizen, type, nowMs);
        lastFiredByCitizen.set(record.username, nowMs);
      } catch (e) {
        // Per-citizen: never let one bad record kill the tick.
        console.warn("[citizen-minerfolk] citizen failed:", e?.message ?? e);
      }
    }
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-minerfolk] tick failed:", e?.message ?? e);
  }
}

/**
 * The materialized player-bot for a roster record, or null when the citizen
 * isn't online. Canonical director API: isOnline(record) + getBot(record)
 * (CitizenDirector.js:1374/1379). director.playerFor / director.onlinePlayers
 * do NOT exist — never call them (miners rung audit 2026-10-08).
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
    // Real engine API: Player.getLocalPlayers() (Player.ts:796).
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

function doMinerfolkWork(director, record, citizen, type, nowMs) {
  const claim = claimFor(record);
  const name = normalizeName(record.username);
  const day = dayNumber(nowMs);

  // Rich-vein strike: once per claim per day, the crowd moment.
  const strike = strikeFor(claim, nowMs);
  if (strike) {
    const key = "veinstrike:" + claim.name + ":" + day;
    if (!lastFiredByCitizen.has(key)) {
      lastFiredByCitizen.set(key, nowMs);
      const line = fill(pickOne(Math.random, STRIKE_LINES), {
        ore: strike.ore,
        claim: claim.name,
      });
      { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
      journalize(record.username, `struck a rich ${strike.ore} vein at ${claim.name}`);
      seedStrikeRumor(record.username, `A rich ${strike.ore} vein struck at ${claim.name}!`, claim.name);
      return;
    }
  }

  // Routine: work emote, find callout, gem find, hire/claim offers.
  const roll = Math.random();
  if (roll < 0.4) {
    const line = pickOne(Math.random, WORK_LINES[type]);
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
    journalize(record.username, `worked at ${claim.name}`);
  } else if (roll < 0.6) {
    const todays = findsFor(name, type, nowMs);
    const find = todays.length ? todays[0] : "ore";
    const line =
      type === MINERFOLK_GEMHUNTER
        ? fill(pickOne(Math.random, GEM_FIND_LINES), { gem: find })
        : fill(pickOne(Math.random, FIND_LINES), { ore: find });
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
    journalize(record.username, `found ${todays.join(", ")} at ${claim.name}`);
  } else if (roll < 0.75) {
    const line = pickOne(Math.random, HIRE_LINES);
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
    journalize(record.username, `offered hire at ${claim.name}`);
  } else {
    const line = pickOne(Math.random, CLAIM_LINES);
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
    journalize(record.username, `invited a player to work ${claim.name}`);
  }
}

module.exports = {
  tickMinerfolk,
  // Public API (data tier, zero LLM) for the LLM dialogue tier:
  minerfolkTypeOf,
  claimFor,
  oreForToday,
  gemForToday,
  findsFor,
  strikeFor,
  priceFor,
  stakeClaim,
  claimForPlayer,
  hireMiner,
  hiredMinerFor,
  buyOre,
  boughtOreFor,
  // Pure helpers for tests:
  hashStr,
  pickOne,
  fill,
  minerfolkTypeFromRoll,
  isRealPlayer,
  isCitizenBot,
  withinTiles,
  isMineHour,
  dayNumber,
  chance,
  seededRng,
  MINERFOLK_TYPES,
  MINERFOLK_PROSPECTOR,
  MINERFOLK_DIGGER,
  MINERFOLK_CARRIER,
  MINERFOLK_GEMHUNTER,
  COMMUNITY_CLAIMS,
  ORES,
  GEMS,
  // Test seam:
  _resetState() {
    lastFiredByCitizen.clear();
    stakeLedger.clear();
    hireLedger.clear();
    buyOreLedger.clear();
    lastPruneAt = 0;
    lastLedgerPrune = 0;
  },
};
