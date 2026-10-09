"use strict";

/**
 * CitizenBankGuilds — the bankers' association (banking guild) operations layer.
 *
 * No-overlap boundary (documented, do not duplicate):
 *   - CitizenBanking owns: REAL bank accounts, deposits, withdrawals,
 *     interest, loans, bank branches, the banker profession registry,
 *     kingdom treasury deposits, and the player banking bridge. Its
 *     records are READ-ONLY here — this module never edits accounts,
 *     loans, or the banker registry directly (except crediting a bank
 *     account when paying a deposit-insurance claim, which is the guild's
 *     own fund paying out — always through the tracked insurance fund,
 *     never invented coins).
 *   - CitizenBankers / CitizenBankers2 own: hash-derived banker and
 *     moneyfolk flavor (dialogue, vault heat, exchange rates). Untouched.
 *   - CitizenBankerWork (brain) owns: the banker service action — bankers
 *     serving real customers at the branch.
 *   - THIS module owns: the profession's GUILD layer — per-kingdom
 *     bankers' associations, membership ranks with real-coin dues, the
 *     banking standards code, branch audits with verifiable findings,
 *     the deposit insurance fund (real tracked coins protecting real
 *     deposits), the banker school (training under auditor-rank masters),
 *     and the ethics tribunal (verifiable ledger-tampering only).
 *
 * WHAT IT DOES (data tier, zero LLM):
 *   - Associations: one per kingdom with a hall tile near the bank branch,
 *     a real tracked treasury, a real tracked deposit-insurance fund, and
 *     a branch health record (audit history, flags, failure state).
 *   - Membership: clerk -> teller -> auditor ranks. Joining requires being
 *     a REAL registered banker (CitizenBanking.bankerFor) — the guild
 *     polices the trade, it does not mint bankers. Weekly real-coin dues
 *     (25, of which 5 feeds the insurance fund); 2 missed online
 *     collections suspend; offline members are skipped, never penalized.
 *   - Standards code: the guild's code of banking practice (a read-only
 *     list — honesty, reserves, fair lending, depositor protection).
 *   - Branch audits: auditor-rank members inspect the REAL ledger.
 *     Verifiable findings only — leverage (outstanding loans vs total
 *     deposits), default rate (defaulted loans vs all loans), banker
 *     coverage (registered bankers at the branch). PASS when leverage <=
 *     1.5, default rate <= 25%, and the branch has a banker. Otherwise
 *     FLAG with reasons. Two consecutive flags with leverage > 2.0 mark
 *     the branch FAILED, which triggers deposit-insurance claims.
 *   - Deposit insurance: depositors pay a monthly premium (1% of balance,
 *     capped at 100 coins, collected from real inventories of online
 *     citizens on the life tick — coverage lapses honestly when unpaid).
 *     On branch failure, every covered depositor gets a claim up to
 *     10,000 coins, paid from the real insurance fund (owed honestly when
 *     the fund runs dry, paid on later ticks as dues refill it).
 *   - Banker school: auditor-rank masters hold classes for clerks;
 *     attendance grants training credit. Promotion: teller at 30 days
 *     tenure + 2 training credits + clean ethics record; auditor at 60
 *     days tenure + 4 training credits + clean record + 2 conducted
 *     audits. All verifiable from guild records — never invented.
 *   - Ethics tribunal: violations are REPORTED and VERIFIED against real
 *     data, never assumed. The one verifiable banking crime is ledger
 *     tampering: an account with a negative balance, or a loan with
 *     negative owed — impossible through real flows, so it means the
 *     ledger was hand-edited. Auditor-rank members vote; cases settle
 *     after 24h. Guilty: expulsion + the `embezzler` fame deed.
 *
 * WHAT IT DOES NOT DO:
 *   - No ticking here (lib/CitizenBankGuildLife.js is ticked by the director).
 *   - No LLM. No movement (brain/actions/CitizenBankGuild.js).
 *   - No invented coins, accounts, loans, or deposits.
 */

const path = require("path");

// === Tuning: all magic numbers here ===
const SAVE_KEY = "citizen-bankguilds.json";
const COINS_ID = 995;

const RANK_CLERK = "clerk";
const RANK_TELLER = "teller";
const RANK_AUDITOR = "auditor";
const RANKS = Object.freeze([RANK_CLERK, RANK_TELLER, RANK_AUDITOR]);

