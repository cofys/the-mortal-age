"use strict";

/**
 * CitizenLegalCode — the data tier for the realm's legal system: statutes,
 * judges, lawyers, appeals, pardons, and player accusations.
 *
 * WHAT IT DOES (data tier, free — read by the slow tick and the brain):
 *   - Legal statutes: per-crime standard penalties derived from
 *     CitizenCrime's catalog, modified by active government laws:
 *       * "harsh-justice": fines x2, jail +50% (rounded up).
 *       * "restorative-justice": fines go to the VICTIM (real coins) rather
 *         than the town purse; jail terms halved (rounded down, min 0).
 *       * "trial-by-jury": verdicts weigh evidence more carefully — the
 *         court's base skepticism rises (fewer false convictions).
 *   - Judges: one per kingdom, appointed from lawful citizens with
 *     reputation >= 20. A judge's fairness (from reputation + lawful traits)
 *     nudges verdict accuracy. `judgeFor(kingdomId)`.
 *   - Lawyers: the `lawyer` career (see CitizenCareers). An accused citizen
 *     may hire a lawyer for a flat 150-coin fee (REAL coins, deducted by the
 *     caller from the real inventory; offline accused accrue fee debt).
 *     A hired lawyer reduces the court's guilt score by 0.15 and, on
 *     acquittal, earns the `advocate` fame deed.
 *   - Appeals: a convicted citizen may appeal within 7 days for a 100-coin
 *     fee. The appeal re-hears the case with fresh eyes (new guilt roll,
 *     lawyer bonus applies). Overturned convictions clear the record.
 *   - Pardons: pardon petitions. The town council grants a pardon when the
 *     convicted has reputation >= 40 (reformed citizen) or a family member
 *     petitions with 500 coins. A pardon clears convictions and jail time.
 *   - Player accusations: `accusePlayer(playerName, crimeKind, reporter)` —
 *     when a guard witnesses a player crime or a citizen reports one, the
 *     accusation is recorded. The Life tick holds a player trial; a guilty
 *     verdict puts the player on the watch's wanted list for the sentence
 *     duration (guards challenge wanted players at gates — real
 *     consequences through existing machinery). Players are never jailed
 *     by this system — only wanted-listed.
 *
 * WHAT IT DOES NOT DO:
 *   - No ticking here. Judge assignment, appeal hearings, pardon decisions,
 *     and player trials live in lib/CitizenLegalLife.js (the director ticks
 *     that).
 *   - No LLM. Journaled facts only; the chat layer riffs on them.
 *   - No invented money: fees are honest (real coins or capped debt).
 *   - Does not replace CitizenCrime/CitizenJusticeLife — it layers the
 *     legal profession on top. Trials still run in CitizenJusticeLife;
 *     this module's hooks (judgeFor, defenseBonusFor) are read defensively
 *     from there.
 *
 * DESIGN NOTES:
 *   - The no-overlap boundary: CitizenCrime owns offense records and base
 *     sentencing; CitizenJusticeLife owns trial scheduling and punishment
 *     execution; CitizenGovernment owns the law catalog and councils. This
 *     module owns statutes-as-applied, the legal profession (judges,
 *     lawyers), post-conviction remedies (appeals, pardons), and the
 *     player-trial bridge.
 *   - All cross-module reads are defensive: a missing CitizenCrime or
 *     CitizenGovernment degrades to base penalties, never throws.
 *
 * Persisted to data/saves/citizen-legalcode.json (dirty-flag pattern, never
 * committed). Test seams: _setSavePathForTests / resetForTests.
 */

const fs = require("fs");
const path = require("path");
const { normalizeName } = require("./CitizenBonds");

let SAVE_FILE = path.join(process.cwd(), "data", "saves", "citizen-legalcode.json");

/** Test seam — redirect the save path (tests must not touch the real one). */
function _setSavePathForTests(p) {
  SAVE_FILE = p;
}

// --- tuning ----------------------------------------------------------------

