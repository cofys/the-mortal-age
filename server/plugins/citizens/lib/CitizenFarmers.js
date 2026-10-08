"use strict";

/**
 * CitizenFarmers — agricultural citizens who grow crops, raise livestock,
 * keep orchards and apiaries, and feed the cities.
 *
 * WHAT IT DOES (data tier, free):
 *   Every commoner is deterministically assigned a farmer trade (or none) from
 *   their username hash — no storage, stable across restarts. Crop stages,
 *   livestock tasks, seasonal produce, and a weather proxy are all derived
 *   from the date + hash, so the simulation runs with zero players online at
 *   zero token cost. Work events are journaled once per visible loop so the
 *   interaction-tier LLM answers "what have you been up to?" truthfully.
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players):
 *   Farmers near farmland/streets visibly work: tilling, planting, watering,
 *   harvesting, milking, shearing, feeding, pruning, checking hives — as
 *   forceChat emote lines. When produce is in season they hawk it
 *   ("Fresh apples, picked this morning!"). Players who linger get a
 *   thank-you / help offer. Actual selling rides on the existing market-stall
 *   haggle system; `farmProduceFor()` is exported so CitizenMarketStalls can
 *   stock farmer wares later.
 *
 * Zero LLM: scripted emote pools and produce lists, chance-gated.
 *
 * Weather: crops drink from a seasonal rain proxy (derived, not coupled) —
 *   rain skips the watering task; hot dry spells add it back. Ties into the
 *   CitizenWeatherReactions theme without reading its private state.
 *
 * Wired into the director tick right after the market stalls block.
 * Plain-node testable: CitizenFarmers.test.js.
 */

// === Tuning: all magic numbers here ===
const FARMER_RADIUS = 40; // tiles — visible work range (same as work loops)
const PITCH_RADIUS = 14; // tiles — hawking/produce offers, close enough to hear
const FARMER_WORK_COOLDOWN_MS = 4 * 60 * 60 * 1000; // visible work at most every 4h
const FARMER_WORK_CHANCE = 0.35; // per eligible citizen per ~60s tick
const PITCH_COOLDOWN_MS = 2 * 60 * 60 * 1000; // produce hawking at most every 2h
const PITCH_CHANCE = 0.3;

// === Farmer types ===
const FARMER_CROP = "crop";
const FARMER_LIVESTOCK = "livestock";
const FARMER_ORCHARD = "orchard";
const FARMER_APIARY = "apiary";
const FARMER_TYPES = Object.freeze([FARMER_CROP, FARMER_LIVESTOCK, FARMER_ORCHARD, FARMER_APIARY]);

// === Seasons (northern-hemisphere farming year) ===
const SEASON_SPRING = "spring";
const SEASON_SUMMER = "summer";
const SEASON_AUTUMN = "autumn";
const SEASON_WINTER = "winter";

// === Crop stages ===
const STAGE_PLOWING = "plowing";
const STAGE_PLANTING = "planting";
const STAGE_WATERING = "watering";
const STAGE_WEEDING = "weeding";
const STAGE_GROWING = "growing";
const STAGE_HARVEST = "harvest";
const STAGE_FALLOW = "fallow";

// === Cooldown state ===
const lastWorkByCitizen = new Map(); // username -> timestamp
const lastPitchByCitizen = new Map(); // username -> timestamp

// Memory-leak plug: prune entries older than a day, at most hourly.
let lastPruneAt = 0;
function pruneCooldowns(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, at] of lastWorkByCitizen) {
    if (at < cutoff) lastWorkByCitizen.delete(k);
  }
  for (const [k, at] of lastPitchByCitizen) {
    if (at < cutoff) lastPitchByCitizen.delete(k);
  }
}

// ============================================================================
// Pure helpers — testable with plain node, no engine.
// ============================================================================

/** FNV-1a 32-bit hash — deterministic, stable across restarts. */
function hashStr(s) {
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

/**
 * Farmer trade for a username, or null for a non-farmer.
 * ~40% of commoners farm; the trade is hash-derived and stable.
 */
function farmerTypeFor(username) {
  if (!username) return null;
  // Primary-profession partition: exactly one early profession per citizen.
  // The old ~40% shares survive as partition weights (CitizenPrimaryProfession).
  const { primaryProfessionFor } = require("./CitizenPrimaryProfession");
  if (primaryProfessionFor(username) !== "farmer") return null;
  const h = hashStr("farmer|" + String(username).toLowerCase());
  return FARMER_TYPES[h % FARMER_TYPES.length];
}

/** Farming season from a month index (0 = Jan). */
function seasonFor(monthIdx) {
  if (monthIdx >= 2 && monthIdx <= 4) return SEASON_SPRING;
  if (monthIdx >= 5 && monthIdx <= 7) return SEASON_SUMMER;
  if (monthIdx >= 8 && monthIdx <= 10) return SEASON_AUTUMN;
  return SEASON_WINTER;
}

/** Day-of-year (1..366) from a timestamp. */
function dayOfYear(dateMs) {
  const d = new Date(dateMs);
  const start = Date.UTC(d.getUTCFullYear(), 0, 0);
  return Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - start) / 86400000);
}

