"use strict";

/**
 * CitizenLawGuilds.test.js — plain-node tests for the bar association.
 * No jest, no engine. CitizenCivilLaw, CitizenCareers, CitizenBanking,
 * CitizenReputation, and CitizenCoins are stubbed through the require cache.
 */

const assert = require("assert");

const Guilds = require("./CitizenLawGuilds");

function fresh() {
  Guilds.resetForTests();
  // Use a temp file for all tests to avoid polluting the real save.
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  if (!fresh.tmp) {
    fresh.tmp = path.join(os.tmpdir(), `lawguild-test-${Date.now()}-${Math.floor(Math.random()*1e6)}.json`);
  }
  Guilds._setSavePathForTests(fresh.tmp);
}

// --- stubs -------------------------------------------------------------------

function stubCareers(careerMap) {
  const key = require.resolve("./CitizenCareers");
  const fake = {
    careerOf: (u) => {
      const k = String(u || "").trim().toLowerCase();
      const c = (careerMap || {})[k];
      return c ? { key: c } : null;
    },
  };
  require.cache[key] = { id: key, filename: key, loaded: true, exports: fake };
  return () => { delete require.cache[key]; };
}

function stubCivilLaw(ledger) {
  const key = require.resolve("./CitizenCivilLaw");
  const fake = {
    courthouseFor: (kid) => ({ x: 3200, y: 3200, z: 0 }),
    disputesNeedingAdvocates: () => (ledger.needing || []).slice(),
    unpaidJudgments: () => (ledger.unpaid || []).slice(),
    disputeById: (id) => (ledger.disputes || {})[id] || null,
    advocateFor: (disputeId, party) => {
      const d = (ledger.disputes || {})[disputeId];
      return d ? (d.advocates || {})[party] || null : null;
    },
    allDisputes: () => Object.values(ledger.disputes || {}),
    hireAdvocate: (disputeId, party, lawyer, feePaid) => {
      const d = (ledger.disputes || {})[disputeId];
      if (!d) return { ok: false };
      d.advocates = d.advocates || {};
      d.advocates[party] = { lawyer, feePaid: !!feePaid };
      return { ok: true };
    },
  };
  require.cache[key] = { id: key, filename: key, loaded: true, exports: fake };
  return () => { delete require.cache[key]; };
}

function stubBanking() {
  const key = require.resolve("./CitizenBanking");
  const credited = [];
  const fake = {
    creditAccount: (u, amt) => { credited.push({ u, amt }); return true; },
    _credited: credited,
  };
  require.cache[key] = { id: key, filename: key, loaded: true, exports: fake };
  return { unstick: () => { delete require.cache[key]; }, credited };
}

function stubReputation(deedsMap) {
  const key = require.resolve("./CitizenReputation");
  const granted = [];
  const fake = {
    deedsFor: (u) => (deedsMap || {})[String(u || "").trim().toLowerCase()] || [],
    grantDeed: (u, deed) => { granted.push({ u, deed }); },
    _granted: granted,
  };
  require.cache[key] = { id: key, filename: key, loaded: true, exports: fake };
  return { unstick: () => { delete require.cache[key]; }, granted };
}

function stubCoins(balances) {
  const key = require.resolve("./CitizenCoins");
  const fake = {
    takeCoins: (u, amt) => {
      const k = String(u || "").trim().toLowerCase();
      const bal = (balances || {})[k] || 0;
      const take = Math.min(bal, Math.floor(amt));
      if (take > 0) balances[k] = bal - take;
      return take;
    },
  };
  require.cache[key] = { id: key, filename: key, loaded: true, exports: fake };
  return () => { delete require.cache[key]; };
}

// --- tests -------------------------------------------------------------------

function testGuildCreation() {
  fresh();
  const unstick = stubCivilLaw({});
  const g = Guilds.ensureGuild("varrock");
  assert.ok(g, "guild created");
  assert.strictEqual(g.treasury, 0);
  assert.strictEqual(g.probonoFund, 0);
  assert.strictEqual(Guilds.guildOf("varrock"), g, "guild retrievable");
  assert.strictEqual(Guilds.guildOf("nowhere"), null, "unknown kingdom -> null");
  unstick();
  console.log("ok - guild creation");
}

function testJoinRequiresRealLawyer() {
  fresh();
  const unCareers = stubCareers({});
  const unCivil = stubCivilLaw({ disputes: {} });
  // Not a lawyer: rejected.
  let r = Guilds.joinGuild("varrock", "Bob");
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "not-a-lawyer");
  // Lawyer by career: accepted.
  unCareers();
  const unCareers2 = stubCareers({ alice: "lawyer" });
  r = Guilds.joinGuild("varrock", "Alice");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.rank, "clerk");
  assert.ok(Guilds.isGuildMember("Alice"));
  assert.strictEqual(Guilds.guildRankOf("Alice"), "clerk");
  // Duplicate join: rejected.
  r = Guilds.joinGuild("varrock", "Alice");
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "already-member");
  unCareers2(); unCivil();
  console.log("ok - join requires real lawyer");
}