const LAWYER_FEE = 150; // flat fee in coins for hiring a defense lawyer
const APPEAL_FEE = 100; // fee to file an appeal
const APPEAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days to appeal
const PARDON_PETITION_FEE = 500; // family petition fee
const PARDON_REPUTATION_THRESHOLD = 40; // reformed-citizen pardon threshold
const JUDGE_REPUTATION_MIN = 20; // minimum reputation to serve as judge
const JUDGE_TERM_MS = 30 * 24 * 60 * 60 * 1000; // 30-day judicial terms
const LAWYER_DEFENSE_BONUS = 0.15; // guilt-score reduction from counsel
const JURY_SKEPTICISM_BONUS = 0.1; // extra court skepticism under trial-by-jury

// --- state -------------------------------------------------------------------

let cache = null; // { judges: {kingdomId: {username, appointedAtMs, fairness}}, lawyers: {norm: {client, hiredAtMs}}, appeals: [...], pardons: [...], playerAccusations: [...] }
let dirty = false;

function blankState() {
  return {
    judges: Object.create(null),
    lawyers: Object.create(null), // norm(accused) -> { lawyer, hiredAtMs, feePaid }
    appeals: [], // { username, crimeKind, filedAtMs, feePaid, status }
    pardons: [], // { username, petitionedBy, petitionedAtMs, status, decidedAtMs }
    playerAccusations: [], // { playerName, crimeKind, reporter, atMs, status }
  };
}

function state() {
  if (!cache) {
    cache = blankState();
    try {
      if (fs.existsSync(SAVE_FILE)) {
        const raw = JSON.parse(fs.readFileSync(SAVE_FILE, "utf8"));
        if (raw && typeof raw === "object") {
          cache.judges = raw.judges || Object.create(null);
          cache.lawyers = raw.lawyers || Object.create(null);
          cache.appeals = Array.isArray(raw.appeals) ? raw.appeals : [];
          cache.pardons = Array.isArray(raw.pardons) ? raw.pardons : [];
          cache.playerAccusations = Array.isArray(raw.playerAccusations)
            ? raw.playerAccusations
            : [];
        }
      }
    } catch {
      cache = blankState();
    }
  }
  return cache;
}

function markDirty() {
  dirty = true;
}

function save() {
  if (!dirty) return false;
  try {
    fs.mkdirSync(path.dirname(SAVE_FILE), { recursive: true });
    fs.writeFileSync(SAVE_FILE, JSON.stringify(state(), null, 2));
    dirty = false;
    return true;
  } catch {
    return false;
  }
}

function resetForTests() {
  cache = null;
  dirty = false;
}

// --- helpers -----------------------------------------------------------------

function crimeDef(kind) {
  try {
    const Crime = require("./CitizenCrime");
    return Crime.crimeDef(kind) || null;
  } catch {
    return null;
  }
}

function activeLaws(kingdomId, nowMs) {
  try {
    const Gov = require("./CitizenGovernment");
    if (typeof Gov.activeLaws === "function") return Gov.activeLaws(kingdomId, nowMs);
    if (typeof Gov.hasLaw === "function") {
      // Fallback: probe the three justice laws individually.
      const ids = ["harsh-justice", "restorative-justice", "trial-by-jury"];
      return ids.filter((id) => Gov.hasLaw(kingdomId, id, nowMs)).map((id) => ({ id }));
    }
    return [];
  } catch {
    return [];
  }
}

function hasJusticeLaw(kingdomId, lawId, nowMs) {
  const laws = activeLaws(kingdomId, nowMs);
  return laws.some((l) => l.id === lawId);
}

// --- statutes: sentencing as applied ------------------------------------------
// Returns { fine, jailDays, victimRestitution } for a crime in a kingdom,
// applying active justice laws. Base comes from CitizenCrime's catalog.

function sentenceFor(kingdomId, crimeKind, priors, nowMs) {
  const def = crimeDef(crimeKind);
  const now = nowMs ?? Date.now();
  // Base penalty from the crime catalog (defensive defaults).
  let fine = def?.fineBase ?? 100;
  let jailDays = def?.jailDays ? Math.max(def.jailDays[0], 1) : 1;
  // Repeat offenders: fine scales with priors.
  fine = Math.round(fine * (1 + 0.5 * Math.max(0, priors)));
  let victimRestitution = 0;

  if (hasJusticeLaw(kingdomId, "harsh-justice", now)) {
    fine = fine * 2;
    jailDays = Math.ceil(jailDays * 1.5);
  }
  if (hasJusticeLaw(kingdomId, "restorative-justice", now)) {
    // Fines go to the victim, not the town; jail is halved (min 0).
    victimRestitution = fine;
    fine = 0;
    jailDays = Math.max(0, Math.floor(jailDays / 2));
  }
  return { fine, jailDays, victimRestitution };
}

