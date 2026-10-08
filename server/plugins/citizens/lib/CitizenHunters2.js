"use strict";

/**
 * CitizenHunters2 — the hunting folk: amateur trackers, bowmen, trappers and
 * falconers who hunt the community grounds near the settlements for food,
 * fun and fellowship.
 *
 * WHAT IT DOES (data tier, free):
 *   Hash-derived hunting-folk types, per-day community grounds, per-day
 *   game bags derived from date + hash, rare trophy-bag events (~8%/ground/
 *   day) seeded into CitizenRumors, 7-day-TTL player ledgers for joining
 *   hunts, buying fresh game and learning tracking.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players,
 * 06:00-20:00 local): scripted tracking/trapping/bowshot/falconry emotes,
 * trophy-bag fanfare as the crowd moment, hunt-sharing and meat-selling
 * offers.
 *
 * NO OVERLAP (by design):
 *   - CitizenHunters owns the PROFESSIONAL trade (trackers, bowmen,
 *     trappers, beastmasters; the named wilds, danger warnings, trophy
 *     kills, commercial meat/hide hawking). Professional hunters are
 *     EXCLUDED from huntfolkTypeOf.
 *   - CitizenCooks owns kitchens and recipes; hunters hawk fresh game
 *     that the cooks buy — the supply side, never cooking it here.
 *   - CitizenSailors own boats; hunting folk work the land on foot only.
 *   - Prey pools reuse the real PREY table from CitizenHunters; trophy
 *     names reuse the real TROPHIES table (static fallbacks when that
 *     module is absent).
 *
 * Zero LLM: all lines from scripted pools; the journal feeds the LLM mouth.
 *
 * Visibility throttle: chance + 3h cooldown (couriers/healers2/watchmen2/
 * fisherfolk/minerfolk precedent) — deliberately NO new primary-hobby key,
 * so adding this module does not reshuffle every citizen's primary hobby.
 *
 * Wired into the director tick right after the minerfolk block.
 * Plain-node testable: CitizenHunters2.test.js.
 */

const { normalizeName } = require("./CitizenBonds");

// Top-level safeRequire (potters perf lesson): the pro-hunter exclusion
// check runs per citizen per tick, so no lazy requires in that path.
function safeRequire(path) {
  try {
    return require(path);
  } catch {
    return null;
  }
}
const ProHunters = safeRequire("./CitizenHunters");
const ProCooks = safeRequire("./CitizenCooks");
const PREY = (ProHunters && ProHunters.PREY) || {
  low: ["rabbit", "pheasant", "squirrel", "partridge"],
  medium: ["deer", "boar", "fox", "badger"],
  high: ["giant boar", "dire wolf", "jungle panther", "swamp basilisk"],
};
const TROPHIES = (ProHunters && ProHunters.TROPHIES) || {
  low: ["great grey owl", "albino rabbit"],
  medium: ["twelve-point stag", "black boar"],
  high: ["drake of the swamps", "jungle king panther"],
};

// === Tuning: all magic numbers here ===
const HUNTFOLK_RADIUS = 14; // tiles — close enough to see/hear
const HUNTFOLK_CITIZEN_COOLDOWN_MS = 3 * 60 * 60 * 1000; // a citizen fires at most every 3h
const HUNTFOLK_CHANCE = 0.15; // per eligible citizen per tick
// Nominal share of commoners who hunt the community grounds for food/fun.
const HUNTFOLK_SHARE = 40;
const DAWN_HOUR = 6; // 06:00 local
const DUSK_HOUR = 20; // 20:00 local
const TROPHY_BAG_CHANCE = 0.08; // trophy-bag event, per ground per day
const LEDGER_TTL_MS = 7 * 24 * 3600 * 1000;

