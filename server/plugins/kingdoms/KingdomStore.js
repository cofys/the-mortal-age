"use strict";

/**
 * KingdomStore — the world-state store for the KINGDOM SYSTEM.
 *
 * Plugins have no world store (see the doom scoreboard precedent), so kingdom
 * world-state — who rules what, treasuries, active wars, story flags — lives in
 * data/saves/kingdoms.json, loaded once at server startup and saved on every
 * mutation. Player membership (kingdom:id, kingdom:rank, kingdom:titles) stays
 * on player attributes instead; this module never touches players.
 *
 * A kingdom record:
 *   { id, name, capital, ruler, rulerTitle, situation, hierarchy, treasury,
 *     flags, foundedAt }
 * Flags are namespaced story-state keys, e.g. "asgarnia:regency".
 */

const fs = require("fs");
const path = require("path");

const SAVE_FILE = path.join(process.cwd(), "data", "saves", "kingdoms.json");
const STORE_VERSION = 1;

let state = null;
let persist = true;

function emptyState() {
  return { version: STORE_VERSION, kingdoms: {}, wars: [], tension: {}, alliances: [] };
}

function load() {
  if (state) return state;
  state = emptyState();
  try {
    const parsed = JSON.parse(fs.readFileSync(SAVE_FILE, "utf8"));
    if (parsed && parsed.version === STORE_VERSION && parsed.kingdoms) {
      state = parsed;
      // Worlds saved before the tension model have no tension map.
      if (!state.tension || typeof state.tension !== "object") state.tension = {};
      if (!Array.isArray(state.wars)) state.wars = [];
      // Worlds saved before the diplomacy layer have no alliance registry.
      if (!Array.isArray(state.alliances)) state.alliances = [];
    }
  } catch {
    // No save yet, or unreadable: the seed data will fill it at startup.
  }
  return state;
}

function save() {
  if (!persist) return;
  try {
    fs.mkdirSync(path.dirname(SAVE_FILE), { recursive: true });
    fs.writeFileSync(SAVE_FILE, JSON.stringify(load(), null, 2));
  } catch (error) {
    console.warn("[kingdoms] could not save world state", error?.message ?? error);
  }
}

function getKingdom(id) {
  return load().kingdoms[id] ?? null;
}

function getKingdoms() {
  return Object.values(load().kingdoms);
}

/**
 * Insert a kingdom, or merge seed fields into an existing record without
 * clobbering live state (treasury, ruler, flags are never reset by a reseed).
 */
function upsertKingdom(def) {
  const kingdoms = load().kingdoms;
  const existing = kingdoms[def.id];
  if (existing) {
    for (const key of ["name", "capital", "situation", "hierarchy"]) {
      if (def[key] !== undefined) existing[key] = def[key];
    }
    if (def.flags) existing.flags = { ...def.flags, ...existing.flags };
    return existing;
  }
  const record = {
    id: def.id,
    name: def.name,
    capital: def.capital ?? null,
    ruler: def.ruler ?? null,
    rulerTitle: def.rulerTitle ?? null,
    situation: def.situation ?? null,
    hierarchy: def.hierarchy ?? [],
    treasury: def.treasury ?? 0,
    flags: def.flags ?? {},
    foundedAt: Date.now(),
  };
  kingdoms[def.id] = record;
  return record;
}

function setRuler(id, ruler, rulerTitle) {
  const kingdom = getKingdom(id);
  if (!kingdom) return null;
  kingdom.ruler = ruler;
  if (rulerTitle !== undefined && rulerTitle !== null) kingdom.rulerTitle = rulerTitle;
  return kingdom;
}

function setFlag(id, key, value) {
  const kingdom = getKingdom(id);
  if (!kingdom) return null;
  kingdom.flags[key] = value;
  return kingdom;
}

/** Add tax revenue to a treasury. Amounts are integer coins. */
function grantTax(id, amount) {
  const kingdom = getKingdom(id);
  if (!kingdom || !(amount > 0)) return null;
  kingdom.treasury = (kingdom.treasury ?? 0) + Math.floor(amount);
  return kingdom.treasury;
}

/** Spend from a treasury; returns false when the funds are not there. */
function spendTax(id, amount) {
  const kingdom = getKingdom(id);
  if (!kingdom || !(amount > 0)) return false;
  const cost = Math.floor(amount);
  if ((kingdom.treasury ?? 0) < cost) return false;
  kingdom.treasury -= cost;
  return true;
}

// --- treasury income ledger --------------------------------------------------
// Every coin entering a treasury is recorded with its source, so the court's
// books are auditable: no income may appear without a real origin (market
// taxes from player sales, fealty dues from player purses, donations,
// war-demand transfers, plunder). Callers record income at the same site
// where they call grantTax; the ledger is accounting, not a second money
// movement. No save: callers save (same convention as setFlag/grantTax).

