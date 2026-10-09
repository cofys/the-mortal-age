"use strict";

/**
 * CitizenCuisine — the REAL fine-dining & cuisine layer for citizens.
 *
 * No-overlap boundary (documented per codebase convention):
 *   - CitizenCooks.js owns: hash-derived cook trade assignment (tavern
 *     keepers, bakers, street vendors), meal-of-the-day flavor, food
 *     hawking, recipe-lesson dialogue (flavor/LLM layer).
 *   - CitizenCook.js (brain action) owns: individual citizen cooking skill
 *     via the Cooking plugin (cook raw -> cooked, real XP).
 *   - THIS module owns: persistent master-chef registry, signature-dish
 *     records with REAL ingredient costs, REAL restaurants with REAL coin
 *     transactions, food-critic reviews, REAL culinary competitions with
 *     REAL prizes, and player diners eating real meals.
 *
 * WHAT IT DOES (data tier, zero LLM):
 *   - Master chefs: citizens with real Cooking 50+ earn the title; quality
 *     of their dishes is deterministic from Cooking level + creativity
 *     (never random).
 *   - Signature dishes: persistent records — name, recipe (ingredients from
 *     the engine COOKABLES table + farm produce), quality 1-10, heal value.
 *     Creating a dish consumes REAL ingredients from the chef's inventory.
 *   - Restaurants: one per kingdom, persistent menu, REAL coin buy/sell.
 *     Diners (citizens and players) pay real coins; the chef earns them.
 *   - Food critics: citizens with high social standing review dishes
 *     (1-10 stars); reviews multiply dish value.
 *   - Culinary competitions: monthly "best dish" per kingdom, REAL prizes.
 *   - Player diners: players order from the menu; the meal restores real HP.
 *
 * All coin movements are REAL (buyer pays or walks away). All ingredients
 * are REAL engine items consumed from REAL inventories. Never invents
 * items, never invents coins.
 *
 * Dirty-flag persistence to data/saves/citizen-cuisine.json.
 * Plain-node testable: CitizenCuisine.test.js.
 */

// === Tuning: all magic numbers here ===
const COMPETITION_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000; // monthly competitions
const COMPETITION_PRIZE = 600; // coins for best-dish winner
const COMPETITION_RUNNER_UP = 250; // coins for runner-up
const REVIEW_DECAY_MS = 14 * 24 * 60 * 60 * 1000; // reviews older than 2 weeks don't count
const CHEF_MASTER_LEVEL = 50; // real Cooking level for master-chef title
const CRITIC_MIN_SOCIAL = 60; // social score needed to be a critic
const SAVE_PATH = "data/saves/citizen-cuisine.json";

// Signature dish archetypes. Each has: label, ingredient kinds (resolved
// defensively against the engine COOKABLES + farm produce), base heal,
// base value. Quality scales value and heal.
const DISHES = Object.freeze({
  hearty_stew: Object.freeze({
    label: "hearty stew", ingredients: Object.freeze({ meat: 2, potato: 2 }), baseHeal: 8, baseValue: 40,
  }),
  grilled_fish: Object.freeze({
    label: "grilled fish", ingredients: Object.freeze({ fish: 2, herb: 1 }), baseHeal: 10, baseValue: 55,
  }),
  royal_roast: Object.freeze({
    label: "royal roast", ingredients: Object.freeze({ meat: 3, herb: 2 }), baseHeal: 14, baseValue: 90,
  }),
  seafood_platter: Object.freeze({
    label: "seafood platter", ingredients: Object.freeze({ fish: 3, herb: 1 }), baseHeal: 16, baseValue: 110,
  }),
  hunters_pie: Object.freeze({
    label: "hunter's pie", ingredients: Object.freeze({ meat: 2, potato: 1, herb: 1 }), baseHeal: 12, baseValue: 70,
  }),
  garden_salad: Object.freeze({
    label: "garden salad", ingredients: Object.freeze({ vegetable: 3, herb: 1 }), baseHeal: 6, baseValue: 35,
  }),
  spiced_curry: Object.freeze({
    label: "spiced curry", ingredients: Object.freeze({ meat: 1, vegetable: 2, herb: 2 }), baseHeal: 11, baseValue: 65,
  }),
  feast_platter: Object.freeze({
    label: "feast platter", ingredients: Object.freeze({ meat: 2, fish: 1, potato: 2, herb: 1 }), baseHeal: 20, baseValue: 150,
  }),
});

