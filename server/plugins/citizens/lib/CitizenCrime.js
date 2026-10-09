"use strict";

/**
 * CitizenCrime — the data tier for citizen crime, criminal records, trials,
 * punishments, and prisons.
 *
 * WHAT IT DOES (data tier, free — read by the slow tick and the brain):
 *   - Crime catalog (theft, assault, vandalism, curfew-violation) with
 *     per-crime severity.
 *   - Crime records per citizen: { kind, severity, at, witnessed,
 *     kingdomId, victim } — the evidence a trial weighs.
 *   - Criminal records: conviction counts, notoriety 0..100 (decays over
 *     30 days), jail sentences, exile marks.
 *   - Prisons per kingdom (8 cells): imprison / release / inmates.
 *   - reportOffense(): records the crime AND reports to the watch's wanted
 *     list (CitizenGuards, defensive) so guards can arrest.
 *   - convict(): applies the sentence — fine (REAL coins from inventory),
 *     jail (real time served), or exile (kingdom mark).
 *
 * WHAT IT DOES NOT DO:
 *   - No ticking here. Onset, curfew checks, trials, punishments, and jail
 *     releases live in lib/CitizenJusticeLife.js (the director ticks that).
 *   - No LLM. Journaled facts only; the chat layer riffs on them.
 *   - Fines are honest: real coins removed from the real inventory when
 *     the citizen is online; offline criminals accrue a fine debt instead
 *     of paying from nowhere. No invented money.
 *
 * DESIGN NOTES:
 *   - Severity drives sentencing: 1 = fine, 2 = fine or short jail,
 *     3 = jail, repeat offenders and severe assaults = exile.
 *   - Notoriety is the criminal reputation other systems read: guards
 *     challenge notorious arrivals, citizens avoid known criminals.
 *     It decays — a citizen can live a crime down over ~30 days.
 *   - The watch's wanted list (CitizenGuards.reportCrime) only knows
 *     theft/attack. reportOffense maps assault -> "attack" defensively.
 *
 * Persisted to data/saves/citizen-crime.json (dirty-flag pattern, never
 * committed). Test seams: _setSavePathForTests / resetForTests.
 */

const fs = require("fs");
const path = require("path");
const { normalizeName } = require("./CitizenBonds");

let SAVE_FILE = path.join(process.cwd(), "data", "saves", "citizen-crime.json");

/** Test seam — redirect the save path (tests must not touch the real one). */
function _setSavePathForTests(p) {
  SAVE_FILE = p;
}

// --- crime catalog -----------------------------------------------------------
// severity: 1 (petty) .. 3 (serious). fineBase: coins for a first-offense fine.
// jailDays: [min, max] sentence range for a custodial sentence.

const CRIMES = Object.freeze({
  theft: Object.freeze({
    label: "theft",
    severity: 2,
    fineBase: 120,
    jailDays: [1, 3],
    description: "stealing from stalls, homes, or pockets",
  }),
  assault: Object.freeze({
    label: "assault",
    severity: 3,
    fineBase: 300,
    jailDays: [3, 7],
    description: "attacking another citizen",
  }),
  vandalism: Object.freeze({
    label: "vandalism",
    severity: 2,
    fineBase: 80,
    jailDays: [1, 2],
    description: "damaging stalls, homes, or town property",
  }),
  "curfew-violation": Object.freeze({
    label: "breaking curfew",
    severity: 1,
    fineBase: 40,
    jailDays: [0, 1],
    description: "out in the streets after curfew",
  }),
});

const CRIME_KEYS = Object.freeze(Object.keys(CRIMES));

function crimeDef(key) {
  return CRIMES[String(key ?? "").toLowerCase()] ?? null;
}

// --- tuning ------------------------------------------------------------------

const DAY_MS = 24 * 3600 * 1000;
const NOTORIETY_DECAY_DAYS = 30; // crimes fade from reputation after this long
const NOTORIETY_PER_SEVERITY = 12; // notoriety points per severity point
const NOTORIETY_PER_CONVICTION = 15;
const NOTORIETY_MAX = 100;
const PRISON_CELLS = 8;
const EXILE_AT_CONVICTIONS = 3; // 3rd conviction for a serious crime = exile
const FINE_DEBT_CAP = 2000; // offline fine debt never exceeds this

// --- state -------------------------------------------------------------------