function testJoinViaAdvocateHistory() {
  fresh();
  const unCareers = stubCareers({}); // no lawyer career
  const unCivil = stubCivilLaw({
    disputes: {
      d1: { id: "d1", advocates: { plaintiff: { lawyer: "Carol" } } },
    },
  });
  // Carol served as a hired advocate: accepted as a real lawyer.
  const r = Guilds.joinGuild("varrock", "Carol");
  assert.strictEqual(r.ok, true);
  unCareers(); unCivil();
  console.log("ok - join via advocate history");
}

function testDues() {
  fresh();
  const unCareers = stubCareers({ alice: "lawyer" });
  const unCivil = stubCivilLaw({});
  Guilds.joinGuild("varrock", "Alice");
  const before = Guilds.guildOf("varrock").treasury;
  assert.ok(Guilds.recordDuesPayment("Alice", Date.now()));
  const g = Guilds.guildOf("varrock");
  assert.strictEqual(g.treasury, before + (Guilds.DUES_WEEKLY - Guilds.DUES_PROBONO_SHARE));
  assert.strictEqual(g.probonoFund, Guilds.DUES_PROBONO_SHARE);
  // Missed dues -> suspension after 2.
  Guilds.recordMissedDues("Alice", Date.now());
  assert.ok(!Guilds.memberOf("Alice").suspended, "one miss is not suspension");
  Guilds.recordMissedDues("Alice", Date.now());
  assert.ok(Guilds.memberOf("Alice").suspended, "two misses suspend");
  // Paying dues lifts non-disciplinary suspension.
  Guilds.recordDuesPayment("Alice", Date.now());
  assert.ok(!Guilds.memberOf("Alice").suspended, "dues lift dues-suspension");
  unCareers(); unCivil();
  console.log("ok - dues and suspension");
}

function testCodeOfPractice() {
  const code = Guilds.codeOfPractice();
  assert.ok(Array.isArray(code) && code.length >= 5, "code has entries");
  code.push("tampered");
  assert.strictEqual(Guilds.codeOfPractice().length, code.length - 1, "code is a copy");
  console.log("ok - code of practice is read-only");
}

function testCaseReview() {
  fresh();
  const unCareers = stubCareers({ alice: "lawyer" });
  const unCivil = stubCivilLaw({
    needing: [{ disputeId: "d1", party: "plaintiff" }],
    unpaid: [{ id: "j1" }],
    disputes: {},
  });
  Guilds.joinGuild("varrock", "Alice");
  const r = Guilds.conductReview("varrock", "Alice");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.result, "FLAG");
  assert.ok(r.reasons.length >= 2, "unserved + unpaid flagged");
  const g = Guilds.guildOf("varrock");
  assert.strictEqual(g.consecutiveFlags, 1);
  // Clean ledger -> PASS resets flags.
  unCivil();
  const unCivil2 = stubCivilLaw({ needing: [], unpaid: [], disputes: {} });
  const r2 = Guilds.conductReview("varrock", "Alice");
  assert.strictEqual(r2.result, "PASS");
  assert.strictEqual(Guilds.guildOf("varrock").consecutiveFlags, 0);
  const mem = Guilds.memberOf("Alice");
  assert.strictEqual(mem.reviewsConducted, 2, "reviews counted");
  unCareers(); unCivil2();
  console.log("ok - case reviews");
}

function testBacklog() {
  fresh();
  const unCareers = stubCareers({ alice: "lawyer" });
  const needing = [{ disputeId: "d1", party: "p" }, { disputeId: "d2", party: "p" }, { disputeId: "d3", party: "p" }];
  const unCivil = stubCivilLaw({ needing, unpaid: [], disputes: {} });
  Guilds.joinGuild("varrock", "Alice");
  Guilds.conductReview("varrock", "Alice");
  assert.ok(!Guilds.guildOf("varrock").docketBacklogged, "one flag is not backlog");
  Guilds.conductReview("varrock", "Alice");
  assert.ok(Guilds.guildOf("varrock").docketBacklogged, "two flags + 3 unserved = backlogged");
  unCareers(); unCivil();
  console.log("ok - docket backlog");
}

