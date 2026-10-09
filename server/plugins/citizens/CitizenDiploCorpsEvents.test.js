"use strict";

/**
 * CitizenDiploCorpsEvents.test.js — plain-node tests for the ::diploguild command.
 * CitizenDiplomaticCorps and CitizenSites are stubbed through the require cache.
 * Bots are rejected; every subcommand is exercised.
 */

const assert = require("assert");

const Corps = require("./lib/CitizenDiplomaticCorps");

function fresh() {
  Corps.resetForTests();
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  if (!fresh.tmp) {
    fresh.tmp = path.join(os.tmpdir(), `diplocorpsevents-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`);
  }
  Corps._setSavePathForTests(fresh.tmp);
}

function stubSites() {
  const key = require.resolve("./lib/../brain/CitizenSites");
  const fake = { kingdomIdOf: () => "misthalin" };
  require.cache[key] = { id: key, filename: key, loaded: true, exports: fake };
  return () => { delete require.cache[key]; };
}

function stubCareers(careerMap) {
  const key = require.resolve("./lib/CitizenCareers");
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

function stubDiplomats() {
  const key = require.resolve("./lib/CitizenDiplomats");
  const fake = { isDiplomat: () => true, diplomatStatus: () => [] };
  require.cache[key] = { id: key, filename: key, loaded: true, exports: fake };
  return () => { delete require.cache[key]; };
}

function stubTension(tensions) {
  const key = require.resolve("./lib/../../kingdoms/Tension.Kingdoms");
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

function stubTreaties() {
  const key = require.resolve("./lib/CitizenTreaties");
  const fake = { embassyPair: () => null, treatyBetween: () => null, atWar: () => false };
  require.cache[key] = { id: key, filename: key, loaded: true, exports: fake };
  return () => { delete require.cache[key]; };
}

function stubBanking() {
  const key = require.resolve("./lib/CitizenBanking");
  const fake = { creditAccount: () => {} };
  require.cache[key] = { id: key, filename: key, loaded: true, exports: fake };
  return () => { delete require.cache[key]; };
}

function stubEspionage() {
  const key = require.resolve("./lib/CitizenEspionage");
  const fake = { cellFor: () => null };
  require.cache[key] = { id: key, filename: key, loaded: true, exports: fake };
  return () => { delete require.cache[key]; };
}

function makePlayer(username, coins, isBot) {
  const messages = [];
  const inv = {
    _coins: coins,
    getAmount: (id) => (id === 995 ? inv._coins : 0),
    remove: (id, amt) => { if (id === 995) inv._coins = Math.max(0, inv._coins - amt); },
  };
  return {
    getUsername: () => username,
    username,
    isBot: !!isBot,
    isRealPlayer: () => !isBot,
    getInventory: () => inv,
    sendMessage: (t) => messages.push(t),
    _messages: messages,
    _coins: () => inv._coins,
  };
}

// Require the events module AFTER stubs that it needs at load time are in place.
// (It only requires CitizenDiplomaticCorps at top level, which is real.)
const { onDiploCorpsCommand } = require("./CitizenDiploCorpsEvents");

function run(player, args) {
  player._messages.length = 0;
  onDiploCorpsCommand(player, args);
  return player._messages.slice();
}

// --- tests -------------------------------------------------------------------

function testBotRejected() {
  fresh();
  const un = [stubSites(), stubCareers({}), stubDiplomats(), stubTension({}), stubTreaties()];
  const bot = makePlayer("Bot", 1000, true);
  const msgs = run(bot, ["status"]);
  assert.ok(msgs.some((m) => m.includes("Citizens work the corps")), "bots rejected");
  cleanup(...un);
}

function cleanup(...fns) { for (const f of fns) { try { f(); } catch {} } }

function testStatus() {
  fresh();
  const un = [stubSites(), stubCareers({}), stubDiplomats(), stubTension({}), stubTreaties()];
  const p = makePlayer("Alice", 1000, false);
  // Before the life tick ensures the corps, status is honest about absence.
  let msgs = run(p, ["status"]);
  assert.ok(msgs.some((m) => m.includes("No diplomatic corps here yet")), "honest absence");
  Corps.ensureCorps("misthalin");
  msgs = run(p, ["status"]);
  assert.ok(msgs.some((m) => m.includes("Diplomatic corps of misthalin")), "status names the corps");
  cleanup(...un);
}

function testJoinGating() {
  fresh();
  const un = [stubSites(), stubCareers({ alice: "ambassador", bob: "chef" }), stubDiplomats(),
    stubTension({}), stubTreaties()];
  let msgs = run(makePlayer("Alice", 1000, false), ["join"]);
  assert.ok(msgs.some((m) => m.includes("Welcome to the diplomatic corps")), "diplomat joins");
  msgs = run(makePlayer("Bob", 1000, false), ["join"]);
  assert.ok(msgs.some((m) => m.includes("Only real diplomats")), "non-diplomat rejected");
  cleanup(...un);
}

function testLeave() {
  fresh();
  const un = [stubSites(), stubCareers({ alice: "ambassador" }), stubDiplomats(),
    stubTension({}), stubTreaties()];
  run(makePlayer("Alice", 1000, false), ["join"]);
  const msgs = run(makePlayer("Alice", 1000, false), ["leave"]);
  assert.ok(msgs.some((m) => m.includes("left the diplomatic corps")), "leave works");
  cleanup(...un);
}

function testDues() {
  fresh();
  const un = [stubSites(), stubCareers({ alice: "ambassador" }), stubDiplomats(),
    stubTension({}), stubTreaties()];
  run(makePlayer("Alice", 1000, false), ["join"]);
  const p = makePlayer("Alice", 1000, false);
  const msgs = run(p, ["dues"]);
  assert.ok(msgs.some((m) => m.includes("Dues paid")), "dues accepted");
  assert.strictEqual(p._coins(), 1000 - Corps.DUES_WEEKLY, "coins taken");
  cleanup(...un);
}

function testDuesBroke() {
  fresh();
  const un = [stubSites(), stubCareers({ alice: "ambassador" }), stubDiplomats(),
    stubTension({}), stubTreaties()];
  run(makePlayer("Alice", 1000, false), ["join"]);
  const msgs = run(makePlayer("Alice", 5, false), ["dues"]);
  assert.ok(msgs.some((m) => m.includes("need")), "broke member told the price");
  cleanup(...un);
}

function testProtocol() {
  fresh();
  const un = [stubSites(), stubCareers({}), stubDiplomats(), stubTension({}), stubTreaties()];
  const msgs = run(makePlayer("Alice", 1000, false), ["protocol"]);
  assert.ok(msgs.length === 6, "code header + five points");
  cleanup(...un);
}

function testReviewAmbassadorsOnly() {
  fresh();
  const un = [stubSites(), stubCareers({ alice: "ambassador" }), stubDiplomats(),
    stubTension({}), stubTreaties()];
  run(makePlayer("Alice", 1000, false), ["join"]);
  const msgs = run(makePlayer("Alice", 1000, false), ["review"]);
  assert.ok(msgs.some((m) => m.includes("Only ambassadors")), "envoys cannot review");
  cleanup(...un);
}

function testMediateAmbassadorsOnly() {
  fresh();
  const un = [stubSites(), stubCareers({ alice: "ambassador" }), stubDiplomats(),
    stubTension({}), stubTreaties()];
  run(makePlayer("Alice", 1000, false), ["join"]);
  const msgs = run(makePlayer("Alice", 1000, false), ["mediate", "kandarin"]);
  assert.ok(msgs.some((m) => m.includes("Only ambassadors")), "envoys cannot mediate");
  cleanup(...un);
}

function testMediateFlow() {
  fresh();
  const tensions = { "kandarin:misthalin": 80 };
  const un = [stubSites(), stubCareers({ alice: "ambassador" }), stubDiplomats(),
    stubTension(tensions), stubTreaties(), stubBanking()];
  run(makePlayer("Alice", 1000, false), ["join"]);
  const g = Corps.corpsOf("misthalin");
  g.members["alice"].rank = Corps.RANK_AMBASSADOR;
  g.mediationFund = 1000;
  const msgs = run(makePlayer("Alice", 1000, false), ["mediate", "kandarin"]);
  assert.ok(msgs.some((m) => m.includes("Mediation with kandarin complete")), "mediation completes");
  assert.strictEqual(tensions["kandarin:misthalin"], 80 - Corps.MEDIATION_TENSION_DROP, "tension cooled");
  cleanup(...un);
}

function testMediateCalmBorder() {
  fresh();
  const un = [stubSites(), stubCareers({ alice: "ambassador" }), stubDiplomats(),
    stubTension({}), stubTreaties(), stubBanking()];
  run(makePlayer("Alice", 1000, false), ["join"]);
  Corps.corpsOf("misthalin").members["alice"].rank = Corps.RANK_AMBASSADOR;
  const msgs = run(makePlayer("Alice", 1000, false), ["mediate", "kandarin"]);
  assert.ok(msgs.some((m) => m.includes("not hot enough")), "calm border rejected");
  cleanup(...un);
}

function testReportUsage() {
  fresh();
  const un = [stubSites(), stubCareers({}), stubDiplomats(), stubTension({}), stubTreaties()];
  const msgs = run(makePlayer("Alice", 1000, false), ["report"]);
  assert.ok(msgs.some((m) => m.includes("Usage")), "usage shown");
  cleanup(...un);
}

function testReportUnverifiable() {
  fresh();
  const un = [stubSites(), stubCareers({}), stubDiplomats(), stubTension({}), stubTreaties(),
    stubEspionage()];
  const msgs = run(makePlayer("Alice", 1000, false), ["report", "Bob"]);
  assert.ok(msgs.some((m) => m.includes("unverifiable")), "no case without a real spy cell");
  cleanup(...un);
}

function testContribute() {
  fresh();
  const un = [stubSites(), stubCareers({}), stubDiplomats(), stubTension({}), stubTreaties()];
  const p = makePlayer("Alice", 1000, false);
  const msgs = run(p, ["contribute", "200"]);
  assert.ok(msgs.some((m) => m.includes("Contributed 200")), "contribution works");
  assert.strictEqual(p._coins(), 800, "coins taken");
  assert.strictEqual(Corps.corpsOf("misthalin").mediationFund, 200, "fund credited");
  cleanup(...un);
}

function testContributeUsage() {
  fresh();
  const un = [stubSites(), stubCareers({}), stubDiplomats(), stubTension({}), stubTreaties()];
  const msgs = run(makePlayer("Alice", 1000, false), ["contribute", "0"]);
  assert.ok(msgs.some((m) => m.includes("Usage")), "usage shown");
  cleanup(...un);
}

function testUnknownSub() {
  fresh();
  const un = [stubSites(), stubCareers({}), stubDiplomats(), stubTension({}), stubTreaties()];
  const msgs = run(makePlayer("Alice", 1000, false), ["frobnicate"]);
  assert.ok(msgs.some((m) => m.includes("::diploguild")), "usage shown for unknown subcommand");
  cleanup(...un);
}

const tests = [
  testBotRejected,
  testStatus,
  testJoinGating,
  testLeave,
  testDues,
  testDuesBroke,
  testProtocol,
  testReviewAmbassadorsOnly,
  testMediateAmbassadorsOnly,
  testMediateFlow,
  testMediateCalmBorder,
  testReportUsage,
  testReportUnverifiable,
  testContribute,
  testContributeUsage,
  testUnknownSub,
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
console.log(`\n${passed}/${tests.length} CitizenDiploCorpsEvents tests passed`);
