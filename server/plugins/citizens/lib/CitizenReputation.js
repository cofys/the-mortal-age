"use strict";

/**
 * CitizenReputation — the data tier for citizen reputation and fame.
 *
 * WHAT IT DOES (data tier, free — read by the slow tick and the brain):
 *   - Reputation score per citizen: -100 (infamous) .. +100 (legendary),
 *     starting at 0. One number, many readers.
 *   - Fame tiers: legendary (75+), famous (40+), known (10+), unknown
 *     (-10..10), disliked (-40..-10), notorious (-75..-40), infamous (-75..).
 *   - Deed catalog: generosity (+3), heroism (+8), skill mastery (+5),
 *     quest completion (+10), betrayal (-6), cowardice (-4). Crimes feed in
 *     from CitizenCrime's notoriety (defensive read) rather than a second
 *     bookkeeping path.
 *   - addReputation(): clamps to [-100, 100], records the deed, marks dirty.
 *   - topFamous(n): leaderboard for bards to sing about and chat to quote.
 *   - salePriceModifierFor(): famous merchants charge more, infamous ones
 *     are shunned into discounts. Pure function of score, no side effects.
 *   - socialModifierFor(): fame tier -> social-activity score delta.
 *   - Fame fades: the slow tick decays scores 1 point/day toward 0.
 *
 * WHAT IT DOES NOT DO:
 *   - No ticking here. Decay, bard songs, fame announcements, and skill-
 *     mastery checks live in lib/CitizenReputationLife.js.
 *   - No LLM. Journaled facts only; the chat layer riffs on them.
 *   - No invented money: price modifiers change what a merchant ASKS, the
 *     buyer still pays real coins or walks away.
 *
 * Persisted to data/saves/citizen-reputation.json (dirty-flag pattern,
 * never committed). Test seams: _setSavePathForTests / resetForTests.
 */

const fs = require("fs");
const path = require("path");
const { normalizeName } = require("./CitizenBonds");

let SAVE_FILE = path.join(process.cwd(), "data", "saves", "citizen-reputation.json");

/** Test seam — redirect the save path (tests must not touch the real one). */
function _setSavePathForTests(p) {
  SAVE_FILE = p;
}

// --- tuning ------------------------------------------------------------------

const DAY_MS = 24 * 3600 * 1000;
const DECAY_PER_DAY = 1; // fame fades: 1 point toward 0 per day
const SCORE_MIN = -100;
const SCORE_MAX = 100;

// Fame tier boundaries (inclusive lower bound).
const TIERS = Object.freeze([
  { min: 75, key: "legendary", label: "legendary" },
  { min: 40, key: "famous", label: "famous" },
  { min: 10, key: "known", label: "well-known" },
  { min: -9, key: "unknown", label: "unknown" },
  { min: -39, key: "disliked", label: "disliked" },
  { min: -74, key: "notorious", label: "notorious" },
  { min: -100, key: "infamous", label: "infamous" },
]);

// Deed catalog: points awarded per deed kind.
const DEEDS = Object.freeze({
  generosity: Object.freeze({ points: 3, label: "generosity" }),
  heroism: Object.freeze({ points: 8, label: "heroism" }),
  skill_mastery: Object.freeze({ points: 5, label: "skill mastery" }),
  quest_hero: Object.freeze({ points: 10, label: "quest heroism" }),
  champion: Object.freeze({ points: 8, label: "tournament champion" }),
  finalist: Object.freeze({ points: 3, label: "tournament finalist" }),
  peacemaker: Object.freeze({ points: 8, label: "marriage alliance broker" }),
  inventor: Object.freeze({ points: 8, label: "invention breakthrough" }),
  sage: Object.freeze({ points: 8, label: "attained sage wisdom" }),
  debater: Object.freeze({ points: 4, label: "won a public debate" }),
  advocate: Object.freeze({ points: 6, label: "won an acquittal as defense counsel" }),
  builder: Object.freeze({ points: 6, label: "completed a public building" }),
  landmark: Object.freeze({ points: 12, label: "raised a landmark of the realm" }),
  virtuoso: Object.freeze({ points: 8, label: "headlined a concert" }),
  trendsetter: Object.freeze({ points: 8, label: "won a style competition" }),
  masterchef: Object.freeze({ points: 8, label: "won a culinary competition" }),
  festival_organizer: Object.freeze({ points: 8, label: "organized a festival" }),
  league_champion: Object.freeze({ points: 10, label: "won a league championship" }),
  scientist: Object.freeze({ points: 8, label: "made a scientific discovery" }),
  engineer: Object.freeze({ points: 8, label: "completed a public work" }),
  stargazer: Object.freeze({ points: 6, label: "charted the heavens" }),
  master_cartographer: Object.freeze({ points: 6, label: "drew a masterwork map" }),
  inkslinger: Object.freeze({ points: 8, label: "published five stories" }),
  muckraker: Object.freeze({ points: 6, label: "exposed three crimes" }),
  financier: Object.freeze({ points: 8, label: "built a banking fortune" }),
  defaulter: Object.freeze({ points: -8, label: "defaulted on a bank loan" }),
  underwriter: Object.freeze({ points: 8, label: "underwrote a thriving insurance book" }),
  uninsured: Object.freeze({ points: -4, label: "let every policy lapse" }),
  counselor: Object.freeze({ points: 6, label: "won a civil case as advocate" }),
  oathbreaker: Object.freeze({ points: -6, label: "broke a sworn contract" }),
  executor: Object.freeze({ points: 4, label: "settled an estate faithfully" }),
  betrayal: Object.freeze({ points: -6, label: "betrayal" }),
  cowardice: Object.freeze({ points: -4, label: "cowardice" }),
});