// === Hunting-folk types ===
const HUNTFOLK_TRACKER = "tracker";
const HUNTFOLK_BOWMAN = "bowman";
const HUNTFOLK_TRAPPER = "trapper";
const HUNTFOLK_FALCONER = "falconer";
const HUNTFOLK_TYPES = [
  HUNTFOLK_TRACKER,
  HUNTFOLK_BOWMAN,
  HUNTFOLK_TRAPPER,
  HUNTFOLK_FALCONER,
];
const HUNTFOLK_WEIGHTS = {
  [HUNTFOLK_TRACKER]: 30,
  [HUNTFOLK_BOWMAN]: 30,
  [HUNTFOLK_TRAPPER]: 25,
  [HUNTFOLK_FALCONER]: 15,
};

// === Community hunting grounds (near the settlements, not the pro wilds) ===
const COMMUNITY_GROUNDS = [
  { name: "the Varrock village coppices", kingdom: "misthalin", danger: "low" },
  { name: "the Lumbridge river meadows", kingdom: "misthalin", danger: "low" },
  { name: "the Draynor orchard edges", kingdom: "misthalin", danger: "low" },
  { name: "the Rimmington heath", kingdom: "asgarnia", danger: "low" },
  { name: "the Falador barley fields", kingdom: "asgarnia", danger: "low" },
  { name: "the Ardougne market gardens", kingdom: "kandarin", danger: "low" },
  { name: "the Feldip village fringes", kingdom: "kandarin", danger: "medium" },
  { name: "the Keldagrim miners' allotments", kingdom: "keldagrim", danger: "low" },
  { name: "the Darkmeyer blood-moss glades", kingdom: "morytania", danger: "medium" },
  { name: "the Al Kharid date-palm groves", kingdom: "kharidian", danger: "low" },
];

// === Scripted lines ===
const WORK_LINES = {
  [HUNTFOLK_TRACKER]: [
    "*crouches to read the tracks*",
    "*brushes the leaf litter aside, studying the prints*",
    "Two deer passed here before dawn — see the cloven marks?",
    "*follows a broken twig trail into the brush*",
  ],
  [HUNTFOLK_BOWMAN]: [
    "*draws the bow, steady as stone*",
    "*nocks an arrow, sighting down the meadow*",
    "*looses — clean shot through the brush*",
    "Patience, lad. The arrow flies straighter when you're calm.",
  ],
  [HUNTFOLK_TRAPPER]: [
    "*sets a snare in the rabbit run*",
    "*bends a sapling into a spring trap*",
    "*baits a box trap with turnip tops*",
    "Check the snares at dawn — rabbit for the pot by noon.",
  ],
  [HUNTFOLK_FALCONER]: [
    "*casts the falcon from the glove*",
    "*swings the lure, calling the bird down*",
    "*feeds the hawk a strip of rabbit*",
    "She hunts the sky; I just carry the glove.",
  ],
};

const BAG_LINES = [
  "Fine morning! {game} for the pot!",
  "The snares gave us {game} today.",
  "Look — {game}! Supper's sorted.",
  "Bagged {game} on the community ground.",
];

const FALCON_LINES = [
  "She stooped like lightning — {game} never stood a chance!",
  "My falcon took {game} on the wing. Beautiful, wasn't it?",
];

const TROPHY_LINES = [
  "A {trophy}! On the community ground of all places! {ground} is blessed!",
  "Never seen its like — a {trophy}, bagged by {hunter} at {ground}!",
  "The hunt club's talking about it for years — {trophy} at {ground}!",
];

const SHARE_LINES = [
  "The hunt's for sharing, friend — take some of the bag.",
  "Community hunt, community table. Help yourself.",
];

const SELL_LINES = [
  "Fresh {game} — straight from the ground, fair price.",
  "Selling the morning's {game}. The cooks buy it quick.",
];