/**
 * Seasonal rain proxy — deterministic per-day rain flag from the farming
 * calendar. Spring and autumn rains, summer dry spells, winter drizzle.
 * Pure: (dateMs) => { season, rain }.
 */
function weatherProxyFor(dateMs) {
  const d = new Date(dateMs);
  const season = seasonFor(d.getUTCMonth());
  const baseRain = {
    [SEASON_SPRING]: 0.45,
    [SEASON_SUMMER]: 0.2,
    [SEASON_AUTUMN]: 0.4,
    [SEASON_WINTER]: 0.3,
  }[season];
  const roll = (hashStr("rain|" + d.getUTCFullYear() + "|" + dayOfYear(dateMs)) % 100) / 100;
  return { season, rain: roll < baseRain };
}

/**
 * Crop stage for a farmer on a date — derived from season + farmer hash so
 * neighbouring farms are out of phase (not all plowing on the same day).
 * Weather adjusts: rain skips watering (rain does the work); a dry summer
 * day adds watering back in.
 */
function cropStageFor(username, dateMs) {
  const { season, rain } = weatherProxyFor(dateMs);
  const h = hashStr("cropstage|" + String(username).toLowerCase());
  if (season === SEASON_SPRING) {
    return h % 2 === 0 ? STAGE_PLOWING : STAGE_PLANTING;
  }
  if (season === SEASON_SUMMER) {
    if (rain) return h % 2 === 0 ? STAGE_WEEDING : STAGE_GROWING;
    return h % 3 === 0 ? STAGE_WEEDING : STAGE_WATERING;
  }
  if (season === SEASON_AUTUMN) return STAGE_HARVEST;
  return STAGE_FALLOW;
}

/**
 * Livestock task from the hour of day — the daily animal rhythm.
 * Milking at dawn, feeding late morning, grazing afternoon, penning at dusk.
 */
function livestockTaskFor(dateMs) {
  const hour = new Date(dateMs).getUTCHours();
  if (hour < 7) return "milking";
  if (hour < 11) return "feeding";
  if (hour < 17) return "grazing";
  if (hour < 20) return "penning";
  return "resting";
}

/** Orchard task by season. */
function orchardTaskFor(dateMs) {
  const { season } = weatherProxyFor(dateMs);
  if (season === SEASON_SPRING) return "pruning";
  if (season === SEASON_SUMMER) return "watering";
  if (season === SEASON_AUTUMN) return "picking";
  return "mending";
}

/** Apiary task by season. */
function apiaryTaskFor(dateMs) {
  const { season } = weatherProxyFor(dateMs);
  if (season === SEASON_SPRING) return "inspecting";
  if (season === SEASON_SUMMER) return "harvesting";
  if (season === SEASON_AUTUMN) return "harvesting";
  return "wintering";
}

// === Visible work lines (forceChat emotes, zero LLM) ===
const WORK_LINES = {
  [STAGE_PLOWING]: ["*turns the soil*", "*breaks the clods*", "*guides the plow*"],
  [STAGE_PLANTING]: ["*scatters seed*", "*sets the seedlings in rows*", "*covers the furrows*"],
  [STAGE_WATERING]: ["*waters the rows*", "*hauls water to the field*", "*mends the irrigation ditch*"],
  [STAGE_WEEDING]: ["*pulls weeds*", "*hoes between the rows*", "*clears the thistles*"],
  [STAGE_GROWING]: ["*checks the young crops*", "*thins the sprouts*", "*props up the stalks*"],
  [STAGE_HARVEST]: ["*swings the scythe*", "*binds the sheaves*", "*gathers the harvest*"],
  [STAGE_FALLOW]: ["*mends the fences*", "*sharpens the tools*", "*spreads manure*"],
  milking: ["*milks the cow*", "*fills the pail*", "*soothes the cow*"],
  feeding: ["*tosses hay to the herd*", "*fills the troughs*", "*calls the flock in*"],
  grazing: ["*watches the grazing herd*", "*counts the sheep*", "*checks the pasture gate*"],
  penning: ["*pens the animals for the night*", "*latches the stable door*", "*beds down the flock*"],
  resting: ["*leans on the fence, watching the herd*"],
  pruning: ["*prunes the branches*", "*shapes the young trees*"],
  picking: ["*picks the ripe fruit*", "*fills the basket*", "*reaches for the high branches*"],
  inspecting: ["*checks the hives*", "*watches the bees work*", "*smokes the hive gently*"],
  harvesting: ["*harvests the honeycomb*", "*uncaps the frames*", "*strains the honey*"],
  wintering: ["*wraps the hives for winter*", "*checks the hive weight*", "*clears snow from the stands*"],
  mending: ["*mends the trellises*", "*sharpens the pruning shears*"],
};

