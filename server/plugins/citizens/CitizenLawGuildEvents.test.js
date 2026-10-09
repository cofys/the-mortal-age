"use strict";

/**
 * CitizenLawGuildEvents.test.js — plain-node tests for the ::lawguild command.
 * CitizenLawGuilds and CitizenSites are stubbed through the require cache.
 * Bots are rejected; every subcommand is exercised.
 */

const assert = require("assert");

const Guilds = require("./lib/CitizenLawGuilds");

function fresh() {
  Guilds.resetForTests();
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  if (!fresh.tmp) {
    fresh.tmp = path.join(os.tmpdir(), `lawguildevents-test-${Date.now()}-${Math.floor(Math.random()*1e6)}.json`);
  }
  Guilds._setSavePathForTests(fresh.tmp);
}

function stubSites() {
  const key = require.resolve("./lib/../brain/CitizenSites");
  const fake = { kingdomIdOf: () => "varrock" };
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

function stubCivilLaw() {
  const key = require.resolve("./lib/CitizenCivilLaw");
  const fake = {
    courthouseFor: () => ({ x: 3200, y: 3200, z: 0 }),
    disputesNeedingAdvocates: () => [],
    unpaidJudgments: () => [],
    disputeById: () => null,
    advocateFor: () => null,
    allDisputes: () => [],
    hireAdvocate: () => ({ ok: true }),
  };
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
// (It only requires CitizenLawGuilds at top level, which is real.)
const { onLawGuildCommand } = require("./CitizenLawGuildEvents");

function run(player, args) {
  player._messages.length = 0;
  onLawGuildCommand(player, args);
  return player._messages.slice();
}

// --- tests -------------------------------------------------------------------

function testBotRejected() {
  fresh();
  const unSites = stubSites();
  const bot = makePlayer("Bot1", 1000, true);
  const msgs = run(bot, ["status"]);
  assert.ok(msgs.some((m) => /citizens work the guild/i.test(m)), "bot rejected");
  unSites();
  console.log("ok - bot rejected");
}

function testStatusNoGuild() {
  fresh();
  const unSites = stubSites();
  const p = makePlayer("Alice", 1000, false);
  const msgs = run(p, ["status"]);
  assert.ok(msgs.some((m) => /no bar association/i.test(m)), "no guild message");
  unSites();
  console.log("ok - status with no guild");
}

function testJoinFlow() {
  fresh();
  const unSites = stubSites();
  const unCareers = stubCareers({ alice: "lawyer" });
  const unCivil = stubCivilLaw();
  const p = makePlayer("Alice", 1000, false);

  let msgs = run(p, ["join"]);
  assert.ok(msgs.some((m) => /welcome to the bar association/i.test(m)), "join welcome");

  msgs = run(p, ["status"]);
  assert.ok(msgs.some((m) => /you are a clerk/i.test(m)), "status shows clerk");

  msgs = run(p, ["leave"]);
  assert.ok(msgs.some((m) => /left the bar association/i.test(m)), "leave confirmed");

  unSites(); unCareers(); unCivil();
  console.log("ok - join/status/leave flow");
}

function testJoinNotLawyer() {
  fresh();
  const unSites = stubSites();
  const unCareers = stubCareers({});
  const unCivil = stubCivilLaw();
  const p = makePlayer("Bob", 1000, false);
  const msgs = run(p, ["join"]);
  assert.ok(msgs.some((m) => /only real lawyers/i.test(m)), "non-lawyer rejected");
  unSites(); unCareers(); unCivil();
  console.log("ok - non-lawyer cannot join");
}

function testDues() {
  fresh();
  const unSites = stubSites();
  const unCareers = stubCareers({ alice: "lawyer" });
  const unCivil = stubCivilLaw();
  const p = makePlayer("Alice", 1000, false);
  run(p, ["join"]);
  const before = p._coins();
  const msgs = run(p, ["dues"]);
  assert.ok(msgs.some((m) => /dues paid/i.test(m)), "dues confirmed");
  assert.strictEqual(p._coins(), before - Guilds.DUES_WEEKLY, "coins taken");

  // Broke player.
  const q = makePlayer("Alice", 5, false);
  // Alice is already a member; use a fresh player object but same username.
  const msgs2 = run(q, ["dues"]);
  assert.ok(msgs2.some((m) => /need \d+ coins/i.test(m)), "broke dues rejected");
  unSites(); unCareers(); unCivil();
  console.log("ok - dues payment");
}

function testCode() {
  fresh();
  const unSites = stubSites();
  const p = makePlayer("Alice", 1000, false);
  const msgs = run(p, ["code"]);
  assert.ok(msgs.length >= 5, "code lines shown");
  unSites();
  console.log("ok - code of practice");
}

function testReviewCounselorOnly() {
  fresh();
  const unSites = stubSites();
  const unCareers = stubCareers({ alice: "lawyer" });
  const unCivil = stubCivilLaw();
  const p = makePlayer("Alice", 1000, false);
  run(p, ["join"]);
  const msgs = run(p, ["review"]);
  assert.ok(msgs.some((m) => /only counselors/i.test(m)), "clerk cannot review");
  unSites(); unCareers(); unCivil();
  console.log("ok - review is counselors-only");
}

function testReportUsage() {
  fresh();
  const unSites = stubSites();
  const p = makePlayer("Alice", 1000, false);
  const msgs = run(p, ["report"]);
  assert.ok(msgs.some((m) => /usage/i.test(m)), "report usage shown");
  unSites();
  console.log("ok - report usage");
}

function testVoteUsage() {
  fresh();
  const unSites = stubSites();
  const p = makePlayer("Alice", 1000, false);
  const msgs = run(p, ["vote"]);
  assert.ok(msgs.some((m) => /usage/i.test(m)), "vote usage shown");
  unSites();
  console.log("ok - vote usage");
}

function testProBono() {
  fresh();
  const unSites = stubSites();
  const unCareers = stubCareers({ alice: "lawyer" });
  const unCivil = stubCivilLaw();
  const p = makePlayer("Alice", 1000, false);
  run(p, ["join"]);
  const msgs = run(p, ["probono"]);
  assert.ok(msgs.some((m) => /pro bono fund/i.test(m)), "pro bono status shown");
  unSites(); unCareers(); unCivil();
  console.log("ok - pro bono status");
}

function testContribute() {
  fresh();
  const unSites = stubSites();
  const unCareers = stubCareers({ alice: "lawyer" });
  const unCivil = stubCivilLaw();
  const p = makePlayer("Alice", 1000, false);
  run(p, ["join"]);
  const before = p._coins();
  const msgs = run(p, ["contribute", "100"]);
  assert.ok(msgs.some((m) => /contributed 100 coins/i.test(m)), "contribution confirmed");
  assert.strictEqual(p._coins(), before - 100, "coins taken");
  const msgs2 = run(p, ["contribute", "0"]);
  assert.ok(msgs2.some((m) => /usage/i.test(m)), "zero contribution rejected");
  unSites(); unCareers(); unCivil();
  console.log("ok - contribute to pro bono fund");
}

function testSchool() {
  fresh();
  const unSites = stubSites();
  const unCareers = stubCareers({ alice: "lawyer" });
  const unCivil = stubCivilLaw();
  const p = makePlayer("Alice", 1000, false);
  let msgs = run(p, ["school"]);
  assert.ok(msgs.some((m) => /not a member/i.test(m)), "non-member school rejected");
  run(p, ["join"]);
  msgs = run(p, ["school"]);
  assert.ok(msgs.some((m) => /training credits/i.test(m)), "school status shown");
  unSites(); unCareers(); unCivil();
  console.log("ok - school");
}

function testUnknownSubcommand() {
  fresh();
  const unSites = stubSites();
  const p = makePlayer("Alice", 1000, false);
  const msgs = run(p, ["frobnicate"]);
  assert.ok(msgs.some((m) => /::lawguild/i.test(m)), "usage shown for unknown");
  unSites();
  console.log("ok - unknown subcommand shows usage");
}

// --- run ---------------------------------------------------------------------

const tests = [
  testBotRejected,
  testStatusNoGuild,
  testJoinFlow,
  testJoinNotLawyer,
  testDues,
  testCode,
  testReviewCounselorOnly,
  testReportUsage,
  testVoteUsage,
  testProBono,
  testContribute,
  testSchool,
  testUnknownSubcommand,
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
console.log(`\n${passed}/${tests.length} CitizenLawGuildEvents tests passed`);
