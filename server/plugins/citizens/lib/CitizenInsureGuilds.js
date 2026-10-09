"use strict";

/**
 * CitizenInsureGuilds — the underwriters' association (insurance guild) operations layer.
 *
 * No-overlap boundary (documented, do not duplicate):
 *   - CitizenInsurance owns: REAL insurer registry, policies, premiums,
 *     the insurer pool, claims, payoutsOwed, risk pricing, and the player
 *     insurance bridge. Its records are READ-ONLY here — this module never
 *     edits policies, premiums, the pool, or the insurer registry directly
 *     (except reducing payoutsOwed via CitizenInsurance.coverOwedPayout
 *     when the guild's own reinsurance fund pays an owed claimant — always
 *     from the guild's tracked fund, never invented coins, and never more
 *     than the pool actually owed).
 *   - CitizenInsurerWork (brain) owns: the insurer service action — insurers
 *     selling real policies and settling claims at the office.
 *   - THIS module owns: the profession's GUILD layer — per-kingdom
 *     underwriters' associations, membership ranks with real-coin dues, the
 *     underwriting standards code, solvency reviews with verifiable findings
 *     from the REAL insurance ledger, the reinsurance fund (real tracked
 *     coins backing the insurer pool when it cannot pay), the actuarial
 *     school (training under actuary-rank masters), and the ethics tribunal
 *     (verifiable policy fraud only).
 *
 * WHAT IT DOES (data tier, zero LLM):
 *   - Associations: one per kingdom with a hall tile near the insurance
 *     office, a real tracked treasury, a real tracked reinsurance fund, and
 *     a pool health record (review history, flags, solvency state).
 *   - Membership: agent -> broker -> actuary ranks. Joining requires being
 *     a REAL registered insurer (CitizenInsurance.insurerFor) — the guild
 *     polices the trade, it does not mint insurers. Weekly real-coin dues
 *     (25, of which 5 feeds the reinsurance fund); 2 missed online
 *     collections suspend; offline members are skipped, never penalized.
 *   - Standards code: the guild's code of underwriting practice (a
 *     read-only list — honesty, reserves, fair pricing, policyholder
 *     protection).
 *   - Solvency reviews: actuary-rank members inspect the REAL insurance
 *     ledger. Verifiable findings only — coverage ratio (pool / total
 *     exposure), unpaid claims (payoutsOwed entries the pool could not pay),
 *     insurer coverage (registered insurers in the kingdom). PASS when
 *     coverage >= 1.0, no unpaid claims, and the kingdom has an insurer.
 *     Otherwise FLAG with reasons. Two consecutive flags with coverage <
 *     0.5 mark the pool INSOLVENT, which triggers reinsurance claims.
 *   - Reinsurance: the guild's fund backs the insurer pool. When the pool
 *     is insolvent, owed claimants get reinsurance claims paid from the
 *     real fund (owed honestly when the fund runs dry, paid on later ticks
 *     as dues refill it). This is reinsurance in the true sense: the guild
 *     insures the insurers' pool.
 *   - Actuarial school: actuary-rank masters hold classes for agents;
 *     attendance grants training credit. Promotion: broker at 30 days
 *     tenure + 2 training credits + clean ethics record; actuary at 60
 *     days tenure + 4 training credits + clean record + 2 conducted
 *     reviews. All verifiable from guild records — never invented.
 *   - Ethics tribunal: violations are REPORTED and VERIFIED against real
 *     data, never assumed. The one verifiable insurance crime is policy
 *     fraud: a policy whose face value exceeds the type's maximum (or is
 *     negative) — impossible through the real quote/buy flow, so it means
 *     the ledger was hand-edited. Actuary-rank members vote; cases settle
 *     after 24h. Guilty: expulsion + the `fraudster` fame deed.
 *
 * WHAT IT DOES NOT DO:
 *   - No ticking here (lib/CitizenInsureGuildLife.js is ticked by the director).
 *   - No LLM. No movement (brain/actions/CitizenInsureGuild.js).
 *   - No invented coins, policies, premiums, or claims.
 */

const path = require("path");

// === Tuning: all magic numbers here ===
const SAVE_KEY = "citizen-insureguilds.json";
const COINS_ID = 995;

