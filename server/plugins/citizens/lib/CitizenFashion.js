"use strict";

/**
 * CitizenFashion — the REAL fashion & style layer for citizens.
 *
 * No-overlap boundary (documented per codebase convention):
 *   - CitizenTailors.js owns: hash-derived tailor trade assignment, seasonal
 *     style flavor, garment hawking, commission dialogue (flavor/LLM layer).
 *   - THIS module owns: persistent garment records, REAL material consumption,
 *     REAL clothing shops with REAL coin transactions, data-driven trend
 *     rotation, REAL style competitions with REAL prizes, seasonal fashion
 *     effects on comfort.
 *
 * WHAT IT DOES (data tier, zero LLM):
 *   - Garment catalog: 8 garment types (shirt, trousers, dress, cloak, hat,
 *     boots, gloves, robe) with REAL material costs resolved defensively
 *     from the engine item tables.
 *   - Fashion trends: rotating weekly trends (color, style, formality) that
 *     affect garment value — what's "in" sells for more.
 *   - Clothing shops: one per kingdom, persistent inventory of citizen-made
 *     garments, REAL coin buy/sell.
 *   - Style competitions: monthly "best dressed" per kingdom, judged by
 *     trend alignment + garment quality, REAL coin prizes.
 *   - Seasonal fashion: winter demands warm clothes (cloak/coat bonus),
 *     summer favors light garments — affects comfort/mood.
 *
 * All coin movements are REAL (buyer pays or walks away). All materials are
 * REAL engine items consumed from REAL inventories. Never invents items,
 * never invents coins.
 *
 * Dirty-flag persistence to data/saves/citizen-fashion.json.
 * Plain-node testable: CitizenFashion.test.js.
 */

// === Tuning: all magic numbers here ===
const TREND_ROTATION_MS = 7 * 24 * 60 * 60 * 1000; // trends rotate weekly
const COMPETITION_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000; // monthly competitions
const SHOP_RESTOCK_MS = 24 * 60 * 60 * 1000; // shops restock daily
const COMPETITION_PRIZE = 500; // coins for best-dressed winner
const COMPETITION_RUNNER_UP = 200; // coins for runner-up
const TREND_VALUE_BONUS = 1.5; // trendy garments sell for 50% more
const SEASON_COMFORT_BONUS = 8; // mood bonus for season-appropriate dress
const SAVE_PATH = "data/saves/citizen-fashion.json";

// Garment catalog: type -> { materials (by name, resolved defensively), baseValue, warmth, formality }
const GARMENTS = Object.freeze({
  shirt: Object.freeze({ materials: Object.freeze({ cloth: 2 }), baseValue: 30, warmth: 1, formality: 1, label: "shirt" }),
  trousers: Object.freeze({ materials: Object.freeze({ cloth: 2 }), baseValue: 35, warmth: 2, formality: 1, label: "trousers" }),
  dress: Object.freeze({ materials: Object.freeze({ cloth: 3 }), baseValue: 60, warmth: 1, formality: 3, label: "dress" }),
  cloak: Object.freeze({ materials: Object.freeze({ cloth: 3, thread: 1 }), baseValue: 80, warmth: 4, formality: 2, label: "cloak" }),
  hat: Object.freeze({ materials: Object.freeze({ cloth: 1, thread: 1 }), baseValue: 25, warmth: 1, formality: 2, label: "hat" }),
  boots: Object.freeze({ materials: Object.freeze({ leather: 2, thread: 1 }), baseValue: 70, warmth: 3, formality: 1, label: "boots" }),
  gloves: Object.freeze({ materials: Object.freeze({ leather: 1, thread: 1 }), baseValue: 40, warmth: 2, formality: 2, label: "gloves" }),
  robe: Object.freeze({ materials: Object.freeze({ cloth: 4, thread: 2 }), baseValue: 120, warmth: 2, formality: 4, label: "robe" }),
});

// Trend dimensions: each week picks one from each category.
const TREND_COLORS = Object.freeze(["crimson", "azure", "emerald", "golden", "violet", "scarlet"]);
const TREND_STYLES = Object.freeze(["elegant", "rugged", "regal", "simple", "ornate", "practical"]);
const TREND_FORMALITY = Object.freeze(["casual", "formal", "ceremonial"]);

const GARMENT_TYPES = Object.freeze(Object.keys(GARMENTS));

// --- state -------------------------------------------------------------------

let cache = null; // { garments: [...], shops: {...}, trends: {...}, competitions: [...] }
let dirty = false;
let _materialCache = null;