const DUES_WEEKLY = 25; // real coins per week
const DUES_INSURANCE_SHARE = 5; // of each dues payment, this much feeds the insurance fund
const DUES_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;
const SUSPEND_AFTER_MISSED = 2; // missed online collections before suspension

const AUDIT_PERIOD_MS = 7 * 24 * 60 * 60 * 1000; // one audit per branch per week
const LEVERAGE_PASS_MAX = 1.5; // outstanding loans / total deposits
const DEFAULT_RATE_PASS_MAX = 0.25; // defaulted loans / all loans
const LEVERAGE_FAIL_MIN = 2.0; // above this on two consecutive flags -> branch FAILED
const CONSECUTIVE_FLAGS_TO_FAIL = 2;

const INSURANCE_COVERAGE_CAP = 10000; // max payout per depositor
const INSURANCE_PREMIUM_BPS = 100; // 1% of balance per month
const INSURANCE_PREMIUM_CAP = 100; // ...capped at 100 coins
const INSURANCE_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

const PROMOTE_TELLER_DAYS = 30;
const PROMOTE_TELLER_TRAINING = 2;
const PROMOTE_AUDITOR_DAYS = 60;
const PROMOTE_AUDITOR_TRAINING = 4;
const PROMOTE_AUDITOR_AUDITS = 2;

const CASE_SETTLE_MS = 24 * 60 * 60 * 1000; // auto-settle open cases after 24h

const HALL_TILE_DX = 4; // guild hall sits a few tiles from the bank branch

// --- state --------------------------------------------------------------------

let cache = null;
// { guilds, members, audits, claims, cases, classes, nextId }
let dirty = false;

function blankState() {
  return {
    guilds: Object.create(null), // kingdomId -> { kingdomId, hallTile, foundedAt, treasury, insuranceFund, branch: { status, flags, lastAuditAt, lastVerdict, certifiedUntil } }
    members: Object.create(null), // norm -> { username, kingdomId, rank, joinedAt, duesPaidUntil, missedDues, suspended, suspendUntil, trainingCredits, auditsConducted, expelled }
    audits: Object.create(null), // id -> { id, kingdomId, auditor, conductedAt, leverage, defaultRate, bankerCount, verdict, reasons }
    claims: Object.create(null), // id -> { id, kingdomId, depositor, amount, paid, owed, filedAt }
    cases: Object.create(null), // id -> { id, accuser, accused, type, status, filedAt, votes, verdict, settledAt, sanction, evidence }
    classes: Object.create(null), // id -> { id, master, pupils, kingdomId, heldAt }
    coverage: Object.create(null), // norm -> { username, coveredUntil }
    nextId: 1,
  };
}

function norm(name) {
  return String(name || "").trim().toLowerCase();
}

function savePath() {
  try {
    return path.join(__dirname, "..", "data", "saves", SAVE_KEY);
  } catch {
    return SAVE_KEY;
  }
}

function load() {
  if (cache) return cache;
  cache = blankState();
  try {
    const fs = require("fs");
    if (fs.existsSync(savePath())) {
      const raw = JSON.parse(fs.readFileSync(savePath(), "utf8"));
      if (raw && typeof raw === "object") {
        for (const k of Object.keys(blankState())) {
          if (raw[k] && typeof raw[k] === "object") cache[k] = raw[k];
        }
        if (typeof raw.nextId === "number") cache.nextId = raw.nextId;
      }
    }
  } catch { /* corrupt save -> blank; never throws */ }
  return cache;
}

function markDirty() { dirty = true; }

function save() {
  if (!dirty) return false;
  try {
    const fs = require("fs");
    fs.mkdirSync(path.dirname(savePath()), { recursive: true });
    fs.writeFileSync(savePath(), JSON.stringify(cache, null, 2));
    dirty = false;
    return true;
  } catch { return false; }
}

function resetForTests() {
  cache = blankState();
  dirty = false;
}

function allocId(prefix) {
  const st = load();
  const id = `${prefix}${st.nextId++}`;
  markDirty();
  return id;
}

// --- dependency seams (lazy, defensive) ---------------------------------------

function bankingApi() {
  try { return require("./CitizenBanking"); } catch { return null; }
}

function sitesApi() {
  try { return require("../brain/CitizenSites"); } catch { return null; }
}

function kingdomIds() {
  try {
    const S = sitesApi();
    if (S && Array.isArray(S.KINGDOM_IDS) && S.KINGDOM_IDS.length) return S.KINGDOM_IDS.slice();
  } catch { /* fall through */ }
  return [];
}