const RANK_AGENT = "agent";
const RANK_BROKER = "broker";
const RANK_ACTUARY = "actuary";
const RANKS = Object.freeze([RANK_AGENT, RANK_BROKER, RANK_ACTUARY]);

const DUES_WEEKLY = 25; // real coins per week
const DUES_REINSURANCE_SHARE = 5; // of each dues payment, this much feeds the reinsurance fund
const DUES_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;
const SUSPEND_AFTER_MISSED = 2; // missed online collections before suspension

const REVIEW_PERIOD_MS = 7 * 24 * 60 * 60 * 1000; // one solvency review per kingdom per week
const COVERAGE_PASS_MIN = 1.0; // pool / total exposure
const COVERAGE_FAIL_MAX = 0.5; // below this on two consecutive flags -> pool INSOLVENT
const CONSECUTIVE_FLAGS_TO_INSOLVENT = 2;

const PROMOTE_BROKER_DAYS = 30;
const PROMOTE_BROKER_TRAINING = 2;
const PROMOTE_ACTUARY_DAYS = 60;
const PROMOTE_ACTUARY_TRAINING = 4;
const PROMOTE_ACTUARY_REVIEWS = 2;

const CASE_SETTLE_MS = 24 * 60 * 60 * 1000; // auto-settle open cases after 24h

const HALL_TILE_DX = 6; // guild hall sits a few tiles from the insurance office

// --- state --------------------------------------------------------------------

let cache = null;
// { guilds, members, reviews, reinsuranceClaims, cases, classes, nextId }
let dirty = false;

function blankState() {
  return {
    guilds: Object.create(null), // kingdomId -> { kingdomId, hallTile, foundedAt, treasury, reinsuranceFund, pool: { status, flags, lastReviewAt, lastVerdict, certifiedUntil } }
    members: Object.create(null), // norm -> { username, kingdomId, rank, joinedAt, duesPaidUntil, missedDues, suspended, suspendUntil, trainingCredits, reviewsConducted, expelled }
    reviews: Object.create(null), // id -> { id, kingdomId, reviewer, conductedAt, coverage, unpaidClaims, insurerCount, verdict, reasons }
    reinsuranceClaims: Object.create(null), // id -> { id, kingdomId, claimant, amount, paid, owed, filedAt }
    cases: Object.create(null), // id -> { id, accuser, accused, type, status, filedAt, votes, verdict, settledAt, sanction, evidence }
    classes: Object.create(null), // id -> { id, master, pupils, kingdomId, heldAt }
    nextId: 1,
  };
}

function savePath() {
  return path.join(__dirname, "..", "data", "saves", SAVE_KEY);
}

function load() {
  if (cache) return cache;
  try {
    const fs = require("fs");
    const raw = JSON.parse(fs.readFileSync(savePath(), "utf8"));
    if (raw && typeof raw === "object") {
      cache = Object.assign(blankState(), raw);
      return cache;
    }
  } catch { /* fresh state */ }
  cache = blankState();
  return cache;
}

function save() {
  if (!dirty) return false;
  try {
    const fs = require("fs");
    fs.mkdirSync(path.dirname(savePath()), { recursive: true });
    fs.writeFileSync(savePath(), JSON.stringify(load(), null, 2));
    dirty = false;
    return true;
  } catch {
    return false;
  }
}

function markDirty() {
  dirty = true;
}

function resetForTests() {
  cache = blankState();
  dirty = false;
}

function norm(name) {
  return String(name ?? "").trim().toLowerCase();
}

function allocId(prefix) {
  const st = load();
  const id = `${prefix}_${st.nextId++}`;
  markDirty();
  return id;
}

// --- lazy cross-module reads (all guarded) -------------------------------------

function insuranceApi() {
  try { return require("./CitizenInsurance"); } catch { return null; }
}

function bankingApi() {
  try { return require("./CitizenBanking"); } catch { return null; }
}

function sitesApi() {
  try { return require("../brain/CitizenSites"); } catch { return null; }
}

function hallTileFor(kingdomId) {
  const kid = String(kingdomId || "");
  let tile = null;
  try {
    const I = insuranceApi();
    tile = I ? I.officeTile(kid) : null;
  } catch { tile = null; }
  if (!tile) {
    try {
      const S = sitesApi();
      tile = S && typeof S.siteTile === "function" ? S.siteTile({ kingdomId: kid }, "market") : null;
    } catch { tile = null; }
  }
  if (!tile) return { x: 3200, y: 3200, z: 0 };
  return { x: (tile.x ?? 3200) + HALL_TILE_DX, y: tile.y ?? 3200, z: tile.z ?? 0 };
}

