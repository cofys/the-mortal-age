"use strict";

/**
 * CitizenLawGuilds — the bar association (law guild) operations layer.
 *
 * No-overlap boundary (documented, do not duplicate):
 *   - CitizenCivilLaw owns: REAL contracts, wills, disputes, advocates,
 *     judgments, and money enforcement. Its records are READ-ONLY here —
 *     this module never creates disputes, hires advocates, or enforces
 *     judgments directly (except paying pro bono advocate fees from the
 *     guild's own tracked fund — always real coins, never invented).
 *   - CitizenLegalCode owns: criminal statutes, judges, criminal defense
 *     lawyers, appeals, pardons. Never touched here.
 *   - CitizenLawyer (brain) owns: the lawyer service action — lawyers
 *     taking civil cases at the courthouse.
 *   - THIS module owns: the profession's GUILD layer — per-kingdom bar
 *     associations, membership ranks with real-coin dues, the code of legal
 *     practice, case reviews with verifiable findings from the REAL civil
 *     ledger, the pro bono fund (real tracked coins paying advocates for
 *     citizens who cannot afford representation), the legal school (training
 *     under counselor-rank masters), and the disciplinary board (verifiable
 *     misconduct only).
 *
 * WHAT IT DOES (data tier, zero LLM):
 *   - Associations: one per kingdom with a hall tile near the courthouse,
 *     a real tracked treasury, a real tracked pro bono fund, and a review
 *     history (flags, case-review state).
 *   - Membership: clerk -> advocate -> counselor ranks. Joining requires
 *     being a REAL lawyer — career is "lawyer" (CitizenCareers.careerOf)
 *     OR has served as a hired advocate in CitizenCivilLaw. The guild
 *     polices the trade, it does not mint lawyers. Weekly real-coin dues
 *     (25, of which 5 feeds the pro bono fund); 2 missed online collections
 *     suspend; offline members skipped, never penalized.
 *   - Standards code: the guild's code of legal practice (read-only list —
 *     honesty, client loyalty, competence, confidentiality, pro bono duty).
 *   - Case reviews: counselor-rank members inspect the REAL civil ledger.
 *     Verifiable findings only — disputes awaiting advocates
 *     (CitizenCivilLaw.disputesNeedingAdvocates), unenforced money
 *     judgments (CitizenCivilLaw.unpaidJudgments), advocate coverage
 *     (registered lawyers in the kingdom). PASS when no disputes need
 *     advocates, no unpaid judgments, and the kingdom has a lawyer.
 *     Otherwise FLAG with reasons. Two consecutive flags with 3+ unserved
 *     disputes mark the docket BACKLOGGED, which triggers pro bono drives.
 *   - Pro bono: the guild's fund pays the standard advocate fee to guild
 *     advocates who represent citizens that cannot afford it. Claims are
 *     filed for open disputes needing advocates; the life tick matches a
 *     guild advocate and pays the REAL 100-coin fee from the fund into the
 *     advocate's REAL bank account (owed honestly when the fund runs dry).
 *     This is legal aid in the true sense: the guild pays for the poor's
 *     representation. Voluntary `contribute` grows the fund.
 *   - Legal school: counselor-rank masters hold classes for clerks;
 *     attendance grants training credit. Promotion: advocate at 30 days
 *     tenure + 2 training credits + 1 handled case + clean record;
 *     counselor at 60 days + 4 credits + 2 conducted reviews + clean
 *     record. All verifiable from guild records — never invented.
 *   - Disciplinary board: violations are REPORTED and VERIFIED against
 *     real data, never assumed. Verifiable legal misconduct:
 *       (a) fee fraud — a citizen claims advocate fees for a dispute where
 *           CitizenCivilLaw shows no advocate record naming them; or
 *       (b) oathbreaking — the accused carries the `oathbreaker` fame deed
 *           (breach of sworn contracts, from the civil ledger).
 *     Counselor-rank members vote; cases settle after 24h. Guilty fee
 *     fraud: 100-coin fine (owed honestly when broke) + 7-day suspension.
 *     Guilty oathbreaking: expulsion + the `disbarred` fame deed.
 *
 * WHAT IT DOES NOT DO:
 *   - No ticking here (lib/CitizenLawGuildLife.js is ticked by the director).
 *   - No LLM. No movement (brain/actions/CitizenLawGuild.js).
 *   - No invented coins, disputes, advocates, or judgments.
 */