// --- judges --------------------------------------------------------------------
// One judge per kingdom. Appointed from lawful citizens with reputation >= 20.
// Fairness 0..1 derived from reputation (higher = fairer).

function assignJudge(kingdomId, username, nowMs) {
  const s = state();
  const now = nowMs ?? Date.now();
  let fairness = 0.5;
  try {
    const Rep = require("./CitizenReputation");
    const score = Rep.scoreFor?.(username) ?? 0;
    fairness = Math.min(1, Math.max(0, 0.5 + score / 200));
  } catch {
    // default fairness
  }
  s.judges[kingdomId] = { username, appointedAtMs: now, fairness };
  markDirty();
  return s.judges[kingdomId];
}

function judgeFor(kingdomId, nowMs) {
  const s = state();
  const j = s.judges[kingdomId];
  if (!j) return null;
  const now = nowMs ?? Date.now();
  if (now - j.appointedAtMs > JUDGE_TERM_MS) return null; // term expired
  return j;
}

function clearJudge(kingdomId) {
  const s = state();
  delete s.judges[kingdomId];
  markDirty();
}

// --- lawyers --------------------------------------------------------------------
// An accused citizen hires a lawyer for a flat fee. The fee is honest: the
// caller deducts real coins (or records debt). This module tracks the
// representation so the trial hook can apply the defense bonus.

function hireLawyer(accusedUsername, lawyerUsername, nowMs, feePaid) {
  const s = state();
  const norm = normalizeName(accusedUsername);
  s.lawyers[norm] = {
    lawyer: lawyerUsername,
    hiredAtMs: nowMs ?? Date.now(),
    feePaid: !!feePaid,
  };
  markDirty();
  return s.lawyers[norm];
}

function lawyerFor(accusedUsername) {
  const s = state();
  return s.lawyers[normalizeName(accusedUsername)] || null;
}

function clearLawyer(accusedUsername) {
  const s = state();
  delete s.lawyers[normalizeName(accusedUsername)];
  markDirty();
}

/** Defense bonus for the trial hook: 0.15 guilt reduction when represented. */
function defenseBonusFor(accusedUsername) {
  return lawyerFor(accusedUsername) ? LAWYER_DEFENSE_BONUS : 0;
}

/** Count of active representations (for decision scoring). */
function representationCount() {
  return Object.keys(state().lawyers).length;
}

/** Extra court skepticism under trial-by-jury law. */
function jurySkepticismBonus(kingdomId, nowMs) {
  return hasJusticeLaw(kingdomId, "trial-by-jury", nowMs ?? Date.now())
    ? JURY_SKEPTICISM_BONUS
    : 0;
}

// --- appeals ----------------------------------------------------------------------

function fileAppeal(username, crimeKind, nowMs, feePaid) {
  const s = state();
  const norm = normalizeName(username);
  // One pending appeal per citizen.
  if (s.appeals.some((a) => normalizeName(a.username) === norm && a.status === "pending")) {
    return null;
  }
  const appeal = {
    username,
    crimeKind,
    filedAtMs: nowMs ?? Date.now(),
    feePaid: !!feePaid,
    status: "pending",
  };
  s.appeals.push(appeal);
  markDirty();
  return appeal;
}

function pendingAppeals(nowMs) {
  const s = state();
  const now = nowMs ?? Date.now();
  return s.appeals.filter(
    (a) => a.status === "pending" && now - a.filedAtMs <= APPEAL_WINDOW_MS
  );
}

function resolveAppeal(username, overturned, nowMs) {
  const s = state();
  const norm = normalizeName(username);
  const appeal = s.appeals.find(
    (a) => normalizeName(a.username) === norm && a.status === "pending"
  );
  if (!appeal) return null;
  appeal.status = overturned ? "overturned" : "upheld";
  appeal.decidedAtMs = nowMs ?? Date.now();
  markDirty();
  return appeal;
}

// --- pardons ------------------------------------------------------------------------