function hallTileFor(kingdomId) {
  const kid = String(kingdomId || "");
  let tile = null;
  try {
    const B = bankingApi();
    tile = B ? B.branchTile(kid) : null;
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

function blankBranch() {
  return { status: "sound", flags: 0, lastAuditAt: 0, lastVerdict: null, certifiedUntil: 0 };
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
      insuranceFund: 0,
      branch: blankBranch(),
    };
    markDirty();
  }
  if (!st.guilds[kid].branch) st.guilds[kid].branch = blankBranch();
  return st.guilds[kid];
}

function guildOf(kingdomId) {
  const st = load();
  return st.guilds[String(kingdomId || "")] || null;
}

function guildTreasuryFor(kingdomId) {
  const g = ensureGuild(kingdomId);
  return g ? g.treasury : 0;
}

function insuranceFundFor(kingdomId) {
  const g = ensureGuild(kingdomId);
  return g ? g.insuranceFund : 0;
}

function creditTreasury(kingdomId, amount) {
  const g = ensureGuild(kingdomId);
  if (!g || !(amount > 0)) return false;
  g.treasury += Math.floor(amount);
  markDirty();
  return true;
}

function debitTreasury(kingdomId, amount) {
  const g = guildOf(kingdomId);
  if (!g || !(amount > 0)) return false;
  const take = Math.floor(amount);
  if (g.treasury < take) return false;
  g.treasury -= take;
  markDirty();
  return true;
}

function creditInsuranceFund(kingdomId, amount) {
  const g = ensureGuild(kingdomId);
  if (!g || !(amount > 0)) return false;
  g.insuranceFund += Math.floor(amount);
  markDirty();
  return true;
}

function debitInsuranceFund(kingdomId, amount) {
  const g = guildOf(kingdomId);
  if (!g || !(amount > 0)) return false;
  const take = Math.floor(amount);
  if (g.insuranceFund < take) return false;
  g.insuranceFund -= take;
  markDirty();
  return true;
}

// --- membership --------------------------------------------------------------

function memberOf(username) {
  const st = load();
  const m = st.members[norm(username)] || null;
  return m && !m.expelled ? m : null;
}

function isGuildMember(username) {
  const m = memberOf(username);
  return !!(m && !m.suspended);
}

function guildRankOf(username) {
  const m = memberOf(username);
  return m ? m.rank : null;
}

function memberCount(kingdomId) {
  const st = load();
  let n = 0;
  for (const m of Object.values(st.members)) {
    if (m.expelled) continue;
    if (!kingdomId || m.kingdomId === String(kingdomId)) n++;
  }
  return n;
}

function auditorsIn(kingdomId) {
  const st = load();
  return Object.values(st.members).filter(
    (m) => !m.expelled && !m.suspended && m.rank === RANK_AUDITOR && (!kingdomId || m.kingdomId === String(kingdomId))
  );
}