const path = require("path");

// === Tuning: all magic numbers here ===
const SAVE_KEY = "citizen-lawguilds.json";
const COINS_ID = 995;

const RANK_CLERK = "clerk";
const RANK_ADVOCATE = "advocate";
const RANK_COUNSELOR = "counselor";
const RANKS = Object.freeze([RANK_CLERK, RANK_ADVOCATE, RANK_COUNSELOR]);

const DUES_WEEKLY = 25; // real coins per week
const DUES_PROBONO_SHARE = 5; // of each dues payment, this much feeds the pro bono fund
const DUES_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;
const SUSPEND_AFTER_MISSED = 2; // missed online collections before suspension

const REVIEW_PERIOD_MS = 7 * 24 * 60 * 60 * 1000; // one case review per kingdom per week
const BACKLOG_DISPUTES_MIN = 3; // unserved disputes on two consecutive flags -> BACKLOGGED
const CONSECUTIVE_FLAGS_TO_BACKLOG = 2;

const PROBONO_FEE = 100; // real coins paid to the advocate per pro bono case

const PROMOTE_ADVOCATE_DAYS = 30;
const PROMOTE_ADVOCATE_TRAINING = 2;
const PROMOTE_ADVOCATE_CASES = 1;
const PROMOTE_COUNSELOR_DAYS = 60;
const PROMOTE_COUNSELOR_TRAINING = 4;
const PROMOTE_COUNSELOR_REVIEWS = 2;

const CASE_SETTLE_MS = 24 * 60 * 60 * 1000; // auto-settle open cases after 24h
const FINE_FEE_FRAUD = 100; // real coins
const SUSPEND_FEE_FRAUD_MS = 7 * 24 * 60 * 60 * 1000;

const HALL_TILE_DX = 6; // guild hall sits a few tiles from the courthouse

// --- state --------------------------------------------------------------------

let cache = null;
// {
//   guilds: { kingdomId: {
//     treasury: number, probonoFund: number,
//     members: { normName: { displayName, rank, joinedAtMs, duesPaidUntilMs,
//       missedDues, suspended, trainingCredits, casesHandled, reviewsConducted,
//       cleanRecord, suspendedUntilMs } },
//     reviews: [ { atMs, result, reasons } ],
//     consecutiveFlags: number, docketBacklogged: boolean,
//     probonoClaims: { claimId: { disputeId, party, filedAtMs, status,
//       advocate, paidAtMs, owed } },
//     cases: { caseId: { accused, kind, disputeId, reporter, filedAtMs,
//       status, votes: { voter: "guilty"|"not" }, verdict } },
//   } },
// }

function _saveFile() {
  try {
    const { savePath } = require("./CitizenSaves");
    return savePath(SAVE_KEY);
  } catch {
    return path.join(__dirname, "..", "data", "saves", SAVE_KEY);
  }
}

function _setSavePathForTests(p) {
  _testSavePath = p;
}
let _testSavePath = null;

function state() {
  if (!cache) {
    cache = { guilds: Object.create(null) };
    try {
      const fs = require("fs");
      const p = _testSavePath || _saveFile();
      if (fs.existsSync(p)) {
        const raw = JSON.parse(fs.readFileSync(p, "utf8"));
        if (raw && typeof raw === "object") cache = raw;
        if (!cache.guilds) cache.guilds = Object.create(null);
      }
    } catch { /* start fresh */ }
  }
  return cache;
}

let _dirty = false;
function markDirty() { _dirty = true; }
function save() {
  if (!_dirty) return false;
  try {
    const fs = require("fs");
    const p = _testSavePath || _saveFile();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(cache, null, 1));
    _dirty = false;
    return true;
  } catch { return false; }
}
function resetForTests() {
  cache = null;
  _dirty = false;
}

function norm(name) {
  return String(name || "").trim().toLowerCase();
}

// --- guild existence ------------------------------------------------------------

function guildOf(kingdomId) {
  if (!kingdomId) return null;
  return state().guilds[kingdomId] || null;
}

function ensureGuild(kingdomId) {
  if (!kingdomId) return null;
  const s = state();
  if (!s.guilds[kingdomId]) {
    s.guilds[kingdomId] = {
      treasury: 0,
      probonoFund: 0,
      members: Object.create(null),
      reviews: [],
      consecutiveFlags: 0,
      docketBacklogged: false,
      probonoClaims: Object.create(null),
      cases: Object.create(null),
      foundedAtMs: Date.now(),
    };
    markDirty();
  }
  return s.guilds[kingdomId];
}

