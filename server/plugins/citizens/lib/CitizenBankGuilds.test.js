"use strict";

/**
 * CitizenBankGuilds.test.js — plain-node tests for the bankers' association.
 * No jest, no engine. Banking is stubbed through the require cache where
 * needed; most tests use the guild's own honest paths.
 */

const assert = require("assert");

const Guilds = require("./CitizenBankGuilds");

function fresh() {
  Guilds.resetForTests();
}

// Stub the CitizenBanking module in the require cache with a controllable
// ledger. The guild only reads it (except claim payouts, which it tests
// separately).
function stubBanking(ledger) {
  const key = require.resolve("./CitizenBanking");
  const fake = {
    bankerFor: (u) => (ledger.bankers || {})[String(u || "").trim().toLowerCase()] || null,
    bankersIn: (kid) => Object.keys(ledger.bankers || {}).filter(
      (k) => (ledger.bankers[k] || {}).kingdomId === String(kid || "").toLowerCase()
    ),
    branchFor: (kid) => ({ name: `${kid} bank`, tile: { x: 3200, y: 3200, z: 0 } }),
    branchTile: (kid) => ({ x: 3200, y: 3200, z: 0 }),
    balanceOf: (u) => {
      const a = (ledger.accounts || {})[String(u || "").trim().toLowerCase()];
      return a ? a.balance || 0 : 0;
    },
    isDefaulted: (u, nowMs) => {
      const l = (ledger.loans || {})[String(u || "").trim().toLowerCase()];
      return l ? nowMs - (l.borrowedAt || 0) > 60 * 24 * 3600 * 1000 : false;
    },
    _data: () => ({ accounts: ledger.accounts || {}, loans: ledger.loans || {} }),
    markDirty: () => {},
  };
  require.cache[key] = { id: key, filename: key, loaded: true, exports: fake };
  return () => { delete require.cache[key]; };
}

function baseLedger() {
  return {
    bankers: { alice: { kingdomId: "misthalin", appointedAt: 1 } },
    accounts: {
      alice: { balance: 5000, lastInterest: 0, createdAt: 1 },
      bob: { balance: 2000, lastInterest: 0, createdAt: 1 },
    },
    loans: {},
  };
}

// --- associations ----------------------------------------------------------

fresh();
{
  const restore = stubBanking(baseLedger());
  const g = Guilds.ensureGuild("misthalin");
  assert.ok(g, "guild created");
  assert.ok(g.hallTile, "hall tile placed");
  assert.strictEqual(Guilds.guildTreasuryFor("misthalin"), 0);
  assert.strictEqual(Guilds.insuranceFundFor("misthalin"), 0);
  restore();
}
console.log("ok - associations");

// --- membership: banker-gated join ------------------------------------------

fresh();
{
  const restore = stubBanking(baseLedger());
  const r1 = Guilds.joinGuild("mallory", "misthalin");
  assert.strictEqual(r1.ok, false, "non-banker rejected");
  assert.strictEqual(r1.reason, "not-banker");
  const r2 = Guilds.joinGuild("alice", "misthalin");
  assert.strictEqual(r2.ok, true, "real banker joins");
  assert.strictEqual(r2.rank, Guilds.RANK_CLERK);
  assert.strictEqual(Guilds.isGuildMember("alice"), true);
  assert.strictEqual(Guilds.guildRankOf("alice"), Guilds.RANK_CLERK);
  const r3 = Guilds.joinGuild("alice", "misthalin");
  assert.strictEqual(r3.ok, false, "duplicate join rejected");
  assert.strictEqual(Guilds.leaveGuild("alice"), true);
  assert.strictEqual(Guilds.isGuildMember("alice"), false);
  restore();
}
console.log("ok - membership join gating");

// --- treasury honesty --------------------------------------------------------