function requestPardon(username, petitionedBy, nowMs, feePaid) {
  const s = state();
  const norm = normalizeName(username);
  if (s.pardons.some((p) => normalizeName(p.username) === norm && p.status === "pending")) {
    return null;
  }
  const pardon = {
    username,
    petitionedBy: petitionedBy || null,
    petitionedAtMs: nowMs ?? Date.now(),
    feePaid: !!feePaid,
    status: "pending",
  };
  s.pardons.push(pardon);
  markDirty();
  return pardon;
}

function pendingPardons() {
  return state().pardons.filter((p) => p.status === "pending");
}

function grantPardon(username, nowMs) {
  const s = state();
  const norm = normalizeName(username);
  const pardon = s.pardons.find(
    (p) => normalizeName(p.username) === norm && p.status === "pending"
  );
  if (!pardon) return null;
  pardon.status = "granted";
  pardon.decidedAtMs = nowMs ?? Date.now();
  // A pardon clears the criminal record — the slate is wiped clean.
  try {
    const Crime = require("./CitizenCrime");
    if (typeof Crime.clearRecord === "function") Crime.clearRecord(username);
    else if (typeof Crime.pardon === "function") Crime.pardon(username);
  } catch {
    // record-clear is best-effort; the pardon itself stands
  }
  markDirty();
  return pardon;
}

function denyPardon(username, nowMs) {
  const s = state();
  const norm = normalizeName(username);
  const pardon = s.pardons.find(
    (p) => normalizeName(p.username) === norm && p.status === "pending"
  );
  if (!pardon) return null;
  pardon.status = "denied";
  pardon.decidedAtMs = nowMs ?? Date.now();
  markDirty();
  return pardon;
}

// --- player accusations ---------------------------------------------------------------
// Guards who witness a player committing a crime, or citizens who report one,
// record an accusation. The Life tick holds a player trial; a guilty verdict
// puts the player on the watch's wanted list (real consequences via existing
// guard machinery). Players are never jailed by this system.

function accusePlayer(playerName, crimeKind, reporter, nowMs) {
  const s = state();
  const norm = normalizeName(playerName);
  // One pending accusation per player per crime kind.
  const existing = s.playerAccusations.find(
    (a) =>
      normalizeName(a.playerName) === norm &&
      a.crimeKind === crimeKind &&
      a.status === "pending"
  );
  if (existing) return existing;
  const accusation = {
    playerName,
    crimeKind,
    reporter: reporter || null,
    atMs: nowMs ?? Date.now(),
    status: "pending",
  };
  s.playerAccusations.push(accusation);
  markDirty();
  return accusation;
}

function pendingPlayerAccusations() {
  return state().playerAccusations.filter((a) => a.status === "pending");
}

function resolvePlayerAccusation(playerName, crimeKind, verdict, nowMs) {
  const s = state();
  const norm = normalizeName(playerName);
  const acc = s.playerAccusations.find(
    (a) =>
      normalizeName(a.playerName) === norm &&
      a.crimeKind === crimeKind &&
      a.status === "pending"
  );
  if (!acc) return null;
  acc.status = verdict; // "guilty" | "acquitted"
  acc.decidedAtMs = nowMs ?? Date.now();
  markDirty();
  return acc;
}

module.exports = {
  // tuning (exported for tests and the Life tick)
  LAWYER_FEE,
  APPEAL_FEE,
  APPEAL_WINDOW_MS,
  PARDON_PETITION_FEE,
  PARDON_REPUTATION_THRESHOLD,
  JUDGE_REPUTATION_MIN,
  JUDGE_TERM_MS,
  LAWYER_DEFENSE_BONUS,
  // statutes
  sentenceFor,
  // judges
  assignJudge,
  judgeFor,
  clearJudge,
  // lawyers
  hireLawyer,
  lawyerFor,
  clearLawyer,
  defenseBonusFor,
  representationCount,
  jurySkepticismBonus,
  // appeals
  fileAppeal,
  pendingAppeals,
  resolveAppeal,
  // pardons
  requestPardon,
  pendingPardons,
  grantPardon,
  denyPardon,
  // player accusations
  accusePlayer,
  pendingPlayerAccusations,
  resolvePlayerAccusation,
  // persistence
  save,
  resetForTests,
  _setSavePathForTests,
};