// --- associations ------------------------------------------------------------

function blankPool() {
  return { status: "sound", flags: 0, lastReviewAt: 0, lastVerdict: null, certifiedUntil: 0 };
}

function ensureGuild(kingdomId) {
  const st = load();
  const kid = String(kingdomId || "");
  if (!kid) return null;
  if (!st.guilds[kid]) {
    st.guilds[kid] = {
      kingdomId: kid,
      hallTile: hallTileFor(kid),
      foundedAt: Date.now(),
      treasury: 0,
      reinsuranceFund: 0,
      pool: blankPool(),
    };
    markDirty();
  }
  if (!st.guilds[kid].pool) st.guilds[kid].pool = blankPool();
  return st.guilds[kid];
}

function guildOf(kingdomId) {
  const st = load();
  const kid = String(kingdomId || "");
  return st.guilds[kid] ?? null;
}

function guildsIn() {
  return Object.keys(load().guilds);
}

// --- membership ---------------------------------------------------------------

function memberOf(username) {
  const st = load();
  const m = st.members[norm(username)];
  return m && !m.expelled ? m : null;
}

function isGuildMember(username) {
  return !!memberOf(username);
}

function guildRankOf(username) {
  const m = memberOf(username);
  return m ? m.rank : null;
}

function joinGuild(username, kingdomId) {
  const st = load();
  const name = String(username || "").trim();
  if (!name) return { ok: false, reason: "no-identity" };
  const kid = String(kingdomId || "");
  if (!kid) return { ok: false, reason: "no-kingdom" };
  if (st.members[norm(name)] && !st.members[norm(name)].expelled) return { ok: false, reason: "already-member" };
  const I = insuranceApi();
  let isInsurer = false;
  try { isInsurer = I ? !!I.insurerFor(name) : false; } catch { isInsurer = false; }
  if (!isInsurer) return { ok: false, reason: "not-insurer" };
  ensureGuild(kid);
  st.members[norm(name)] = {
    username: name,
    kingdomId: kid,
    rank: RANK_AGENT,
    joinedAt: Date.now(),
    duesPaidUntil: Date.now() + DUES_PERIOD_MS,
    missedDues: 0,
    suspended: false,
    suspendUntil: 0,
    trainingCredits: 0,
    reviewsConducted: 0,
    expelled: false,
  };
  markDirty();
  return { ok: true, rank: RANK_AGENT };
}

function leaveGuild(username) {
  const st = load();
  const key = norm(username);
  if (!st.members[key] || st.members[key].expelled) return false;
  delete st.members[key];
  markDirty();
  return true;
}

function liftSuspension(username) {
  const m = memberOf(username);
  if (!m || !m.suspended) return false;
  m.suspended = false;
  m.suspendUntil = 0;
  m.missedDues = 0;
  m.duesPaidUntil = Date.now() + DUES_PERIOD_MS;
  markDirty();
  return true;
}

function guildKingdomOf(username) {
  const m = memberOf(username);
  return m ? m.kingdomId : null;
}

function membersIn(kingdomId) {
  const st = load();
  const kid = String(kingdomId || "");
  return Object.values(st.members).filter((m) => !m.expelled && m.kingdomId === kid);
}

// --- standards code (read-only) ------------------------------------------------

const STANDARDS_CODE = Object.freeze([
  "1. Reserves: never write the realm into ruin — keep the pool well above total exposure.",
  "2. Honesty: the ledger is sacred — no hand-edited policies, no phantom claims.",
  "3. Fair pricing: risk-based premiums for any citizen, not only the rich.",
  "4. Policyholder protection: every owed claim is sacred — the reinsurance fund stands behind it.",
  "5. Accountability: submit to the guild's reviews and the tribunal's verdict like any member.",
]);

// --- ledger reads (read-only; CitizenInsurance owns the ledger) -----------------