fresh();
{
  const restore = stubBanking(baseLedger());
  assert.strictEqual(Guilds.creditTreasury("misthalin", 100), true);
  assert.strictEqual(Guilds.guildTreasuryFor("misthalin"), 100);
  assert.strictEqual(Guilds.debitTreasury("misthalin", 150), false, "cannot overdraw");
  assert.strictEqual(Guilds.debitTreasury("misthalin", 60), true);
  assert.strictEqual(Guilds.guildTreasuryFor("misthalin"), 40);
  assert.strictEqual(Guilds.creditInsuranceFund("misthalin", 25), true);
  assert.strictEqual(Guilds.insuranceFundFor("misthalin"), 25);
  assert.strictEqual(Guilds.debitInsuranceFund("misthalin", 30), false, "insurance fund cannot overdraw");
  restore();
}
console.log("ok - treasury honesty");

// --- ledger reads --------------------------------------------------------------

fresh();
{
  const ledger = baseLedger();
  ledger.loans = {
    carol: { principal: 1000, owed: 1100, borrowedAt: 1, dueAt: 2, lastInterest: 1 },
  };
  const restore = stubBanking(ledger);
  assert.strictEqual(Guilds.totalDeposits(), 7000, "deposits sum real balances");
  const stats = Guilds.loanStats();
  assert.strictEqual(stats.count, 1);
  assert.strictEqual(stats.owed, 1100);
  const lev = Guilds.leverageRatio();
  assert.ok(Math.abs(lev - 1100 / 7000) < 1e-9, "leverage is real math");
  restore();
}
console.log("ok - ledger reads");

// --- audits: pass / flag ----------------------------------------------------------

fresh();
{
  const ledger = baseLedger();
  const restore = stubBanking(ledger);
  Guilds.joinGuild("alice", "misthalin");
  // Promote alice to auditor for the test (bypass school via direct rank).
  const m = Guilds.memberOf("alice");
  m.rank = Guilds.RANK_AUDITOR;
  const r = Guilds.conductAudit("misthalin", "alice", 1000);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.audit.verdict, "pass", "healthy ledger passes");
  assert.strictEqual(r.branchStatus, "sound");
  const st = Guilds.branchStatus("misthalin");
  assert.ok(st.certifiedUntil > 0, "pass certifies the branch");
  assert.strictEqual(Guilds.auditsConductedBy("alice"), 1);
  restore();
}
console.log("ok - audit pass");

fresh();
{
  const ledger = baseLedger();
  // Over-leveraged: loans far exceed deposits, and the loan is defaulted.
  ledger.loans = {
    dave: { principal: 20000, owed: 25000, borrowedAt: 1, dueAt: 2, lastInterest: 1 },
  };
  const restore = stubBanking(ledger);
  Guilds.joinGuild("alice", "misthalin");
  Guilds.memberOf("alice").rank = Guilds.RANK_AUDITOR;
  const r = Guilds.conductAudit("misthalin", "alice", 1000);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.audit.verdict, "flag", "over-leveraged ledger flags");
  assert.ok(r.audit.reasons.length > 0, "reasons recorded");
  assert.strictEqual(r.branchStatus, "flagged");
  // Second consecutive flag with leverage > 2.0 -> FAILED.
  const r2 = Guilds.conductAudit("misthalin", "alice", 1000 + 8 * 24 * 3600 * 1000);
  assert.strictEqual(r2.branchStatus, "failed");
  assert.strictEqual(Guilds.isBranchFailed("misthalin"), true);
  restore();
}
console.log("ok - audit flag and failure");

fresh();
{
  const restore = stubBanking(baseLedger());
  const r = Guilds.conductAudit("misthalin", "alice", 1000);
  assert.strictEqual(r.ok, false, "non-auditor cannot audit");
  assert.strictEqual(r.reason, "not-an-auditor");
  // The guild itself may auto-audit.
  const r2 = Guilds.conductAudit("misthalin", "guild", 1000);
  assert.strictEqual(r2.ok, true, "guild auto-audit allowed");
  restore();
}
console.log("ok - audit gating");

// --- deposit insurance ------------------------------------------------------------

fresh();
{
  const restore = stubBanking(baseLedger());
  assert.strictEqual(Guilds.premiumFor("alice"), 50, "1% of 5000");
  assert.strictEqual(Guilds.premiumFor("nobody"), 0, "no account, no premium");
  assert.strictEqual(Guilds.isCovered("alice"), false);
  Guilds.markCovered("alice", 1000);
  assert.strictEqual(Guilds.isCovered("alice", 2000), true);
  assert.strictEqual(Guilds.isCovered("alice", 1000 + 31 * 24 * 3600 * 1000), false, "coverage lapses");
  restore();
}
console.log("ok - insurance premiums and coverage");