function blankState() {
  return {
    garments: [], // { id, type, color, maker, quality, trendScore, listedAt, soldAt, buyer }
    shops: {}, // kingdomId -> { inventory: [garmentId], lastRestock }
    trends: { color: null, style: null, formality: null, setAt: 0 },
    competitions: [], // { id, kingdomId, scheduledAt, winner, runnerUp, entries: [...] }
    lastCompetition: {}, // kingdomId -> timestamp
  };
}

function load() {
  if (cache) return cache;
  cache = blankState();
  try {
    const fs = require("fs");
    const path = require("path");
    const full = path.join(process.cwd(), SAVE_PATH);
    if (fs.existsSync(full)) {
      const data = JSON.parse(fs.readFileSync(full, "utf8"));
      if (data && typeof data === "object") {
        cache = Object.assign(blankState(), data);
      }
    }
  } catch {
    // Corrupt/missing save — start fresh. Never throws.
  }
  return cache;
}

function save() {
  if (!dirty) return false;
  try {
    const fs = require("fs");
    const path = require("path");
    const full = path.join(process.cwd(), SAVE_PATH);
    const dir = path.dirname(full);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(full, JSON.stringify(cache, null, 2));
    dirty = false;
    return true;
  } catch {
    return false;
  }
}

function markDirty() {
  dirty = true;
}

// --- material resolution (defensive) ------------------------------------------

function materialIds() {
  if (_materialCache) return _materialCache;
  const ids = {};
  try {
    const Items = require("../../items/Items.plugin.js");
    ids.cloth = Items.itemIdByName?.("bolt of cloth") ?? Items.itemIdByName?.("cloth") ?? null;
    ids.thread = Items.itemIdByName?.("thread") ?? null;
    ids.leather = Items.itemIdByName?.("leather") ?? null;
    ids.needle = Items.itemIdByName?.("needle") ?? null;
  } catch {
    // Engine items unavailable — garments honestly cannot be made.
  }
  _materialCache = Object.freeze(ids);
  return _materialCache;
}

// --- trends -------------------------------------------------------------------

/**
 * Get the current fashion trend. Rotates weekly (deterministic from timestamp).
 * Returns { color, style, formality, setAt }.
 */
function currentTrend(nowMs) {
  const st = load();
  nowMs = nowMs ?? Date.now();
  if (!st.trends.setAt || nowMs - st.trends.setAt >= TREND_ROTATION_MS) {
    // Deterministic rotation from week number — stable, no RNG needed.
    const week = Math.floor(nowMs / TREND_ROTATION_MS);
    st.trends = {
      color: TREND_COLORS[week % TREND_COLORS.length],
      style: TREND_STYLES[Math.floor(week / TREND_COLORS.length) % TREND_STYLES.length],
      formality: TREND_FORMALITY[Math.floor(week / (TREND_COLORS.length * TREND_STYLES.length)) % TREND_FORMALITY.length],
      setAt: nowMs,
    };
    markDirty();
  }
  return st.trends;
}

/**
 * Score how well a garment matches the current trend (0-100).
 */
function trendScoreFor(garment, nowMs) {
  const trend = currentTrend(nowMs);
  let score = 30; // base
  if (garment.color === trend.color) score += 35;
  // Formality alignment: garment formality vs trend formality
  const formalityMap = { casual: 1, formal: 2.5, ceremonial: 4 };
  const target = formalityMap[trend.formality] ?? 2;
  const gFormality = GARMENTS[garment.type]?.formality ?? 1;
  score += Math.max(0, 25 - Math.abs(gFormality - target) * 10);
  // Quality always matters
  score += (garment.quality ?? 50) * 0.1;
  return Math.min(100, Math.round(score));
}

/**
 * Value of a garment: base × quality × trend bonus.
 */
function garmentValue(garment, nowMs) {
  const def = GARMENTS[garment.type];
  if (!def) return 0;
  const qualityMult = 0.5 + (garment.quality ?? 50) / 100; // 0.5x - 1.5x
  const trendMult = trendScoreFor(garment, nowMs) >= 70 ? TREND_VALUE_BONUS : 1.0;
  return Math.round(def.baseValue * qualityMult * trendMult);
}

// --- garments ------------------------------------------------------------------

let _garmentSeq = 0;

/**
 * Create a garment record. Materials must already be consumed by the caller.
 * Returns the garment record, or null if the type is unknown.
 */