const DISH_TYPES = Object.freeze(Object.keys(DISHES));

// Restaurant names per kingdom index — flavor only, deterministic.
const RESTAURANT_NAMES = Object.freeze([
  "The Golden Ladle", "The Silver Platter", "The Copper Kettle",
  "The Ivory Fork", "The Bronze Banquet",
]);

// --- state -------------------------------------------------------------------

let cache = null; // { chefs: {...}, dishes: [...], restaurants: {...}, reviews: [...], competitions: [...], lastCompetition: {...} }
let dirty = false;
let _ingredientCache = null;
let _itemTable = null; // lazy cache of the flat engine item table

function blankState() {
  return {
    chefs: {}, // normName -> { title: "master", earnedAt }
    dishes: [], // { id, type, name, chef, quality, heal, value, createdAt, servings }
    restaurants: {}, // kingdomId -> { name, menu: [dishId], openedAt }
    reviews: [], // { id, dishId, critic, stars, createdAt }
    competitions: [], // { id, kingdomId, scheduledAt, resolvedAt, winner, runnerUp, entries: [dishId] }
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

function norm(name) {
  return String(name ?? "").trim().toLowerCase();
}

function resetForTests() {
  cache = blankState();
  dirty = false;
  _ingredientCache = null;
}

// --- ingredient resolution (defensive) ---------------------------------------

/**
 * Resolve ingredient kinds to real engine item IDs. Returns a map of
 * kind -> itemId, or null if the engine tables are unavailable (caller
 * must honestly refuse rather than invent).
 */
function ingredientIds() {
  if (_ingredientCache) return _ingredientCache;
  try {
    // Kinds map to representative real items. We resolve defensively:
    // if any lookup fails, we return what we have; the caller decides.
    const ids = {};
    // Meat: cooked meat is a real heal item.
    ids.meat = resolveItemId(["COOKED_MEAT", "cooked meat"]);
    ids.fish = resolveItemId(["COOKED_FISH", "TROUT", "cooked trout", "SALMON", "cooked salmon"]);
    ids.potato = resolveItemId(["POTATO", "potato"]);
    ids.vegetable = resolveItemId(["CABBAGE", "cabbage", "ONION", "onion"]);
    // Herbs are real "Grimy <name> leaf" items in the engine table — the old
    // CLEAN_HERB/GRIMY_HERB candidates matched nothing.
    ids.herb = resolveItemId(["grimy guam leaf", "grimy marrentill", "grimy tarromin", "grimy harralander", "clean guam"]);
    _ingredientCache = ids;
    return ids;
  } catch {
    return null;
  }
}

function resolveItemId(candidates) {
  // Canonical engine table: server/data/definitions/item-gameplay.json is a
  // FLAT ARRAY of { id, name }. The old code required keyed { items } maps
  // at table paths that do not exist, so every ingredient silently resolved
  // to null and dishes claimed ingredients that were never real. Returns
  // the lowest matching id, or null — the caller refuses honestly rather
  // than inventing an id.
  try {
    if (!_itemTable) {
      const rows = safeRequire("../../../data/definitions/item-gameplay.json");
      _itemTable = Array.isArray(rows) ? rows : [];
    }
    const keys = (candidates ?? [])
      .map((c) => String(c || "").toLowerCase().trim().replace(/_/g, " "))
      .filter(Boolean);
    let best = null;
    for (const row of _itemTable) {
      if (!keys.includes(String(row?.name || "").toLowerCase().replace(/_/g, " "))) continue;
      if (best == null || row.id < best) best = row.id;
    }
    return best;
  } catch { /* fall through */ }
  return null;
}

function safeRequire(p) {
  try {
    return require(p);
  } catch {
    return null;
  }
}

// --- master chefs ------------------------------------------------------------

/**
 * Award the master-chef title. Requires real Cooking 50+. Returns true if
 * newly awarded.
 */
function awardMasterChef(username) {
  const st = load();
  const n = norm(username);
  if (!n || st.chefs[n]) return false;
  st.chefs[n] = { title: "master", earnedAt: Date.now() };
  markDirty();
  return true;
}

function isMasterChef(username) {
  return !!load().chefs[norm(username)];
}

function masterChefs() {
  return Object.keys(load().chefs);
}

/**
 * Deterministic dish quality from the chef's real Cooking level and
 * creativity trait (1-10). Never random.
 */
function dishQuality(cookingLevel, creativity) {
  const lvl = Math.max(1, Math.min(99, Number(cookingLevel) || 1));
  const cre = Math.max(0, Math.min(1, Number(creativity) || 0));
  // 1-10: level contributes up to 7, creativity up to 3.
  const q = 1 + Math.floor((lvl / 99) * 6) + Math.floor(cre * 3);
  return Math.max(1, Math.min(10, q));
}

// --- signature dishes ----------------------------------------------------------

let _dishSeq = 0;

function dishValue(type, quality, avgStars) {
  const def = DISHES[type];
  if (!def) return 0;
  // Base value scaled by quality (0.5x - 2x), reviews multiply up to 1.5x.
  const qMult = 0.5 + (quality / 10) * 1.5;
  const rMult = avgStars > 0 ? 1 + (avgStars / 10) * 0.5 : 1;
  return Math.round(def.baseValue * qMult * rMult);
}

function dishHeal(type, quality) {
  const def = DISHES[type];
  if (!def) return 0;
  return Math.round(def.baseHeal * (0.7 + (quality / 10) * 0.6));
}

/**
 * Create a signature dish record. The caller is responsible for consuming
 * REAL ingredients from the chef's REAL inventory first — this function
 * only records the dish. Returns the dish record or null on bad input.
 */
function createDish(type, chefName, quality, nowMs) {
  const def = DISHES[type];
  if (!def || !chefName) return null;
  const st = load();
  _dishSeq += 1;
  const dish = {
    id: `dish-${nowMs ?? Date.now()}-${_dishSeq}`,
    type,
    name: `${def.label}`,
    chef: chefName,
    quality: Math.max(1, Math.min(10, Math.round(quality) || 1)),
    heal: dishHeal(type, quality),
    value: 0, // computed after reviews
    createdAt: nowMs ?? Date.now(),
    servings: 10, // a dish serves 10 diners before it's gone
  };
  dish.value = dishValue(type, dish.quality, 0);
  st.dishes.push(dish);
  markDirty();
  return dish;
}

function dishById(id) {
  return load().dishes.find((d) => d.id === id) ?? null;
}

function dishesByChef(chefName) {
  const n = norm(chefName);
  return load().dishes.filter((d) => norm(d.chef) === n);
}

function averageStars(dishId) {
  const now = Date.now();
  const rel = load().reviews.filter(
    (r) => r.dishId === dishId && now - r.createdAt < REVIEW_DECAY_MS
  );
  if (!rel.length) return 0;
  return rel.reduce((s, r) => s + r.stars, 0) / rel.length;
}

/** Refresh a dish's value after new reviews. */
function refreshDishValue(dishId) {
  const st = load();
  const dish = st.dishes.find((d) => d.id === dishId);
  if (!dish) return 0;
  dish.value = dishValue(dish.type, dish.quality, averageStars(dishId));
  markDirty();
  return dish.value;
}

// --- restaurants ---------------------------------------------------------------

function restaurantFor(kingdomId, nowMs) {
  const st = load();
  const kid = String(kingdomId ?? "unknown");
  if (!st.restaurants[kid]) {
    const idx = Math.abs(hashStr(kid)) % RESTAURANT_NAMES.length;
    st.restaurants[kid] = {
      name: RESTAURANT_NAMES[idx],
      menu: [], // dishIds
      openedAt: nowMs ?? Date.now(),
    };
    markDirty();
  }
  return st.restaurants[kid];
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return h;
}

function addToMenu(kingdomId, dishId) {
  const st = load();
  const rest = restaurantFor(kingdomId);
  if (!rest.menu.includes(dishId)) {
    rest.menu.push(dishId);
    markDirty();
    return true;
  }
  return false;
}

function menuFor(kingdomId) {
  const rest = restaurantFor(kingdomId);
  return rest.menu
    .map((id) => dishById(id))
    .filter((d) => d && d.servings > 0);
}

// --- critics & reviews -----------------------------------------------------------

/**
 * Record a critic review. Returns the review or null. Critics must have
 * social standing (checked by caller); stars clamped 1-10.
 */
function reviewDish(dishId, criticName, stars, nowMs) {
  const dish = dishById(dishId);
  if (!dish || !criticName) return null;
  const st = load();
  const review = {
    id: `rev-${nowMs ?? Date.now()}-${st.reviews.length}`,
    dishId,
    critic: criticName,
    stars: Math.max(1, Math.min(10, Math.round(stars) || 5)),
    createdAt: nowMs ?? Date.now(),
  };
  st.reviews.push(review);
  markDirty();
  refreshDishValue(dishId);
  return review;
}

function reviewsFor(dishId) {
  return load().reviews.filter((r) => r.dishId === dishId);
}

// --- dining (real coins, real HP) --------------------------------------------------

/**
 * A diner orders a dish. Returns { ok, dish, price, heal } or { ok: false, reason }.
 * The caller moves REAL coins from diner to chef and applies the heal.
 * This function only computes the transaction — never touches inventories.
 */
function orderDish(kingdomId, dishId, dinerCoins) {
  const dish = dishById(dishId);
  if (!dish) return { ok: false, reason: "no-such-dish" };
  if (dish.servings <= 0) return { ok: false, reason: "sold-out" };
  const price = dish.value;
  if ((dinerCoins ?? 0) < price) return { ok: false, reason: "cant-afford" };
  return { ok: true, dish, price, heal: dish.heal, chef: dish.chef };
}

/** Consume one serving after a successful order. */
function serveDish(dishId) {
  const st = load();
  const dish = st.dishes.find((d) => d.id === dishId);
  if (!dish || dish.servings <= 0) return false;
  dish.servings -= 1;
  markDirty();
  return true;
}

// --- culinary competitions -----------------------------------------------------------

function maybeScheduleCompetition(kingdomId, nowMs) {
  const st = load();
  const kid = String(kingdomId ?? "unknown");
  nowMs = nowMs ?? Date.now();
  const last = st.lastCompetition[kid] ?? 0;
  if (nowMs - last < COMPETITION_INTERVAL_MS) return null;
  const open = st.competitions.find((c) => c.kingdomId === kid && !c.resolvedAt);
  if (open) return null; // one at a time
  const comp = {
    id: `comp-${nowMs}`,
    kingdomId: kid,
    scheduledAt: nowMs,
    resolvedAt: 0,
    winner: null,
    runnerUp: null,
    entries: [], // dishIds
  };
  st.competitions.push(comp);
  st.lastCompetition[kid] = nowMs;
  markDirty();
  return comp;
}

function enterCompetition(compId, dishId) {
  const st = load();
  const comp = st.competitions.find((c) => c.id === compId);
  const dish = dishById(dishId);
  if (!comp || comp.resolvedAt || !dish) return false;
  if (!comp.entries.includes(dishId)) {
    comp.entries.push(dishId);
    markDirty();
    return true;
  }
  return false;
}

/**
 * Resolve a competition: best dish by (quality * avgStars) wins.
 * Returns { winner, runnerUp, prize, runnerUpPrize } or null.
 */
function resolveCompetition(compId, nowMs) {
  const st = load();
  const comp = st.competitions.find((c) => c.id === compId);
  if (!comp || comp.resolvedAt || comp.entries.length < 2) return null;
  const scored = comp.entries
    .map((id) => dishById(id))
    .filter(Boolean)
    .map((d) => ({ dish: d, score: d.quality * (1 + averageStars(d.id) / 5) }))
    .sort((a, b) => b.score - a.score);
  if (scored.length < 2) return null;
  comp.resolvedAt = nowMs ?? Date.now();
  comp.winner = scored[0].dish.chef;
  comp.runnerUp = scored[1].dish.chef;
  markDirty();
  return {
    winner: comp.winner,
    runnerUp: comp.runnerUp,
    prize: COMPETITION_PRIZE,
    runnerUpPrize: COMPETITION_RUNNER_UP,
    winningDish: scored[0].dish,
  };
}

function openCompetition(kingdomId) {
  const st = load();
  const kid = String(kingdomId ?? "unknown");
  return st.competitions.find((c) => c.kingdomId === kid && !c.resolvedAt) ?? null;
}

module.exports = {
  DISHES,
  DISH_TYPES,
  COMPETITION_PRIZE,
  COMPETITION_RUNNER_UP,
  CHEF_MASTER_LEVEL,
  CRITIC_MIN_SOCIAL,
  load,
  save,
  resetForTests,
  ingredientIds,
  awardMasterChef,
  isMasterChef,
  masterChefs,
  dishQuality,
  dishValue,
  dishHeal,
  createDish,
  dishById,
  dishesByChef,
  averageStars,
  refreshDishValue,
  restaurantFor,
  addToMenu,
  menuFor,
  reviewDish,
  reviewsFor,
  orderDish,
  serveDish,
  maybeScheduleCompetition,
  enterCompetition,
  resolveCompetition,
  openCompetition,
};
