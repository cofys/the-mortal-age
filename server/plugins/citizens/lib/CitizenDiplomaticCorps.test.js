"use strict";

/**
 * CitizenDiplomaticCorps.test.js — plain-node tests for the diplomatic corps.
 * No jest, no engine. CitizenCareers, CitizenDiplomats, CitizenTreaties,
 * Tension, CitizenBanking, CitizenEspionage, CitizenReputation, CitizenSites
 * are stubbed through the require cache.
 */

const assert = require("assert");

const Corps = require("./CitizenDiplomaticCorps");

function fresh() {
  Corps.resetForTests();
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  if (!fresh.tmp) {
    fresh.tmp = path.join(os.tmpdir(), `diplocorps-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`);
  }
  Corps._setSavePathForTests(fresh.tmp);
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

function stubDiplomats(missionLines) {
  const key = require.resolve("./CitizenDiplomats");
  const fake = {
    isDiplomat: (u) => String(u || "").trim().toLowerCase() !== "judgebob",
    diplomatStatus: () => (missionLines || []).slice(),
  };
  require.cache[key] = { id: key, filename: key, loaded: true, exports: fake };
  return () => { delete require.cache[key]; };
}

function stubSites() {
  const key = require.resolve("../brain/CitizenSites");
  const fake = {
    KINGDOM_IDS: ["misthalin", "kandarin", "asgarnia"],
    siteTileByKingdom: (kid, kind) => ({ x: 3200, y: 3200, z: 0 }),
  };
  require.cache[key] = { id: key, filename: key, loaded: true, exports: fake };
  return () => { delete require.cache[key]; };
}

function stubTension(tensions) {
  const key = require.resolve("../../kingdoms/Tension.Kingdoms");
  const fake = {
    getTension: (a, b) => {
      const k = [String(a), String(b)].sort().join(":");
      const v = (tensions || {})[k];
      return typeof v === "number" ? v : 50;
    },
    setTension: (a, b, v) => {
      const k = [String(a), String(b)].sort().join(":");
      (tensions || {})[k] = v;
    },
  };
  require.cache[key] = { id: key, filename: key, loaded: true, exports: fake };
  return () => { delete require.cache[key]; };
}

function stubTreaties(ledger) {
  const key = require.resolve("./CitizenTreaties");
  const fake = {
    embassyPair: (a, b) => ((ledger.embassies || {})[[a, b].sort().join(":")] ? { a, b } : null),
    treatyBetween: (a, b) => (ledger.treaties || {})[[a, b].sort().join(":")] || null,
    atWar: (a, b) => !!((ledger.wars || {})[[a, b].sort().join(":")]),
  };
  require.cache[key] = { id: key, filename: key, loaded: true, exports: fake };
  return () => { delete require.cache[key]; };
}

function stubBanking() {
  const key = require.resolve("./CitizenBanking");
  const fake = {
    creditAccount: (u, amt) => { fake.credits = fake.credits || []; fake.credits.push({ u, amt }); },
  };
  require.cache[key] = { id: key, filename: key, loaded: true, exports: fake };
  return () => { delete require.cache[key]; };
}

function stubEspionage(spies) {
  const key = require.resolve("./CitizenEspionage");
  const fake = {
    cellFor: (u) => {
      const n = String(u || "").trim().toLowerCase();
      return (spies || []).includes(n) ? { spy: u, targetKingdom: "kandarin" } : null;
    },
  };
  require.cache[key] = { id: key, filename: key, loaded: true, exports: fake };
  return () => { delete require.cache[key]; };
}

function stubReputation() {
  const key = require.resolve("./CitizenReputation");
  const fake = { grantDeed: (u, deed) => { fake.deeds = fake.deeds || []; fake.deeds.push({ u, deed }); } };
  require.cache[key] = { id: key, filename: key, loaded: true, exports: fake };
  return () => { delete require.cache[key]; };
}

function cleanup(...fns) { for (const f of fns) { try { f(); } catch {} } }

// --- tests -------------------------------------------------------------------

function testCorpsAndHall() {
  fresh();
  const un = [stubSites()];
  const g = Corps.ensureCorps("misthalin");
  assert.ok(g, "corps created");
  assert.strictEqual(Corps.corpsOf("misthalin"), g);
  const tile = Corps.hallTileFor("misthalin");
  assert.ok(tile && typeof tile.x === "number", "hall tile near court anchor");
  cleanup(...un);
}

function testJoinGating() {
  fresh();
  const un = [stubCareers({ alice: "ambassador", bob: "chef" }), stubDiplomats([])];
  let r = Corps.joinGuild("misthalin", "Alice");
  assert.ok(r.ok && r.rank === "envoy", "ambassador-career citizen joins as envoy");
  r = Corps.joinGuild("misthalin", "Bob");
  assert.ok(!r.ok && r.reason === "not-a-diplomat", "non-diplomat rejected");
  cleanup(...un);
}

function testJoinViaMission() {
  fresh();
  const un = [stubCareers({}), stubDiplomats(["carol (negotiator) of Misthalin: negotiating — trade with Kandarin."])];
  const r = Corps.joinGuild("misthalin", "Carol");
  assert.ok(r.ok, "mission-serving citizen joins");
  cleanup(...un);
}

function testJoinJudgeExcluded() {
  fresh();
  const un = [stubCareers({}), stubDiplomats(["judgebob (negotiator) of Misthalin: negotiating — trade with Kandarin."])];
  const r = Corps.joinGuild("misthalin", "judgebob");
  assert.ok(!r.ok, "judge-claimed courtier excluded from real-diplomat check");
  cleanup(...un);
}

function testDuesHonesty() {
  fresh();
  const un = [stubCareers({ alice: "ambassador" }), stubDiplomats([])];
  Corps.joinGuild("misthalin", "Alice");
  assert.ok(Corps.recordDuesPayment("Alice"), "dues payment records");
  const g = Corps.corpsOf("misthalin");
  assert.strictEqual(g.treasury, Corps.DUES_WEEKLY - Corps.DUES_MEDIATION_SHARE, "treasury share");
  assert.strictEqual(g.mediationFund, Corps.DUES_MEDIATION_SHARE, "mediation share");
  Corps.recordMissedDues("Alice");
  Corps.recordMissedDues("Alice");
  assert.ok(Corps.memberOf("Alice").suspended, "suspended after 2 missed");
  Corps.recordDuesPayment("Alice");
  assert.ok(!Corps.memberOf("Alice").suspended, "payment lifts suspension");
  cleanup(...un);
}

function testProtocolCode() {
  const code = Corps.protocolCode();
  assert.ok(Array.isArray(code) && code.length === 5, "five-point protocol code");
  code.push("tampered");
  assert.strictEqual(Corps.protocolCode().length, 5, "code is immutable");
}

function testReviewPass() {
  fresh();
  const un = [stubSites(), stubTension({}), stubTreaties({})];
  const r = Corps.conductReview("misthalin", null);
  assert.ok(r.ok && r.result === "PASS", "calm borders pass");
  assert.strictEqual(Corps.corpsOf("misthalin").crisis, false);
  cleanup(...un);
}

function testReviewFlagAndCrisis() {
  fresh();
  const tensions = { "asgarnia:misthalin": 80, "kandarin:misthalin": 75 };
  const un = [stubSites(), stubTension(tensions), stubTreaties({})];
  let r = Corps.conductReview("misthalin", null);
  assert.ok(r.ok && r.result === "FLAG", "hot borders flag");
  assert.strictEqual(r.hotBorders, 2, "two hot borders");
  assert.ok(r.reasons.some((x) => x.includes("no standing embassy")), "embassy gap reported");
  assert.strictEqual(Corps.corpsOf("misthalin").crisis, false, "one flag is not crisis");
  r = Corps.conductReview("misthalin", null);
  assert.ok(Corps.corpsOf("misthalin").crisis, "two consecutive flags with 2+ hot borders = crisis");
  cleanup(...un);
}

function testMediationFlow() {
  fresh();
  const tensions = { "asgarnia:misthalin": 80 };
  const un = [stubSites(), stubTension(tensions), stubTreaties({}), stubBanking(),
    stubCareers({ diana: "ambassador" }), stubDiplomats([]), stubReputation()];
  Corps.joinGuild("misthalin", "Diana");
  const g = Corps.corpsOf("misthalin");
  g.mediationFund = 1000;
  const filed = Corps.fileMediationClaim("misthalin", "asgarnia");
  assert.ok(filed.ok, "claim filed for hot border");
  // Promote diana to ambassador rank for assignment (bypass tenure via direct rank set)
  g.members["diana"].rank = Corps.RANK_AMBASSADOR;
  const res = Corps.assignMediation("misthalin", filed.claimId, "Diana");
  assert.ok(res.ok, "mediation assigned");
  assert.strictEqual(res.tensionBefore, 80, "tension before");
  assert.strictEqual(res.tensionAfter, 80 - Corps.MEDIATION_TENSION_DROP, "tension cooled");
  assert.strictEqual(res.paid, Corps.MEDIATION_FEE, "fee paid");
  assert.strictEqual(tensions["asgarnia:misthalin"], 80 - Corps.MEDIATION_TENSION_DROP, "tension actually written");
  const bKey = require.resolve("./CitizenBanking");
  assert.ok(require.cache[bKey].exports.credits.some((c) => c.u === "Diana" && c.amt === Corps.MEDIATION_FEE),
    "fee credited to mediator's bank account");
  assert.strictEqual(g.members["diana"].mediationsLed, 1, "mediation counted");
  cleanup(...un);
}

function testMediationHonesty() {
  fresh();
  const tensions = { "asgarnia:misthalin": 30 }; // not hot
  const un = [stubSites(), stubTension(tensions), stubTreaties({}),
    stubCareers({ diana: "ambassador" }), stubDiplomats([])];
  Corps.joinGuild("misthalin", "Diana");
  const r = Corps.fileMediationClaim("misthalin", "asgarnia");
  assert.ok(!r.ok && r.reason === "border-not-hot", "calm border rejected");
  cleanup(...un);
}

function testMediationAtWar() {
  fresh();
  const tensions = { "asgarnia:misthalin": 90 };
  const un = [stubSites(), stubTension(tensions), stubTreaties({ wars: { "asgarnia:misthalin": true } }),
    stubCareers({ diana: "ambassador" }), stubDiplomats([])];
  Corps.joinGuild("misthalin", "Diana");
  const r = Corps.fileMediationClaim("misthalin", "asgarnia");
  assert.ok(!r.ok && r.reason === "at-war", "war border rejected");
  cleanup(...un);
}

function testMediationOwedRetry() {
  fresh();
  const tensions = { "asgarnia:misthalin": 80 };
  const un = [stubSites(), stubTension(tensions), stubTreaties({}), stubBanking(),
    stubCareers({ diana: "ambassador" }), stubDiplomats([])];
  Corps.joinGuild("misthalin", "Diana");
  const g = Corps.corpsOf("misthalin");
  g.mediationFund = 50; // broke fund
  g.members["diana"].rank = Corps.RANK_AMBASSADOR;
  const filed = Corps.fileMediationClaim("misthalin", "asgarnia");
  const res = Corps.assignMediation("misthalin", filed.claimId, "Diana");
  assert.ok(res.ok && res.owed > 0, "owed honestly when fund dry");
  assert.strictEqual(g.mediationClaims[filed.claimId].status, "owed");
  g.mediationFund = 500;
  const retried = Corps.retryOwedMediation("misthalin");
  assert.ok(retried > 0, "owed fee retried");
  assert.strictEqual(g.mediationClaims[filed.claimId].status, "paid", "claim paid after refill");
  cleanup(...un);
}

function testContribute() {
  fresh();
  const r = Corps.contributeMediation("misthalin", "Patron", 120);
  assert.ok(r.ok && r.contributed === 120, "contribution recorded");
  assert.strictEqual(Corps.corpsOf("misthalin").mediationFund, 120);
}

function testTreasonTribunal() {
  fresh();
  const un = [stubCareers({ spy: "ambassador", master: "ambassador" }), stubDiplomats([]), stubEspionage(["spy"]),
    stubReputation()];
  Corps.joinGuild("misthalin", "Spy");
  Corps.joinGuild("misthalin", "Master");
  const g = Corps.corpsOf("misthalin");
  g.members["master"].rank = Corps.RANK_AMBASSADOR;
  const rep = Corps.reportMisconduct("misthalin", "Spy", "treason", "Master");
  assert.ok(rep.ok, "treason case opened for active spy cell");
  const dup = Corps.reportMisconduct("misthalin", "Spy", "treason", "Master");
  assert.ok(!dup.ok && dup.reason === "already-open", "no double jeopardy");
  assert.ok(Corps.voteOnCase("misthalin", rep.caseId, "Master", true).ok, "ambassador votes");
  const s = Corps.settleCase("misthalin", rep.caseId);
  assert.ok(s.ok && s.verdict === "guilty", "guilty verdict");
  assert.ok(!Corps.isGuildMember("Spy"), "traitor expelled");
  const bKey = require.resolve("./CitizenReputation");
  assert.ok(require.cache[bKey].exports.deeds.some((d) => d.deed === "traitor"), "traitor deed granted");
  cleanup(...un);
}

function testTreasonUnverifiable() {
  fresh();
  const un = [stubCareers({ alice: "ambassador" }), stubDiplomats([]), stubEspionage([])];
  Corps.joinGuild("misthalin", "Alice");
  const r = Corps.reportMisconduct("misthalin", "Alice", "treason", "corps");
  assert.ok(!r.ok && r.reason === "unverifiable", "no case without a real spy cell");
  cleanup(...un);
}

function testSchoolAndPromotion() {
  fresh();
  const un = [stubCareers({ master: "ambassador", envoy: "ambassador" }), stubDiplomats([]), stubReputation()];
  Corps.joinGuild("misthalin", "Master");
  Corps.joinGuild("misthalin", "Envoy");
  const g = Corps.corpsOf("misthalin");
  g.members["master"].rank = Corps.RANK_AMBASSADOR;
  const c = Corps.holdClass("misthalin", "Master");
  assert.ok(c.ok && c.taught === 1, "class taught to envoy");
  assert.strictEqual(g.members["envoy"].trainingCredits, 1, "credit granted");
  // Promotion requires tenure — backdate.
  g.members["envoy"].joinedAtMs = Date.now() - 31 * 24 * 60 * 60 * 1000;
  g.members["envoy"].trainingCredits = 2;
  g.members["envoy"].mediationsLed = 1;
  const p = Corps.tryPromote("Envoy");
  assert.ok(p.ok && p.rank === Corps.RANK_NEGOTIATOR, "promoted to negotiator");
  cleanup(...un);
}

function testLeaveAndDescribe() {
  fresh();
  const un = [stubCareers({ alice: "ambassador" }), stubDiplomats([])];
  Corps.joinGuild("misthalin", "Alice");
  const d = Corps.describe("misthalin");
  assert.strictEqual(d.members, 1, "describe counts members");
  assert.ok(Corps.leaveGuild("Alice"), "leave works");
  assert.ok(!Corps.isGuildMember("Alice"), "no longer a member");
  cleanup(...un);
}

function testPersistence() {
  fresh();
  const un = [stubCareers({ alice: "ambassador" }), stubDiplomats([])];
  Corps.joinGuild("misthalin", "Alice");
  Corps.recordDuesPayment("Alice");
  assert.ok(Corps.save(), "save writes when dirty");
  Corps.resetForTests();
  Corps._setSavePathForTests(fresh.tmp);
  const m = Corps.memberOf("Alice");
  assert.ok(m && m.rank === "envoy", "member persisted");
  cleanup(...un);
}

const tests = [
  testCorpsAndHall,
  testJoinGating,
  testJoinViaMission,
  testJoinJudgeExcluded,
  testDuesHonesty,
  testProtocolCode,
  testReviewPass,
  testReviewFlagAndCrisis,
  testMediationFlow,
  testMediationHonesty,
  testMediationAtWar,
  testMediationOwedRetry,
  testContribute,
  testTreasonTribunal,
  testTreasonUnverifiable,
  testSchoolAndPromotion,
  testLeaveAndDescribe,
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
console.log(`\n${passed}/${tests.length} CitizenDiplomaticCorps tests passed`);