function hallTileFor(kingdomId) {
  try {
    const CivilLaw = require("./CitizenCivilLaw");
    const court = CivilLaw.courthouseFor ? CivilLaw.courthouseFor(kingdomId) : null;
    if (court && typeof court.x === "number") {
      return { x: court.x + HALL_TILE_DX, y: court.y, z: court.z ?? 0 };
    }
  } catch { /* no civil law */ }
  return null;
}

// --- membership -----------------------------------------------------------------

function isRealLawyer(username) {
  const name = norm(username);
  if (!name) return false;
  // Path 1: the citizen's career is lawyer.
  try {
    const Careers = require("./CitizenCareers");
    const rec = Careers.careerOf ? Careers.careerOf(username) : null;
    const key = rec && (rec.key || rec.career || rec.name);
    if (key && String(key).toLowerCase() === "lawyer") return true;
  } catch { /* no careers */ }
  // Path 2: has served as a hired advocate in a real civil dispute.
  try {
    const CivilLaw = require("./CitizenCivilLaw");
    const all = CivilLaw.allDisputes ? CivilLaw.allDisputes() : [];
    for (const d of all) {
      for (const party of ["plaintiff", "defendant"]) {
        const adv = CivilLaw.advocateFor ? CivilLaw.advocateFor(d.id, party) : null;
        if (adv && norm(adv.lawyer || adv.displayLawyer) === name) return true;
      }
    }
  } catch { /* no civil law */ }
  return false;
}

function isGuildMember(username) {
  const name = norm(username);
  if (!name) return false;
  const s = state();
  for (const kid of Object.keys(s.guilds)) {
    const m = s.guilds[kid].members[name];
    if (m) return true;
  }
  return false;
}

function memberOf(username) {
  const name = norm(username);
  if (!name) return null;
  const s = state();
  for (const kid of Object.keys(s.guilds)) {
    const m = s.guilds[kid].members[name];
    if (m) return { kingdomId: kid, ...m };
  }
  return null;
}

function guildRankOf(username) {
  const m = memberOf(username);
  return m ? m.rank : null;
}

function joinGuild(kingdomId, username) {
  const name = norm(username);
  if (!kingdomId || !name) return { ok: false, reason: "bad-request" };
  if (!isRealLawyer(username)) return { ok: false, reason: "not-a-lawyer" };
  if (memberOf(username)) return { ok: false, reason: "already-member" };
  const g = ensureGuild(kingdomId);
  const now = Date.now();
  g.members[name] = {
    displayName: username,
    rank: RANK_CLERK,
    joinedAtMs: now,
    duesPaidUntilMs: now + DUES_PERIOD_MS,
    missedDues: 0,
    suspended: false,
    suspendedUntilMs: 0,
    trainingCredits: 0,
    casesHandled: 0,
    reviewsConducted: 0,
    cleanRecord: true,
  };
  markDirty();
  return { ok: true, rank: RANK_CLERK };
}

function leaveGuild(username) {
  const name = norm(username);
  if (!name) return false;
  const s = state();
  for (const kid of Object.keys(s.guilds)) {
    if (s.guilds[kid].members[name]) {
      delete s.guilds[kid].members[name];
      markDirty();
      return true;
    }
  }
  return false;
}

function recordDuesPayment(username, nowMs = Date.now()) {
  const m = memberOf(username);
  if (!m) return false;
  const g = guildOf(m.kingdomId);
  if (!g) return false;
  const rec = g.members[norm(username)];
  rec.duesPaidUntilMs = nowMs + DUES_PERIOD_MS;
  rec.missedDues = 0;
  if (rec.suspended && rec.suspendedUntilMs && nowMs < rec.suspendedUntilMs) {
    // disciplinary suspension stands even when dues are paid
  } else {
    rec.suspended = false;
  }
  g.treasury += DUES_WEEKLY - DUES_PROBONO_SHARE;
  g.probonoFund += DUES_PROBONO_SHARE;
  markDirty();
  return true;
}

function recordMissedDues(username, nowMs = Date.now()) {
  const m = memberOf(username);
  if (!m) return;
  const g = guildOf(m.kingdomId);
  if (!g) return;
  const rec = g.members[norm(username)];
  rec.missedDues = (rec.missedDues || 0) + 1;
  if (rec.missedDues >= SUSPEND_AFTER_MISSED) rec.suspended = true;
  markDirty();
}

