"use strict";

/**
 * PlayerShopStore — persistence for PLAYER-OWNED MARKET STALLS.
 *
 * Same shape as the kingdom store: data/saves/player-shops.json, loaded once
 * at server startup and saved on every mutation. Keyed by lowercase owner
 * username. Player attributes stay on the player (shop:stall-owner); this
 * module never touches players.
 *
 * A stall record:
 *   { owner, ownerKey, kingdomId, createdAt,
 *     stock: { itemId: qty }, prices: { itemId: price },
 *     till, employee, lastWageAt, lastRentAt, rentDebt }
 * Stock awaiting collection (repossessed / closed stalls) lives under
 * returns: { ownerKey: [{ id, qty }] } — claimable with ::shop claim, so it
 * survives the owner being offline.
 *
 * The tuning constants below are the whole player-shop economy; they are
 * documented in citizens/DESIGN.md ("Player-owned market stalls").
 */

const fs = require("fs");
const path = require("path");

const SAVE_FILE = path.join(process.cwd(), "data", "saves", "player-shops.json");
const STORE_VERSION = 1;

// --- The player-shop economy (single source of truth) ---
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
/** Stall lease cost by kingdom: prime Varrock market vs cheap Burgh de Rott. */
const STALL_COSTS = Object.freeze({
  misthalin: { upfront: 10000, weeklyRent: 1000 }, // Varrock market — prime
  asgarnia: { upfront: 7500, weeklyRent: 750 }, // Falador
  kandarin: { upfront: 6000, weeklyRent: 600 }, // East Ardougne
  keldagrim: { upfront: 5000, weeklyRent: 500 }, // the dwarven city
  morytania: { upfront: 3000, weeklyRent: 300 }, // Burgh de Rott — cheap
});
const DEFAULT_STALL_COST = Object.freeze({ upfront: 5000, weeklyRent: 500 });
/** One citizen employee's daily wage, taken from the till automatically. */
const DAILY_WAGE = 75;
/** Cut of every sale that goes to the kingdom treasury (kingdom:tax-collected). */
const MARKET_TAX_RATE = 0.05;
/** A stall is a market pitch, not a warehouse: 4 ware types max (one per UI row). */
const MAX_WARES = 4;
/** Player-set prices must sit within 10%–1000% of the reference price. */
const PRICE_MIN_RATIO = 0.1;
const PRICE_MAX_RATIO = 10;
/** Unpaid rent beyond this many weeks repossesses the stall. */
const MISSED_RENT_WEEKS = 2;

let state = null;
let persist = true;

function emptyState() {
  return { version: STORE_VERSION, stalls: {}, returns: {} };
}

function load() {
  if (state) return state;
  state = emptyState();
  try {
    const parsed = JSON.parse(fs.readFileSync(SAVE_FILE, "utf8"));
    if (parsed && parsed.version === STORE_VERSION && parsed.stalls) {
      state = parsed;
      if (!state.returns) state.returns = {};
    }
  } catch {
    // No save yet, or unreadable: starts empty.
  }
  return state;
}

function save() {
  if (!persist) return;
  try {
    fs.mkdirSync(path.dirname(SAVE_FILE), { recursive: true });
    fs.writeFileSync(SAVE_FILE, JSON.stringify(load(), null, 2));
  } catch (error) {
    console.warn("[player-shops] could not save stall state", error?.message ?? error);
  }
}

function keyOf(username) {
  return String(username ?? "").toLowerCase();
}

function getStall(ownerKey) {
  return load().stalls[keyOf(ownerKey)] ?? null;
}

function getStallByOwner(username) {
  return getStall(keyOf(username));
}

function getAllStalls() {
  return Object.values(load().stalls);
}

function upsertStall(stall) {
  const stalls = load().stalls;
  const record = stalls[keyOf(stall.ownerKey ?? stall.owner)] ?? {};
  const merged = {
    owner: stall.owner ?? record.owner,
    ownerKey: keyOf(stall.ownerKey ?? stall.owner),
    kingdomId: stall.kingdomId ?? record.kingdomId,
    createdAt: stall.createdAt ?? record.createdAt ?? Date.now(),
    stock: stall.stock ?? record.stock ?? {},
    prices: stall.prices ?? record.prices ?? {},
    till: stall.till ?? record.till ?? 0,
    employee: stall.employee ?? record.employee ?? null,
    lastWageAt: stall.lastWageAt ?? record.lastWageAt ?? Date.now(),
    lastRentAt: stall.lastRentAt ?? record.lastRentAt ?? Date.now(),
    rentDebt: stall.rentDebt ?? record.rentDebt ?? 0,
  };
  // Explicit nulls (e.g. firing an employee) must win over the merge.
  if (stall.employee === null) merged.employee = null;
  stalls[merged.ownerKey] = merged;
  return merged;
}

function removeStall(ownerKey) {
  const stalls = load().stalls;
  const key = keyOf(ownerKey);
  const removed = stalls[key] ?? null;
  delete stalls[key];
  return removed;
}

/** Is this citizen username currently employed at any stall? */
function isEmployed(username) {
  const name = String(username ?? "").toLowerCase();
  if (!name) return false;
  return getAllStalls().some(
    (s) => String(s.employee ?? "").toLowerCase() === name
  );
}

/** Queue items/coins for an (offline or online) owner to claim later. */
function addReturns(ownerKey, entries) {
  const key = keyOf(ownerKey);
  const list = (load().returns[key] ??= []);
  for (const entry of entries ?? []) {
    const id = Math.floor(Number(entry?.id));
    const qty = Math.floor(Number(entry?.qty));
    if (!(id > 0) || !(qty > 0)) continue;
    const existing = list.find((e) => e.id === id);
    if (existing) existing.qty += qty;
    else list.push({ id, qty });
  }
  return list;
}

function peekReturns(ownerKey) {
  return [...(load().returns[keyOf(ownerKey)] ?? [])];
}

/** Take (and clear) everything queued for this owner. */
function takeReturns(ownerKey) {
  const key = keyOf(ownerKey);
  const list = load().returns[key] ?? [];
  delete load().returns[key];
  return list;
}

/** Lease cost for a kingdom id; unknown kingdoms get the default. */
function stallCosts(kingdomId) {
  return STALL_COSTS[kingdomId] ?? DEFAULT_STALL_COST;
}

/** Clamp a player-set price into [10%, 1000%] of the reference price. */
function clampPrice(referencePrice, wanted) {
  const ref = Math.max(1, Math.floor(Number(referencePrice) || 1));
  const want = Math.floor(Number(wanted));
  if (!(want >= 1)) return 1;
  const min = Math.max(1, Math.floor(ref * PRICE_MIN_RATIO));
  const max = Math.max(min, Math.floor(ref * PRICE_MAX_RATIO));
  return Math.min(max, Math.max(min, want));
}

/** For tests: forget all stalls and keep them in memory only. */
function resetForTests() {
  state = emptyState();
  persist = false;
}

module.exports = {
  DAY_MS,
  WEEK_MS,
  STALL_COSTS,
  DEFAULT_STALL_COST,
  DAILY_WAGE,
  MARKET_TAX_RATE,
  MAX_WARES,
  PRICE_MIN_RATIO,
  PRICE_MAX_RATIO,
  MISSED_RENT_WEEKS,
  load,
  save,
  keyOf,
  getStall,
  getStallByOwner,
  getAllStalls,
  upsertStall,
  removeStall,
  isEmployed,
  addReturns,
  peekReturns,
  takeReturns,
  stallCosts,
  clampPrice,
  resetForTests,
};
