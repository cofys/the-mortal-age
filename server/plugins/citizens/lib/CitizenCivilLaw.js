"use strict";

/**
 * CitizenCivilLaw — persistent registry of REAL civil-law instruments:
 * contracts, wills, disputes, advocates, and judgments.
 *
 * Complements (does not duplicate) the existing layers:
 *   - CitizenCrime owns offense records and base sentencing.
 *   - CitizenJusticeLife owns CRIMINAL trial scheduling and punishment.
 *   - CitizenLegalCode owns statutes-as-applied, judges, criminal defense
 *     lawyers, appeals, pardons, and player accusations.
 *   - THIS module owns CIVIL law: enforceable contracts between citizens,
 *     wills and estate execution on death, civil disputes (breach, debt,
 *     defamation) with mediation and civil-court hearings, advocates
 *     (civil representation, parallel to criminal defense counsel), and
 *     money judgments enforced with real coins.
 *
 * Every coin that moves touches a real inventory or a real bank account.
 * Nothing is invented. Zero LLM. Dirty-flag persistence. Plain-node testable.
 *
 * No-overlap boundary: criminal defense stays in CitizenLegalCode
 * (hireLawyer/defenseBonusFor); this module's hireAdvocate/advocateBonusFor
 * covers civil disputes only. The sitting judge is READ defensively from
 * CitizenLegalCode — never appointed here.
 */

const fs = require("fs");
const path = require("path");
const { normalizeName } = require("./CitizenBonds");

let SAVE_FILE = path.join(__dirname, "..", "data", "saves", "citizen-civillaw.json");

/** Test seam — redirect the save path (tests must not touch the real one). */
function _setSavePathForTests(p) {
  SAVE_FILE = p;
}

// --- tuning ----------------------------------------------------------------

const COINS_ID = 995;
const CONTRACT_WITNESS_FEE = 10; // coins to the court clerk for witnessing
const DISPUTE_FILING_FEE = 50; // coins to file a civil dispute
const ADVOCATE_FEE = 100; // flat fee for civil representation
const ADVOCATE_BONUS = 0.12; // hearing-score shift from having an advocate
const MEDIATION_SETTLE_CHANCE = 0.5; // probability mediation settles
const CROWN_ESCHEAT_SHARE = 0.2; // 20% of intestate estates go to the crown
const CONTRACT_TYPES = Object.freeze({
  service: "service", // A hires B for work; A pays amount on completion
  trade: "trade", // A sells goods to B; B pays amount on delivery
  lease: "lease", // A rents a market stall pitch to B for the term
});
const DISPUTE_TYPES = Object.freeze({
  breach: "breach", // a contract was breached
  debt: "debt", // unpaid debt outside banking
  defamation: "defamation", // public false statements (from the press)
});
const DISPUTE_STATUS = Object.freeze({
  filed: "filed",
  mediation: "mediation",
  hearing: "hearing",
  decided: "decided",
  dismissed: "dismissed",
  settled: "settled",
});
const CONTRACT_STATUS = Object.freeze({
  active: "active",
  fulfilled: "fulfilled",
  breached: "breached",
  disputed: "disputed",
  void: "void",
});

// --- state -------------------------------------------------------------------

let cache = null;
// {
//   contracts: { id: {...} },
//   wills: { norm(testator): { heirs: [{username, share}], executor, createdAtMs } },
//   disputes: { id: {...} },
//   advocates: { disputeId: { plaintiff: lawyer, defendant: lawyer } },
//   judgments: { disputeId: {...} },
//   executedWills: { norm(testator): executedAtMs },
//   willWatermarkMs: 0,
//   seq: 1,
// }
let dirty = false;

function blankState() {
  return {
    contracts: Object.create(null),
    wills: Object.create(null),
    disputes: Object.create(null),
    advocates: Object.create(null),
    judgments: Object.create(null),
    executedWills: Object.create(null),
    willWatermarkMs: 0,
    seq: 1,
  };
}

function state() {
  if (!cache) {
    cache = blankState();
    load();
  }
  return cache;
}