function testProBono() {
  fresh();
  const unCareers = stubCareers({ alice: "lawyer", bob: "lawyer" });
  const unCivil = stubCivilLaw({
    disputes: { d1: { id: "d1", advocates: {} } },
    needing: [],
  });
  const unBank = stubBanking();
  Guilds.joinGuild("varrock", "Alice");
  Guilds.joinGuild("varrock", "Bob");
  // Promote Bob to advocate so he can take the case (bypass via direct rank set for test).
  Guilds.guildOf("varrock").members["bob"].rank = Guilds.RANK_ADVOCATE;
  // Fund the pro bono pool.
  Guilds.guildOf("varrock").probonoFund = 500;

  const f = Guilds.fileProBonoClaim("varrock", "d1", "plaintiff");
  assert.strictEqual(f.ok, true);
  // Duplicate filing rejected.
  assert.strictEqual(Guilds.fileProBonoClaim("varrock", "d1", "plaintiff").ok, false);

  const a = Guilds.assignProBonoAdvocate("varrock", f.claimId, "Bob");
  assert.strictEqual(a.ok, true);
  assert.strictEqual(a.paid, Guilds.PROBONO_FEE);
  assert.strictEqual(a.owed, 0);
  assert.strictEqual(unBank.credited.length, 1);
  assert.strictEqual(unBank.credited[0].u, "Bob");
  assert.strictEqual(unBank.credited[0].amt, Guilds.PROBONO_FEE);
  assert.strictEqual(Guilds.memberOf("Bob").casesHandled, 1);
  unCareers(); unCivil(); unBank.unstick();
  console.log("ok - pro bono assignment and payment");
}

function testProBonoOwed() {
  fresh();
  const unCareers = stubCareers({ bob: "lawyer" });
  const unCivil = stubCivilLaw({ disputes: { d1: { id: "d1", advocates: {} } } });
  const unBank = stubBanking();
  Guilds.joinGuild("varrock", "Bob");
  Guilds.guildOf("varrock").members["bob"].rank = Guilds.RANK_ADVOCATE;
  Guilds.guildOf("varrock").probonoFund = 30; // not enough for the full fee

  const f = Guilds.fileProBonoClaim("varrock", "d1", "plaintiff");
  const a = Guilds.assignProBonoAdvocate("varrock", f.claimId, "Bob");
  assert.strictEqual(a.ok, true);
  assert.strictEqual(a.paid, 30);
  assert.strictEqual(a.owed, Guilds.PROBONO_FEE - 30);
  // Refill and retry.
  Guilds.guildOf("varrock").probonoFund = 1000;
  const repaid = Guilds.retryOwedProBono("varrock");
  assert.strictEqual(repaid, Guilds.PROBONO_FEE - 30);
  const g = Guilds.guildOf("varrock");
  assert.strictEqual(g.probonoClaims[f.claimId].status, "paid");
  unCareers(); unCivil(); unBank.unstick();
  console.log("ok - pro bono owed and retried honestly");
}

function testMisconductOathbreaking() {
  fresh();
  const unCareers = stubCareers({ alice: "lawyer", dave: "lawyer" });
  const unCivil = stubCivilLaw({});
  const unRep = stubReputation({ dave: ["oathbreaker"] });
  Guilds.joinGuild("varrock", "Alice");
  Guilds.joinGuild("varrock", "Dave");
  // Dave carries the oathbreaker deed: verifiable misconduct.
  assert.strictEqual(Guilds.scanMisconduct("Dave"), "oathbreaking");
  assert.strictEqual(Guilds.scanMisconduct("Alice"), null);
  // Promote Alice to counselor so she can vote.
  Guilds.guildOf("varrock").members["alice"].rank = Guilds.RANK_COUNSELOR;
  const r = Guilds.reportMisconduct("varrock", "Dave", "oathbreaking", null, "Alice");
  assert.strictEqual(r.ok, true);
  // Unverifiable report rejected.
  assert.strictEqual(Guilds.reportMisconduct("varrock", "Alice", "oathbreaking", null, "Dave").ok, false);
  // Vote and settle.
  assert.strictEqual(Guilds.voteOnCase("varrock", r.caseId, "Alice", true).ok, true);
  const s = Guilds.settleCase("varrock", r.caseId);
  assert.strictEqual(s.verdict, "guilty");
  assert.ok(!Guilds.isGuildMember("Dave"), "Dave expelled");
  assert.ok(unRep.granted.some((x) => x.u === "Dave" && x.deed === "disbarred"), "disbarred deed granted");
  unCareers(); unCivil(); unRep.unstick();
  console.log("ok - oathbreaking misconduct and expulsion");
}