function ledgerSnapshot() {
  const I = insuranceApi();
  const snap = { policies: {}, pool: 0, insurers: {}, payoutsOwed: {}, ok: false };
  if (!I) return snap;
  try {
    const st = I._data ? I._data() : null;
    if (st && typeof st === "object") {
      snap.policies = st.policies && typeof st.policies === "object" ? st.policies : {};
      snap.pool = typeof st.pool === "number" ? st.pool : 0;
      snap.insurers = st.insurers && typeof st.insurers === "object" ? st.insurers : {};
      snap.payoutsOwed = st.payoutsOwed && typeof st.payoutsOwed === "object" ? st.payoutsOwed : {};
      snap.ok = true;
    }
  } catch { /* ledger unreadable */ }
  return snap;
}

function totalExposure() {
  const I = insuranceApi();
  try { return I ? I.totalExposure() : 0; } catch { return 0; }
}

function poolBalance() {
  const I = insuranceApi();
  try { return I ? I.poolBalance() : 0; } catch { return 0; }
}

function coverageRatio() {
  const exposure = totalExposure();
  if (exposure <= 0) return Infinity; // no exposure: trivially covered
  return poolBalance() / exposure;
}

function unpaidClaimCount() {
  const { payoutsOwed, ok } = ledgerSnapshot();
  if (!ok) return 0;
  let n = 0;
  for (const v of Object.values(payoutsOwed)) {
    if (typeof v === "number" && v > 0) n++;
  }
  return n;
}

function unpaidClaimTotal() {
  const { payoutsOwed, ok } = ledgerSnapshot();
  if (!ok) return 0;
  let total = 0;
  for (const v of Object.values(payoutsOwed)) {
    if (typeof v === "number" && v > 0) total += v;
  }
  return total;
}

function insurerCount(kingdomId) {
  const I = insuranceApi();
  const kid = String(kingdomId || "");
  try { return I ? I.insurersIn(kid).length : 0; } catch { return 0; }
}

// --- solvency reviews ----------------------------------------------------------

/**
 * Conduct a solvency review. Findings are computed from the REAL insurance
 * ledger — never assumed. The reviewer must be an actuary-rank member in good
 * standing (or the guild itself for automatic reviews).
 */
function conductReview(kingdomId, reviewer, nowMs = Date.now()) {
  const st = load();
  const kid = String(kingdomId || "");
  if (!kid) return { ok: false, reason: "no-kingdom" };
  const I = insuranceApi();
  if (!I) return { ok: false, reason: "no-insurance" };
  const rev = String(reviewer || "guild").trim() || "guild";
  if (rev !== "guild") {
    const m = memberOf(rev);
    if (!m || m.rank !== RANK_ACTUARY || m.suspended) return { ok: false, reason: "not-an-actuary" };
    if (m.kingdomId !== kid) return { ok: false, reason: "wrong-kingdom" };
  }
  const coverage = coverageRatio();
  const unpaid = unpaidClaimCount();
  const insurers = insurerCount(kid);
  const reasons = [];
  if (!(coverage >= COVERAGE_PASS_MIN)) reasons.push(`coverage ${coverage === Infinity ? "infinite" : coverage.toFixed(2)} below ${COVERAGE_PASS_MIN}`);
  if (unpaid > 0) reasons.push(`${unpaid} unpaid claim${unpaid === 1 ? "" : "s"} the pool could not pay`);
  if (insurers <= 0) reasons.push("no registered insurer in the kingdom");
  const verdict = reasons.length === 0 ? "pass" : "flag";
  const id = allocId("review");
  const record = {
    id,
    kingdomId: kid,
    reviewer: rev,
    conductedAt: nowMs,
    coverage: coverage === Infinity ? -1 : coverage, // -1 serializes "infinite"
    unpaidClaims: unpaid,
    insurerCount: insurers,
    verdict,
    reasons,
  };
  st.reviews[id] = record;
  const g = ensureGuild(kid);
  g.pool.lastReviewAt = nowMs;
  g.pool.lastVerdict = verdict;
  if (verdict === "pass") {
    g.pool.flags = 0;
    g.pool.status = "sound";
    g.pool.certifiedUntil = nowMs + REVIEW_PERIOD_MS;
  } else {
    g.pool.flags = (g.pool.flags || 0) + 1;
    g.pool.certifiedUntil = 0;
    if (g.pool.flags >= CONSECUTIVE_FLAGS_TO_INSOLVENT && coverage < COVERAGE_FAIL_MAX) {
      g.pool.status = "insolvent";
    } else {
      g.pool.status = "flagged";
    }
  }
  if (rev !== "guild") {
    const m = memberOf(rev);
    if (m) m.reviewsConducted = (m.reviewsConducted || 0) + 1;
  }
  markDirty();
  return { ok: true, review: record, poolStatus: g.pool.status };
}

