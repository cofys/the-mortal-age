"use strict";

/**
 * CitizenSpyGuildEvents.test.js — plain-node tests for the ::spyguild command.
 * CitizenSpyGuilds and CitizenSites are stubbed through the require cache.
 * Bots are rejected; every subcommand is exercised.
 */

const assert = require("assert");

const Guilds = require("./lib/CitizenSpyGuilds");
const { onSpyGuildCommand } = require("./CitizenSpyGuildEvents");

function fresh() {
  Guilds.resetForTests();
  const os = require("os");
  const path = require("path");
  if (!fresh.tmp) {
    fresh.tmp = path.join(os.tmpdir(), `spyguildevents-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`);
  }
  Guilds._setSavePathForTests(fresh.tmp);
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

function stubEspionage() {
  const key = require.resolve("./lib/CitizenEspionage");
  const fake = {
    networkFor: () => null,
    cellFor: () => null,
    cellsIn: () => [],
    counterAgentsOf: () => [],
    isHandler: () => false,
    interrogate: ({ spy, by }) => [`op-${spy}-${by}`],
    interrogationsOf: () => [],
  };
  require.cache[key] = { id: key, filename: key, loaded: true, exports: fake };
  return () => { delete require.cache[key]; };
}

function stubBanking() {
  const key = require.resolve("./lib/CitizenBanking");
  const fake = { creditAccount: () => ({ ok: true }) };
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

function run(player, args) {
  onSpyGuildCommand(player, args);
  return player._messages;
}

function cleanup(...uns) {
  for (const u of uns) { try { u(); } catch { /* cleaned */ } }
}

// --- tests -------------------------------------------------------------------

function testBotRejected() {
  fresh();
  const un = [stubSites(), stubCareers({}), stubEspionage()];
  const bot = makePlayer("Bot", 1000, true);
  const msgs = run(bot, ["status"]);
  assert.ok(msgs.some((m) => m.includes("Citizens work the shadow guild")), "bot rejected");
  cleanup(...un);
}

function testJoinAndStatus() {
  fresh();
  const un = [stubSites(), stubCareers({ alice: "spymaster" }), stubEspionage()];
  let msgs = run(makePlayer("Alice", 1000, false), ["join"]);
  assert.ok(msgs.some((m) => m.includes("Welcome to the shadows")), "join works: " + msgs.join("|"));
  msgs = run(makePlayer("Alice", 1000, false), ["status"]);
  assert.ok(msgs.some((m) => m.includes("Shadow guild of misthalin")), "status shows guild");
  assert.ok(msgs.some((m) => m.includes("operative")), "rank shown");
  // Non-spy cannot join.
  msgs = run(makePlayer("Bob", 1000, false), ["join"]);
  assert.ok(msgs.some((m) => m.includes("Only real spies")), "non-spy rejected: " + msgs.join("|"));
  cleanup(...un);
}

function testLeave() {
  fresh();
  const un = [stubSites(), stubCareers({ alice: "spymaster" }), stubEspionage()];
  run(makePlayer("Alice", 1000, false), ["join"]);
  let msgs = run(makePlayer("Alice", 1000, false), ["leave"]);
  assert.ok(msgs.some((m) => m.includes("left the shadow guild")), "leave works");
  msgs = run(makePlayer("Nobody", 1000, false), ["leave"]);
  assert.ok(msgs.some((m) => m.includes("not a member")), "non-member leave honest");
  cleanup(...un);
}

function testDues() {
  fresh();
  const un = [stubSites(), stubCareers({ alice: "spymaster" }), stubEspionage()];
  run(makePlayer("Alice", 1000, false), ["join"]);
  const p = makePlayer("Alice", 1000, false);
  const msgs = run(p, ["dues"]);
  assert.ok(msgs.some((m) => m.includes("Dues paid")), "dues paid");
  assert.strictEqual(p._coins(), 1000 - Guilds.DUES_WEEKLY, "coins taken");
  const broke = makePlayer("Broke", 0, false);
  const msgs2 = run(broke, ["join"]); // not a spy — need career; skip
  void msgs2;
  cleanup(...un);
}

function testCode() {
  fresh();
  const un = [stubSites(), stubCareers({}), stubEspionage()];
  const msgs = run(makePlayer("Alice", 1000, false), ["code"]);
  assert.ok(msgs.some((m) => m.includes("tradecraft code")), "code header shown");
  assert.ok(msgs.some((m) => m.includes("Discretion")), "first tenet shown");
  cleanup(...un);
}

function testDrops() {
  fresh();
  const un = [stubSites(), stubCareers({ alice: "spymaster", bob: "spymaster" }), stubEspionage()];
  run(makePlayer("Alice", 1000, false), ["join"]);
  run(makePlayer("Bob", 1000, false), ["join"]);
  let msgs = run(makePlayer("Alice", 1000, false), ["drop", "Bob", "the", "raven", "flies"]);
  assert.ok(msgs.some((m) => m.includes("Sealed drop left")), "drop left: " + msgs.join("|"));
  msgs = run(makePlayer("Bob", 1000, false), ["drops"]);
  assert.ok(msgs.some((m) => m.includes("raven flies")), "drop readable by recipient");
  // Missing args -> usage.
  msgs = run(makePlayer("Alice", 1000, false), ["drop"]);
  assert.ok(msgs.some((m) => m.includes("Usage")), "drop usage shown");
  // Drop to outsider -> honest failure.
  msgs = run(makePlayer("Alice", 1000, false), ["drop", "Stranger", "hello"]);
  assert.ok(msgs.some((m) => m.includes("not a member in good standing")), "outsider drop rejected");
  cleanup(...un);
}

function testSanctuary() {
  fresh();
  const un = [stubSites(), stubCareers({ alice: "spymaster" }), stubEspionage()];
  run(makePlayer("Alice", 1000, false), ["join"]);
  const p = makePlayer("Alice", 1000, false);
  const msgs = run(p, ["sanctuary"]);
  assert.ok(msgs.some((m) => m.includes("safe house")), "sanctuary granted");
  assert.strictEqual(p._coins(), 1000 - Guilds.SANCTUARY_COST, "sanctuary fee taken");
  // Broke player -> honest failure.
  const broke = makePlayer("Broke2", 10, false);
  const msgs2 = run(broke, ["sanctuary"]);
  assert.ok(msgs2.some((m) => m.includes("costs")), "broke sanctuary honest");
  cleanup(...un);
}

function testInterrogate() {
  fresh();
  const un = [stubSites(), stubCareers({ alice: "spymaster", bob: "spymaster" }), stubEspionage(), stubBanking()];
  run(makePlayer("Alice", 1000, false), ["join"]);
  run(makePlayer("Bob", 1000, false), ["join"]);
  Guilds.guildOf("misthalin").members["alice"].rank = Guilds.RANK_SPYMASTER;
  Guilds.guildOf("misthalin").tradecraftFund = 500;
  let msgs = run(makePlayer("Alice", 1000, false), ["interrogate", "CaughtSpy"]);
  assert.ok(msgs.some((m) => m.includes("Interrogation complete")), "interrogation runs: " + msgs.join("|"));
  // Operative cannot interrogate.
  msgs = run(makePlayer("Bob", 1000, false), ["interrogate", "CaughtSpy"]);
  assert.ok(msgs.some((m) => m.includes("Only spymasters")), "operative blocked");
  cleanup(...un);
}

function testReportAndCases() {
  fresh();
  const un = [stubSites(), stubCareers({ alice: "spymaster" }), stubEspionage()];
  run(makePlayer("Alice", 1000, false), ["join"]);
  // No verifiable mole -> honest rejection.
  let msgs = run(makePlayer("Alice", 1000, false), ["report", "Bob"]);
  assert.ok(msgs.some((m) => m.includes("unverifiable") || m.includes("Could not open")), "unverifiable report rejected");
  msgs = run(makePlayer("Alice", 1000, false), ["cases"]);
  assert.ok(msgs.some((m) => m.includes("No open mole cases")), "no cases listed");
  cleanup(...un);
}

function testVoteValidation() {
  fresh();
  const un = [stubSites(), stubCareers({ alice: "spymaster" }), stubEspionage()];
  run(makePlayer("Alice", 1000, false), ["join"]);
  let msgs = run(makePlayer("Alice", 1000, false), ["vote", "nope", "guilty"]);
  assert.ok(msgs.some((m) => m.includes("Could not vote")), "bad case id honest");
  msgs = run(makePlayer("Alice", 1000, false), ["vote"]);
  assert.ok(msgs.some((m) => m.includes("Usage")), "vote usage shown");
  cleanup(...un);
}

function testContribute() {
  fresh();
  const un = [stubSites(), stubCareers({ alice: "spymaster" }), stubEspionage()];
  run(makePlayer("Alice", 1000, false), ["join"]);
  const p = makePlayer("Alice", 1000, false);
  const msgs = run(p, ["contribute", "200"]);
  assert.ok(msgs.some((m) => m.includes("Contributed 200")), "contribution works");
  assert.strictEqual(p._coins(), 800, "coins taken");
  cleanup(...un);
}

function testSchool() {
  fresh();
  const un = [stubSites(), stubCareers({ alice: "spymaster" }), stubEspionage()];
  run(makePlayer("Alice", 1000, false), ["join"]);
  const msgs = run(makePlayer("Alice", 1000, false), ["school"]);
  assert.ok(msgs.some((m) => m.includes("Tradecraft school")), "school status shown");
  const msgs2 = run(makePlayer("Nobody", 1000, false), ["school"]);
  assert.ok(msgs2.some((m) => m.includes("not a member")), "non-member school honest");
  cleanup(...un);
}

function testUnknownSubcommand() {
  fresh();
  const un = [stubSites(), stubCareers({}), stubEspionage()];
  const msgs = run(makePlayer("Alice", 1000, false), ["frobnicate"]);
  assert.ok(msgs.some((m) => m.includes("::spyguild")), "usage shown for unknown subcommand");
  cleanup(...un);
}

const tests = [
  testBotRejected,
  testJoinAndStatus,
  testLeave,
  testDues,
  testCode,
  testDrops,
  testSanctuary,
  testInterrogate,
  testReportAndCases,
  testVoteValidation,
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
console.log(`\n${passed}/${tests.length} CitizenSpyGuildEvents tests passed`);
