"use strict";

/**
 * CitizenCooks2 — the cooking folk: home cooks, street vendors, feast cooks
 * and soup-kitchen helpers who feed the community from village hearths,
 * market stalls and communal ovens.
 *
 * WHAT IT DOES (data tier, free):
 *   Hash-derived cooking-folk types, per-day community kitchens, per-day
 *   dishes derived from date + hash, rare grand-feast events (~8%/spot/
 *   day) seeded into CitizenRumors, 7-day-TTL player ledgers for buying
 *   meals, learning recipes and helping cook.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players,
 * 06:00-21:00 local): scripted stirring/serving/hawking emotes, grand-feast
 * fanfare as the crowd moment, meal-selling and recipe-teaching offers.
 *
 * NO OVERLAP (by design):
 *   - CitizenCooks owns the PROFESSIONAL trade (chefs, bakers, street-vendor
 *     pros, the named kitchens, commercial hawking, recipe teaching for
 *     coin). Professional cooks are EXCLUDED from cookfolkTypeOf.
 *   - CitizenFarmers owns ingredients; cooking folk read the real seasonal
 *     tables so their dishes match what is in season.
 *   - CitizenInnkeepers own tavern food; this module owns hearths, stalls
 *     and charity kitchens only.
 *
 * Zero LLM: all lines from scripted pools; the journal feeds the LLM mouth.
 *
 * Visibility throttle: chance + 3h cooldown (huntfolk/minerfolk/fisherfolk/
 * watchmen2/healers2 precedent) — deliberately NO new primary-hobby key,
 * so adding this module does not reshuffle every citizen's primary hobby.
 *
 * Wired into the director tick right after the huntfolk block.
 * Plain-node testable: CitizenCooks2.test.js.
 */

const { normalizeName } = require("./CitizenBonds");
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { sayPublic } = require("../chat/CitizenSayPublic");


// Top-level safeRequire (potters perf lesson): the pro-cook exclusion
// check runs per citizen per tick, so no lazy requires in that path.
function safeRequire(path) {
  try {
    return require(path);
  } catch {
    return null;
  }
}
const ProCooks = safeRequire("./CitizenCooks");
const Farmers = safeRequire("./CitizenFarmers");
const REGIONAL_DISHES = (ProCooks && ProCooks.REGIONAL_DISHES) || {
  misthalin: ["shepherd's pie", "Varrock stew"],
  kandarin: ["Ardougne spiced curry"],
  asgarnia: ["Falador roast boar"],
  keldagrim: ["dwarven rockcake"],
  morytania: ["swamp paste tart"],
  kharidian: ["spiced desert flatbread"],
};
const SEASONAL_SPECIALS = (ProCooks && ProCooks.SEASONAL_SPECIALS) || {
  spring: ["wild garlic soup"],
  summer: ["sweetcorn fritters"],
  autumn: ["pumpkin pie"],
  winter: ["hearty mutton stew"],
};
const STREET_FOOD = (ProCooks && ProCooks.STREET_FOOD) || [
  "skewered kebabs",
  "roast corn on the cob",
  "baked potatoes",
  "sausage rolls",
];
const FALLBACK_PRODUCE = {
  spring: ["cabbage", "onion", "milk", "eggs"],
  summer: ["wheat", "sweetcorn", "milk", "eggs"],
  autumn: ["wheat", "potato", "pumpkin", "mutton"],
  winter: ["milk", "eggs"],
};

// === Tuning: all magic numbers here ===
const COOKFOLK_RADIUS = 14; // tiles — close enough to see/hear
const COOKFOLK_CITIZEN_COOLDOWN_MS = 3 * 60 * 60 * 1000; // a citizen fires at most every 3h
const COOKFOLK_CHANCE = 0.15; // per eligible citizen per tick
// Nominal share of commoners who cook for the community.
const COOKFOLK_SHARE = 40;
const DAWN_HOUR = 6; // 06:00 local
const NIGHT_HOUR = 21; // 21:00 local
const FEAST_CHANCE = 0.08; // grand-feast event, per spot per day
const LEDGER_TTL_MS = 7 * 24 * 3600 * 1000;