function poolStatus(kingdomId) {
  const g = guildOf(kingdomId);
  return g ? g.pool.status : "unknown";
}

// --- reinsurance ---------------------------------------------------------------

/**
 * File reinsurance claims for every claimant the insurer pool still owes.
 * Called by the life tick when a kingdom's pool is insolvent. Idempotent:
 * an open claim already on file for the same claimant is not duplicated.
 */
function fileReinsuranceClaims(kingdomId, nowMs = Date.now()) {
  const st = load();
  const kid = String(kingdomId || "");
  if (!kid) return { ok: false, reason: "no-kingdom" };
  const g = ensureGuild(kid);
  if (g.pool.status !== "insolvent") return { ok: false, reason: "pool-not-insolvent" };
  const { payoutsOwed, ok } = ledgerSnapshot();
  if (!ok) return { ok: false, reason: "no-ledger" };
  let filed = 0;
  for (const [key, owed] of Object.entries(payoutsOwed)) {
    if (typeof owed !== "number" || owed <= 0) continue;
    const already = Object.values(st.reinsuranceClaims).some(
      (c) => norm(c.claimant) === norm(key) && c.kingdomId === kid && (c.owed ?? 0) > 0
    );
    if (already) continue;
    const id = allocId("reclaim");
    st.reinsuranceClaims[id] = {
      id,
      kingdomId: kid,
      claimant: key,
      amount: owed,
      paid: 0,
      owed,
      filedAt: nowMs,
    };
    filed++;
  }
  markDirty();
  return { ok: true, filed };
}

function openReinsuranceClaims(kingdomId) {
  const st = load();
  const kid = String(kingdomId || "");
  return Object.values(st.reinsuranceClaims).filter(
    (c) => (!kid || c.kingdomId === kid) && (c.owed ?? 0) > 0
  );
}

/**
 * Pay a reinsurance claim from the guild's own tracked fund. The coins go to
 * the claimant's real bank account (falling back to honest owed when they
 * have no account), and the insurance module's payoutsOwed is reduced by the
 * same amount so the pool never double-pays on recovery.
 */
function payReinsuranceClaim(claimId) {
  const st = load();
  const c = st.reinsuranceClaims[String(claimId)];
  if (!c || (c.owed ?? 0) <= 0) return { ok: false, reason: "no-open-claim" };
  const g = guildOf(c.kingdomId);
  if (!g) return { ok: false, reason: "no-guild" };
  const pay = Math.min(c.owed, Math.floor(g.reinsuranceFund));
  if (pay <= 0) return { ok: false, reason: "fund-empty" };
  const B = bankingApi();
  const I = insuranceApi();
  if (!B || !I) return { ok: false, reason: "no-banking" };
  try {
    const ledger = B._data ? B._data() : null;
    const key = norm(c.claimant);
    if (!ledger || !ledger.accounts || !ledger.accounts[key]) return { ok: false, reason: "no-account" };
    // Reduce what the pool owes FIRST (honest — the guild only ever debits
    // its fund by what the pool actually still owed).
    const covered = typeof I.coverOwedPayout === "function" ? I.coverOwedPayout(key, pay) : 0;
    if (covered <= 0) {
      // Nothing left to cover — close the claim out without moving coins.
      c.owed = 0;
      markDirty();
      return { ok: true, paid: 0, owed: 0, note: "already-covered" };
    }
    g.reinsuranceFund -= covered;
    ledger.accounts[key].balance = (ledger.accounts[key].balance || 0) + covered;
    c.paid = (c.paid || 0) + covered;
    c.owed = c.amount - c.paid;
    markDirty();
    if (typeof B.markDirty === "function") B.markDirty();
    return { ok: true, paid: covered, owed: c.owed };
  } catch {
    return { ok: false, reason: "ledger-write-failed" };
  }
}

/**
 * Voluntary contribution to the kingdom's reinsurance fund. Real coins only —
 * the caller must have taken them from a real inventory first.
 */