/** Produce by farmer type and season — what the farm has fresh right now. */
function produceFor(type, season) {
  const table = {
    [FARMER_CROP]: {
      [SEASON_SPRING]: ["cabbage", "onion", "leek"],
      [SEASON_SUMMER]: ["wheat", "barley", "sweetcorn"],
      [SEASON_AUTUMN]: ["wheat", "potato", "pumpkin"],
      [SEASON_WINTER]: [],
    },
    [FARMER_LIVESTOCK]: {
      [SEASON_SPRING]: ["milk", "eggs", "lamb"],
      [SEASON_SUMMER]: ["milk", "eggs", "wool"],
      [SEASON_AUTUMN]: ["milk", "eggs", "wool", "mutton"],
      [SEASON_WINTER]: ["milk", "eggs"],
    },
    [FARMER_ORCHARD]: {
      [SEASON_SPRING]: [],
      [SEASON_SUMMER]: ["plum", "cherry"],
      [SEASON_AUTUMN]: ["apple", "pear", "cider"],
      [SEASON_WINTER]: [],
    },
    [FARMER_APIARY]: {
      [SEASON_SPRING]: [],
      [SEASON_SUMMER]: ["honey"],
      [SEASON_AUTUMN]: ["honey", "honeycomb"],
      [SEASON_WINTER]: [],
    },
  };
  return (table[type] && table[type][season]) || [];
}

/**
 * True when this farmer has fresh produce to sell right now.
 * Crop farmers sell at harvest; livestock farmers most of the year;
 * orchards in fruit season; apiaries when hives are full.
 */
function hasProduceReady(username, dateMs) {
  const type = farmerTypeFor(username);
  if (!type) return false;
  if (type === FARMER_CROP) return cropStageFor(username, dateMs) === STAGE_HARVEST;
  const { season } = weatherProxyFor(dateMs);
  return produceFor(type, season).length > 0;
}

/**
 * Public produce offer for market integration: { type, items, season } or null.
 * CitizenMarketStalls can consume this to stock farmer wares.
 */
function farmProduceFor(username, dateMs) {
  const type = farmerTypeFor(username);
  if (!type) return null;
  const { season } = weatherProxyFor(dateMs);
  const items = produceFor(type, season);
  if (!items.length) return null;
  return { type, items, season };
}

/** Current work task key for a farmer (what they'd visibly be doing). */
function taskFor(username, dateMs) {
  const type = farmerTypeFor(username);
  if (!type) return null;
  if (type === FARMER_CROP) return cropStageFor(username, dateMs);
  if (type === FARMER_LIVESTOCK) return livestockTaskFor(username, dateMs);
  if (type === FARMER_ORCHARD) return orchardTaskFor(dateMs);
  return apiaryTaskFor(dateMs);
}

/** Scripted work line for a task, or null. */
function workLineFor(rng, task) {
  const pool = WORK_LINES[task];
  if (!pool) return null;
  return pickOne(rng, pool);
}

/** Scripted produce pitch for a farmer with ready produce. */
function pitchLineFor(rng, username, dateMs) {
  const offer = farmProduceFor(username, dateMs);
  if (!offer) return null;
  const item = pickOne(rng, offer.items);
  return pickOne(rng, [
    `Fresh ${item}, picked this morning!`,
    `Get your fresh ${item} here!`,
    `${item[0].toUpperCase() + item.slice(1)}, straight from the farm!`,
    `Best ${item} in the kingdom, friend!`,
  ]);
}

/**
 * Decide whether this farmer should do visible work now.
 * Pure: (rng, lastWorkMs, nowMs) => boolean. Test this.
 */
function shouldFire(rng, lastWorkMs, nowMs) {
  if (nowMs - (lastWorkMs || 0) < FARMER_WORK_COOLDOWN_MS) return false;
  return rng() < FARMER_WORK_CHANCE;
}