// === Cooking-folk types ===
const COOKFOLK_HOME = "home-cook";
const COOKFOLK_VENDOR = "street-vendor";
const COOKFOLK_FEAST = "feast-cook";
const COOKFOLK_SOUP = "soup-kitchen";
const COOKFOLK_TYPES = [
  COOKFOLK_HOME,
  COOKFOLK_VENDOR,
  COOKFOLK_FEAST,
  COOKFOLK_SOUP,
];
const COOKFOLK_WEIGHTS = {
  [COOKFOLK_HOME]: 30,
  [COOKFOLK_VENDOR]: 30,
  [COOKFOLK_FEAST]: 25,
  [COOKFOLK_SOUP]: 15,
};

// === Community kitchens (village hearths, market stalls, communal ovens) ===
const COMMUNITY_KITCHENS = [
  { name: "the Varrock village hearth", kingdom: "misthalin", kind: "hearth" },
  { name: "the Lumbridge communal oven", kingdom: "misthalin", kind: "oven" },
  { name: "the Draynor market food stalls", kingdom: "misthalin", kind: "stall" },
  { name: "the Falador soup kitchen", kingdom: "asgarnia", kind: "soup" },
  { name: "the Rimmington harvest feast-hall", kingdom: "asgarnia", kind: "hall" },
  { name: "the Ardougne street food row", kingdom: "kandarin", kind: "stall" },
  { name: "the Hemenster communal kitchen", kingdom: "kandarin", kind: "hearth" },
  { name: "the Keldagrim miners' cookhouse", kingdom: "keldagrim", kind: "hall" },
  { name: "the Darkmeyer night soup pot", kingdom: "morytania", kind: "soup" },
  { name: "the Al Kharid date-palm food court", kingdom: "kharidian", kind: "stall" },
];

// === Scripted lines ===
const WORK_LINES = {
  [COOKFOLK_HOME]: [
    "Dinner's nearly on — mind the little ones at the table.",
  ],
  [COOKFOLK_VENDOR]: [
    "Hot food, fair price — step right up!",
  ],
  [COOKFOLK_FEAST]: [
    "Forty mouths to feed at the feast — pass me the carving knife!",
  ],
  [COOKFOLK_SOUP]: [
    "Nobody goes hungry tonight — there's always another ladle.",
  ],
};

// (DISH_LINES removed 2026-10-08 with fabrication branches.)

// (SELL_LINES removed 2026-10-08 with fabrication branches.)

// (SHARE_LINES removed 2026-10-08 with fabrication branches.)

const TEACH_LINES = [
  "Want to learn the trick of a good {dish}? Watch close.",
  "I can teach you my {dish} — it's all in the timing.",
];

const HELP_LINES = [
  "Extra hands make light work — want to help stir?",
  "Could use a hand with the chopping, if you've a minute.",
];