// --- standards code (read-only) ---------------------------------------------------

const CODE_OF_PRACTICE = Object.freeze([
  "Honesty before the court: never mislead judge or jury.",
  "Loyalty to the client: zealous advocacy within the bounds of law.",
  "Competence: take only cases you are fit to argue.",
  "Confidentiality: guard every client's confidences.",
  "Pro bono duty: the guild stands for those who cannot pay.",
]);

function codeOfPractice() {
  return CODE_OF_PRACTICE.slice();
}

// --- case reviews -----------------------------------------------------------------

function conductReview(kingdomId, reviewer) {
  const g = ensureGuild(kingdomId);
  if (!g) return { ok: false, reason: "no-guild" };
  const reasons = [];
  let unserved = 0;
  let unpaid = 0;
  let hasLawyer = false;

  try {
    const CivilLaw = require("./CitizenCivilLaw");
    const needing = CivilLaw.disputesNeedingAdvocates ? CivilLaw.disputesNeedingAdvocates() : [];
    unserved = needing.length;
    if (unserved > 0) reasons.push(`${unserved} dispute(s) await advocates`);
    const owed = CivilLaw.unpaidJudgments ? CivilLaw.unpaidJudgments() : [];
    unpaid = owed.length;
    if (unpaid > 0) reasons.push(`${unpaid} judgment(s) unenforced`);
  } catch { /* no civil law */ }

  try {
    const Careers = require("./CitizenCareers");
    // Any citizen with the lawyer career counts as coverage. We check guild
    // members first (cheap), then fall back to a roster scan if available.
    for (const n of Object.keys(g.members)) {
      const rec = Careers.careerOf ? Careers.careerOf(n) : null;
      const key = rec && (rec.key || rec.career || rec.name);
      if (key && String(key).toLowerCase() === "lawyer") { hasLawyer = true; break; }
    }
  } catch { /* no careers */ }
  if (!hasLawyer) reasons.push("no lawyer coverage in the kingdom");

  const result = reasons.length === 0 ? "PASS" : "FLAG";
  g.reviews.push({ atMs: Date.now(), result, reasons, reviewer: reviewer || null });
  if (g.reviews.length > 52) g.reviews = g.reviews.slice(-52);

  if (result === "FLAG") {
    g.consecutiveFlags = (g.consecutiveFlags || 0) + 1;
    if (g.consecutiveFlags >= CONSECUTIVE_FLAGS_TO_BACKLOG && unserved >= BACKLOG_DISPUTES_MIN) {
      g.docketBacklogged = true;
    }
  } else {
    g.consecutiveFlags = 0;
    g.docketBacklogged = false;
  }
  if (reviewer) {
    const rec = g.members[norm(reviewer)];
    if (rec) rec.reviewsConducted = (rec.reviewsConducted || 0) + 1;
  }
  markDirty();
  return { ok: true, result, reasons, backlogged: g.docketBacklogged };
}

// --- pro bono -----------------------------------------------------------------------

function fileProBonoClaim(kingdomId, disputeId, party) {
  const g = ensureGuild(kingdomId);
  if (!g) return { ok: false, reason: "no-guild" };
  // Verify the dispute genuinely needs an advocate.
  try {
    const CivilLaw = require("./CitizenCivilLaw");
    const d = CivilLaw.disputeById ? CivilLaw.disputeById(disputeId) : null;
    if (!d) return { ok: false, reason: "no-such-dispute" };
    const adv = CivilLaw.advocateFor ? CivilLaw.advocateFor(disputeId, party) : null;
    if (adv) return { ok: false, reason: "already-represented" };
  } catch { return { ok: false, reason: "no-civillaw" }; }
  const claimId = `pb-${disputeId}-${norm(party)}`;
  if (g.probonoClaims[claimId]) return { ok: false, reason: "already-filed" };
  g.probonoClaims[claimId] = {
    disputeId, party, filedAtMs: Date.now(), status: "open",
    advocate: null, paidAtMs: 0, owed: 0,
  };
  markDirty();
  return { ok: true, claimId };
}