let cache = null; // { crimes: { [norm]: [record] }, records: { [norm]: rec }, prisons: { [kingdomId]: prison } }
let dirty = false;

function blankState() {
  return {
    crimes: Object.create(null),
    records: Object.create(null),
    prisons: Object.create(null),
  };
}

function blankRecord(username) {
  return {
    username,
    convictions: 0,
    fineDebt: 0,
    jailed: false,
    jailedUntil: 0,
    jailedFor: null,
    exiled: false,
    exiledAt: 0,
    exiledFrom: null,
    lastCrimeAt: 0,
  };
}

function load() {
  if (cache) return cache;
  cache = blankState();
  try {
    if (fs.existsSync(SAVE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SAVE_FILE, "utf8"));
      if (raw && typeof raw === "object") {
        if (raw.crimes && typeof raw.crimes === "object") cache.crimes = raw.crimes;
        if (raw.records && typeof raw.records === "object") cache.records = raw.records;
        if (raw.prisons && typeof raw.prisons === "object") cache.prisons = raw.prisons;
      }
    }
  } catch {
    // Corrupt save — start clean rather than crash the tick.
    cache = blankState();
  }
  return cache;
}

function save() {
  if (!dirty || !cache) return false;
  try {
    fs.mkdirSync(path.dirname(SAVE_FILE), { recursive: true });
    const tmp = SAVE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(cache));
    fs.renameSync(tmp, SAVE_FILE);
    dirty = false;
    return true;
  } catch {
    // Best-effort: never break the tick over a save failure.
    return false;
  }
}

function markDirty() {
  dirty = true;
}

/** Test seam — drop the in-memory cache. */
function resetForTests() {
  cache = null;
  dirty = false;
}

// --- crime records -----------------------------------------------------------

function recordOf(username) {
  const st = load();
  const norm = normalizeName(username);
  if (!st.records[norm]) st.records[norm] = blankRecord(norm);
  return st.records[norm];
}

/** All recorded offenses for a citizen, newest last. */
function crimeHistory(username) {
  const st = load();
  return (st.crimes[normalizeName(username)] ?? []).slice();
}

function convictionCount(username) {
  const st = load();
  return st.records[normalizeName(username)]?.convictions ?? 0;
}

/**
 * Record an offense and report the suspect to the watch's wanted list.
 * Returns the crime record, or null for an unknown crime kind.
 * Defensive: a missing/broken guard module still records the crime.
 */
function reportOffense(username, kind, opts = {}) {
  const def = crimeDef(kind);
  if (!def) return null;
  const st = load();
  const norm = normalizeName(username);
  const now = opts.nowMs ?? Date.now();
  const rec = {
    kind: kind.toLowerCase(),
    severity: def.severity,
    at: now,
    witnessed: !!opts.witnessed,
    kingdomId: opts.kingdomId ?? null,
    victim: opts.victim ?? null,
    display: opts.display ?? username,
  };
  if (!st.crimes[norm]) st.crimes[norm] = [];
  st.crimes[norm].push(rec);
  const r = recordOf(username);
  r.lastCrimeAt = now;
  markDirty();
  // The watch's wanted list drives guard arrests. Map to its crime kinds.
  try {
    const Guards = require("./CitizenGuards");
    const watchKind = kind.toLowerCase() === "assault" ? "attack" : "theft";
    Guards.reportCrime(
      opts.reporter ?? "the watch",
      username,
      watchKind,
      now
    );
  } catch {
    // Wanted list unavailable — the crime is still recorded for trial.
  }
  return rec;
}

// --- notoriety ----------------------------------------------------------------

/**
 * Criminal reputation 0..100. Severity-weighted, decays over 30 days;
 * convictions add a lasting stain. Pure-ish (reads the save).
 */
function notorietyFor(username, nowMs) {
  const st = load();
  const norm = normalizeName(username);
  const now = nowMs ?? Date.now();
  const crimes = st.crimes[norm] ?? [];
  let n = 0;
  for (const c of crimes) {
    const ageDays = Math.max(0, (now - c.at) / DAY_MS);
    if (ageDays >= NOTORIETY_DECAY_DAYS) continue;
    const weight = 1 - ageDays / NOTORIETY_DECAY_DAYS;
    n += c.severity * NOTORIETY_PER_SEVERITY * weight;
  }
  const rec = st.records[norm];
  if (rec) n += rec.convictions * NOTORIETY_PER_CONVICTION;
  return Math.min(NOTORIETY_MAX, Math.round(n));
}

