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
  return { version: STORE_VERSION, kingdoms: {}, wars: [], tension: {} };
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
  declareWar,
  endWar,
  getActiveWars,
  getEndedWars,
  getRawTension,
  setRawTension,
  getTensionMap,
  resetForTests,
};