fresh();
{
  const ledger = baseLedger();
  ledger.loans = {
    dave: { principal: 20000, owed: 25000, borrowedAt: 1, dueAt: 2, lastInterest: 1 },
  };
  const restore = stubBanking(ledger);
  Guilds.joinGuild("alice", "misthalin");
  Guilds.memberOf("alice").rank = Guilds.RANK_AUDITOR;
  Guilds.conductAudit("misthalin", "alice", 1000);
  Guilds.conductAudit("misthalin", "alice", 2000);
  assert.strictEqual(Guilds.isBranchFailed("misthalin"), true);
  // Only covered depositors get claims.
  Guilds.markCovered("alice", 3000);
  const fr = Guilds.fileFailureClaims("misthalin", 3000);
  assert.strictEqual(fr.ok, true);
  assert.strictEqual(fr.filed, 1, "only alice covered; bob not covered");
  const claims = Guilds.openClaims("misthalin");
  assert.strictEqual(claims.length, 1);
  assert.strictEqual(claims[0].amount, 5000, "min(balance, cap)");
  // Fund is empty -> cannot pay.
  const p0 = Guilds.payClaim(claims[0].id);
  assert.strictEqual(p0.ok, false);
  assert.strictEqual(p0.reason, "fund-empty");
  // Fund the insurance and pay.
  Guilds.creditInsuranceFund("misthalin", 3000);
  const p1 = Guilds.payClaim(claims[0].id);
  assert.strictEqual(p1.ok, true);
  assert.strictEqual(p1.paid, 3000);
  assert.strictEqual(p1.owed, 2000, "remainder owed honestly");
  assert.strictEqual(ledger.accounts.alice.balance, 8000, "real account credited");
  restore();
}
console.log("ok - insurance claims");

// --- ethics tribunal ---------------------------------------------------------------

fresh();
{
  const ledger = baseLedger();
  ledger.accounts.eve = { balance: -50, lastInterest: 0, createdAt: 1 }; // tampered
  const restore = stubBanking(ledger);
  const tampered = Guilds.findTamperedRecords();
  assert.strictEqual(tampered.length, 1);
  assert.strictEqual(tampered[0].kind, "account");
  Guilds.joinGuild("alice", "misthalin");
  Guilds.memberOf("alice").rank = Guilds.RANK_AUDITOR;
  const r = Guilds.reportViolation("guild", "alice", Guilds.VIOLATION_TAMPERING, 1000);
  // alice is a member; the tampered record is ledger-wide evidence, not
  // attributed to her — the case still opens (tribunal weighs evidence).
  assert.strictEqual(r.ok, true);
  const v = Guilds.voteOnCase(r.id, "alice", true, 1000);
  // Cannot judge self.
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.reason, "cannot-judge-self");
  restore();
}
console.log("ok - ethics report");

fresh();
{
  const ledger = baseLedger();
  ledger.accounts.eve = { balance: -50, lastInterest: 0, createdAt: 1 };
  ledger.bankers.judge = { kingdomId: "misthalin", appointedAt: 1 };
  const restore = stubBanking(ledger);
  Guilds.joinGuild("alice", "misthalin");
  Guilds.joinGuild("judge", "misthalin");
  Guilds.memberOf("judge").rank = Guilds.RANK_AUDITOR;
  const r = Guilds.reportViolation("guild", "alice", Guilds.VIOLATION_TAMPERING, 1000);
  assert.strictEqual(r.ok, true);
  const v = Guilds.voteOnCase(r.id, "judge", true, 1000);
  assert.strictEqual(v.ok, true);
  const s = Guilds.settleCase(r.id, 1000 + 25 * 3600 * 1000);
  assert.strictEqual(s.ok, true);
  assert.strictEqual(s.verdict, "guilty", "tampered ledger + guilty vote convicts");
  assert.strictEqual(s.sanction, "expulsion");
  assert.strictEqual(Guilds.isGuildMember("alice"), false, "expelled");
  assert.strictEqual(Guilds.guiltyVerdictsFor("alice").length, 1);
  restore();
}
console.log("ok - ethics tribunal conviction");

