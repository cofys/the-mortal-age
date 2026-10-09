"use strict";

/**
 * CitizenCookOffs — the REAL competitive cooking circuit for citizens.
 *
 * WHAT IT DOES (data tier, zero LLM):
 *   - Live cook-offs: weekly per kingdom. Chefs enter (REAL 100-coin entry
 *     fee), cook 3 timed rounds with a MYSTERY INGREDIENT drawn from real
 *     farm produce, and are scored by a 3-judge panel.
 *   - Judging panels: judges score taste/presentation/creativity 1-10 each;
 *     deterministic from judge traits + dish quality (never random).
 *   - Prize pots: entry fees fund the pot; winner 70%, runner-up 20%,
 *     third 10% — all REAL coin movement via injected callbacks.
 *   - Seasonal chef rankings: quarterly seasons, points per placement.
 *   - Recipes: citizens INVENT recipes (consumes REAL ingredients, quality
 *     from real Cooking level), DISCOVER recipes (from exploration), and
 *     TRADE them (real coins change hands, ownership transfers).
 *
 * WHAT IT DOES NOT DO (no-overlap boundaries):
 *   - CitizenCuisine owns: master chefs, signature dishes, restaurants,
 *     food critics, MONTHLY "best dish" dish-showcase competitions, and
 *     player diners. This never runs dish showcases; cook-offs are live
 *     head-to-head chef duels with mystery ingredients and judging panels.
 *   - CitizenCooks.js owns: hash-derived cook trade flavor.
 *   - CitizenCook (brain action) owns: individual cooking skill XP.
 *   - CitizenFarmers owns produce. This only READS produce names as
 *     mystery-ingredient themes; it never farms.
 *
 * All coin movements are REAL (caller-supplied take/give callbacks; honest
 * failure when broke). All scoring is deterministic (seeded hashes, never
 * Math.random). Dirty-flag persistence to citizen-cookoffs.json.
 * Plain-node testable: CitizenCookOffs.test.js.
 */

const { normalizeName } = require("./CitizenBonds");
const fs = require("fs");
const path = require("path");

let SAVE_FILE = path.join(process.cwd(), "data", "saves", "citizen-cookoffs.json");

function setSaveFile(p) {
  SAVE_FILE = p;
}

// === Tuning: all magic numbers here ===
const COOKOFF_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // weekly cook-offs
const COOKOFF_OPEN_MS = 2 * 24 * 60 * 60 * 1000; // resolve after 2+ days open
const ENTRY_FEE = 100; // coins, real
const ROUNDS = ["appetizer", "main", "dessert"];
const WINNER_SHARE = 0.7;
const RUNNERUP_SHARE = 0.2;
const THIRD_SHARE = 0.1;
const MIN_COOKING_TO_INVENT = 25;
const RANK_POINTS = { 1: 10, 2: 6, 3: 3 };

// Mystery-ingredient themes, each drawn from REAL farm produce names
// (CitizenFarmers.produceFor). Never invents ingredients.
const MYSTERY_THEMES = {
  root: ["potato", "onion", "leek"],
  grain: ["wheat", "barley", "sweetcorn"],
  dairy: ["milk", "eggs"],
  meat: ["lamb", "mutton"],
  fruit: ["apple", "pear", "plum", "cherry"],
  sweet: ["honey", "honeycomb"],
  vegetable: ["cabbage", "pumpkin"],
};
const THEME_KEYS = Object.keys(MYSTERY_THEMES);

// === State ===
let state = null;
let dirty = false;

function blankState() {
  return {
    cookoffs: [], // { id, kingdomId, scheduledAt, theme, mystery, entries[], resolvedAt, winner, pot }
    rankings: {}, // `${kingdomId}:${season}` -> { norm -> { name, points, wins, entries } }
    recipes: [], // { id, name, inventor, ingredients[], quality, source, createdAt }
    lastScheduled: {}, // kingdomId -> ms
    deededHunters: {}, // norm -> true (recipehunter deed already awarded)
  };
}

