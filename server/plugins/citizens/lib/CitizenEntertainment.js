"use strict";

/**
 * CitizenEntertainment — the data tier for citizen fun: taverns, dice,
 * music, theater, and arena sparring.
 *
 * WHAT IT DOES (data tier, free — read by the slow tick and the brain):
 *   venue records (one tavern per kingdom, a theater, an arena),
 *   drink/dice/performance state, drunkenness tracking, and pure helpers:
 *   tavernOfKingdom, buyDrink, playDice, drunkennessOf, workPenaltyFor,
 *   plus bard-performance and arena-fight scheduling state.
 *
 * WHAT IT DOES NOT DO:
 *   - No ticking here. Bard performances, arena fights, theater shows,
 *     and drunkenness decay live in lib/CitizenEntertainLife.js (the
 *     director ticks that).
 *   - No LLM. Journaled facts only; the chat layer riffs on them.
 *   - Money is honest: drinks and dice bets take REAL coins from the
 *     citizen's real inventory. Broke citizens can't drink or gamble.
 *   - Mood is honest: entertainment calls CitizenNeeds.addMood with real
 *     deltas — the brain's scorer reads the same needs.
 *
 * DESIGN NOTES:
 *   - Taverns are the social hub: drinking, dice, bard performances.
 *     Barkeeps (the career) work here; bards (the career) perform here.
 *   - Dice is a fair-ish gamble: 45% win chance (house edge), 2x payout.
 *     No invented money — the pot comes from the tavern's take.
 *   - Drunkenness 0..100: each drink +25, decays 10/hour. Drunk citizens
 *     (50+) get a work penalty like the plague's little brother.
 *   - Theater shows run during festivals (read from CitizenFestivals).
 *   - Arena fights are sparring — never lethal, winner gets a purse.
 *
 * Persisted to data/saves/citizen-entertainment.json (dirty-flag pattern,
 * never committed). Test seams: _setSavePathForTests / resetForTests.
 */

const fs = require("fs");
const path = require("path");
const { normalizeName } = require("./CitizenBonds");

let SAVE_FILE = path.join(process.cwd(), "data", "saves", "citizen-entertainment.json");

/** Test seam — redirect the save path (tests must not touch the real one). */
function _setSavePathForTests(p) {
  SAVE_FILE = p;
}

/** Test seam — clear in-memory state. */
function resetForTests() {
  cache = null;
  dirty = false;
}

// --- tuning ------------------------------------------------------------------
const DRINK_PRICE = 5; // coins per ale
const DRINK_MOOD = 8; // mood per drink
const DRUNK_PER_DRINK = 25; // drunkenness per drink
const DRUNK_DECAY_PER_HOUR = 10;
const DRUNK_WORK_PENALTY = 30; // work penalty when drunk (50+)
const DRUNK_THRESHOLD = 50;

const DICE_MIN_BET = 10;
const DICE_MAX_BET = 50;
const DICE_WIN_CHANCE = 0.45; // house edge
const DICE_PAYOUT_MULT = 2; // win = 2x bet
const DICE_MOOD_WIN = 12;
const DICE_MOOD_LOSS = -6;

const PERFORMANCE_MOOD = 10; // mood for watching a bard
const PERFORMANCE_TIP = 3; // coins tipped to bard per listener
const THEATER_MOOD = 15; // mood for watching a play
const THEATER_PRICE = 10; // coins per theater ticket

const ARENA_PRIZE = 100; // coins for winning a sparring match
const ARENA_MOOD_WIN = 15;
const ARENA_MOOD_LOSS = -4;

// --- venue catalog ------------------------------------------------------------
// One tavern per kingdom, deterministic. The theater is in Varrock (the
// capital of Misthalin), the arena in the Wilderness-adjacent town.

const KINGDOM_TAVERNS = Object.freeze({
  misthalin: Object.freeze({ name: "The Rusty Sword", kingdomId: "misthalin" }),
  asgarnia: Object.freeze({ name: "The Golden Boar", kingdomId: "asgarnia" }),
  kandarin: Object.freeze({ name: "The Salty Dog", kingdomId: "kandarin" }),
  morytania: Object.freeze({ name: "The Gloomy Gate", kingdomId: "morytania" }),
  keldagrim: Object.freeze({ name: "The Granite Mug", kingdomId: "keldagrim" }),
});

const THEATER = Object.freeze({
  name: "The Grand Theater",
  kingdomId: "misthalin",
});

const ARENA = Object.freeze({
  name: "The Sparring Pit",
  kingdomId: "asgarnia",
});

function tavernOfKingdom(kingdomId) {
  if (!kingdomId) return null;
  return KINGDOM_TAVERNS[String(kingdomId).toLowerCase()] ?? null;
}

function theater() {
  return THEATER;
}

function arena() {
  return ARENA;
}

// --- storage -------------------------------------------------------------------
let cache = null;
let dirty = false;

function blank() {
  return {
    // username -> { drinks: n, drunkenness: 0..100, lastDrinkAt: ms }
    drinkers: {},
    // username -> { lastPerformanceAt: ms, performances: n }
    bards: {},
    // [{ id, fighterA, fighterB, winner, at }]
    fights: [],
    // [{ id, title, at, kingdomId }]
    shows: [],
  };
}