// --- state -------------------------------------------------------------------

let cache = null; // { reps: { [norm]: { score, deeds: [...], lastDecay, announcedTier } } }
let dirty = false;

function blankState() {
  return { reps: Object.create(null) };
}

function blankRep(username) {
  return { username, score: 0, deeds: [], lastDecay: 0, announcedTier: "unknown" };
}

function load() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(SAVE_FILE, "utf8"));
    cache = blankState();
    if (raw && typeof raw === "object") {
      for (const [k, v] of Object.entries(raw.reps ?? {})) {
        if (!v || typeof v !== "object") continue;
        cache.reps[k] = {
          username: String(v.username ?? k),
          score: clampScore(Number(v.score ?? 0)),
          deeds: Array.isArray(v.deeds) ? v.deeds.slice(-20) : [],
          lastDecay: Number(v.lastDecay ?? 0),
          announcedTier: String(v.announcedTier ?? "unknown"),
        };
      }
    }
  } catch {
    cache = blankState();
  }
  return cache;
}

function clampScore(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(SCORE_MIN, Math.min(SCORE_MAX, Math.round(n)));
}

function markDirty() {
  dirty = true;
}

// --- reads -------------------------------------------------------------------

/** Fame tier key for a score: legendary | famous | known | unknown | disliked | notorious | infamous */
function tierForScore(score) {
  const s = clampScore(score);
  for (const t of TIERS) {
    if (s >= t.min) return t.key;
  }
  return "infamous";
}

/** Human label for a tier key. */
function tierLabel(tierKey) {
  return TIERS.find((t) => t.key === tierKey)?.label ?? "unknown";
}

/** Current reputation score for a citizen (0 when unknown). */
function reputationFor(username) {
  if (!username) return 0;
  const st = load();
  return st.reps[normalizeName(username)]?.score ?? 0;
}

/** Fame tier key for a citizen. */
function fameTierFor(username) {
  return tierForScore(reputationFor(username));
}

/** Full reputation summary for chat/journal. */
function reputationSummary(username) {
  const score = reputationFor(username);
  const tier = tierForScore(score);
  const st = load();
  const rep = st.reps[normalizeName(username)];
  return {
    username,
    score,
    tier,
    tierLabel: tierLabel(tier),
    recentDeeds: (rep?.deeds ?? []).slice(-5).reverse(),
  };
}

/**
 * Sale-price modifier for a merchant citizen: famous merchants command
 * higher prices, infamous ones must discount to move goods.
 * Returns a multiplier (e.g. 1.10 = +10%). Pure function, no side effects.
 */
function salePriceModifierFor(username) {
  const score = reputationFor(username);
  if (score >= 75) return 1.15;
  if (score >= 40) return 1.1;
  if (score >= 10) return 1.05;
  if (score <= -75) return 0.85;
  if (score <= -40) return 0.9;
  if (score <= -10) return 0.95;
  return 1.0;
}

/**
 * Social-activity score delta for a citizen: the famous are welcomed,
 * the infamous are shunned. Read by CitizenDecisions.
 */
function socialModifierFor(username) {
  const tier = fameTierFor(username);
  switch (tier) {
    case "legendary": return 12;
    case "famous": return 8;
    case "known": return 4;
    case "disliked": return -4;
    case "notorious": return -8;
    case "infamous": return -12;
    default: return 0;
  }
}

/**
 * Leaderboard: top N citizens by reputation score. Optional kingdomId
 * filter needs a roster lookup the caller provides via kingdomOf(username).
 */
function topFamous(n = 5, kingdomOf = null) {
  const st = load();
  const rows = [];
  for (const rep of Object.values(st.reps)) {
    if (rep.score < 10) continue; // only the known-and-above make the board
    if (typeof kingdomOf === "function") {
      try {
        if (kingdomOf(rep.username) === undefined) continue;
      } catch {
        continue;
      }
    }
    rows.push({ username: rep.username, score: rep.score, tier: tierForScore(rep.score) });
  }
  rows.sort((a, b) => b.score - a.score);
  return rows.slice(0, Math.max(1, n));
}

// --- writes ------------------------------------------------------------------