function joinGuild(username, kingdomId) {
  const st = load();
  const name = String(username || "").trim();
  if (!name) return { ok: false, reason: "no-identity" };
  const kid = String(kingdomId || "");
  if (!kid) return { ok: false, reason: "no-kingdom" };
  if (st.members[norm(name)] && !st.members[norm(name)].expelled) return { ok: false, reason: "already-member" };
  const B = bankingApi();
  let isBanker = false;
  try { isBanker = B ? !!B.bankerFor(name) : false; } catch { isBanker = false; }
  if (!isBanker) return { ok: false, reason: "not-banker" };
  ensureGuild(kid);
  st.members[norm(name)] = {
    username: name,
    kingdomId: kid,
    rank: RANK_CLERK,
    joinedAt: Date.now(),
    duesPaidUntil: Date.now() + DUES_PERIOD_MS,
    missedDues: 0,
    suspended: false,
    suspendUntil: 0,
    trainingCredits: 0,
    auditsConducted: 0,
    expelled: false,
  };
  markDirty();
  return { ok: true, rank: RANK_CLERK };
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

// --- standards code (read-only) ------------------------------------------------

const STANDARDS_CODE = Object.freeze([
  "1. Reserves: never lend the realm into ruin — keep outstanding loans well below total deposits.",
  "2. Honesty: the ledger is sacred — no hand-edited balances, no phantom accounts.",
  "3. Fair lending: loans for any citizen who can repay, not only the rich.",
  "4. Depositor protection: every covered deposit is sacred — the insurance fund stands behind it.",
  "5. Accountability: submit to the guild's audits and the tribunal's verdict like any member.",
]);

// --- ledger reads (read-only; CitizenBanking owns the ledger) -------------------

function ledgerSnapshot() {
  const B = bankingApi();
  const snap = { accounts: {}, loans: {}, ok: false };
  if (!B) return snap;
  try {
    const st = B._data ? B._data() : null;
    if (st && typeof st === "object") {
      snap.accounts = st.accounts && typeof st.accounts === "object" ? st.accounts : {};
      snap.loans = st.loans && typeof st.loans === "object" ? st.loans : {};
      snap.ok = true;
    }
  } catch { /* ledger unreadable */ }
  return snap;
}

function totalDeposits() {
  const { accounts, ok } = ledgerSnapshot();
  if (!ok) return 0;
  let total = 0;
  for (const a of Object.values(accounts)) {
    const bal = a && typeof a.balance === "number" ? a.balance : 0;
    if (bal > 0) total += bal;
  }
  return total;
}

function loanStats(nowMs = Date.now()) {
  const { loans, ok } = ledgerSnapshot();
  if (!ok) return { total: 0, owed: 0, defaulted: 0, count: 0 };
  const B = bankingApi();
  let owed = 0;
  let defaulted = 0;
  let count = 0;
  for (const [key, loan] of Object.entries(loans)) {
    if (!loan) continue;
    count++;
    const o = typeof loan.owed === "number" ? loan.owed : 0;
    if (o > 0) owed += o;
    try {
      if (B && typeof B.isDefaulted === "function" && B.isDefaulted(key, nowMs)) defaulted++;
    } catch { /* one bad loan never breaks the stats */ }
  }
  return { total: owed, owed, defaulted, count };
}

function leverageRatio() {
  const deposits = totalDeposits();
  const { owed } = loanStats();
  if (deposits <= 0) return owed > 0 ? Infinity : 0;
  return owed / deposits;
}

function defaultRate(nowMs = Date.now()) {
  const { defaulted, count } = loanStats(nowMs);
  if (count <= 0) return 0;
  return defaulted / count;
}

/**
 * Verifiable ledger tampering: an account with a negative balance, or a
 * loan with negative owed — impossible through real flows (deposit,
 * withdraw, borrow, repay all guard amounts), so it means hand-edited
 * state. Returns the list of tampered records. Real records only.
 */
function findTamperedRecords() {
  const { accounts, loans, ok } = ledgerSnapshot();
  const out = [];
  if (!ok) return out;
  for (const [key, a] of Object.entries(accounts)) {
    if (a && typeof a.balance === "number" && a.balance < 0) {
      out.push({ kind: "account", id: key, balance: a.balance });
    }
  }
  for (const [key, l] of Object.entries(loans)) {
    if (l && typeof l.owed === "number" && l.owed < 0) {
      out.push({ kind: "loan", id: key, owed: l.owed });
    }
  }
  return out;
}

// --- branch audits ---------------------------------------------------------------

function lastAuditFor(kingdomId) {
  const kid = String(kingdomId || "");
  let last = null;
  for (const a of Object.values(load().audits)) {
    if (a.kingdomId === kid && (!last || (a.conductedAt ?? 0) > (last.conductedAt ?? 0))) last = a;
  }
  return last;
}

function auditsFor(kingdomId) {
  const kid = String(kingdomId || "");
  return Object.values(load().audits)
    .filter((a) => !kid || a.kingdomId === kid)
    .sort((a, b) => (b.conductedAt ?? 0) - (a.conductedAt ?? 0));
}

function auditsConductedBy(username) {
  return Object.values(load().audits).filter((a) => norm(a.auditor) === norm(username)).length;
}

/**
 * Conduct a branch audit. Findings are computed from the REAL ledger —
 * never assumed. The auditor must be an auditor-rank member in good
 * standing (or the guild itself for automatic audits).
 */
function conductAudit(kingdomId, auditor, nowMs = Date.now()) {
  const st = load();
  const kid = String(kingdomId || "");
  if (!kid) return { ok: false, reason: "no-kingdom" };
  const B = bankingApi();
  if (!B) return { ok: false, reason: "no-banking" };
  let branch = null;
  try { branch = B.branchFor(kid); } catch { branch = null; }
  if (!branch) return { ok: false, reason: "no-branch" };
  const aud = String(auditor || "guild").trim() || "guild";
  if (aud !== "guild") {
    const m = memberOf(aud);
    if (!m || m.rank !== RANK_AUDITOR || m.suspended) return { ok: false, reason: "not-an-auditor" };
    if (m.kingdomId !== kid) return { ok: false, reason: "wrong-kingdom" };
  }
  const leverage = leverageRatio();
  const drate = defaultRate(nowMs);
  let bankerCount = 0;
  try { bankerCount = B.bankersIn(kid).length; } catch { bankerCount = 0; }
  const reasons = [];
  if (!(leverage <= LEVERAGE_PASS_MAX)) reasons.push(`leverage ${leverage === Infinity ? "infinite" : leverage.toFixed(2)} exceeds ${LEVERAGE_PASS_MAX}`);
  if (drate > DEFAULT_RATE_PASS_MAX) reasons.push(`default rate ${(drate * 100).toFixed(1)}% exceeds ${(DEFAULT_RATE_PASS_MAX * 100).toFixed(0)}%`);
  if (bankerCount <= 0) reasons.push("no registered banker at the branch");
  const verdict = reasons.length === 0 ? "pass" : "flag";
  const id = allocId("audit");
  const record = {
    id,
    kingdomId: kid,
    auditor: aud,
    conductedAt: nowMs,
    leverage: leverage === Infinity ? -1 : leverage, // -1 serializes "infinite"
    defaultRate: drate,
    bankerCount,
    verdict,
    reasons,
  };
  st.audits[id] = record;
  const g = ensureGuild(kid);
  g.branch.lastAuditAt = nowMs;
  g.branch.lastVerdict = verdict;
  if (verdict === "pass") {
    g.branch.flags = 0;
    g.branch.status = "sound";
    g.branch.certifiedUntil = nowMs + AUDIT_PERIOD_MS;
  } else {
    g.branch.flags = (g.branch.flags || 0) + 1;
    g.branch.certifiedUntil = 0;
    if (g.branch.flags >= CONSECUTIVE_FLAGS_TO_FAIL && leverage > LEVERAGE_FAIL_MIN) {
      g.branch.status = "failed";
    } else {
      g.branch.status = "flagged";
    }
  }
  if (aud !== "guild") {
    const m = memberOf(aud);
    if (m) m.auditsConducted = (m.auditsConducted || 0) + 1;
  }
  markDirty();
  return { ok: true, audit: record, branchStatus: g.branch.status };
}

function branchStatus(kingdomId) {
  const g = ensureGuild(kingdomId);
  return g ? { ...g.branch } : null;
}

function isBranchFailed(kingdomId) {
  const g = guildOf(kingdomId);
  return !!(g && g.branch && g.branch.status === "failed");
}

// --- deposit insurance ------------------------------------------------------------

/**
 * Premium for a depositor: 1% of balance, capped at 100 coins.
 * Read from the real account — never invented.
 */
function premiumFor(username) {
  const B = bankingApi();
  if (!B) return 0;
  let bal = 0;
  try { bal = B.balanceOf(username) || 0; } catch { bal = 0; }
  if (bal <= 0) return 0;
  return Math.min(INSURANCE_PREMIUM_CAP, Math.floor((bal * INSURANCE_PREMIUM_BPS) / 10000));
}

function isCovered(username, nowMs = Date.now()) {
  const c = load().coverage[norm(username)];
  return !!(c && c.coveredUntil > nowMs);
}

function coverageFor(username) {
  return load().coverage[norm(username)] || null;
}

function markCovered(username, nowMs = Date.now()) {
  const st = load();
  const name = String(username || "").trim();
  if (!name) return false;
  st.coverage[norm(name)] = { username: name, coveredUntil: nowMs + INSURANCE_PERIOD_MS };
  markDirty();
  return true;
}

function pruneCoverage(nowMs = Date.now()) {
  const st = load();
  let n = 0;
  for (const [k, c] of Object.entries(st.coverage)) {
    if ((c.coveredUntil ?? 0) <= nowMs) { delete st.coverage[k]; n++; }
  }
  if (n) markDirty();
  return n;
}

function openClaims(kingdomId) {
  const kid = String(kingdomId || "");
  return Object.values(load().claims).filter(
    (c) => (!kid || c.kingdomId === kid) && (c.owed ?? 0) > 0
  );
}

/**
 * File deposit-insurance claims for a failed branch. Every covered
 * depositor with a positive real balance gets a claim up to the coverage
 * cap. Claims are real records against the real insurance fund.
 */
function fileFailureClaims(kingdomId, nowMs = Date.now()) {
  const st = load();
  const kid = String(kingdomId || "");
  if (!kid) return { ok: false, reason: "no-kingdom" };
  if (!isBranchFailed(kid)) return { ok: false, reason: "branch-not-failed" };
  const { accounts, ok } = ledgerSnapshot();
  if (!ok) return { ok: false, reason: "no-ledger" };
  let filed = 0;
  for (const [key, a] of Object.entries(accounts)) {
    const bal = a && typeof a.balance === "number" ? a.balance : 0;
    if (bal <= 0) continue;
    if (!isCovered(key, nowMs)) continue;
    // One open claim per depositor.
    const existing = Object.values(st.claims).some(
      (c) => c.kingdomId === kid && norm(c.depositor) === norm(key) && (c.owed ?? 0) > 0
    );
    if (existing) continue;
    const amount = Math.min(bal, INSURANCE_COVERAGE_CAP);
    const id = allocId("claim");
    st.claims[id] = { id, kingdomId: kid, depositor: key, amount, paid: 0, owed: amount, filedAt: nowMs };
    filed++;
  }
  markDirty();
  return { ok: true, filed };
}

/**
 * Pay open claims from the real insurance fund. Credits the depositor's
 * REAL bank account (this is deposit insurance — the payout restores the
 * deposit). Owed honestly when the fund runs dry; the life tick retries
 * as dues refill the fund.
 */
function payClaim(claimId) {
  const st = load();
  const c = st.claims[String(claimId)];
  if (!c || (c.owed ?? 0) <= 0) return { ok: false, reason: "no-open-claim" };
  const g = guildOf(c.kingdomId);
  if (!g) return { ok: false, reason: "no-guild" };
  const pay = Math.min(c.owed, Math.floor(g.insuranceFund));
  if (pay <= 0) return { ok: false, reason: "fund-empty" };
  const B = bankingApi();
  if (!B) return { ok: false, reason: "no-banking" };
  // Credit the real account through the ledger. The guild's fund pays —
  // this is the one place this module writes the banking ledger, and
  // only from its own tracked fund.
  try {
    const ledger = B._data ? B._data() : null;
    const key = norm(c.depositor);
    if (!ledger || !ledger.accounts || !ledger.accounts[key]) return { ok: false, reason: "no-account" };
    g.insuranceFund -= pay;
    ledger.accounts[key].balance = (ledger.accounts[key].balance || 0) + pay;
    c.paid = (c.paid || 0) + pay;
    c.owed = c.amount - c.paid;
    markDirty();
    if (typeof B.markDirty === "function") B.markDirty();
    return { ok: true, paid: pay, owed: c.owed };
  } catch {
    return { ok: false, reason: "ledger-write-failed" };
  }
}

// --- ethics tribunal ---------------------------------------------------------------

const VIOLATION_TAMPERING = "tampering";
const VIOLATION_TYPES = Object.freeze([VIOLATION_TAMPERING]);

function reportViolation(accuser, accused, type, nowMs = Date.now()) {
  const st = load();
  if (!VIOLATION_TYPES.includes(type)) return { ok: false, reason: "bad-type" };
  const acc = String(accused || "").trim();
  if (!acc) return { ok: false, reason: "no-accused" };
  const m = memberOf(acc);
  if (!m) return { ok: false, reason: "not-a-member" };
  // No double jeopardy: one open case per accused.
  for (const c of Object.values(st.cases)) {
    if (c.status === "open" && norm(c.accused) === norm(acc)) {
      return { ok: false, reason: "already-open", id: c.id };
    }
  }
  const id = allocId("case");
  st.cases[id] = {
    id,
    accuser: String(accuser || "guild").trim() || "guild",
    accused: m.username,
    type,
    status: "open",
    filedAt: nowMs,
    votes: Object.create(null),
    verdict: null,
    settledAt: 0,
    sanction: null,
    evidence: null,
  };
  markDirty();
  return { ok: true, id };
}

function caseFor(id) {
  return load().cases[String(id)] || null;
}

function openCases(kingdomId) {
  return Object.values(load().cases).filter(
    (c) => c.status === "open" && (!kingdomId || guildKingdomOf(c.accused) === String(kingdomId))
  );
}

function violationsFor(username) {
  return Object.values(load().cases).filter((c) => norm(c.accused) === norm(username));
}

function guiltyVerdictsFor(username) {
  return violationsFor(username).filter((c) => c.status === "decided" && c.verdict === "guilty");
}

/**
 * Verifiable tampering: the tampered records found in the real ledger.
 * The tribunal needs evidence, not suspicion — anything else is
 * "unverifiable" and the case fails.
 */
function verifyTampering() {
  const tampered = findTamperedRecords();
  return { ok: true, tampered: tampered.length > 0, records: tampered };
}

function voteOnCase(caseId, voter, guilty, nowMs = Date.now()) {
  const st = load();
  const c = st.cases[String(caseId)];
  if (!c || c.status !== "open") return { ok: false, reason: "no-open-case" };
  const v = memberOf(voter);
  if (!v) return { ok: false, reason: "not-a-member" };
  if (v.rank !== RANK_AUDITOR || v.suspended) return { ok: false, reason: "not-an-auditor" };
  if (norm(voter) === norm(c.accused)) return { ok: false, reason: "cannot-judge-self" };
  c.votes[norm(voter)] = { voter: v.username, guilty: !!guilty, at: nowMs };
  markDirty();
  return { ok: true };
}

function settleCase(caseId, nowMs = Date.now()) {
  const st = load();
  const c = st.cases[String(caseId)];
  if (!c || c.status !== "open") return { ok: false, reason: "no-open-case" };
  const evidence = verifyTampering();
  const votes = Object.values(c.votes);
  const guiltyVotes = votes.filter((v) => v.guilty).length;
  const notGuiltyVotes = votes.filter((v) => !v.guilty).length;
  // Verifiable tampering evidence counts as one guilty vote — the tribunal
  // weighs facts, and auditors weigh judgment.
  const evidenceGuilty = evidence.ok && evidence.tampered;
  const totalGuilty = guiltyVotes + (evidenceGuilty ? 1 : 0);
  const quorum = votes.length >= 1 || nowMs - c.filedAt >= CASE_SETTLE_MS;
  if (!quorum) return { ok: false, reason: "no-quorum" };
  const guilty = totalGuilty > notGuiltyVotes;
  c.status = "decided";
  c.verdict = guilty ? "guilty" : "not-guilty";
  c.settledAt = nowMs;
  c.evidence = evidence.tampered ? evidence.records.slice(0, 5) : [];
  if (guilty) {
    c.sanction = "expulsion";
    const m = memberOf(c.accused);
    if (m) { m.expelled = true; m.suspended = true; }
  } else {
    c.sanction = "none";
  }
  markDirty();
  return { ok: true, verdict: c.verdict, sanction: c.sanction, evidence };
}

// --- banker school --------------------------------------------------------------------

function holdClass(master, pupilUsernames, kingdomId, nowMs = Date.now()) {
  const st = load();
  const kid = String(kingdomId || "");
  const m = memberOf(master);
  if (!m || m.rank !== RANK_AUDITOR || m.suspended) return { ok: false, reason: "not-an-auditor" };
  const pupils = [];
  for (const u of pupilUsernames || []) {
    const p = memberOf(u);
    if (p && p.rank === RANK_CLERK && !p.suspended && p.kingdomId === kid) {
      p.trainingCredits = (p.trainingCredits || 0) + 1;
      pupils.push(p.username);
    }
  }
  if (!pupils.length) return { ok: false, reason: "no-pupils" };
  const id = allocId("class");
  st.classes[id] = { id, master: m.username, pupils, kingdomId: kid, heldAt: nowMs };
  markDirty();
  return { ok: true, id, pupils };
}

function classesFor(username) {
  return Object.values(load().classes).filter((c) => c.pupils.some((a) => norm(a) === norm(username)));
}

function tenureDays(member, nowMs = Date.now()) {
  return Math.floor((nowMs - (member.joinedAt ?? nowMs)) / (24 * 60 * 60 * 1000));
}

function promotionEligible(username, nowMs = Date.now()) {
  const m = memberOf(username);
  if (!m || m.suspended || m.expelled) return { ok: false, reason: "not-eligible" };
  const days = tenureDays(m, nowMs);
  if (m.rank === RANK_CLERK) {
    if (days < PROMOTE_TELLER_DAYS) return { ok: false, reason: "needs-tenure", need: PROMOTE_TELLER_DAYS - days };
    if ((m.trainingCredits || 0) < PROMOTE_TELLER_TRAINING) {
      return { ok: false, reason: "needs-training", need: PROMOTE_TELLER_TRAINING - (m.trainingCredits || 0) };
    }
    if (guiltyVerdictsFor(m.username).length) return { ok: false, reason: "ethics-record" };
    return { ok: true, to: RANK_TELLER };
  }
  if (m.rank === RANK_TELLER) {
    if (days < PROMOTE_AUDITOR_DAYS) return { ok: false, reason: "needs-tenure", need: PROMOTE_AUDITOR_DAYS - days };
    if ((m.trainingCredits || 0) < PROMOTE_AUDITOR_TRAINING) {
      return { ok: false, reason: "needs-training", need: PROMOTE_AUDITOR_TRAINING - (m.trainingCredits || 0) };
    }
    if ((m.auditsConducted || 0) < PROMOTE_AUDITOR_AUDITS) {
      return { ok: false, reason: "needs-audits", need: PROMOTE_AUDITOR_AUDITS - (m.auditsConducted || 0) };
    }
    if (guiltyVerdictsFor(m.username).length) return { ok: false, reason: "ethics-record" };
    return { ok: true, to: RANK_AUDITOR };
  }
  return { ok: false, reason: "at-top" };
}

function promote(username, nowMs = Date.now()) {
  const m = memberOf(username);
  if (!m) return { ok: false, reason: "not-a-member" };
  const elig = promotionEligible(username, nowMs);
  if (!elig.ok) return elig;
  m.rank = elig.to;
  m.promotedAt = nowMs;
  markDirty();
  return { ok: true, to: elig.to };
}

// --- describe ---------------------------------------------------------------------------

function describe(kingdomId) {
  const kid = String(kingdomId || "");
  const g = ensureGuild(kid);
  if (!g) return null;
  return {
    kingdomId: kid,
    members: memberCount(kid),
    auditors: auditorsIn(kid).length,
    treasury: g.treasury,
    insuranceFund: g.insuranceFund,
    branchStatus: g.branch.status,
    branchFlags: g.branch.flags,
    certifiedUntil: g.branch.certifiedUntil,
    openCases: openCases(kid).length,
    openClaims: openClaims(kid).length,
    lastAudit: lastAuditFor(kid),
  };
}

module.exports = {
  // constants
  SAVE_KEY, COINS_ID,
  RANK_CLERK, RANK_TELLER, RANK_AUDITOR, RANKS,
  DUES_WEEKLY, DUES_INSURANCE_SHARE, DUES_PERIOD_MS, SUSPEND_AFTER_MISSED,
  AUDIT_PERIOD_MS, LEVERAGE_PASS_MAX, DEFAULT_RATE_PASS_MAX, LEVERAGE_FAIL_MIN, CONSECUTIVE_FLAGS_TO_FAIL,
  INSURANCE_COVERAGE_CAP, INSURANCE_PREMIUM_BPS, INSURANCE_PREMIUM_CAP, INSURANCE_PERIOD_MS,
  PROMOTE_TELLER_DAYS, PROMOTE_TELLER_TRAINING, PROMOTE_AUDITOR_DAYS, PROMOTE_AUDITOR_TRAINING, PROMOTE_AUDITOR_AUDITS,
  VIOLATION_TAMPERING, VIOLATION_TYPES, CASE_SETTLE_MS,
  STANDARDS_CODE,
  // associations
  ensureGuild, guildOf, guildTreasuryFor, insuranceFundFor,
  creditTreasury, debitTreasury, creditInsuranceFund, debitInsuranceFund,
  hallTileFor,
  // membership
  memberOf, isGuildMember, guildRankOf, memberCount, auditorsIn,
  joinGuild, leaveGuild, liftSuspension, guildKingdomOf,
  // ledger reads (read-only)
  ledgerSnapshot, totalDeposits, loanStats, leverageRatio, defaultRate, findTamperedRecords,
  // audits
  conductAudit, lastAuditFor, auditsFor, auditsConductedBy, branchStatus, isBranchFailed,
  // insurance
  premiumFor, isCovered, coverageFor, markCovered, pruneCoverage,
  openClaims, fileFailureClaims, payClaim,
  // ethics
  reportViolation, caseFor, openCases, violationsFor, guiltyVerdictsFor,
  verifyTampering, voteOnCase, settleCase,
  // school
  holdClass, classesFor, tenureDays, promotionEligible, promote,
  // describe + persistence
  describe, save, resetForTests,
};