const JOIN_LINES = [
  "We're hunting the community ground at dawn — join us?",
  "The hunt club welcomes all. Bow, snare, or just your eyes.",
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
const joinLedger = new Map(); // normName -> { ground, at }
const buyGameLedger = new Map(); // normName -> { game, price, at }
const learnLedger = new Map(); // normName -> { skill, at }
let lastLedgerPrune = 0;
function pruneLedgers(nowMs) {
  if (nowMs - lastLedgerPrune < 3600 * 1000) return;
  lastLedgerPrune = nowMs;
  for (const [map] of [[joinLedger], [buyGameLedger], [learnLedger]]) {
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

/** Weighted pick of a huntfolk type from a 0..99 roll. */
function huntfolkTypeFromRoll(roll) {
  let acc = 0;
  for (const t of HUNTFOLK_TYPES) {
    acc += HUNTFOLK_WEIGHTS[t];
    if (roll < acc) return t;
  }
  return HUNTFOLK_BOWMAN;
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

/** True during hunt hours (06:00-20:00 server-local time). */
function isHuntHour(nowMs) {
  const h = new Date(nowMs).getHours();
  return h >= DAWN_HOUR && h < DUSK_HOUR;
}

// ============================================================================
// Hunting-folk identity — hash-derived, stable across restarts, no storage.
// ============================================================================

/**
 * The huntfolk type for a roster record, or null.
 * Excludes professional hunters (CitizenHunters owns the trade) so no
 * citizen belongs to both the commercial wilds and the community grounds.
 * Activity system: any other commoner may hunt the community grounds.
 */
function huntfolkTypeOf(record) {
  try {
    const role = record?.role ?? record?.attributes?.role;
    if (role && role !== "commoner" && role !== "COMMONER") return null;
    const username = record?.username;
    const name = normalizeName(username);
    if (!name) return null;
    // No overlap: professional hunters own the trade.
    try {
      if (ProHunters && typeof ProHunters.hunterTypeFor === "function" && ProHunters.hunterTypeFor(username)) {
        return null;
      }
    } catch {
      /* pro module absent or threw — treat as non-pro */
    }
    const roll = hashStr("huntfolk:" + name) % 100;
    if (roll >= HUNTFOLK_SHARE) return null;
    return huntfolkTypeFromRoll(hashStr("huntfolktype:" + name) % 100);
  } catch {
    return null;
  }
}

/** Kingdom-preferred community ground, stable across restarts. */
function groundFor(record) {
  const kid = record?.kingdomId;
  const local = COMMUNITY_GROUNDS.filter((g) => g.kingdom === kid);
  const pool = local.length ? local : COMMUNITY_GROUNDS;
  const name = normalizeName(record?.username) || "anon";
  return pool[hashStr("huntfolkground:" + name) % pool.length];
}

/** The game a huntfolk citizen bags today, from their ground's table. */
function gameForToday(username, ground, dateMs) {
  const name = (normalizeName(username) || "anon").toLowerCase();
  const day = dayNumber(dateMs);
  const danger = (ground && ground.danger) || "low";
  const pool = PREY[danger] || PREY.low;
  return pool[hashStr("huntfolkgame:" + name + ":" + day) % pool.length];
}

/**
 * Today's bag for a huntfolk citizen: 1-3 game animals.
 * Derived from date + hash; zero storage.
 */
function bagFor(username, ground, dateMs) {
  const name = normalizeName(username) || "anon";
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr("huntfolkbag:" + name + ":" + day));
  const count = 1 + Math.floor(rng() * 3); // 1-3
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(gameForToday(name + ":" + i, ground, dateMs));
  }
  return out;
}

/**
 * Today's trophy-bag event at a ground (~8%/day), or null.
 * { trophy, hunter } — the crowd moment.
 */
function trophyBagFor(ground, dateMs) {
  const day = dayNumber(dateMs);
  const rng = seededRng(hashStr("huntfolktrophy:" + ground.name + ":" + day));
  if (rng() >= TROPHY_BAG_CHANCE) return null;
  const danger = ground.danger || "low";
  const pool = TROPHIES[danger] || TROPHIES.low;
  return { trophy: pool[Math.floor(rng() * pool.length)] };
}

/** A fair price for fresh game (5-50 coins by danger-table rank). */
function priceFor(game, dateMs) {
  const rng = seededRng(hashStr("huntfolkprice:" + game + ":" + dayNumber(dateMs)));
  let idx = -1;
  for (const table of Object.values(PREY)) {
    const i = table.indexOf(game);
    if (i >= 0) { idx = i; break; }
  }
  const base = idx >= 0 ? 5 + idx * 8 : 10;
  return base + Math.floor(rng() * 12);
}

/**
 * A game dish the cooks are serving today — read from the real
 * CitizenCooks regional tables (static fallback), so the hunters' hawking
 * matches what the kitchens actually want.
 */
function dishForToday(kingdomId, dateMs) {
  try {
    const dishes = ProCooks && ProCooks.REGIONAL_DISHES;
    const pool = (dishes && (dishes[kingdomId] || dishes.misthalin)) || null;
    if (Array.isArray(pool) && pool.length) {
      return pool[hashStr("huntfolkdish:" + kingdomId + ":" + dayNumber(dateMs)) % pool.length];
    }
  } catch {
    /* cooks absent */
  }
  return "game stew";
}

// ============================================================================
// Player ledgers (data tier, zero LLM) — exported for the LLM dialogue tier.
// ============================================================================

/** Record that a player joined a community hunt. */
function joinHunt(playerName, ground, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name || !ground) return null;
  pruneLedgers(nowMs);
  joinLedger.set(name, { ground: String(ground), at: nowMs });
  return ground;
}

/** The ground a player last joined a hunt on, or null. */
function huntFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = joinLedger.get(name);
  return rec ? rec.ground : null;
}