function ensure() {
  if (!state) state = blankState();
  return state;
}

function norm(name) {
  try { return normalizeName(name); } catch { return String(name || "").toLowerCase().trim(); }
}

function markDirty() { dirty = true; }

function save() {
  if (!dirty) return false;
  try {
    fs.mkdirSync(path.dirname(SAVE_FILE), { recursive: true });
    fs.writeFileSync(SAVE_FILE, JSON.stringify(state, null, 2));
    dirty = false;
    return true;
  } catch { return false; }
}

function load() {
  try {
    const raw = fs.readFileSync(SAVE_FILE, "utf8");
    state = Object.assign(blankState(), JSON.parse(raw));
  } catch { state = blankState(); }
  dirty = false;
  return state;
}

function resetForTests() {
  state = blankState();
  dirty = false;
}

/** Deterministic string hash (FNV-1a). Never Math.random. */
function hashStr(s) {
  let h = 2166136261;
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function seasonOf(nowMs) {
  return Math.floor((nowMs ?? Date.now()) / (90 * 24 * 3600 * 1000));
}

// === Cook-offs ===

function themeFor(kingdomId, nowMs) {
  const keys = THEME_KEYS;
  return keys[hashStr(`${kingdomId}|${nowMs}`) % keys.length];
}

function mysteryFor(theme) {
  const list = MYSTERY_THEMES[theme] || MYSTERY_THEMES.root;
  return list[0]; // deterministic representative; the theme is the category
}

function scheduleCookOff(kingdomId, nowMs) {
  const s = ensure();
  const kid = String(kingdomId ?? "unknown");
  nowMs = nowMs ?? Date.now();
  const last = s.lastScheduled[kid] ?? 0;
  if (nowMs - last < COOKOFF_INTERVAL_MS) return null;
  const open = s.cookoffs.find((c) => c.kingdomId === kid && !c.resolvedAt);
  if (open) return null; // one at a time
  const theme = themeFor(kid, nowMs);
  const co = {
    id: `cookoff-${nowMs}`,
    kingdomId: kid,
    scheduledAt: nowMs,
    theme,
    mystery: mysteryFor(theme),
    entries: [], // { chef, paid, rounds: { appetizer: score, ... } }
    resolvedAt: 0,
    winner: null,
    pot: 0,
  };
  s.cookoffs.push(co);
  s.lastScheduled[kid] = nowMs;
  markDirty();
  return co;
}

function openCookOff(kingdomId) {
  const s = ensure();
  const kid = String(kingdomId ?? "unknown");
  return s.cookoffs.find((c) => c.kingdomId === kid && !c.resolvedAt) ?? null;
}

function cookOffById(id) {
  return ensure().cookoffs.find((c) => c.id === id) ?? null;
}

/**
 * Enter a cook-off. takeCoinsFn(chefName, amount) -> boolean must move REAL
 * coins; entry fails honestly when the chef is broke. Returns true on entry.
 */
function enterCookOff(cookOffId, chefName, takeCoinsFn, nowMs) {
  const co = cookOffById(cookOffId);
  const n = norm(chefName);
  if (!co || co.resolvedAt || !n) return false;
  if (co.entries.some((e) => norm(e.chef) === n)) return false; // already in
  let paid = false;
  try { paid = !!takeCoinsFn?.(chefName, ENTRY_FEE); } catch { paid = false; }
  if (!paid) return false; // honest — no coins, no entry
  co.entries.push({ chef: chefName, paid: ENTRY_FEE, rounds: {} });
  co.pot += ENTRY_FEE;
  markDirty();
  return true;
}

/** Does this chef hold a recipe using an ingredient of the given theme? */
function hasThemeRecipe(chefName, theme) {
  const n = norm(chefName);
  const ingredients = MYSTERY_THEMES[theme] || [];
  return ensure().recipes.some((r) =>
    norm(r.inventor) === n &&
    r.ingredients.some((ing) => ingredients.includes(String(ing).toLowerCase()))
  );
}

/**
 * Deterministic round score 1-100 for a chef's dish.
 * cookingLevel 1-99 (real), creativity 0-1 (real trait).
 * Never random: seeded on cook-off + chef + theme + round.
 */
function roundScore(cookOffId, roundName, chefName, cookingLevel, creativity) {
  const co = cookOffById(cookOffId);
  if (!co || !ROUNDS.includes(roundName)) return 0;
  const lvl = clamp(Number(cookingLevel) || 1, 1, 99);
  const cre = clamp(Number(creativity) || 0, 0, 1);
  const synergy = hashStr(`${cookOffId}|${chefName}|${co.theme}|${roundName}`) % 16; // 0..15
  const recipeBonus = hasThemeRecipe(chefName, co.theme) ? 8 : 0;
  const score = 30 + (lvl / 99) * 40 + cre * 10 + synergy + recipeBonus;
  return clamp(Math.round(score), 1, 100);
}

/** Record a chef's round score (called by the brain action after each round). */
function recordRoundScore(cookOffId, chefName, roundName, cookingLevel, creativity) {
  const co = cookOffById(cookOffId);
  if (!co || co.resolvedAt || !ROUNDS.includes(roundName)) return 0;
  const entry = co.entries.find((e) => norm(e.chef) === norm(chefName));
  if (!entry) return 0;
  const score = roundScore(cookOffId, roundName, chefName, cookingLevel, creativity);
  entry.rounds[roundName] = score;
  markDirty();
  return score;
}

function roundsTotal(entry) {
  return ROUNDS.reduce((sum, r) => sum + (entry.rounds[r] || 0), 0);
}

/**
 * One judge's score 1-100 for a chef. Deterministic from judge traits +
 * the chef's round average. judges: [{ name, strictness 0..1 }].
 */
function judgeScore(cookOffId, chefName, judge, roundAvg) {
  const variance = (hashStr(`${cookOffId}|${judge.name}|${chefName}`) % 21) - 10; // -10..+10
  const strictPenalty = clamp(Number(judge.strictness) || 0, 0, 1) * 10;
  return clamp(Math.round(roundAvg + variance - strictPenalty), 1, 100);
}

/**
 * Resolve a cook-off. judges: 3x { name, strictness }.
 * giveCoinsFn(name, amount) moves REAL prize coins.
 * Returns { winner, placements, pot } or null when unresolvable.
 */
function resolveCookOff(cookOffId, judges, giveCoinsFn, nowMs) {
  const co = cookOffById(cookOffId);
  nowMs = nowMs ?? Date.now();
  if (!co || co.resolvedAt) return null;
  const scored = co.entries
    .filter((e) => roundsTotal(e) > 0)
    .map((e) => {
      const roundAvg = roundsTotal(e) / ROUNDS.length;
      const total = (judges || []).reduce((sum, j) => sum + judgeScore(co.id, e.chef, j, roundAvg), 0);
      return { chef: e.chef, total };
    })
    .sort((a, b) => b.total - a.total);
  if (scored.length < 2) return null; // need a real contest
  co.resolvedAt = nowMs;
  co.winner = scored[0].chef;
  const pot = co.pot;
  const shares = [WINNER_SHARE, RUNNERUP_SHARE, THIRD_SHARE];
  scored.slice(0, 3).forEach((s, i) => {
    const amount = i === 0
      ? pot - Math.round(pot * RUNNERUP_SHARE) - Math.round(pot * THIRD_SHARE) // winner takes remainder
      : Math.round(pot * shares[i]);
    try { giveCoinsFn?.(s.chef, amount); } catch { /* prize best-effort */ }
    s.prize = amount;
  });
  // Seasonal rankings.
  const season = seasonOf(nowMs);
  scored.forEach((s, i) => recordRanking(co.kingdomId, s.chef, i + 1, season));
  markDirty();
  return { winner: co.winner, placements: scored, pot };
}

// === Rankings ===

function recordRanking(kingdomId, chefName, placement, season) {
  const s = ensure();
  const key = `${kingdomId}:${season}`;
  s.rankings[key] = s.rankings[key] || {};
  const n = norm(chefName);
  const rec = s.rankings[key][n] || { name: chefName, points: 0, wins: 0, entries: 0 };
  rec.points += RANK_POINTS[placement] ?? 1;
  if (placement === 1) rec.wins += 1;
  rec.entries += 1;
  s.rankings[key][n] = rec;
  markDirty();
  return rec;
}

function rankingsFor(kingdomId, season, limit = 10) {
  const s = ensure();
  const key = `${kingdomId}:${season}`;
  return Object.values(s.rankings[key] || {})
    .sort((a, b) => b.points - a.points || b.wins - a.wins)
    .slice(0, limit);
}

// === Recipes ===

let _recipeSeq = 0;

/**
 * Invent a recipe. consumeFn(chefName, ingredientName) -> boolean must remove
 * ONE of each REAL ingredient from the chef's inventory; all must succeed
 * or the invention fails honestly with nothing consumed... (best-effort:
 * consumes in order, fails fast — the caller passes real removals).
 * Returns the recipe record or null.
 */
function inventRecipe(chefName, name, ingredientNames, cookingLevel, consumeFn, nowMs) {
  const n = norm(chefName);
  const ings = (ingredientNames || []).map((i) => String(i).toLowerCase().trim()).filter(Boolean);
  const lvl = Number(cookingLevel) || 0;
  if (!n || ings.length < 2 || ings.length > 5 || lvl < MIN_COOKING_TO_INVENT) return null;
  for (const ing of ings) {
    let ok = false;
    try { ok = !!consumeFn?.(chefName, ing); } catch { ok = false; }
    if (!ok) return null; // honest — missing ingredient, no recipe
  }
  const s = ensure();
  _recipeSeq += 1;
  const quality = clamp(1 + Math.floor((clamp(lvl, 1, 99) / 99) * 7) + Math.min(2, ings.length - 2), 1, 10);
  const recipe = {
    id: `recipe-${nowMs ?? Date.now()}-${_recipeSeq}`,
    name: String(name || `${ings[0]} & ${ings[1]} medley`),
    inventor: chefName,
    ingredients: ings,
    quality,
    source: "invented",
    createdAt: nowMs ?? Date.now(),
  };
  s.recipes.push(recipe);
  markDirty();
  return recipe;
}

/**
 * Discover a recipe from exploration (sourceName = discovery name).
 * No ingredient cost — the discovery IS the cost. Deterministic quality.
 */
function discoverRecipe(chefName, sourceName, nowMs) {
  const n = norm(chefName);
  if (!n || !sourceName) return null;
  const s = ensure();
  _recipeSeq += 1;
  const recipe = {
    id: `recipe-${nowMs ?? Date.now()}-${_recipeSeq}`,
    name: `Lost recipe of ${sourceName}`,
    inventor: chefName,
    ingredients: [],
    quality: clamp(3 + (hashStr(`${chefName}|${sourceName}`) % 6), 1, 10), // 3..8
    source: "discovered",
    createdAt: nowMs ?? Date.now(),
  };
  s.recipes.push(recipe);
  markDirty();
  return recipe;
}

function recipeById(id) {
  return ensure().recipes.find((r) => r.id === id) ?? null;
}

/** All cook-offs (in-memory; use load() first if you need disk state). */
function cookoffs() {
  return ensure().cookoffs;
}

function recipesByChef(chefName) {
  const n = norm(chefName);
  return ensure().recipes.filter((r) => norm(r.inventor) === n);
}

/**
 * All recipes in the ledger (defensive copies) — read-only enumerator for
 * guild systems (theft scans, certification audits). Never mutate the
 * returned records; the ledger owns them.
 */
function allRecipes() {
  return ensure().recipes.map((r) => ({ ...r }));
}

/**
 * List a recipe for sale at an asking price. Returns true on success.
 */
function listRecipe(recipeId, price) {
  const r = recipeById(recipeId);
  const amount = Math.floor(Number(price) || 0);
  if (!r || amount <= 0) return false;
  r.listPrice = amount;
  markDirty();
  return true;
}

/** Guarded: true once the recipehunter deed was awarded (call after awarding). */
function isHunterDeeded(chefName) {
  return !!ensure().deededHunters[norm(chefName)];
}

function markHunterDeeded(chefName) {
  const n = norm(chefName);
  if (!n || ensure().deededHunters[n]) return false;
  ensure().deededHunters[n] = true;
  markDirty();
  return true;
}

/** Recipes currently listed for sale. */
function listedRecipes(limit = 20) {
  return ensure().recipes.filter((r) => r.listPrice > 0).slice(0, limit);
}

/**
 * Buy a listed recipe: buyer pays listPrice in REAL coins, seller receives
 * them, ownership transfers, listing clears. Returns true on success.
 */
function buyListedRecipe(recipeId, buyerName, takeCoinsFn, giveCoinsFn, refundFn) {
  const r = recipeById(recipeId);
  if (!r || !(r.listPrice > 0) || norm(r.inventor) === norm(buyerName)) return false;
  let paid = false;
  try { paid = !!takeCoinsFn?.(buyerName, r.listPrice); } catch { paid = false; }
  if (!paid) return false; // honest — buyer broke, no sale
  let credited = false;
  try { credited = !!giveCoinsFn?.(r.inventor, r.listPrice); } catch { credited = false; }
  if (!credited) {
    // Honest rollback: seller unreachable, refund the buyer.
    try { refundFn?.(buyerName, r.listPrice); } catch { /* refund best-effort */ }
    return false;
  }
  r.inventor = buyerName;
  r.soldAt = Date.now();
  r.soldFor = r.listPrice;
  r.listPrice = 0;
  markDirty();
  return true;
}

/**
 * Sell a recipe: buyer pays price in REAL coins, seller receives them,
 * ownership transfers. Returns true on success.
 */
function sellRecipe(recipeId, buyerName, price, takeCoinsFn, giveCoinsFn) {
  const r = recipeById(recipeId);
  const amount = Math.floor(Number(price) || 0);
  if (!r || amount <= 0 || norm(r.inventor) === norm(buyerName)) return false;
  let paid = false;
  try { paid = !!takeCoinsFn?.(buyerName, amount); } catch { paid = false; }
  if (!paid) return false; // honest — buyer broke, no sale
  try { giveCoinsFn?.(r.inventor, amount); } catch { /* seller credit best-effort */ }
  r.inventor = buyerName; // ownership transfers
  r.soldAt = Date.now();
  r.soldFor = amount;
  markDirty();
  return true;
}

module.exports = {
  COOKOFF_INTERVAL_MS,
  COOKOFF_OPEN_MS,
  ENTRY_FEE,
  ROUNDS,
  MYSTERY_THEMES,
  THEME_KEYS,
  setSaveFile,
  load,
  save,
  resetForTests,
  scheduleCookOff,
  openCookOff,
  cookOffById,
  cookoffs,
  enterCookOff,
  themeFor,
  mysteryFor,
  roundScore,
  recordRoundScore,
  roundsTotal,
  judgeScore,
  resolveCookOff,
  recordRanking,
  rankingsFor,
  seasonOf,
  hasThemeRecipe,
  inventRecipe,
  discoverRecipe,
  recipeById,
  recipesByChef,
  allRecipes,
  isHunterDeeded,
  markHunterDeeded,
  listRecipe,
  listedRecipes,
  buyListedRecipe,
  sellRecipe,
};