const FEAST_LINES = [
  "The grand feast at {kitchen} is ON! Tables groaning with {dish}!",
  "Feast day! {kitchen} is serving {dish} to all who come!",
  "They're still talking about the feast — {dish} at {kitchen}!",
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
const buyMealLedger = new Map(); // normName -> { dish, price, at }
const learnLedger = new Map(); // normName -> { recipe, at }
const helpLedger = new Map(); // normName -> { kitchen, at }
let lastLedgerPrune = 0;
function pruneLedgers(nowMs) {
  if (nowMs - lastLedgerPrune < 3600 * 1000) return;
  lastLedgerPrune = nowMs;
  for (const [map] of [[buyMealLedger], [learnLedger], [helpLedger]]) {
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

/** Weighted pick of a cookfolk type from a 0..99 roll. */
function cookfolkTypeFromRoll(roll) {
  let acc = 0;
  for (const t of COOKFOLK_TYPES) {
    acc += COOKFOLK_WEIGHTS[t];
    if (roll < acc) return t;
  }
  return COOKFOLK_HOME;
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

/** True during cooking hours (06:00-21:00 server-local time). */
function isCookHour(nowMs) {
  const h = new Date(nowMs).getHours();
  return h >= DAWN_HOUR && h < NIGHT_HOUR;
}

// ============================================================================
// Cooking-folk identity — hash-derived, stable across restarts, no storage.
// ============================================================================

/**
 * The cookfolk type for a roster record, or null.
 * Excludes professional cooks (CitizenCooks owns the trade) so no citizen
 * belongs to both the professional kitchens and the community hearths.
 * Activity system: any other commoner may cook for the community.
 */
function cookfolkTypeOf(record) {
  try {
    const role = record?.role ?? record?.attributes?.role;
    if (role && role !== "commoner" && role !== "COMMONER") return null;
    const username = record?.username;
    const name = normalizeName(username);
    if (!name) return null;
    // No overlap: professional cooks own the trade.
    try {
      if (ProCooks && typeof ProCooks.cookTypeFor === "function" && ProCooks.cookTypeFor(username)) {
        return null;
      }
    } catch {
      /* pro module absent or threw — treat as non-pro */
    }
    const roll = hashStr("cookfolk:" + name) % 100;
    if (roll >= COOKFOLK_SHARE) return null;
    return cookfolkTypeFromRoll(hashStr("cookfolktype:" + name) % 100);
  } catch {
    return null;
  }
}

/** Kingdom-preferred community kitchen, stable across restarts. */
function kitchenFor(record) {
  const kid = record?.kingdomId;
  const local = COMMUNITY_KITCHENS.filter((k) => k.kingdom === kid);
  const pool = local.length ? local : COMMUNITY_KITCHENS;
  const name = normalizeName(record?.username) || "anon";
  return pool[hashStr("cookfolkkitchen:" + name) % pool.length];
}

/**
 * What's in season today — read from the real CitizenFarmers tables
 * (static fallback), so the cooking folk's dishes match the harvest.
 */
function seasonNameFor(dateMs) {
  try {
    if (Farmers && typeof Farmers.seasonFor === "function") {
      return Farmers.seasonFor(new Date(dateMs).getMonth());
    }
  } catch {
    /* farmers absent */
  }
  return "summer";
}

// (produceForToday removed 2026-10-08: hash-derived fabrication.)

// (dishForToday removed 2026-10-08: hash-derived fabrication.)

// (menuFor removed 2026-10-08: hash-derived fabrication.)

// (feastFor removed 2026-10-08: hash-derived fabrication.)

// (priceFor removed 2026-10-08: hash-derived fabrication.)

// ============================================================================
// Player ledgers (data tier, zero LLM) — exported for the LLM dialogue tier.
// ============================================================================

/** Record that a player bought a community meal. */
function buyMeal(playerName, dish, price, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name || !dish) return null;
  pruneLedgers(nowMs);
  buyMealLedger.set(name, { dish: String(dish), price: Number(price) || 0, at: nowMs });
  return dish;
}

/** The last community meal a player bought, or null. */
function mealFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = buyMealLedger.get(name);
  return rec ? { dish: rec.dish, price: rec.price } : null;
}

/** Record that a player learned a recipe from a cooking-folk citizen. */
function learnRecipe(playerName, recipe, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name || !recipe) return null;
  pruneLedgers(nowMs);
  learnLedger.set(name, { recipe: String(recipe), at: nowMs });
  return recipe;
}

/** The last recipe a player learned, or null. */
function recipeFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = learnLedger.get(name);
  return rec ? rec.recipe : null;
}

/** Record that a player helped cook at a community kitchen. */
function helpCook(playerName, kitchen, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name || !kitchen) return null;
  pruneLedgers(nowMs);
  helpLedger.set(name, { kitchen: String(kitchen), at: nowMs });
  return kitchen;
}

/** The last community kitchen a player helped at, or null. */
function helpedCookFor(playerName, nowMs = Date.now()) {
  const name = normalizeName(playerName);
  if (!name) return null;
  pruneLedgers(nowMs);
  const rec = helpLedger.get(name);
  return rec ? rec.kitchen : null;
}