fresh();
{
  const restore = stubBanking(baseLedger()); // clean ledger, no tampering
  Guilds.joinGuild("alice", "misthalin");
  Guilds.memberOf("alice").rank = Guilds.RANK_AUDITOR;
  const r = Guilds.reportViolation("guild", "alice", Guilds.VIOLATION_TAMPERING, 1000);
  assert.strictEqual(r.ok, true);
  const s = Guilds.settleCase(r.id, 1000 + 25 * 3600 * 1000);
  assert.strictEqual(s.ok, true);
  assert.strictEqual(s.verdict, "not-guilty", "no evidence, no conviction");
  restore();
}
console.log("ok - ethics tribunal acquittal");

// --- banker school ----------------------------------------------------------------------

fresh();
{
  const ledger = baseLedger();
  ledger.bankers.boss = { kingdomId: "misthalin", appointedAt: 1 };
  const restore = stubBanking(ledger);
  Guilds.joinGuild("alice", "misthalin");
  Guilds.joinGuild("boss", "misthalin");
  Guilds.memberOf("boss").rank = Guilds.RANK_AUDITOR;
  const c = Guilds.holdClass("boss", ["alice"], "misthalin", 1000);
  assert.strictEqual(c.ok, true);
  assert.deepStrictEqual(c.pupils, ["alice"]);
  assert.strictEqual(Guilds.memberOf("alice").trainingCredits, 1);
  // Promotion needs 30 days tenure + 2 credits: not yet.
  const e1 = Guilds.promotionEligible("alice", 1000);
  assert.strictEqual(e1.ok, false);
  // Fast-forward tenure and add a credit.
  Guilds.memberOf("alice").joinedAt = 1000 - 31 * 24 * 3600 * 1000;
  Guilds.memberOf("alice").trainingCredits = 2;
  const e2 = Guilds.promotionEligible("alice", 1000);
  assert.strictEqual(e2.ok, true);
  assert.strictEqual(e2.to, Guilds.RANK_TELLER);
  const p = Guilds.promote("alice", 1000);
  assert.strictEqual(p.ok, true);
  assert.strictEqual(Guilds.guildRankOf("alice"), Guilds.RANK_TELLER);
  restore();
}
console.log("ok - banker school and promotion");

fresh();
{
  const ledger = baseLedger();
  ledger.bankers.boss = { kingdomId: "misthalin", appointedAt: 1 };
  const restore = stubBanking(ledger);
  Guilds.joinGuild("alice", "misthalin");
  Guilds.joinGuild("boss", "misthalin");
  const m = Guilds.memberOf("alice");
  m.rank = Guilds.RANK_TELLER;
  m.joinedAt = 1000 - 61 * 24 * 3600 * 1000;
  m.trainingCredits = 4;
  m.auditsConducted = 2;
  Guilds.memberOf("boss").rank = Guilds.RANK_AUDITOR;
  const e = Guilds.promotionEligible("alice", 1000);
  assert.strictEqual(e.ok, true);
  assert.strictEqual(e.to, Guilds.RANK_AUDITOR);
  restore();
}
console.log("ok - auditor promotion");

// --- persistence round-trip ------------------------------------------------------------------

fresh();
{
  const restore = stubBanking(baseLedger());
  Guilds.joinGuild("alice", "misthalin");
  Guilds.creditTreasury("misthalin", 77);
  Guilds.creditInsuranceFund("misthalin", 13);
  assert.strictEqual(Guilds.save(), true, "dirty save writes");
  assert.strictEqual(Guilds.save(), false, "clean save is a no-op");
  restore();
}
console.log("ok - persistence");

// --- describe ------------------------------------------------------------------------------------

fresh();
{
  const restore = stubBanking(baseLedger());
  Guilds.joinGuild("alice", "misthalin");
  const d = Guilds.describe("misthalin");
  assert.ok(d, "describe returns");
  assert.strictEqual(d.members, 1);
  assert.strictEqual(d.branchStatus, "sound");
  restore();
}
console.log("ok - describe");

Guilds.resetForTests();
console.log("ALL BANKGUILD TESTS PASS");