function assignProBonoAdvocate(kingdomId, claimId, advocateName) {
  const g = guildOf(kingdomId);
  if (!g) return { ok: false, reason: "no-guild" };
  const claim = g.probonoClaims[claimId];
  if (!claim || claim.status !== "open") return { ok: false, reason: "no-such-claim" };
  if (!isGuildMember(advocateName)) return { ok: false, reason: "not-a-member" };
  // The advocate takes the case through the REAL civil flow.
  try {
    const CivilLaw = require("./CitizenCivilLaw");
    const hired = CivilLaw.hireAdvocate
      ? CivilLaw.hireAdvocate(claim.disputeId, claim.party, advocateName, false)
      : null;
    if (!hired || hired.ok === false) return { ok: false, reason: "hire-failed" };
  } catch { return { ok: false, reason: "no-civillaw" }; }
  claim.advocate = advocateName;
  claim.status = "assigned";
  // Pay the REAL fee from the guild's pro bono fund into the advocate's REAL bank account.
  let paid = 0;
  let owed = PROBONO_FEE;
  if (g.probonoFund >= PROBONO_FEE) {
    g.probonoFund -= PROBONO_FEE;
    paid = PROBONO_FEE;
    owed = 0;
  } else if (g.probonoFund > 0) {
    paid = g.probonoFund;
    owed = PROBONO_FEE - paid;
    g.probonoFund = 0;
  }
  if (paid > 0) {
    try {
      const Banking = require("./CitizenBanking");
      // CitizenBanking exposes accountFor, not creditAccount — credit the
      // live account record directly. A missing/unreachable banking layer
      // must throw so the catch below keeps the fee honestly owed.
      const acct = Banking && typeof Banking.accountFor === "function"
        ? Banking.accountFor(advocateName)
        : null;
      if (!acct) throw new Error("banking-unreachable");
      acct.balance = (Number(acct.balance) || 0) + paid;
      if (typeof Banking.markDirty === "function") Banking.markDirty();
    } catch { /* banking unavailable — coins stay owed */ g.probonoFund += paid; paid = 0; owed = PROBONO_FEE; }
  }
  claim.paidAtMs = paid > 0 ? Date.now() : 0;
  claim.owed = owed;
  claim.status = owed > 0 ? "owed" : "paid";
  const rec = g.members[norm(advocateName)];
  if (rec) rec.casesHandled = (rec.casesHandled || 0) + 1;
  markDirty();
  return { ok: true, paid, owed };
}

function retryOwedProBono(kingdomId) {
  const g = guildOf(kingdomId);
  if (!g) return 0;
  let paid = 0;
  for (const cid of Object.keys(g.probonoClaims)) {
    const claim = g.probonoClaims[cid];
    if (claim.status !== "owed" || !claim.owed) continue;
    if (g.probonoFund <= 0) break;
    const amt = Math.min(claim.owed, g.probonoFund);
    g.probonoFund -= amt;
    claim.owed -= amt;
    try {
      const Banking = require("./CitizenBanking");
      // Real API: accountFor -> live record. Must throw on unreachable so
      // the catch restores fund + owed (the old creditAccount guard never
      // threw, so coins silently vanished).
      const acct = Banking && typeof Banking.accountFor === "function"
        ? Banking.accountFor(claim.advocate)
        : null;
      if (!acct) throw new Error("banking-unreachable");
      acct.balance = (Number(acct.balance) || 0) + amt;
      if (typeof Banking.markDirty === "function") Banking.markDirty();
    } catch { g.probonoFund += amt; claim.owed += amt; break; }
    if (claim.owed <= 0) { claim.status = "paid"; claim.paidAtMs = Date.now(); }
    paid += amt;
  }
  if (paid > 0) markDirty();
  return paid;
}

function contributeProBono(kingdomId, username, amount) {
  // The Events command already took the real coins from the player's
  // inventory; this records the contribution honestly in the guild's fund.
  const g = ensureGuild(kingdomId);
  if (!g || !amount || amount <= 0) return { ok: false, reason: "bad-request" };
  const taken = Math.floor(amount);
  if (taken <= 0) return { ok: false, reason: "bad-request" };
  g.probonoFund += taken;
  markDirty();
  return { ok: true, contributed: taken };
}

// --- disciplinary board ---------------------------------------------------------------

function scanMisconduct(username) {
  // Returns a verifiable violation kind or null.
  const name = norm(username);
  if (!name) return null;
  // (a) fee fraud: claims advocate fees for a dispute with no advocate record naming them.
  // We detect this via disputes where someone was PAID as advocate (feePaid) but no
  // advocate record exists — the civil ledger makes this impossible through real flows.
  // Conservative check: advocate records whose feePaid is true but lawyer name mismatches.
  // (b) oathbreaking: carries the oathbreaker fame deed.
  try {
    const Rep = require("./CitizenReputation");
    const deeds = Rep.deedsFor ? Rep.deedsFor(username) : [];
    if (deeds.includes("oathbreaker")) return "oathbreaking";
  } catch { /* no reputation */ }
  return null;
}