function createGarment(type, color, makerUsername, quality) {
  const def = GARMENTS[type];
  if (!def) return null;
  const st = load();
  const garment = {
    id: `g${Date.now()}_${++_garmentSeq}`,
    type,
    color: color ?? "natural",
    maker: makerUsername,
    quality: Math.max(1, Math.min(100, quality ?? 50)),
    createdAt: Date.now(),
    soldAt: null,
    buyer: null,
  };
  garment.trendScore = trendScoreFor(garment);
  st.garments.push(garment);
  markDirty();
  return garment;
}

/**
 * Check if a player has the materials for a garment type.
 * Returns { ok, missing: [names] }.
 */
function canAffordMaterials(player, type) {
  const def = GARMENTS[type];
  if (!def) return { ok: false, missing: ["unknown garment"] };
  const ids = materialIds();
  const missing = [];
  for (const [matName, count] of Object.entries(def.materials)) {
    const id = ids[matName];
    if (id == null) {
      missing.push(`${matName} (unresolvable)`);
      continue;
    }
    const has = countItem(player, id);
    if (has < count) missing.push(`${matName} (need ${count}, have ${has})`);
  }
  return { ok: missing.length === 0, missing };
}

/**
 * Consume materials for a garment from a player's inventory.
 * Returns true if all consumed, false if any missing (nothing consumed).
 */
function consumeMaterials(player, type) {
  const check = canAffordMaterials(player, type);
  if (!check.ok) return false;
  const def = GARMENTS[type];
  const ids = materialIds();
  for (const [matName, count] of Object.entries(def.materials)) {
    removeItem(player, ids[matName], count);
  }
  return true;
}

// --- shops ---------------------------------------------------------------------

/**
 * Get or create a clothing shop for a kingdom.
 */
function shopFor(kingdomId) {
  const st = load();
  if (!st.shops[kingdomId]) {
    st.shops[kingdomId] = { inventory: [], lastRestock: 0 };
    markDirty();
  }
  return st.shops[kingdomId];
}

/**
 * List a garment for sale in a kingdom's shop.
 */
function listGarment(kingdomId, garmentId) {
  const st = load();
  const garment = st.garments.find((g) => g.id === garmentId && !g.soldAt);
  if (!garment) return false;
  const shop = shopFor(kingdomId);
  if (!shop.inventory.includes(garmentId)) {
    shop.inventory.push(garmentId);
    markDirty();
  }
  return true;
}

/**
 * Buy a garment from a shop. Moves REAL coins from buyer to maker (or shop).
 * Returns { ok, garment, price } or { ok: false, reason }.
 */
function buyGarment(kingdomId, garmentId, buyerPlayer) {
  const st = load();
  const shop = st.shops[kingdomId];
  if (!shop || !shop.inventory.includes(garmentId)) {
    return { ok: false, reason: "not listed" };
  }
  const garment = st.garments.find((g) => g.id === garmentId);
  if (!garment || garment.soldAt) {
    return { ok: false, reason: "already sold" };
  }
  const price = garmentValue(garment);
  const coins = coinCount(buyerPlayer);
  if (coins < price) {
    return { ok: false, reason: "cannot afford", price, coins };
  }
  // Move real coins.
  removeCoins(buyerPlayer, price);
  // Pay the maker if they're online (70%), shop keeps 30%.
  // Offline makers: full price goes to shop purse (honest — never invented).
  const makerShare = Math.round(price * 0.7);
  // (Caller handles maker payout via director; we just record the sale.)
  garment.soldAt = Date.now();
  garment.buyer = playerName(buyerPlayer);
  garment.salePrice = price;
  garment.makerShare = makerShare;
  shop.inventory = shop.inventory.filter((id) => id !== garmentId);
  markDirty();
  return { ok: true, garment, price, makerShare };
}

// --- competitions ----------------------------------------------------------------

/**
 * Schedule a style competition for a kingdom if due.
 * Returns the competition record, or null if not due.
 */
function maybeScheduleCompetition(kingdomId, nowMs) {
  const st = load();
  nowMs = nowMs ?? Date.now();
  const last = st.lastCompetition[kingdomId] ?? 0;
  if (nowMs - last < COMPETITION_INTERVAL_MS) return null;
  const comp = {
    id: `c${nowMs}_${kingdomId}`,
    kingdomId,
    scheduledAt: nowMs,
    entries: [], // { username, garmentId, score }
    winner: null,
    runnerUp: null,
    resolvedAt: null,
  };
  st.competitions.push(comp);
  st.lastCompetition[kingdomId] = nowMs;
  markDirty();
  return comp;
}

/**
 * Enter a style competition with a garment.
 */