function load() {
  try {
    if (!fs.existsSync(SAVE_FILE)) return;
    const raw = fs.readFileSync(SAVE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      cache = Object.assign(blankState(), parsed);
    }
  } catch {
    // corrupt or unreadable — start blank
  }
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

function markDirty() {
  dirty = true;
}

function resetForTests() {
  cache = blankState();
  dirty = false;
}

function nextId(prefix) {
  const s = state();
  const id = `${prefix}-${s.seq++}`;
  markDirty();
  return id;
}

// --- coin helpers ------------------------------------------------------------

function countCoins(player) {
  try {
    const inv = player?.getInventory?.();
    if (!inv) return 0;
    if (typeof inv.count === "function") return inv.count(COINS_ID) || 0;
    if (typeof inv.getAmount === "function") return inv.getAmount(COINS_ID) || 0;
    return 0;
  } catch {
    return 0;
  }
}

function takeCoins(player, amount) {
  try {
    const inv = player?.getInventory?.();
    if (!inv || amount <= 0) return 0;
    const have = countCoins(player);
    const take = Math.min(have, amount);
    if (take <= 0) return 0;
    if (typeof inv.remove === "function") inv.remove(COINS_ID, take);
    else if (typeof inv.delete === "function") inv.delete(COINS_ID, take);
    else return 0;
    return take;
  } catch {
    return 0;
  }
}

function giveCoins(player, amount) {
  try {
    const inv = player?.getInventory?.();
    if (!inv || amount <= 0) return 0;
    if (typeof inv.add === "function") {
      inv.add(COINS_ID, amount);
      return amount;
    }
    return 0;
  } catch {
    return 0;
  }
}

/** Take coins from inventory first, then bank account. Returns amount taken. */
function takeCoinsAnywhere(player, username, amount) {
  let taken = takeCoins(player, amount);
  if (taken >= amount) return taken;
  try {
    const Banking = require("./CitizenBanking");
    const remaining = amount - taken;
    const res = Banking.withdraw?.(username, remaining);
    if (res && res.ok) taken += res.withdrew || 0;
  } catch {
    // banking unreadable — inventory coins only
  }
  return taken;
}

// --- contracts ---------------------------------------------------------------

/**
 * Create a contract between two citizens. The witness fee (10 coins) is
 * collected honestly from the proposer's inventory.
 * Returns { ok, contract } or { ok: false, reason }.
 */
function createContract({ type, partyA, partyB, amount, deadlineMs, description, kingdomId, proposerPlayer }) {
  const s = state();
  if (!CONTRACT_TYPES[type]) return { ok: false, reason: "bad-type" };
  if (!partyA || !partyB) return { ok: false, reason: "bad-parties" };
  if (normalizeName(partyA) === normalizeName(partyB)) return { ok: false, reason: "self-deal" };
  amount = Math.floor(Number(amount) || 0);
  if (amount <= 0) return { ok: false, reason: "bad-amount" };
  deadlineMs = Number(deadlineMs) || Date.now() + 7 * 24 * 60 * 60 * 1000;

  // Witness fee — honest: fails if the proposer can't pay.
  if (proposerPlayer) {
    const paid = takeCoins(proposerPlayer, CONTRACT_WITNESS_FEE);
    if (paid < CONTRACT_WITNESS_FEE) return { ok: false, reason: "no-fee" };
  }

  const id = nextId("ctr");
  const contract = {
    id,
    type,
    partyA: normalizeName(partyA),
    partyB: normalizeName(partyB),
    displayA: partyA,
    displayB: partyB,
    amount,
    description: String(description || "").slice(0, 200),
    kingdomId: kingdomId || null,
    status: CONTRACT_STATUS.active,
    createdAtMs: Date.now(),
    deadlineMs,
    breachedBy: null,
    fulfilledAtMs: null,
  };
  s.contracts[id] = contract;
  markDirty();
  return { ok: true, contract };
}

function contractById(id) {
  return state().contracts[id] || null;
}

function contractsOf(username) {
  const norm = normalizeName(username);
  return Object.values(state().contracts).filter(
    (c) => c.partyA === norm || c.partyB === norm
  );
}

function activeContracts() {
  return Object.values(state().contracts).filter((c) => c.status === CONTRACT_STATUS.active);
}

/** All contracts ever recorded (for credibility checks, audits). */
function allContracts() {
  return Object.values(state().contracts);
}

/**
 * Mark a contract fulfilled. Coins move per the contract type:
 *   service: partyA (hirer) pays partyB (worker) the amount.
 *   trade:   partyB (buyer) pays partyA (seller) the amount.
 *   lease:   partyB (tenant) pays partyA (landlord) the amount.
 * Returns { ok, paid } — honest: partial payment when funds are short.
 */
function fulfillContract(id, playerFor) {
  const s = state();
  const c = s.contracts[id];
  if (!c || c.status !== CONTRACT_STATUS.active) return { ok: false, reason: "not-active" };
  const payerName = c.type === "service" ? c.displayA : c.displayB;
  const payeeName = c.type === "service" ? c.displayB : c.displayA;
  const payerNorm = c.type === "service" ? c.partyA : c.partyB;
  const payeeNorm = c.type === "service" ? c.partyB : c.partyA;
  const payer = playerFor ? playerFor(payerName) : null;
  const payee = playerFor ? playerFor(payeeName) : null;
  let paid = 0;
  if (payer) {
    paid = takeCoins(payer, c.amount);
    if (paid > 0) {
      if (payee) {
        giveCoins(payee, paid);
      } else {
        // Payee offline: bank it honestly so nothing is invented or lost.
        try {
          const Banking = require("./CitizenBanking");
          Banking.creditAccount?.(payeeNorm, paid);
        } catch {
          // banking unreadable — return the coins (honest)
          giveCoins(payer, paid);
          paid = 0;
        }
      }
    }
  }
  c.status = CONTRACT_STATUS.fulfilled;
  c.fulfilledAtMs = Date.now();
  c.paidAmount = paid;
  markDirty();
  return { ok: true, paid };
}

/**
 * Record a breach. The breacher's name is attached to their reputation via
 * the oathbreaker deed (awarded by the Life tick). A dispute is opened
 * automatically so the wronged party has recourse.
 */
function breachContract(id, breachedBy) {
  const s = state();
  const c = s.contracts[id];
  if (!c || c.status !== CONTRACT_STATUS.active) return { ok: false, reason: "not-active" };
  c.status = CONTRACT_STATUS.breached;
  c.breachedBy = normalizeName(breachedBy);
  c.breachedAtMs = Date.now();
  markDirty();
  // Auto-open a dispute for the wronged party.
  const wronged = c.breachedBy === c.partyA ? c.displayB : c.displayA;
  const dispute = fileDispute({
    type: DISPUTE_TYPES.breach,
    plaintiff: wronged,
    defendant: breachedBy,
    claim: c.amount,
    contractId: id,
    kingdomId: c.kingdomId,
  });
  return { ok: true, contract: c, disputeId: dispute.ok ? dispute.dispute.id : null };
}

// --- wills -------------------------------------------------------------------

/**
 * Register a will. Heirs are [{ username, share }] with shares summing to ~1.
 * The executor settles the estate (or the court appoints one).
 */
function registerWill(testator, heirs, executor) {
  const s = state();
  if (!testator) return { ok: false, reason: "bad-testator" };
  if (!Array.isArray(heirs) || heirs.length === 0) return { ok: false, reason: "no-heirs" };
  const total = heirs.reduce((sum, h) => sum + (Number(h.share) || 0), 0);
  if (total <= 0.99 || total > 1.01) return { ok: false, reason: "bad-shares" };
  const norm = normalizeName(testator);
  s.wills[norm] = {
    testator: norm,
    displayTestator: testator,
    heirs: heirs.map((h) => ({ username: normalizeName(h.username), display: h.username, share: Number(h.share) })),
    executor: executor ? normalizeName(executor) : null,
    displayExecutor: executor || null,
    createdAtMs: Date.now(),
  };
  markDirty();
  return { ok: true };
}

function willFor(testator) {
  return state().wills[normalizeName(testator)] || null;
}

function willsExecuted() {
  return Object.keys(state().executedWills).length;
}

/**
 * Execute a will (or intestate succession). The estate is real coins:
 * inventory coins + bank balance. Distributed per shares; remainder from
 * rounding goes to the largest heir. No will → 20% to the crown (kingdom
 * treasury via Banking), the rest split among the deceased's close bonds,
 * or escheat entirely if no bonds exist.
 * Returns { ok, distributed, heirs: [{username, amount}] }.
 */
function executeWill(testator, estate, playerFor, bondUsernames) {
  const s = state();
  const norm = normalizeName(testator);
  if (s.executedWills[norm]) return { ok: false, reason: "already-executed" };
  estate = Math.floor(Number(estate) || 0);
  if (estate <= 0) {
    s.executedWills[norm] = Date.now();
    markDirty();
    return { ok: true, distributed: 0, heirs: [] };
  }
  const will = s.wills[norm];
  const payouts = [];
  if (will) {
    let remaining = estate;
    const sorted = [...will.heirs].sort((a, b) => b.share - a.share);
    sorted.forEach((h, i) => {
      const amount = i === sorted.length - 1 ? remaining : Math.floor(estate * h.share);
      remaining -= amount;
      payouts.push({ username: h.username, display: h.display, amount });
    });
  } else {
    // Intestate: crown takes 20%, rest to close bonds or escheat.
    const crownShare = Math.floor(estate * CROWN_ESCHEAT_SHARE);
    let remaining = estate - crownShare;
    const bonds = (bondUsernames || []).filter((b) => normalizeName(b) !== norm).slice(0, 8);
    if (bonds.length > 0) {
      const per = Math.floor(remaining / bonds.length);
      bonds.forEach((b, i) => {
        const amount = i === bonds.length - 1 ? remaining : per;
        remaining -= amount;
        payouts.push({ username: normalizeName(b), display: b, amount });
      });
    }
    // Whatever remains (crown share + unclaimed) goes to the kingdom treasury.
    payouts.push({ username: "__crown__", display: "the crown", amount: estate - payouts.reduce((t, p) => t + p.amount, 0) });
  }
  // Deliver: real coins to real players; crown share to the treasury.
  for (const p of payouts) {
    if (p.amount <= 0) continue;
    if (p.username === "__crown__") {
      try {
        const Banking = require("./CitizenBanking");
        Banking.treasuryDeposit?.(null, p.amount);
      } catch {
        // treasury unreadable — coins stay undistributed (honest)
      }
      continue;
    }
    const player = playerFor ? playerFor(p.display || p.username) : null;
    if (player) {
      giveCoins(player, p.amount);
    } else {
      // Offline heir: deposit to their bank account so nothing is invented
      // and nothing is lost.
      try {
        const Banking = require("./CitizenBanking");
        Banking.creditAccount?.(p.username, p.amount);
      } catch {
        // banking unreadable — honest: coins undistributed
      }
    }
  }
  s.executedWills[norm] = Date.now();
  markDirty();
  return { ok: true, distributed: estate, heirs: payouts, intestate: !will };
}

// --- disputes ----------------------------------------------------------------

/**
 * File a civil dispute. The filing fee (50 coins) is collected honestly
 * from the plaintiff's inventory.
 */
function fileDispute({ type, plaintiff, defendant, claim, contractId, kingdomId, plaintiffPlayer }) {
  const s = state();
  if (!DISPUTE_TYPES[type]) return { ok: false, reason: "bad-type" };
  if (!plaintiff || !defendant) return { ok: false, reason: "bad-parties" };
  if (normalizeName(plaintiff) === normalizeName(defendant)) return { ok: false, reason: "self-suit" };
  claim = Math.floor(Number(claim) || 0);
  if (claim <= 0) return { ok: false, reason: "bad-claim" };
  if (plaintiffPlayer) {
    const paid = takeCoins(plaintiffPlayer, DISPUTE_FILING_FEE);
    if (paid < DISPUTE_FILING_FEE) return { ok: false, reason: "no-fee" };
  }
  const id = nextId("dsp");
  const dispute = {
    id,
    type,
    plaintiff: normalizeName(plaintiff),
    defendant: normalizeName(defendant),
    displayPlaintiff: plaintiff,
    displayDefendant: defendant,
    claim,
    contractId: contractId || null,
    kingdomId: kingdomId || null,
    status: DISPUTE_STATUS.filed,
    filedAtMs: Date.now(),
    mediationAtMs: null,
    hearingAtMs: null,
    decidedAtMs: null,
  };
  s.disputes[id] = dispute;
  markDirty();
  return { ok: true, dispute };
}

function disputeById(id) {
  return state().disputes[id] || null;
}

function openDisputes() {
  return Object.values(state().disputes).filter(
    (d) => d.status === DISPUTE_STATUS.filed || d.status === DISPUTE_STATUS.mediation || d.status === DISPUTE_STATUS.hearing
  );
}

function disputesOf(username) {
  const norm = normalizeName(username);
  return Object.values(state().disputes).filter((d) => d.plaintiff === norm || d.defendant === norm);
}

/** Hire a civil advocate. Parallel to LegalCode.hireLawyer (criminal). */
function hireAdvocate(disputeId, party, lawyer, feePaid) {
  const s = state();
  const d = s.disputes[disputeId];
  if (!d) return { ok: false, reason: "no-dispute" };
  const normParty = normalizeName(party);
  if (normParty !== d.plaintiff && normParty !== d.defendant) return { ok: false, reason: "not-party" };
  if (!s.advocates[disputeId]) s.advocates[disputeId] = {};
  s.advocates[disputeId][normParty] = { lawyer: normalizeName(lawyer), displayLawyer: lawyer, hiredAtMs: Date.now(), feePaid: !!feePaid };
  markDirty();
  return { ok: true };
}

function advocateFor(disputeId, party) {
  const entry = state().advocates[disputeId];
  if (!entry) return null;
  return entry[normalizeName(party)] || null;
}

/** Disputes with at least one party lacking an advocate — the client pool. */
function disputesNeedingAdvocates() {
  return openDisputes().filter((d) => {
    const adv = state().advocates[d.id] || {};
    return !adv[d.plaintiff] || !adv[d.defendant];
  });
}

function advocateBonusFor(disputeId, party) {
  return advocateFor(disputeId, party) ? ADVOCATE_BONUS : 0;
}

function setDisputeStatus(id, status) {
  const s = state();
  const d = s.disputes[id];
  if (!d) return false;
  d.status = status;
  const now = Date.now();
  if (status === DISPUTE_STATUS.mediation) d.mediationAtMs = now;
  if (status === DISPUTE_STATUS.hearing) d.hearingAtMs = now;
  if (status === DISPUTE_STATUS.decided || status === DISPUTE_STATUS.dismissed || status === DISPUTE_STATUS.settled) d.decidedAtMs = now;
  markDirty();
  return true;
}

// --- judgments ---------------------------------------------------------------

function recordJudgment(disputeId, winner, award) {
  const s = state();
  const d = s.disputes[disputeId];
  if (!d) return { ok: false, reason: "no-dispute" };
  award = Math.floor(Number(award) || 0);
  const judgment = {
    disputeId,
    winner: normalizeName(winner),
    displayWinner: winner,
    loser: normalizeName(winner) === d.plaintiff ? d.defendant : d.plaintiff,
    displayLoser: normalizeName(winner) === d.plaintiff ? d.displayDefendant : d.displayPlaintiff,
    award,
    paid: 0,
    status: award > 0 ? "unpaid" : "none",
    recordedAtMs: Date.now(),
  };
  s.judgments[disputeId] = judgment;
  setDisputeStatus(disputeId, DISPUTE_STATUS.decided);
  markDirty();
  return { ok: true, judgment };
}

function judgmentFor(disputeId) {
  return state().judgments[disputeId] || null;
}

function unpaidJudgments() {
  return Object.values(state().judgments).filter((j) => j.status === "unpaid");
}

/**
 * Enforce a judgment: real coins from the loser's inventory (then bank)
 * to the winner. Partial payment when funds are short; the remainder
 * stays as an honest debt record.
 */
function enforceJudgment(disputeId, playerFor) {
  const s = state();
  const j = s.judgments[disputeId];
  if (!j || j.status !== "unpaid") return { ok: false, reason: "nothing-to-enforce" };
  const owed = j.award - j.paid;
  if (owed <= 0) {
    j.status = "paid";
    markDirty();
    return { ok: true, paid: 0 };
  }
  const loser = playerFor ? playerFor(j.displayLoser || j.loser) : null;
  const winner = playerFor ? playerFor(j.displayWinner || j.winner) : null;
  let moved = 0;
  if (loser) {
    moved = takeCoinsAnywhere(loser, j.loser, owed);
    if (moved > 0 && winner) giveCoins(winner, moved);
    else if (moved > 0) {
      // Winner offline: bank it so nothing is invented or lost.
      try {
        const Banking = require("./CitizenBanking");
        Banking.creditAccount?.(j.winner, moved);
      } catch {
        // banking unreadable — return the coins (honest)
        giveCoins(loser, moved);
        moved = 0;
      }
    }
  }
  j.paid += moved;
  if (j.paid >= j.award) j.status = "paid";
  markDirty();
  return { ok: true, paid: moved, remaining: j.award - j.paid };
}

// --- courthouses ---------------------------------------------------------------

/** One courthouse per kingdom, near the market — like presses and banks. */
function courthouseFor(kingdomId) {
  if (!kingdomId) return null;
  try {
    const { siteTile } = require("../brain/CitizenSites");
    const tile = siteTile ? siteTile(kingdomId, "market") : null;
    if (tile) return { x: tile.x + 2, y: tile.y, z: tile.z ?? 0, kingdomId };
  } catch {
    // sites unreadable
  }
  return null;
}

function describe(kingdomId) {
  const s = state();
  const open = openDisputes().filter((d) => !kingdomId || d.kingdomId === kingdomId);
  return {
    courthouse: courthouseFor(kingdomId),
    openDisputes: open.length,
    activeContracts: activeContracts().filter((c) => !kingdomId || c.kingdomId === kingdomId).length,
    willsRegistered: Object.keys(s.wills).length,
    filingFee: DISPUTE_FILING_FEE,
    witnessFee: CONTRACT_WITNESS_FEE,
    advocateFee: ADVOCATE_FEE,
  };
}

module.exports = {
  _setSavePathForTests,
  resetForTests,
  save,
  CONTRACT_TYPES,
  DISPUTE_TYPES,
  DISPUTE_STATUS,
  CONTRACT_STATUS,
  CONTRACT_WITNESS_FEE,
  DISPUTE_FILING_FEE,
  ADVOCATE_FEE,
  ADVOCATE_BONUS,
  MEDIATION_SETTLE_CHANCE,
  createContract,
  contractById,
  contractsOf,
  activeContracts,
  allContracts,
  fulfillContract,
  breachContract,
  registerWill,
  willFor,
  willsExecuted,
  executeWill,
  fileDispute,
  disputeById,
  openDisputes,
  disputesOf,
  disputesNeedingAdvocates,
  hireAdvocate,
  advocateFor,
  advocateBonusFor,
  setDisputeStatus,
  recordJudgment,
  judgmentFor,
  unpaidJudgments,
  enforceJudgment,
  courthouseFor,
  describe,
  get willWatermarkMs() {
    return state().willWatermarkMs;
  },
  setWillWatermarkMs(ms) {
    state().willWatermarkMs = ms;
    markDirty();
  },
};