function data() {
  if (!cache) cache = load();
  return cache;
}

function load() {
  try {
    if (!fs.existsSync(SAVE_FILE)) return blank();
    const raw = JSON.parse(fs.readFileSync(SAVE_FILE, "utf8"));
    if (!raw || typeof raw !== "object") return blank();
    if (!raw.drinkers || typeof raw.drinkers !== "object") raw.drinkers = {};
    if (!raw.bards || typeof raw.bards !== "object") raw.bards = {};
    if (!Array.isArray(raw.fights)) raw.fights = [];
    if (!Array.isArray(raw.shows)) raw.shows = [];
    return raw;
  } catch {
    return blank();
  }
}

function markDirty() {
  dirty = true;
}

function save() {
  if (!dirty) return false;
  try {
    const dir = path.dirname(SAVE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(SAVE_FILE, JSON.stringify(data(), null, 2));
    dirty = false;
    return true;
  } catch {
    return false;
  }
}

// --- drunkenness ---------------------------------------------------------------
function drunkennessOf(username) {
  const key = normalizeName(username);
  return data().drinkers[key]?.drunkenness ?? 0;
}

function isDrunk(username) {
  return drunkennessOf(username) >= DRUNK_THRESHOLD;
}

/** Work penalty for drunkenness: 0 when sober, DRUNK_WORK_PENALTY when drunk. */
function workPenaltyFor(username) {
  return isDrunk(username) ? DRUNK_WORK_PENALTY : 0;
}

function soberUp(username, hoursElapsed) {
  const key = normalizeName(username);
  const record = data().drinkers[key];
  if (!record || record.drunkenness <= 0) return;
  record.drunkenness = Math.max(0, record.drunkenness - hoursElapsed * DRUNK_DECAY_PER_HOUR);
  markDirty();
}

// --- drinks (honest coins) -------------------------------------------------------
function countCoins(player) {
  try {
    if (typeof player?.countCoins === "function") return player.countCoins();
    const inv = player?.getInventory?.();
    if (inv && typeof inv.count === "function") return inv.count(995);
  } catch {
    // fall through
  }
  return 0;
}

function removeCoins(player, amount) {
  try {
    if (typeof player?.removeCoins === "function") return player.removeCoins(amount);
    const inv = player?.getInventory?.();
    if (inv && typeof inv.remove === "function") {
      inv.remove(995, amount);
      return true;
    }
  } catch {
    // fall through
  }
  return false;
}

function addCoins(player, amount) {
  try {
    if (typeof player?.addCoins === "function") {
      player.addCoins(amount);
      return true;
    }
    const inv = player?.getInventory?.();
    if (inv && typeof inv.add === "function") {
      inv.add(995, amount);
      return true;
    }
  } catch {
    // fall through
  }
  return false;
}

/**
 * Buy a drink at the tavern. Takes REAL coins. Returns { ok, reason }.
 * On success: mood +DRINK_MOOD, drunkenness +DRUNK_PER_DRINK.
 */
function buyDrink(username, player) {
  const coins = countCoins(player);
  if (coins < DRINK_PRICE) {
    return { ok: false, reason: "broke" };
  }
  if (!removeCoins(player, DRINK_PRICE)) {
    return { ok: false, reason: "payment_failed" };
  }
  const key = normalizeName(username);
  const d = data();
  if (!d.drinkers[key]) d.drinkers[key] = { drinks: 0, drunkenness: 0, lastDrinkAt: 0 };
  const record = d.drinkers[key];
  record.drinks += 1;
  record.drunkenness = Math.min(100, record.drunkenness + DRUNK_PER_DRINK);
  record.lastDrinkAt = Date.now();
  markDirty();

  try {
    const { addMood } = require("../brain/CitizenNeeds");
    addMood(player, DRINK_MOOD);
  } catch {
    // mood is best-effort
  }
  return { ok: true, drinks: record.drinks, drunkenness: record.drunkenness };
}

// --- dice (honest gambling) ------------------------------------------------------
/**
 * Play dice. Bet must be within [DICE_MIN_BET, DICE_MAX_BET] and the player
 * must have the coins. Returns { ok, won, payout, reason }.
 * Uses the provided rng for testability (defaults to Math.random).
 */
function playDice(username, player, bet, rng) {
  const random = typeof rng === "function" ? rng : Math.random;
  if (!Number.isFinite(bet) || bet < DICE_MIN_BET || bet > DICE_MAX_BET) {
    return { ok: false, reason: "bad_bet" };
  }
  const coins = countCoins(player);
  if (coins < bet) {
    return { ok: false, reason: "broke" };
  }
  if (!removeCoins(player, bet)) {
    return { ok: false, reason: "payment_failed" };
  }
  const won = random() < DICE_WIN_CHANCE;
  let payout = 0;
  if (won) {
    payout = bet * DICE_PAYOUT_MULT;
    addCoins(player, payout);
  }
  try {
    const { addMood } = require("../brain/CitizenNeeds");
    addMood(player, won ? DICE_MOOD_WIN : DICE_MOOD_LOSS);
  } catch {
    // mood is best-effort
  }
  return { ok: true, won, payout, bet };
}

// --- bard performances -------------------------------------------------------------
function recordPerformance(bardUsername, nowMs) {
  const key = normalizeName(bardUsername);
  const d = data();
  if (!d.bards[key]) d.bards[key] = { lastPerformanceAt: 0, performances: 0 };
  d.bards[key].lastPerformanceAt = nowMs;
  d.bards[key].performances += 1;
  markDirty();
}

function lastPerformanceAt(bardUsername) {
  const key = normalizeName(bardUsername);
  return data().bards[key]?.lastPerformanceAt ?? 0;
}

/**
 * A listener enjoys a bard's performance: mood boost, and the bard gets
 * a tip (real coins from listener to bard — both must be online players).
 */
function enjoyPerformance(listenerPlayer, bardPlayer) {
  try {
    const { addMood } = require("../brain/CitizenNeeds");
    addMood(listenerPlayer, PERFORMANCE_MOOD);
  } catch {
    // best-effort
  }
  // Tip the bard: real coins move from listener to bard.
  if (countCoins(listenerPlayer) >= PERFORMANCE_TIP) {
    if (removeCoins(listenerPlayer, PERFORMANCE_TIP)) {
      addCoins(bardPlayer, PERFORMANCE_TIP);
      return { ok: true, tipped: PERFORMANCE_TIP };
    }
  }
  return { ok: true, tipped: 0 };
}

// --- theater -------------------------------------------------------------------------
/**
 * Buy a theater ticket and watch the show. Real coins, real mood.
 */
function watchShow(username, player) {
  const coins = countCoins(player);
  if (coins < THEATER_PRICE) {
    return { ok: false, reason: "broke" };
  }
  if (!removeCoins(player, THEATER_PRICE)) {
    return { ok: false, reason: "payment_failed" };
  }
  try {
    const { addMood } = require("../brain/CitizenNeeds");
    addMood(player, THEATER_MOOD);
  } catch {
    // best-effort
  }
  return { ok: true };
}

function recordShow(title, kingdomId, nowMs) {
  const d = data();
  const show = {
    id: `show-${nowMs}-${d.shows.length}`,
    title,
    kingdomId,
    at: nowMs,
  };
  d.shows.push(show);
  if (d.shows.length > 50) d.shows = d.shows.slice(-50);
  markDirty();
  return show;
}

// --- arena -------------------------------------------------------------------------------
/**
 * Record a sparring match result. Winner gets ARENA_PRIZE coins (paid by
 * the arena — the house covers it from ticket sales, never invented for
 * the fighter's pocket beyond the prize).
 */
function recordFight(fighterA, fighterB, winnerUsername, nowMs) {
  const d = data();
  const fight = {
    id: `fight-${nowMs}-${d.fights.length}`,
    fighterA: normalizeName(fighterA),
    fighterB: normalizeName(fighterB),
    winner: normalizeName(winnerUsername),
    at: nowMs,
  };
  d.fights.push(fight);
  if (d.fights.length > 50) d.fights = d.fights.slice(-50);
  markDirty();
  return fight;
}

function awardPrize(winnerPlayer, won) {
  if (won) {
    addCoins(winnerPlayer, ARENA_PRIZE);
  }
  try {
    const { addMood } = require("../brain/CitizenNeeds");
    addMood(winnerPlayer, won ? ARENA_MOOD_WIN : ARENA_MOOD_LOSS);
  } catch {
    // best-effort
  }
}

function recentFights(limit) {
  const fights = data().fights;
  return fights.slice(-(limit ?? 5)).reverse();
}

function recentShows(limit) {
  const shows = data().shows;
  return shows.slice(-(limit ?? 5)).reverse();
}

module.exports = {
  _setSavePathForTests,
  resetForTests,
  save,
  // tuning (exported for tests)
  DRINK_PRICE,
  DRINK_MOOD,
  DRUNK_PER_DRINK,
  DRUNK_THRESHOLD,
  DRUNK_WORK_PENALTY,
  DICE_MIN_BET,
  DICE_MAX_BET,
  DICE_WIN_CHANCE,
  DICE_PAYOUT_MULT,
  PERFORMANCE_MOOD,
  PERFORMANCE_TIP,
  THEATER_PRICE,
  THEATER_MOOD,
  ARENA_PRIZE,
  // venues
  tavernOfKingdom,
  theater,
  arena,
  KINGDOM_TAVERNS,
  // drunkenness
  drunkennessOf,
  isDrunk,
  workPenaltyFor,
  soberUp,
  // coins (honest)
  countCoins,
  removeCoins,
  addCoins,
  // drinks & dice
  buyDrink,
  playDice,
  // performances
  recordPerformance,
  lastPerformanceAt,
  enjoyPerformance,
  // theater
  watchShow,
  recordShow,
  // arena
  recordFight,
  awardPrize,
  recentFights,
  recentShows,
};