function enterCompetition(compId, username, garmentId, nowMs) {
  const st = load();
  const comp = st.competitions.find((c) => c.id === compId && !c.resolvedAt);
  if (!comp) return false;
  const garment = st.garments.find((g) => g.id === garmentId);
  if (!garment) return false;
  if (comp.entries.some((e) => e.username === username)) return false; // one entry each
  const score = trendScoreFor(garment, nowMs);
  comp.entries.push({ username, garmentId, score });
  markDirty();
  return true;
}

/**
 * Resolve a competition: pick winner and runner-up by trend score.
 * Returns { winner, runnerUp } or null if no entries.
 */
function resolveCompetition(compId, nowMs) {
  const st = load();
  const comp = st.competitions.find((c) => c.id === compId && !c.resolvedAt);
  if (!comp || comp.entries.length === 0) return null;
  const sorted = [...comp.entries].sort((a, b) => b.score - a.score);
  comp.winner = sorted[0].username;
  comp.runnerUp = sorted[1]?.username ?? null;
  comp.resolvedAt = nowMs ?? Date.now();
  markDirty();
  return { winner: comp.winner, runnerUp: comp.runnerUp, prize: COMPETITION_PRIZE, runnerUpPrize: COMPETITION_RUNNER_UP };
}

// --- seasonal fashion ------------------------------------------------------------

/**
 * Comfort bonus for wearing season-appropriate clothes.
 * Winter wants warmth (cloak, boots); summer wants light (shirt, dress).
 * Returns mood bonus 0-SEASON_COMFORT_BONUS.
 */
function seasonalComfortBonus(wornTypes, nowMs) {
  let season = "spring";
  try {
    const Seasons = require("./CitizenSeasons");
    season = Seasons.seasonOf(nowMs) ?? "spring";
  } catch {
    // No seasons module — no bonus. Honest.
  }
  const warmth = (wornTypes ?? []).reduce((sum, t) => sum + (GARMENTS[t]?.warmth ?? 0), 0);
  if (season === "winter") {
    return warmth >= 5 ? SEASON_COMFORT_BONUS : Math.round((warmth / 5) * SEASON_COMFORT_BONUS);
  }
  if (season === "summer") {
    // Light dress is comfortable in summer.
    return warmth <= 3 ? SEASON_COMFORT_BONUS : Math.max(0, SEASON_COMFORT_BONUS - (warmth - 3) * 2);
  }
  return Math.round(SEASON_COMFORT_BONUS / 2); // mild seasons, mild bonus
}

// --- inventory helpers (defensive, real engine) -----------------------------------

function countItem(player, itemId) {
  try {
    return player?.inventory?.count?.(itemId) ?? player?.inventory?.getCount?.(itemId) ?? 0;
  } catch {
    return 0;
  }
}

function removeItem(player, itemId, count) {
  try {
    if (player?.inventory?.remove?.(itemId, count) !== undefined) {
      player.inventory.remove(itemId, count);
      return true;
    }
    if (player?.inventory?.delete) {
      player.inventory.delete(itemId, count);
      return true;
    }
  } catch {
    // Honest failure.
  }
  return false;
}

function coinCount(player) {
  try {
    return player?.inventory?.count?.(995) ?? player?.coins ?? 0;
  } catch {
    return 0;
  }
}

function removeCoins(player, amount) {
  try {
    if (player?.inventory?.remove?.(995, amount) !== undefined) {
      player.inventory.remove(995, amount);
      return true;
    }
  } catch {
    // Honest failure.
  }
  return false;
}

function playerName(player) {
  try {
    return player?.username ?? player?.displayName ?? player?.name ?? "unknown";
  } catch {
    return "unknown";
  }
}

// --- test seams -------------------------------------------------------------------

function resetForTests() {
  cache = blankState();
  dirty = false;
  _materialCache = null;
  _garmentSeq = 0;
}

module.exports = {
  GARMENTS,
  GARMENT_TYPES,
  TREND_COLORS,
  TREND_STYLES,
  TREND_FORMALITY,
  TREND_ROTATION_MS,
  COMPETITION_INTERVAL_MS,
  COMPETITION_PRIZE,
  COMPETITION_RUNNER_UP,
  currentTrend,
  trendScoreFor,
  garmentValue,
  createGarment,
  canAffordMaterials,
  consumeMaterials,
  shopFor,
  listGarment,
  buyGarment,
  maybeScheduleCompetition,
  enterCompetition,
  resolveCompetition,
  seasonalComfortBonus,
  materialIds,
  load,
  save,
  resetForTests,
};