/** Human-readable summary for chat/LLM. Null when the citizen is clean. */
function criminalSummary(username, nowMs) {
  const st = load();
  const norm = normalizeName(username);
  const crimes = st.crimes[norm] ?? [];
  if (crimes.length === 0) return null;
  const rec = st.records[norm];
  return {
    offenses: crimes.length,
    convictions: rec?.convictions ?? 0,
    notoriety: notorietyFor(username, nowMs),
    jailed: isJailed(username, nowMs),
    exiled: !!rec?.exiled,
    lastCrime: crimes[crimes.length - 1]?.kind ?? null,
  };
}

// --- jail ---------------------------------------------------------------------

/** True while the citizen is serving a custodial sentence. */
function isJailed(username, nowMs) {
  const st = load();
  const rec = st.records[normalizeName(username)];
  if (!rec || !rec.jailed) return false;
  const now = nowMs ?? Date.now();
  if (rec.jailedUntil <= now) return false; // sentence expired — tick releases them
  return true;
}

/**
 * Work penalty 0..60 for the decision layer. A jailed citizen cannot work
 * at all — 60, same as the plague. Pure.
 */
function jailPenaltyFor(username, nowMs) {
  return isJailed(username, nowMs) ? 60 : 0;
}

/** True when the citizen has been exiled from their kingdom. */
function isExiled(username) {
  const st = load();
  return !!st.records[normalizeName(username)]?.exiled;
}

// --- prisons ------------------------------------------------------------------

function prisonOfKingdom(kingdomId) {
  const st = load();
  return st.prisons[kingdomId] ?? null;
}

function ensurePrison(kingdomId, name) {
  const st = load();
  if (!st.prisons[kingdomId]) {
    st.prisons[kingdomId] = {
      kingdomId,
      name: name ?? `${kingdomId} gaol`,
      cells: PRISON_CELLS,
      inmates: [], // [{ username, display, until, crime }]
      foundedAt: Date.now(),
    };
    markDirty();
  }
  return st.prisons[kingdomId];
}

function inmatesOfKingdom(kingdomId) {
  const p = prisonOfKingdom(kingdomId);
  return p ? p.inmates.slice() : [];
}

/**
 * Lock a citizen up until untilMs. Returns false when the gaol is full.
 */
function imprison(username, kingdomId, untilMs, crimeKind, display) {
  const st = load();
  const prison = ensurePrison(kingdomId);
  if (prison.inmates.length >= prison.cells) return false;
  const norm = normalizeName(username);
  if (prison.inmates.some((i) => i.username === norm)) return false; // already inside
  prison.inmates.push({
    username: norm,
    display: display ?? username,
    until: untilMs,
    crime: crimeKind ?? null,
  });
  const rec = recordOf(username);
  rec.jailed = true;
  rec.jailedUntil = untilMs;
  rec.jailedFor = crimeKind ?? null;
  markDirty();
  return true;
}

/**
 * Release a citizen early (or after their time). Returns true if they were held.
 */
function release(username) {
  const st = load();
  const norm = normalizeName(username);
  let held = false;
  for (const prison of Object.values(st.prisons)) {
    const i = prison.inmates.findIndex((x) => x.username === norm);
    if (i >= 0) {
      prison.inmates.splice(i, 1);
      held = true;
    }
  }
  const rec = st.records[norm];
  if (rec && rec.jailed) {
    rec.jailed = false;
    rec.jailedUntil = 0;
    rec.jailedFor = null;
    markDirty();
  }
  if (held) markDirty();
  return held || !!rec?.jailed;
}

// --- sentencing ----------------------------------------------------------------

// --- canonical coin helpers (real engine API: getAmount / deleteNumber / adds) ---
// The old multi-API guards probed `inv.count` / `inv.remove` / `inv.delete` —
// `count` and `remove` do not exist on the engine inventory. These three are
// the only coin paths; every balance move is verified before reporting success.

/** Read a real item amount. Never throws, never invents. */
function coinCount(inv, id) {
  try { return inv?.getAmount?.(id) ?? 0; } catch { return 0; }
}

/**
 * Remove exactly `amount` of `id`, verifying the balance moved.
 * Returns true only when the inventory confirms the debit.
 */