function contributeToFund(kingdomId, amount) {
  const g = ensureGuild(kingdomId);
  if (!g) return { ok: false, reason: "no-guild" };
  const n = Math.floor(Number(amount) || 0);
  if (n <= 0) return { ok: false, reason: "bad-amount" };
  g.reinsuranceFund = Math.floor(g.reinsuranceFund || 0) + n;
  markDirty();
  return { ok: true, fund: g.reinsuranceFund };
}

function reinsuranceFundOf(kingdomId) {
  const g = guildOf(kingdomId);
  return g ? Math.floor(g.reinsuranceFund || 0) : 0;
}

// --- actuarial school ------------------------------------------------------------

/**
 * Hold a class: an actuary-rank master teaches agent-rank pupils in the same
 * kingdom. Each pupil gains one training credit. Verifiable from guild
 * records — never invented.
 */
function holdClass(master, pupils, kingdomId, nowMs = Date.now()) {
  const st = load();
  const kid = String(kingdomId || "");
  if (!kid) return { ok: false, reason: "no-kingdom" };
  const m = memberOf(master);
  if (!m || m.rank !== RANK_ACTUARY || m.suspended) return { ok: false, reason: "not-an-actuary" };
  if (m.kingdomId !== kid) return { ok: false, reason: "wrong-kingdom" };
  const taught = [];
  for (const p of pupils || []) {
    const pm = memberOf(p);
    if (pm && pm.rank === RANK_AGENT && !pm.suspended && pm.kingdomId === kid) {
      pm.trainingCredits = (pm.trainingCredits || 0) + 1;
      taught.push(pm.username);
    }
  }
  if (taught.length === 0) return { ok: false, reason: "no-pupils" };
  const id = allocId("class");
  st.classes[id] = { id, master: m.username, pupils: taught, kingdomId: kid, heldAt: nowMs };
  markDirty();
  return { ok: true, taught };
}

/**
 * Promote a member when the verifiable requirements are met:
 *   agent -> broker: 30 days tenure, 2 training credits, clean record
 *   broker -> actuary: 60 days tenure, 4 training credits, 2 conducted reviews, clean record
 */
function tryPromote(username, nowMs = Date.now()) {
  const m = memberOf(username);
  if (!m || m.suspended) return { ok: false, reason: "not-eligible" };
  const tenureDays = (nowMs - (m.joinedAt || nowMs)) / (24 * 60 * 60 * 1000);
  const clean = !Object.values(load().cases).some(
    (c) => norm(c.accused) === norm(username) && c.verdict === "guilty"
  );
  if (m.rank === RANK_AGENT) {
    if (tenureDays < PROMOTE_BROKER_DAYS) return { ok: false, reason: "tenure" };
    if ((m.trainingCredits || 0) < PROMOTE_BROKER_TRAINING) return { ok: false, reason: "training" };
    if (!clean) return { ok: false, reason: "ethics-record" };
    m.rank = RANK_BROKER;
    markDirty();
    return { ok: true, rank: RANK_BROKER };
  }
  if (m.rank === RANK_BROKER) {
    if (tenureDays < PROMOTE_ACTUARY_DAYS) return { ok: false, reason: "tenure" };
    if ((m.trainingCredits || 0) < PROMOTE_ACTUARY_TRAINING) return { ok: false, reason: "training" };
    if ((m.reviewsConducted || 0) < PROMOTE_ACTUARY_REVIEWS) return { ok: false, reason: "reviews" };
    if (!clean) return { ok: false, reason: "ethics-record" };
    m.rank = RANK_ACTUARY;
    markDirty();
    return { ok: true, rank: RANK_ACTUARY };
  }
  return { ok: false, reason: "max-rank" };
}

// --- ethics tribunal ---------------------------------------------------------------

/**
 * Scan the REAL insurance ledger for verifiable policy fraud: a policy whose
 * face value exceeds the type's maximum (or is negative) — impossible through
 * the real quote/buy flow, so it means the ledger was hand-edited. Returns
 * evidence records; the tribunal decides guilt.
 */