/** Record that a player bought fresh game from the huntfolk. */
function buyGame(playerName, game, price, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name || !game) return null;
  pruneLedgers(nowMs);
  buyGameLedger.set(name, { game: String(game), price: Number(price) || 0, at: nowMs });
  return game;
}

/** The last game purchase a player made, or null. */
function boughtGameFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = buyGameLedger.get(name);
  return rec ? { game: rec.game, price: rec.price } : null;
}

/** Record that a player learned a tracking skill from a huntfolk tracker. */
function learnTracking(playerName, skill, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name || !skill) return null;
  pruneLedgers(nowMs);
  learnLedger.set(name, { skill: String(skill), at: nowMs });
  return skill;
}

/** The last tracking skill a player learned, or null. */
function trackingFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = learnLedger.get(name);
  return rec ? rec.skill : null;
}

// ============================================================================
// Journal + rumor helpers.
// ============================================================================

function journalize(citizen, text) {
  try {
    const journal = require("./CitizenJournal");
    if (typeof journal.appendEntry === "function") {
      journal.appendEntry(citizen, text);
    } else if (typeof journal.addEntry === "function") {
      journal.addEntry(citizen, text);
    }
  } catch {
    /* journal absent */
  }
}

function seedRumor(text) {
  try {
    const rumors = require("./CitizenRumors");
    if (typeof rumors.seedRumor === "function") rumors.seedRumor(text);
  } catch {
    /* rumors absent */
  }
}

// ============================================================================
// The tick function — called from the director tick.
// Gate order: cooldown (cheapest) → huntfolk? → materialized → hunt
// hours → real player near → chance → work.
// ============================================================================

function tickHuntfolk(director, nowMs, desync = 0) {
  pruneCooldowns(nowMs);
  const now = nowMs + desync * 1000;
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Cooldown gate — O(1), skips almost everyone
        const last = lastFiredByCitizen.get(record.username) || 0;
        if (nowMs - last < HUNTFOLK_CITIZEN_COOLDOWN_MS) continue;

        // 2. Must be community hunting folk (hash-derived, cheap)
        const type = huntfolkTypeOf(record);
        if (!type) continue;

        // 3. Citizen must be materialized (near a player already)
        const citizen = (director.isOnline(record) ? director.getBot(record) : null);
        if (!citizen) continue;

        // 4. Hunt hours only (dawn to dusk, server-local)
        if (!isHuntHour(now)) continue;

        // 5. A real player must be within earshot
        if (!anyRealPlayerNear(director, citizen, HUNTFOLK_RADIUS)) continue;

        // 6. Chance gate
        if (!chance(Math.random, HUNTFOLK_CHANCE)) continue;

        // 7. Do the thing (scripted, zero LLM)
        doHuntfolkWork(director, record, citizen, type, nowMs);
        lastFiredByCitizen.set(record.username, nowMs);
      } catch (e) {
        // Per-citizen: never let one bad record kill the tick.
        console.warn("[citizen-huntfolk] citizen failed:", e?.message ?? e);
      }
    }
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-huntfolk] tick failed:", e?.message ?? e);
  }
}