/**
 * Award (or dock) reputation for a deed. amount is added to the score and
 * clamped to [-100, 100]; reason is journaled on the deed record.
 * Returns the new score.
 */
function addReputation(username, amount, reason, nowMs = Date.now()) {
  if (!username || !Number.isFinite(amount) || amount === 0) return reputationFor(username);
  const st = load();
  const key = normalizeName(username);
  if (!st.reps[key]) st.reps[key] = blankRep(username);
  const rep = st.reps[key];
  rep.score = clampScore(rep.score + Math.round(amount));
  rep.deeds.push({ at: nowMs, amount: Math.round(amount), reason: String(reason ?? "deed") });
  if (rep.deeds.length > 20) rep.deeds = rep.deeds.slice(-20);
  markDirty();
  return rep.score;
}

/** Award a catalogued deed by kind (generosity, heroism, ...). Returns new score. */
function awardDeed(username, deedKind, nowMs = Date.now()) {
  const def = DEEDS[String(deedKind ?? "").toLowerCase()];
  if (!def) return reputationFor(username);
  return addReputation(username, def.points, def.label, nowMs);
}

/**
 * Sync criminal infamy: reads CitizenCrime's notoriety (0..100) and keeps
 * the negative side of the reputation score in line with it. Crimes drag
 * reputation down; living clean lets the decay bring it back. Defensive:
 * a missing/broken crime module is a no-op.
 */
function syncCrimeInfamy(username, nowMs = Date.now()) {
  try {
    const Crime = require("./CitizenCrime");
    if (typeof Crime.notorietyFor !== "function") return reputationFor(username);
    const notoriety = Number(Crime.notorietyFor(username, nowMs) ?? 0);
    if (!(notoriety > 0)) return reputationFor(username);
    // Notoriety 100 -> reputation floor of -80; proportional below that.
    const target = -Math.round((notoriety / 100) * 80);
    const current = reputationFor(username);
    if (current <= target) return current; // already infamous enough
    const st = load();
    const key = normalizeName(username);
    if (!st.reps[key]) st.reps[key] = blankRep(username);
    st.reps[key].score = clampScore(target);
    st.reps[key].deeds.push({ at: nowMs, amount: target - current, reason: "criminal notoriety" });
    if (st.reps[key].deeds.length > 20) st.reps[key].deeds = st.reps[key].deeds.slice(-20);
    markDirty();
    return target;
  } catch {
    return reputationFor(username);
  }
}

/**
 * Decay one citizen's score toward 0. Returns true when something changed.
 * Called by the slow tick; also directly testable.
 */
function decayOnce(username, nowMs = Date.now()) {
  const st = load();
  const key = normalizeName(username);
  const rep = st.reps[key];
  if (!rep || rep.score === 0) return false;
  if (nowMs - (rep.lastDecay ?? 0) < DAY_MS) return false;
  rep.lastDecay = nowMs;
  rep.score += rep.score > 0 ? -DECAY_PER_DAY : DECAY_PER_DAY;
  rep.score = clampScore(rep.score);
  markDirty();
  return true;
}

/** Decay every tracked citizen. Returns the count changed. */
function decayAll(nowMs = Date.now()) {
  const st = load();
  let changed = 0;
  for (const key of Object.keys(st.reps)) {
    if (decayOnce(st.reps[key].username, nowMs)) changed++;
  }
  return changed;
}

/** Mark a fame tier as announced so the tick doesn't repeat itself. */
function markTierAnnounced(username, tierKey) {
  const st = load();
  const key = normalizeName(username);
  if (!st.reps[key]) st.reps[key] = blankRep(username);
  if (st.reps[key].announcedTier !== tierKey) {
    st.reps[key].announcedTier = tierKey;
    markDirty();
  }
}

/** The last tier we announced for this citizen (to detect crossings). */
function announcedTierFor(username) {
  const st = load();
  return st.reps[normalizeName(username)]?.announcedTier ?? "unknown";
}

// --- persistence ---------------------------------------------------------------

function save() {
  if (!dirty) return false;
  try {
    fs.mkdirSync(path.dirname(SAVE_FILE), { recursive: true });
    fs.writeFileSync(SAVE_FILE, JSON.stringify(load(), null, 2), "utf8");
    dirty = false;
    return true;
  } catch {
    return false;
  }
}

/** Test seam — wipe in-memory state. */
function resetForTests() {
  cache = blankState();
  dirty = false;
}

module.exports = {
  _setSavePathForTests,
  resetForTests,
  tierForScore,
  tierLabel,
  reputationFor,
  fameTierFor,
  reputationSummary,
  salePriceModifierFor,
  socialModifierFor,
  topFamous,
  addReputation,
  awardDeed,
  syncCrimeInfamy,
  decayOnce,
  decayAll,
  markTierAnnounced,
  announcedTierFor,
  save,
  DEEDS,
  SCORE_MIN,
  SCORE_MAX,
};