function scanForFraud() {
  const { policies, ok } = ledgerSnapshot();
  const I = insuranceApi();
  if (!ok || !I) return [];
  const found = [];
  const types = I.POLICY_TYPES || {};
  for (const [key, slot] of Object.entries(policies)) {
    if (!slot || typeof slot !== "object") continue;
    for (const t of Object.keys(types)) {
      const p = slot[t];
      if (!p || typeof p !== "object") continue;
      const def = types[t];
      if (!def) continue;
      const face = p.faceValue;
      if (typeof face === "number" && (face > def.maxFace || face < 0)) {
        found.push({
          holder: key,
          type: t,
          faceValue: face,
          maxFace: def.maxFace,
          policyId: p.id ?? null,
        });
      }
      const prem = p.premium;
      if (typeof prem === "number" && prem < 0) {
        found.push({ holder: key, type: t, negativePremium: prem, policyId: p.id ?? null });
      }
    }
  }
  return found;
}

/**
 * Report suspected fraud. The report is verified against real data before a
 * case opens: the accused must actually hold a fraudulent policy. Reports
 * may come from members or real players.
 */
function reportFraud(accuser, accused) {
  const st = load();
  const acc = String(accused || "").trim();
  if (!acc) return { ok: false, reason: "no-accused" };
  const fraud = scanForFraud().filter((f) => norm(f.holder) === norm(acc));
  if (fraud.length === 0) return { ok: false, reason: "no-evidence" };
  const dup = Object.values(st.cases).some(
    (c) => norm(c.accused) === norm(acc) && c.type === "fraud" && c.status === "open"
  );
  if (dup) return { ok: false, reason: "already-open" };
  const id = allocId("case");
  st.cases[id] = {
    id,
    accuser: String(accuser || "guild"),
    accused: acc,
    type: "fraud",
    status: "open",
    filedAt: Date.now(),
    votes: {},
    verdict: null,
    settledAt: 0,
    sanction: null,
    evidence: fraud,
  };
  markDirty();
  return { ok: true, caseId: id, evidence: fraud };
}

function openCases(kingdomId) {
  const st = load();
  const kid = String(kingdomId || "");
  return Object.values(st.cases).filter(
    (c) => c.status === "open" && (!kid || guildKingdomOf(c.accused) === kid || !guildKingdomOf(c.accused))
  );
}

/**
 * Vote on an open case. Only actuary-rank members in good standing vote.
 */
function voteOnCase(voter, caseId, guilty) {
  const st = load();
  const c = st.cases[String(caseId)];
  if (!c || c.status !== "open") return { ok: false, reason: "no-open-case" };
  const m = memberOf(voter);
  if (!m || m.rank !== RANK_ACTUARY || m.suspended) return { ok: false, reason: "not-an-actuary" };
  c.votes[norm(voter)] = !!guilty;
  markDirty();
  return { ok: true };
}

/**
 * Settle cases open longer than CASE_SETTLE_MS. Majority of votes decides;
 * ties acquit. Guilty fraud: expulsion + the `fraudster` fame deed.
 */
function settleCases(nowMs = Date.now()) {
  const st = load();
  const settled = [];
  for (const c of Object.values(st.cases)) {
    if (c.status !== "open") continue;
    if (nowMs - (c.filedAt || 0) < CASE_SETTLE_MS) continue;
    const votes = Object.values(c.votes || {});
    const guilty = votes.filter(Boolean).length;
    const innocent = votes.length - guilty;
    const verdict = guilty > innocent ? "guilty" : "innocent";
    c.status = "settled";
    c.verdict = verdict;
    c.settledAt = nowMs;
    if (verdict === "guilty") {
      c.sanction = "expulsion";
      const key = norm(c.accused);
      if (st.members[key]) st.members[key].expelled = true;
      try {
        const Rep = require("./CitizenReputation");
        if (typeof Rep.awardDeed === "function") Rep.awardDeed(c.accused, "fraudster", nowMs);
      } catch { /* reputation optional */ }
    }
    settled.push(c);
  }
  if (settled.length) markDirty();
  return settled;
}

// --- dues ------------------------------------------------------------------------

function duesInfo(username) {
  const m = memberOf(username);
  if (!m) return null;
  return {
    paidUntil: m.duesPaidUntil || 0,
    missed: m.missedDues || 0,
    suspended: !!m.suspended,
    weekly: DUES_WEEKLY,
  };
}