function testFeeFraud() {
  fresh();
  const unCareers = stubCareers({ alice: "lawyer", erin: "lawyer" });
  const unCivil = stubCivilLaw({ disputes: { d9: { id: "d9", advocates: {} } } });
  Guilds.joinGuild("varrock", "Alice");
  Guilds.joinGuild("varrock", "Erin");
  Guilds.guildOf("varrock").members["alice"].rank = Guilds.RANK_COUNSELOR;
  // Erin has no advocate record on d9: fee-fraud claim is verifiable.
  assert.strictEqual(Guilds.verifyMisconduct("Erin", "fee-fraud", "d9"), true);
  const r = Guilds.reportMisconduct("varrock", "Erin", "fee-fraud", "d9", "Alice");
  assert.strictEqual(r.ok, true);
  // Double jeopardy: second open case for same accused+kind rejected.
  assert.strictEqual(Guilds.reportMisconduct("varrock", "Erin", "fee-fraud", "d9", "Alice").ok, false);
  Guilds.voteOnCase("varrock", r.caseId, "Alice", true);
  const s = Guilds.settleCase("varrock", r.caseId);
  assert.strictEqual(s.verdict, "guilty");
  const mem = Guilds.memberOf("Erin");
  assert.strictEqual(mem.finesOwed, 100, "100-coin fine recorded as owed");
  assert.ok(mem.suspended, "Erin suspended");
  assert.ok(!mem.cleanRecord, "record stained");
  unCareers(); unCivil();
  console.log("ok - fee fraud fine and suspension");
}

function testSchoolAndPromotion() {
  fresh();
  const unCareers = stubCareers({ alice: "lawyer", bob: "lawyer" });
  const unCivil = stubCivilLaw({});
  Guilds.joinGuild("varrock", "Alice");
  Guilds.joinGuild("varrock", "Bob");
  Guilds.guildOf("varrock").members["alice"].rank = Guilds.RANK_COUNSELOR;
  const h = Guilds.holdClass("varrock", "Alice");
  assert.strictEqual(h.ok, true);
  assert.strictEqual(h.taught, 1, "Bob the clerk taught");
  assert.strictEqual(Guilds.memberOf("Bob").trainingCredits, 1);
  // Non-counselor cannot teach.
  assert.strictEqual(Guilds.holdClass("varrock", "Bob").ok, false);
  unCareers(); unCivil();
  console.log("ok - legal school");
}

function testLeave() {
  fresh();
  const unCareers = stubCareers({ alice: "lawyer" });
  const unCivil = stubCivilLaw({});
  Guilds.joinGuild("varrock", "Alice");
  assert.ok(Guilds.leaveGuild("Alice"));
  assert.ok(!Guilds.isGuildMember("Alice"));
  assert.ok(!Guilds.leaveGuild("Alice"), "leaving twice is false");
  unCareers(); unCivil();
  console.log("ok - leave guild");
}

function testDescribe() {
  fresh();
  const unCareers = stubCareers({ alice: "lawyer" });
  const unCivil = stubCivilLaw({});
  Guilds.joinGuild("varrock", "Alice");
  const d = Guilds.describe("varrock");
  assert.strictEqual(d.members, 1);
  assert.strictEqual(d.clerks, 1);
  assert.strictEqual(Guilds.describe("nowhere"), null);
  unCareers(); unCivil();
  console.log("ok - describe");
}

function testPersistence() {
  fresh();
  const unCareers = stubCareers({ alice: "lawyer" });
  const unCivil = stubCivilLaw({});
  Guilds.joinGuild("varrock", "Alice");
  Guilds.guildOf("varrock").treasury = 123;
  assert.ok(Guilds.save(), "save returns true when dirty");
  assert.ok(!Guilds.save(), "save returns false when clean");
  // Reload from disk via a fresh cache.
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const tmp = path.join(os.tmpdir(), `lawguild-test-${Date.now()}.json`);
  Guilds._setSavePathForTests(tmp);
  Guilds.resetForTests();
  Guilds.ensureGuild("varrock");
  Guilds.guildOf("varrock").treasury = 456;
  Guilds.save();
  Guilds.resetForTests();
  Guilds.ensureGuild("varrock"); // loads from tmp
  assert.strictEqual(Guilds.guildOf("varrock").treasury, 456, "round-trip");
  try { fs.unlinkSync(tmp); } catch {}
  Guilds._setSavePathForTests(null);
  unCareers(); unCivil();
  console.log("ok - persistence round-trip");
}

// --- run ---------------------------------------------------------------------

const tests = [
  testGuildCreation,
  testJoinRequiresRealLawyer,
  testJoinViaAdvocateHistory,
  testDues,
  testCodeOfPractice,
  testCaseReview,
  testBacklog,
  testProBono,
  testProBonoOwed,
  testMisconductOathbreaking,
  testFeeFraud,
  testSchoolAndPromotion,
  testLeave,
  testDescribe,
  testPersistence,
];

let passed = 0;
for (const t of tests) {
  try {
    t();
    passed++;
  } catch (e) {
    console.error(`FAIL ${t.name}: ${e.message}`);
    console.error(e.stack.split("\n").slice(0, 4).join("\n"));
    process.exit(1);
  }
}
console.log(`\n${passed}/${tests.length} CitizenLawGuilds tests passed`);