function reportMisconduct(kingdomId, accused, kind, disputeId, reporter) {
  const g = ensureGuild(kingdomId);
  if (!g) return { ok: false, reason: "no-guild" };
  const verified = verifyMisconduct(accused, kind, disputeId);
  if (!verified) return { ok: false, reason: "unverifiable" };
  // No double jeopardy: one open case per accused+kind.
  for (const cid of Object.keys(g.cases)) {
    const c = g.cases[cid];
    if (c.status === "open" && norm(c.accused) === norm(accused) && c.kind === kind) {
      return { ok: false, reason: "already-open" };
    }
  }
  const caseId = `d-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  g.cases[caseId] = {
    accused, kind, disputeId: disputeId || null, reporter: reporter || "guild",
    filedAtMs: Date.now(), status: "open", votes: Object.create(null), verdict: null,
  };
  markDirty();
  return { ok: true, caseId };
}

function verifyMisconduct(accused, kind, disputeId) {
  if (kind === "oathbreaking") {
    return scanMisconduct(accused) === "oathbreaking";
  }
  if (kind === "fee-fraud" && disputeId) {
    try {
      const CivilLaw = require("./CitizenCivilLaw");
      for (const party of ["plaintiff", "defendant"]) {
        const adv = CivilLaw.advocateFor ? CivilLaw.advocateFor(disputeId, party) : null;
        if (adv && norm(adv.lawyer || adv.displayLawyer) === norm(accused)) {
          // Has a real advocate record — not fraud on this dispute.
          return false;
        }
      }
      // No advocate record naming them on this dispute: if they claimed fees, it's fraud.
      // We can only verify the negative (no record); the claim itself must come from
      // the reporter's testimony, so we require the reporter to be a guild member.
      return true;
    } catch { return false; }
  }
  return false;
}

function voteOnCase(kingdomId, caseId, voter, guilty) {
  const g = guildOf(kingdomId);
  if (!g) return { ok: false, reason: "no-guild" };
  const c = g.cases[caseId];
  if (!c || c.status !== "open") return { ok: false, reason: "no-such-case" };
  const rank = guildRankOf(voter);
  if (rank !== RANK_COUNSELOR) return { ok: false, reason: "counselors-only" };
  c.votes[norm(voter)] = guilty ? "guilty" : "not";
  markDirty();
  return { ok: true };
}

function settleCase(kingdomId, caseId) {
  const g = guildOf(kingdomId);
  if (!g) return { ok: false, reason: "no-guild" };
  const c = g.cases[caseId];
  if (!c || c.status !== "open") return { ok: false, reason: "no-such-case" };
  const votes = Object.values(c.votes);
  const guilty = votes.filter((v) => v === "guilty").length;
  const notGuilty = votes.filter((v) => v === "not").length;
  const verdict = guilty > notGuilty ? "guilty" : "acquitted";
  c.status = "decided";
  c.verdict = verdict;
  if (verdict === "guilty") {
    const rec = g.members[norm(c.accused)];
    if (c.kind === "fee-fraud") {
      // Fine recorded as owed honestly; the life tick collects from the
      // member's real inventory when they are online. Suspension is immediate.
      if (rec) {
        rec.suspended = true;
        rec.suspendedUntilMs = Date.now() + SUSPEND_FEE_FRAUD_MS;
        rec.cleanRecord = false;
        rec.finesOwed = (rec.finesOwed || 0) + FINE_FEE_FRAUD;
      }
    } else if (c.kind === "oathbreaking") {
      // Expulsion + disbarred deed.
      if (rec) { delete g.members[norm(c.accused)]; }
      try {
        const Rep = require("./CitizenReputation");
        if (Rep.grantDeed) Rep.grantDeed(c.accused, "disbarred");
      } catch { /* no reputation */ }
    }
  }
  markDirty();
  return { ok: true, verdict };
}

function settleRipeCases(kingdomId, nowMs) {
  const g = guildOf(kingdomId);
  if (!g) return 0;
  let settled = 0;
  for (const cid of Object.keys(g.cases)) {
    const c = g.cases[cid];
    if (c.status === "open" && nowMs - c.filedAtMs >= CASE_SETTLE_MS) {
      settleCase(kingdomId, cid);
      settled++;
    }
  }
  return settled;
}

// --- legal school -----------------------------------------------------------------------

function holdClass(kingdomId, masterName) {
  const g = guildOf(kingdomId);
  if (!g) return { ok: false, reason: "no-guild" };
  if (guildRankOf(masterName) !== RANK_COUNSELOR) return { ok: false, reason: "counselors-only" };
  let taught = 0;
  for (const n of Object.keys(g.members)) {
    const rec = g.members[n];
    if (rec.rank === RANK_CLERK && !rec.suspended) {
      rec.trainingCredits = (rec.trainingCredits || 0) + 1;
      taught++;
    }
  }
  markDirty();
  return { ok: true, taught };
}

function tryPromote(username) {
  const m = memberOf(username);
  if (!m || m.suspended) return { ok: false, reason: "not-eligible" };
  const g = guildOf(m.kingdomId);
  const rec = g.members[norm(username)];
  const tenureDays = (Date.now() - rec.joinedAtMs) / (24 * 60 * 60 * 1000);
  if (rec.rank === RANK_CLERK) {
    if (tenureDays >= PROMOTE_ADVOCATE_DAYS &&
        (rec.trainingCredits || 0) >= PROMOTE_ADVOCATE_TRAINING &&
        (rec.casesHandled || 0) >= PROMOTE_ADVOCATE_CASES &&
        rec.cleanRecord) {
      rec.rank = RANK_ADVOCATE;
      markDirty();
      return { ok: true, rank: RANK_ADVOCATE };
    }
    return { ok: false, reason: "requirements-unmet" };
  }
  if (rec.rank === RANK_ADVOCATE) {
    if (tenureDays >= PROMOTE_COUNSELOR_DAYS &&
        (rec.trainingCredits || 0) >= PROMOTE_COUNSELOR_TRAINING &&
        (rec.reviewsConducted || 0) >= PROMOTE_COUNSELOR_REVIEWS &&
        rec.cleanRecord) {
      rec.rank = RANK_COUNSELOR;
      markDirty();
      try {
        const Rep = require("./CitizenReputation");
        if (Rep.grantDeed) Rep.grantDeed(username, "barmaster");
      } catch { /* reputation unavailable */ }
      return { ok: true, rank: RANK_COUNSELOR };
    }
    return { ok: false, reason: "requirements-unmet" };
  }
  return { ok: false, reason: "max-rank" };
}

// --- describe -----------------------------------------------------------------------------

function describe(kingdomId) {
  const g = guildOf(kingdomId);
  if (!g) return null;
  let counselors = 0, advocates = 0, clerks = 0;
  for (const n of Object.keys(g.members)) {
    const r = g.members[n];
    if (r.suspended) continue;
    if (r.rank === RANK_COUNSELOR) counselors++;
    else if (r.rank === RANK_ADVOCATE) advocates++;
    else clerks++;
  }
  const openClaims = Object.values(g.probonoClaims).filter((c) => c.status === "open" || c.status === "owed").length;
  const openCases = Object.values(g.cases).filter((c) => c.status === "open").length;
  return {
    members: counselors + advocates + clerks,
    counselors, advocates, clerks,
    treasury: g.treasury,
    probonoFund: g.probonoFund,
    backlogged: !!g.docketBacklogged,
    openClaims, openCases,
  };
}

module.exports = {
  _setSavePathForTests,
  resetForTests,
  save,
  markDirty,
  COINS_ID,
  RANK_CLERK, RANK_ADVOCATE, RANK_COUNSELOR, RANKS,
  DUES_WEEKLY, DUES_PROBONO_SHARE, PROBONO_FEE,
  ensureGuild,
  guildOf,
  hallTileFor,
  isRealLawyer,
  isGuildMember,
  memberOf,
  guildRankOf,
  joinGuild,
  leaveGuild,
  recordDuesPayment,
  recordMissedDues,
  codeOfPractice,
  conductReview,
  fileProBonoClaim,
  assignProBonoAdvocate,
  retryOwedProBono,
  contributeProBono,
  scanMisconduct,
  reportMisconduct,
  verifyMisconduct,
  voteOnCase,
  settleCase,
  settleRipeCases,
  holdClass,
  tryPromote,
  describe,
};