const INCOME_LEDGER_FLAG = "treasury:income-ledger";
const INCOME_TOTALS_FLAG = "treasury:income-totals";
const INCOME_LEDGER_CAP = 100;

/** Known income sources. New real flows add a key here. */
const INCOME_SOURCES = [
  "player-stall", // 5% market tax on player stall sales (buyer's purse)
  "fealty", // fealty dues taken from a player's purse
  "promotion", // promotion tax taken from a player's purse
  "task", // kingdom-task tax taken from a player's purse
  "donation", // ::donate from a player's purse
  "war-demand", // honored war demand: ally treasury -> this treasury
  "plunder", // seized war chest (player-funded) after a crushed founding
];

function recordIncome(id, source, amount) {
  const kingdom = getKingdom(id);
  if (!kingdom || !(amount > 0)) return;
  const coins = Math.floor(amount);
  const key = INCOME_SOURCES.includes(source) ? source : "other";
  const ledger = Array.isArray(kingdom.flags[INCOME_LEDGER_FLAG])
    ? kingdom.flags[INCOME_LEDGER_FLAG]
    : [];
  ledger.push({ at: Date.now(), source: key, amount: coins });
  kingdom.flags[INCOME_LEDGER_FLAG] = ledger.slice(-INCOME_LEDGER_CAP);
  const totals = { ...(kingdom.flags[INCOME_TOTALS_FLAG] ?? {}) };
  totals[key] = (totals[key] ?? 0) + coins;
  kingdom.flags[INCOME_TOTALS_FLAG] = totals;
}

/** Lifetime income per source for a kingdom: { source: coins }. */
function getIncomeTotals(id) {
  const totals = getKingdom(id)?.flags?.[INCOME_TOTALS_FLAG];
  return totals && typeof totals === "object" ? { ...totals } : {};
}

/** Coins recorded from real income in the last windowMs milliseconds. */
function getRecentIncome(id, windowMs) {
  const ledger = getKingdom(id)?.flags?.[INCOME_LEDGER_FLAG];
  if (!Array.isArray(ledger) || !(windowMs > 0)) return 0;
  const since = Date.now() - windowMs;
  return ledger.reduce((sum, e) => (e && e.at >= since ? sum + (e.amount ?? 0) : sum), 0);
}

// --- market tax rate ---------------------------------------------------------
// The steward's tax-rate seal sets the real market tax players pay on stall
// sales: base 5%, scaled by the steward's multiplier (0.5x/1x/1.5x/2x), and
// by the marshal's war levy while the kingdom is at war. Flag keys mirror
// OfficeTools (the write side); this module only reads.

const MARKET_TAX_BASE = 0.05;
const TAX_RATE_FLAG = "sim:tax-rate";
const WAR_LEVY_FLAG = "sim:war-levy";
const TAX_MULTIPLIERS = [0.5, 1, 1.5, 2];
const WAR_LEVY_MULTIPLIERS = [1.2, 1.6, 2.0, 2.5];

function kingdomAtWar(id) {
  try {
    return getActiveWars().some((w) => w.active && (w.attackerId === id || w.defenderId === id));
  } catch {
    return false;
  }
}

/** Effective market-tax fraction for stall sales in this kingdom's markets. */
function getMarketTaxRate(id) {
  const kingdom = getKingdom(id);
  const taxFlag = kingdom?.flags?.[TAX_RATE_FLAG];
  const mult = TAX_MULTIPLIERS.includes(taxFlag) ? taxFlag : 1;
  let rate = MARKET_TAX_BASE * mult;
  if (kingdomAtWar(id)) {
    const levyFlag = kingdom?.flags?.[WAR_LEVY_FLAG];
    const levy = WAR_LEVY_MULTIPLIERS.includes(levyFlag) ? levyFlag : 1.6;
    rate *= levy;
  }
  return rate;
}

function declareWar({ attackerId, defenderId, declaredBy = null, reason = null, resolveAt = null }) {
  const wars = load().wars;
  const open = wars.find(
    (w) => w.active && w.attackerId === attackerId && w.defenderId === defenderId
  );
  if (open) return open;
  const war = {
    attackerId,
    defenderId,
    declaredBy,
    reason,
    active: true,
    declaredAt: Date.now(),
    endedAt: null,
    outcome: null,
    // Timestamp (ms) when the war burns itself out if nothing ends it sooner.
    resolveAt: Number.isFinite(resolveAt) ? resolveAt : null,
  };
  wars.push(war);
  return war;
}