/** True if any real (non-bot) player is within radius tiles of the citizen. */
function anyRealPlayerNear(director, citizen, radius) {
  try {
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

function doHuntfolkWork(director, record, citizen, type, nowMs) {
  const ground = groundFor(record);
  const name = normalizeName(record.username);
  const day = dayNumber(nowMs);

  // Trophy-bag event: once per ground per day, the crowd moment.
  const trophy = trophyBagFor(ground, nowMs);
  if (trophy) {
    const key = "trophybag:" + ground.name + ":" + day;
    if (!lastFiredByCitizen.has(key)) {
      lastFiredByCitizen.set(key, nowMs);
      const line = fill(pickOne(Math.random, TROPHY_LINES), {
        trophy: trophy.trophy,
        hunter: name,
        ground: ground.name,
      });
      citizen.forceChat?.(line);
      journalize(citizen, `bagged a ${trophy.trophy} at ${ground.name}`);
      seedRumor(`A ${trophy.trophy} bagged at ${ground.name}!`);
      return;
    }
  }

  // Routine: work emote, bag callout, falconry callout, share/sell/join offers.
  const roll = Math.random();
  if (roll < 0.35) {
    const line = pickOne(Math.random, WORK_LINES[type]);
    citizen.forceChat?.(line);
    journalize(citizen, `hunted at ${ground.name}`);
  } else if (roll < 0.55) {
    const todays = bagFor(name, ground, nowMs);
    const game = todays.length ? todays[0] : "rabbit";
    const lines = type === HUNTFOLK_FALCONER ? FALCON_LINES : BAG_LINES;
    const line = fill(pickOne(Math.random, lines), { game });
    citizen.forceChat?.(line);
    journalize(citizen, `bagged ${todays.join(", ")} at ${ground.name}`);
  } else if (roll < 0.7) {
    const line = pickOne(Math.random, SHARE_LINES);
    citizen.forceChat?.(line);
    journalize(citizen, `shared the bag at ${ground.name}`);
  } else if (roll < 0.85) {
    const todays = bagFor(name, ground, nowMs);
    const game = todays.length ? todays[0] : "rabbit";
    const line = fill(pickOne(Math.random, SELL_LINES), {
      game,
      dish: dishForToday(record.kingdomId, nowMs),
    });
    citizen.forceChat?.(line);
    journalize(citizen, `hawked ${game} at ${ground.name}`);
  } else {
    const line = pickOne(Math.random, JOIN_LINES);
    citizen.forceChat?.(line);
    journalize(citizen, `invited a player to the hunt at ${ground.name}`);
  }
}

module.exports = {
  tickHuntfolk,
  // Public API (data tier, zero LLM) for the LLM dialogue tier:
  huntfolkTypeOf,
  groundFor,
  gameForToday,
  bagFor,
  trophyBagFor,
  priceFor,
  dishForToday,
  joinHunt,
  huntFor,
  buyGame,
  boughtGameFor,
  learnTracking,
  trackingFor,
  // Pure helpers for tests:
  hashStr,
  pickOne,
  fill,
  huntfolkTypeFromRoll,
  isRealPlayer,
  isCitizenBot,
  withinTiles,
  isHuntHour,
  dayNumber,
  chance,
  seededRng,
  HUNTFOLK_TYPES,
  HUNTFOLK_TRACKER,
  HUNTFOLK_BOWMAN,
  HUNTFOLK_TRAPPER,
  HUNTFOLK_FALCONER,
  COMMUNITY_GROUNDS,
  PREY,
  TROPHIES,
  // Test seam:
  _resetState() {
    lastFiredByCitizen.clear();
    joinLedger.clear();
    buyGameLedger.clear();
    learnLedger.clear();
    lastPruneAt = 0;
    lastLedgerPrune = 0;
  },
};