/** Decide whether this farmer should pitch produce now. Pure. */
function shouldPitch(rng, lastPitchMs, nowMs) {
  if (nowMs - (lastPitchMs || 0) < PITCH_COOLDOWN_MS) return false;
  return rng() < PITCH_CHANCE;
}

// === Journal access (lazy require — CitizenJournal may not load in tests) ===
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

function journalEvent(citizenName, text) {
  try {
    journal()?.log(citizenName, "work", text);
  } catch {
    // Journal is best-effort; never break the tick.
  }
}

// ============================================================================
// The tick function — called from the director tick.
// Gate order: cooldown (cheapest) → farmer check → citizen exists → real
// player near → chance → work.
// ============================================================================

/**
 * @param {object} director - the CitizenDirector instance
 * @param {number} nowMs - Date.now()
 */
function tickFarmers(director, nowMs) {
  pruneCooldowns(nowMs);
  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        // 1. Only commoners farm (cheapest gates first).
        if (!record || record.role !== "commoner") continue;
        const type = farmerTypeFor(record.username);
        if (!type) continue;

        // 2. Cooldown gate — O(1), skips almost everyone.
        const last = lastWorkByCitizen.get(record.username) || 0;
        if (nowMs - last < FARMER_WORK_COOLDOWN_MS) continue;

        // 3. Citizen must be materialized (near a player already).
        const citizen = director.playerFor?.(record);
        if (!citizen) continue;

        // 4. A real player must be within sight of the farm work.
        if (!anyRealPlayerNear(director, citizen, FARMER_RADIUS)) continue;

        // 5. Chance gate, then do the visible work (scripted, zero LLM).
        if (Math.random() >= FARMER_WORK_CHANCE) continue;
        doFarmWork(director, record, citizen, type, nowMs);
        lastWorkByCitizen.set(record.username, nowMs);
      } catch {
        // One bad citizen never breaks the tick.
      }
    }

    // Produce pitching is a separate, tighter-radius pass.
    for (const record of director.roster?.values?.() ?? []) {
      try {
        if (!record || record.role !== "commoner") continue;
        const type = farmerTypeFor(record.username);
        if (!type) continue;
        if (!hasProduceReady(record.username, nowMs)) continue;
        const last = lastPitchByCitizen.get(record.username) || 0;
        if (nowMs - last < PITCH_COOLDOWN_MS) continue;
        const citizen = director.playerFor?.(record);
        if (!citizen) continue;
        if (!anyRealPlayerNear(director, citizen, PITCH_RADIUS)) continue;
        if (Math.random() >= PITCH_CHANCE) continue;
        doProducePitch(citizen, record.username, nowMs);
        lastPitchByCitizen.set(record.username, nowMs);
      } catch {
        // One bad citizen never breaks the tick.
      }
    }
  } catch (e) {
    // Never let a citizen feature crash the director tick.
    console.warn("[citizen-farmers] tick failed:", e?.message ?? e);
  }
}

/** The visible work: emote line + journal line. */
function doFarmWork(director, record, citizen, type, nowMs) {
  const task = taskFor(record.username, nowMs);
  const line = task ? workLineFor(Math.random, task) : null;
  if (!line) return;
  try {
    citizen.forceChat?.(line);
  } catch {
    // forceChat is best-effort.
  }
  // One journal line per loop — the LLM's source of truth.
  const typeLabel = {
    [FARMER_CROP]: "the fields",
    [FARMER_LIVESTOCK]: "the livestock",
    [FARMER_ORCHARD]: "the orchard",
    [FARMER_APIARY]: "the hives",
  }[type];
  journalEvent(record.username, `Worked ${typeLabel} — ${task}.`);
}

/** Produce hawking near markets/streets. */
function doProducePitch(citizen, username, nowMs) {
  const line = pitchLineFor(Math.random, username, nowMs);
  if (!line) return;
  try {
    citizen.forceChat?.(line);
  } catch {
    // forceChat is best-effort.
  }
  journalEvent(username, "Took fresh produce to sell.");
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
  tickFarmers,
  // Pure helpers for tests and market integration:
  hashStr,
  farmerTypeFor,
  seasonFor,
  dayOfYear,
  weatherProxyFor,
  cropStageFor,
  livestockTaskFor,
  orchardTaskFor,
  apiaryTaskFor,
  produceFor,
  hasProduceReady,
  farmProduceFor,
  taskFor,
  workLineFor,
  pitchLineFor,
  shouldFire,
  shouldPitch,
  pickOne,
  isRealPlayer,
  withinTiles,
  // Test seams:
  _resetState() {
    lastWorkByCitizen.clear();
    lastPitchByCitizen.clear();
    lastPruneAt = 0;
  },
};