function recordDuesPayment(username, nowMs = Date.now()) {
  const m = memberOf(username);
  if (!m) return false;
  m.duesPaidUntil = nowMs + DUES_PERIOD_MS;
  m.missedDues = 0;
  if (m.suspended && nowMs >= (m.suspendUntil || 0)) {
    m.suspended = false;
    m.suspendUntil = 0;
  }
  const g = guildOf(m.kingdomId);
  if (g) {
    g.treasury = Math.floor(g.treasury || 0) + (DUES_WEEKLY - DUES_REINSURANCE_SHARE);
    g.reinsuranceFund = Math.floor(g.reinsuranceFund || 0) + DUES_REINSURANCE_SHARE;
  }
  markDirty();
  return true;
}

function recordMissedDues(username, nowMs = Date.now()) {
  const m = memberOf(username);
  if (!m) return false;
  m.missedDues = (m.missedDues || 0) + 1;
  if (m.missedDues >= SUSPEND_AFTER_MISSED) {
    m.suspended = true;
    m.suspendUntil = nowMs + DUES_PERIOD_MS;
  }
  markDirty();
  return m.suspended;
}

// --- treasury / fund credits ---------------------------------------------------------

function creditTreasury(kingdomId, amount) {
  const g = ensureGuild(kingdomId);
  if (!g) return 0;
  const n = Math.floor(Number(amount) || 0);
  g.treasury = Math.floor(g.treasury || 0) + n;
  if (n !== 0) markDirty();
  return g.treasury;
}

function debitTreasury(kingdomId, amount) {
  const g = ensureGuild(kingdomId);
  if (!g) return { ok: false, reason: "no-guild" };
  const n = Math.floor(Number(amount) || 0);
  if (n <= 0) return { ok: false, reason: "bad-amount" };
  if (Math.floor(g.treasury || 0) < n) return { ok: false, reason: "insufficient" };
  g.treasury -= n;
  markDirty();
  return { ok: true, treasury: g.treasury };
}

function creditReinsuranceFund(kingdomId, amount) {
  const g = ensureGuild(kingdomId);
  if (!g) return 0;
  const n = Math.floor(Number(amount) || 0);
  g.reinsuranceFund = Math.floor(g.reinsuranceFund || 0) + n;
  if (n !== 0) markDirty();
  return g.reinsuranceFund;
}

function reviewsFor(kingdomId) {
  const st = load();
  const kid = String(kingdomId || "");
  return Object.values(st.reviews)
    .filter((r) => !kid || r.kingdomId === kid)
    .sort((a, b) => (b.conductedAt || 0) - (a.conductedAt || 0));
}

// --- describe ----------------------------------------------------------------------

function describe(kingdomId) {
  const g = guildOf(kingdomId);
  if (!g) return null;
  const members = membersIn(kingdomId);
  return {
    kingdomId: g.kingdomId,
    members: members.length,
    actuaries: members.filter((m) => m.rank === RANK_ACTUARY && !m.suspended).length,
    treasury: Math.floor(g.treasury || 0),
    reinsuranceFund: Math.floor(g.reinsuranceFund || 0),
    poolStatus: g.pool.status,
    lastVerdict: g.pool.lastVerdict,
    openClaims: openReinsuranceClaims(kingdomId).length,
  };
}

module.exports = {
  SAVE_KEY,
  COINS_ID,
  RANK_AGENT,
  RANK_BROKER,
  RANK_ACTUARY,
  RANKS,
  DUES_WEEKLY,
  DUES_REINSURANCE_SHARE,
  DUES_PERIOD_MS,
  REVIEW_PERIOD_MS,
  COVERAGE_PASS_MIN,
  COVERAGE_FAIL_MAX,
  STANDARDS_CODE,
  ensureGuild,
  guildOf,
  guildsIn,
  memberOf,
  isGuildMember,
  guildRankOf,
  joinGuild,
  leaveGuild,
  liftSuspension,
  guildKingdomOf,
  membersIn,
  coverageRatio,
  unpaidClaimCount,
  unpaidClaimTotal,
  insurerCount,
  conductReview,
  poolStatus,
  fileReinsuranceClaims,
  openReinsuranceClaims,
  payReinsuranceClaim,
  contributeToFund,
  reinsuranceFundOf,
  holdClass,
  tryPromote,
  scanForFraud,
  reportFraud,
  openCases,
  voteOnCase,
  settleCases,
  duesInfo,
  recordDuesPayment,
  recordMissedDues,
  creditTreasury,
  debitTreasury,
  creditReinsuranceFund,
  reviewsFor,
  describe,
  save,
  resetForTests,
  markDirty,
};