function takeCoins(inv, id, amount) {
  try {
    if (!inv || amount <= 0) return false;
    const before = inv.getAmount?.(id) ?? 0;
    if (before < amount) return false;
    inv.deleteNumber?.(id, amount);
    return (inv.getAmount?.(id) ?? 0) === before - amount;
  } catch { return false; }
}

/**
 * Credit exactly `amount` of `id`, verifying the balance moved.
 * Returns true only when the inventory confirms the credit.
 */
function giveCoins(inv, id, amount) {
  try {
    if (!inv || amount <= 0) return false;
    const before = inv.getAmount?.(id) ?? 0;
    inv.adds?.(id, amount);
    return (inv.getAmount?.(id) ?? 0) === before + amount;
  } catch { return false; }
}

/** Test seam: canonical real-API coin helpers (inventory audit). */
function _coinHelpersForTests() {
  return { coinCount, takeCoins, giveCoins };
}

function countCoins(player) {
  try {
    return coinCount(player?.getInventory?.(), 995);
  } catch {
    return 0;
  }
}

function removeCoins(player, amount) {
  try {
    const inv = player?.getInventory?.();
    if (!inv) return 0;
    const take = Math.min(coinCount(inv, 995), amount);
    if (take <= 0) return 0;
    return takeCoins(inv, 995, take) ? take : 0;
  } catch {
    return 0;
  }
}

/**
 * Apply a fine. Online citizens pay real coins; offline ones accrue a fine
 * debt (capped) instead of paying from nowhere. Returns { paid, debted }.
 */
function applyFine(username, amount, player) {
  const rec = recordOf(username);
  const due = Math.max(0, Math.round(amount));
  if (due <= 0) return { paid: 0, debted: 0 };
  let paid = 0;
  if (player) paid = removeCoins(player, due);
  const rest = due - paid;
  if (rest > 0) {
    rec.fineDebt = Math.min(FINE_DEBT_CAP, rec.fineDebt + rest);
  }
  markDirty();
  return { paid, debted: rest };
}

/** Mark a citizen exiled from a kingdom. Their record carries the stain. */
function exileCitizen(username, kingdomId, nowMs) {
  const rec = recordOf(username);
  rec.exiled = true;
  rec.exiledAt = nowMs ?? Date.now();
  rec.exiledFrom = kingdomId ?? null;
  markDirty();
  return true;
}

/** Lift an exile (royal pardon, sentence served). */
function pardon(username) {
  const st = load();
  const rec = st.records[normalizeName(username)];
  if (!rec || !rec.exiled) return false;
  rec.exiled = false;
  rec.exiledAt = 0;
  rec.exiledFrom = null;
  markDirty();
  return true;
}

/**
 * Record a conviction and return the recommended sentence.
 * { type: "fine"|"jail"|"exile", fine, jailDays } — the tick applies it.
 * First petty offense: fine. Repeat or serious: jail. Third serious
 * conviction: exile.
 */
function convict(username, kind, nowMs) {
  const def = crimeDef(kind);
  if (!def) return null;
  const rec = recordOf(username);
  rec.convictions += 1;
  const [jMin, jMax] = def.jailDays;
  let sentence;
  if (rec.convictions >= EXILE_AT_CONVICTIONS && def.severity >= 2) {
    sentence = { type: "exile", fine: 0, jailDays: 0 };
  } else if (def.severity >= 3 || rec.convictions >= 2) {
    const days = jMin + Math.floor(Math.random() * Math.max(1, jMax - jMin + 1));
    sentence = { type: "jail", fine: 0, jailDays: days };
  } else {
    const fine = def.fineBase * rec.convictions; // fines scale with priors
    sentence = { type: "fine", fine, jailDays: 0 };
  }
  markDirty();
  return sentence;
}

module.exports = {
  CRIMES,
  CRIME_KEYS,
  crimeDef,
  PRISON_CELLS,
  EXILE_AT_CONVICTIONS,
  // records
  recordOf,
  crimeHistory,
  convictionCount,
  criminalSummary,
  reportOffense,
  // reputation
  notorietyFor,
  // jail
  isJailed,
  jailPenaltyFor,
  imprison,
  release,
  // prisons
  prisonOfKingdom,
  ensurePrison,
  inmatesOfKingdom,
  // sentencing
  applyFine,
  exileCitizen,
  pardon,
  isExiled,
  convict,
  // persistence
  save,
  load,
  resetForTests,
  _setSavePathForTests,
  _coinHelpersForTests,
};