// ============================================================================
// Journal + rumor helpers.
// ============================================================================

// Canonical: getJournal().log(name, kind, text). The appendEntry/addEntry
// probe pattern is dead — CitizenJournal only exports getJournal() with a
// log() method.
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

// ============================================================================
// The tick function — called from the director tick.
// Gate order: cooldown (cheapest) → cookfolk? → materialized → cooking
// hours → real player near → chance → work.
// ============================================================================

function tickCookfolk(director, nowMs, desync = 0) {
  pruneCooldowns(nowMs);
  const now = nowMs + desync * 1000;
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Cooldown gate — O(1), skips almost everyone
        const last = lastFiredByCitizen.get(record.username) || 0;
        if (nowMs - last < COOKFOLK_CITIZEN_COOLDOWN_MS) continue;

        // 2. Must be community cooking folk (hash-derived, cheap)
        const type = cookfolkTypeOf(record);
        if (!type) continue;

        // 3. Citizen must be materialized (near a player already)
        const citizen = (director.isOnline(record) ? director.getBot(record) : null);
        if (!citizen) continue;

        // 4. Cooking hours only (dawn to late, server-local)
        if (!isCookHour(now)) continue;

        // 5. A real player must be within earshot
        if (!anyRealPlayerNear(director, citizen, COOKFOLK_RADIUS)) continue;

        // 6. Chance gate
        if (!chance(Math.random, COOKFOLK_CHANCE)) continue;

        // 7. Do the thing (scripted, zero LLM)
        doCookfolkWork(director, record, citizen, type, nowMs);
        lastFiredByCitizen.set(record.username, nowMs);
      } catch (e) {
        // Per-citizen: never let one bad record kill the tick.
        console.warn("[citizen-cookfolk] citizen failed:", e?.message ?? e);
      }
    }
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-cookfolk] tick failed:", e?.message ?? e);
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

function doCookfolkWork(director, record, citizen, type, nowMs) {
  const kitchen = kitchenFor(record);

  // Grand feast: once per kitchen per day, the crowd moment.
  // (Crowd-moment fabrication block removed 2026-10-08: feastFor was hash-derived.)

  // Routine: honest ambient chatter only — cooking, teaching, help.
  // (Dish/serve/sell/share branches removed 2026-10-08: menuFor/dishForToday/
  // priceFor were hash-derived fabrication — the citizen never cooked those dishes.)
  const roll = Math.random();
  if (roll < 0.5) {
    const line = pickOne(Math.random, WORK_LINES[type]);
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
    journalize(citizen, `cooked at ${kitchen.name}`);
  } else if (roll < 0.75) {
    const line = pickOne(Math.random, TEACH_LINES);
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
    journalize(citizen, `shared cooking wisdom at ${kitchen.name}`);
  } else {
    const line = pickOne(Math.random, HELP_LINES);
    { const _cvp = citizen.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(citizen, voiceLine(voiceFor(_cvp), { plain: [line] })); }
    journalize(citizen, `asked for help at ${kitchen.name}`);
  }
}

module.exports = {
  tickCookfolk,
  // Public API (data tier, zero LLM) for the LLM dialogue tier:
  cookfolkTypeOf,
  kitchenFor,
  seasonNameFor,
  buyMeal,
  mealFor,
  learnRecipe,
  recipeFor,
  helpCook,
  helpedCookFor,
  // Pure helpers for tests:
  hashStr,
  pickOne,
  fill,
  cookfolkTypeFromRoll,
  isRealPlayer,
  isCitizenBot,
  withinTiles,
  isCookHour,
  dayNumber,
  chance,
  seededRng,
  COOKFOLK_TYPES,
  COOKFOLK_HOME,
  COOKFOLK_VENDOR,
  COOKFOLK_FEAST,
  COOKFOLK_SOUP,
  COMMUNITY_KITCHENS,
  // Test seam:
  _resetState() {
    lastFiredByCitizen.clear();
    buyMealLedger.clear();
    learnLedger.clear();
    helpLedger.clear();
    lastPruneAt = 0;
    lastLedgerPrune = 0;
  },
};