/**
 * Pairwise tension lives here (canonical "a:b" keys, a < b) so every plugin
 * reads one persisted map. 0 = calm, 100 = war. New pairs default to
 * TENSION_DEFAULT (see Tension.Kingdoms.js) on first read.
 */
function tensionKey(a, b) {
  return [String(a), String(b)].sort().join(":");
}

/** Raw stored tension, or null when the pair has never been scored. */
function getRawTension(a, b) {
  const v = load().tension?.[tensionKey(a, b)];
  return Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : null;
}

function setRawTension(a, b, score) {
  const tension = load().tension ?? (load().tension = {});
  tension[tensionKey(a, b)] = Math.max(0, Math.min(100, Math.round(score)));
  // No save: callers save (same convention as setFlag/grantTax).
}

/** All pairs that have ever been scored: { "a:b": score }. */
function getTensionMap() {
  return { ...(load().tension ?? {}) };
}

/** Wars that have ended — the tension engine reads these for armistice windows. */
function getEndedWars() {
  return load().wars.filter((w) => !w.active);
}

function endWar(attackerId, defenderId, outcome = "unknown") {
  const war = load().wars.find(
    (w) => w.active && w.attackerId === attackerId && w.defenderId === defenderId
  );
  if (!war) return null;
  war.active = false;
  war.outcome = outcome;
  war.endedAt = Date.now();
  return war;
}

function getActiveWars() {
  return load().wars.filter((w) => w.active);
}

/**
 * Alliances: persisted pact records. Each is
 *   { a, b, formedAt, pactName, broker, strength, betrayalRisk }
 * with a/b in canonical sorted order. Strength 1-5 (blood bonds grow);
 * betrayalRisk 0-100 (spymaster schemes push it up; at 100 the pact shatters).
 */
function allianceKey(a, b) {
  return [String(a), String(b)].sort();
}

function getAlliances() {
  return load().alliances.map((r) => ({ ...r }));
}

function getAlliance(a, b) {
  const [x, y] = allianceKey(a, b);
  const rec = load().alliances.find((r) => r.a === x && r.b === y);
  return rec ? { ...rec } : null;
}

function isAllied(a, b) {
  return getAlliance(a, b) !== null;
}

function alliesOf(kingdomId) {
  const id = String(kingdomId);
  return load()
    .alliances.filter((r) => r.a === id || r.b === id)
    .map((r) => (r.a === id ? r.b : r.a));
}

/** Form a pact between two kingdoms. Idempotent — returns the record. */
function formAlliance(a, b, { pactName = null, broker = null } = {}) {
  if (a === b) return null;
  const [x, y] = allianceKey(a, b);
  const existing = getAlliance(x, y);
  if (existing) return existing;
  const record = {
    a: x,
    b: y,
    formedAt: Date.now(),
    pactName: pactName ?? `the ${x}-${y} accord`,
    broker: broker ?? null,
    strength: 1,
    betrayalRisk: 0,
  };
  load().alliances.push(record);
  return { ...record };
}

/** Dissolve a pact. Returns the removed record, or null. */
function breakAlliance(a, b) {
  const [x, y] = allianceKey(a, b);
  const list = load().alliances;
  const idx = list.findIndex((r) => r.a === x && r.b === y);
  if (idx < 0) return null;
  const [removed] = list.splice(idx, 1);
  return { ...removed };
}

/** Nudge a pact's betrayal risk (0-100) or strength (1-5). Returns the record, or null. */
function adjustAlliance(a, b, { betrayalRiskDelta = 0, strengthDelta = 0 } = {}) {
  const [x, y] = allianceKey(a, b);
  const rec = load().alliances.find((r) => r.a === x && r.b === y);
  if (!rec) return null;
  rec.betrayalRisk = Math.max(0, Math.min(100, (rec.betrayalRisk ?? 0) + betrayalRiskDelta));
  rec.strength = Math.max(1, Math.min(5, (rec.strength ?? 1) + strengthDelta));
  return { ...rec };
}

/** For tests: forget the world's kingdoms and keep them in memory only. */
function resetForTests() {
  state = emptyState();
  persist = false;
}

module.exports = {
  load,
  save,
  getKingdom,
  getKingdoms,
  upsertKingdom,
  setRuler,
  setFlag,
  grantTax,
  spendTax,
  recordIncome,
  getIncomeTotals,
  getRecentIncome,
  getMarketTaxRate,
  INCOME_SOURCES,
  declareWar,
  endWar,
  getActiveWars,
  getEndedWars,
  getRawTension,
  setRawTension,
  getTensionMap,
  getAlliances,
  getAlliance,
  isAllied,
  alliesOf,
  formAlliance,
  breakAlliance,
  adjustAlliance,
  resetForTests,
};
