"use strict";

/**
 * CitizenDiplomaticCorpsLife.test.js — plain-node tests for the corps tick.
 * No jest, no engine. The director is a stub; CitizenSites, CitizenCareers,
 * CitizenDiplomats, CitizenTreaties, Tension, CitizenBanking, CitizenEspionage
 * are stubbed through the require cache.
 */

const assert = require("assert");

const Corps = require("./CitizenDiplomaticCorps");
const Life = require("./CitizenDiplomaticCorpsLife");

function fresh() {
  Corps.resetForTests();
  Life.resetForTests();
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  if (!fresh.tmp) {
    fresh.tmp = path.join(os.tmpdir(), `diplocorpslife-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`);
  }
  Corps._setSavePathForTests(fresh.tmp);
}

function stubSites(kingdomMap) {
  const key = require.resolve("../brain/CitizenSites");
  const fake = {
    KINGDOM_IDS: ["misthalin", "kandarin", "asgarnia"],
    kingdomIdOf: (r) => {
      const name = (r?.getUsername?.() ?? r?.username ?? "").toLowerCase();
      return (kingdomMap || {})[name] || "misthalin";
    },
    siteTileByKingdom: () => ({ x: 3200, y: 3200, z: 0 }),
  };
  require.cache[key] = { id: key, filename: key, loaded: true, exports: fake };
  return () => { delete require.cache[key]; };
}

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

function stubDiplomats() {
  const key = require.resolve("./CitizenDiplomats");
  const fake = { isDiplomat: () => true, diplomatStatus: () => [] };
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

function stubTreaties() {
  const key = require.resolve("./CitizenTreaties");
  const fake = { embassyPair: () => null, treatyBetween: () => null, atWar: () => false };
  require.cache[key] = { id: key, filename: key, loaded: true, exports: fake };
  return () => { delete require.cache[key]; };
}

function stubBanking() {
  const key = require.resolve("./CitizenBanking");
  const fake = { creditAccount: () => {} };
  require.cache[key] = { id: key, filename: key, loaded: true, exports: fake };
  return () => { delete require.cache[key]; };
}

function stubEspionage(spies) {
  const key = require.resolve("./CitizenEspionage");
  const fake = {
    cellFor: (u) => {
      const n = String(u || "").trim().toLowerCase();
      return (spies || []).includes(n) ? { spy: u } : null;
    },
  };
  require.cache[key] = { id: key, filename: key, loaded: true, exports: fake };
  return () => { delete require.cache[key]; };
}

function stubReputation() {
  const key = require.resolve("./CitizenReputation");
  const fake = { grantDeed: () => {} };
  require.cache[key] = { id: key, filename: key, loaded: true, exports: fake };
  return () => { delete require.cache[key]; };
}

function makeBot(username, coins) {
  const inv = {
    _coins: coins,
    getAmount: (id) => (id === 995 ? inv._coins : 0),
    remove: (id, amt) => { if (id === 995) inv._coins = Math.max(0, inv._coins - amt); },
  };
  return {
    getUsername: () => username,
    username,
    getInventory: () => inv,
    inventory: inv,
  };
}

function makeDirector(bots) {
  const records = (bots || []).map((b) => ({ bot: b, username: b.getUsername() }));
  return {
    roster: records,
    isOnline: () => true,
    getBot: (r) => r.bot,
  };
}

// --- tests -------------------------------------------------------------------

function testNeverThrows() {
  fresh();
  const unSites = stubSites({});
  const unCareers = stubCareers({});
  const unDiplo = stubDiplomats();
  const unTension = stubTension({});
  const unTreaties = stubTreaties();
  const unEsp = stubEspionage([]);
  const director = makeDirector([]);
  Life.tickDiplomaticCorpsLife(director, Date.now());
  Life.tickDiplomaticCorpsLife(null, Date.now());
  Life.tickDiplomaticCorpsLife(director);
  unSites(); unCareers(); unDiplo(); unTension(); unTreaties(); unEsp();
}

function testDuesCollection() {
  fresh();
  const unSites = stubSites({ alice: "misthalin" });
  const unCareers = stubCareers({ alice: "ambassador" });
  const unDiplo = stubDiplomats();
  const unTension = stubTension({});
  const unTreaties = stubTreaties();
  const unEsp = stubEspionage([]);
  Corps.joinGuild("misthalin", "Alice");
  Corps.corpsOf("misthalin").members["alice"].duesPaidUntilMs = Date.now() - 1000;

  const bot = makeBot("Alice", 1000);
  const director = makeDirector([bot]);
  Life.tickDiplomaticCorpsLife(director, Date.now());

  const g = Corps.corpsOf("misthalin");
  assert.ok(g.treasury > 0, "treasury got dues");
  assert.ok(g.mediationFund > 0, "mediation fund got share");
  assert.strictEqual(bot.inventory._coins, 1000 - Corps.DUES_WEEKLY, "coins taken from bot");
  unSites(); unCareers(); unDiplo(); unTension(); unTreaties(); unEsp();
}

function testReviewFlagsAndCrisis() {
  fresh();
  const tensions = { "asgarnia:misthalin": 80, "kandarin:misthalin": 75 };
  const unSites = stubSites({});
  const unCareers = stubCareers({});
  const unDiplo = stubDiplomats();
  const unTension = stubTension(tensions);
  const unTreaties = stubTreaties();
  const unEsp = stubEspionage([]);
  // First tick runs the weekly auto-review (hot borders -> FLAG).
  Life.tickDiplomaticCorpsLife(makeDirector([]), Date.now());
  let g = Corps.corpsOf("misthalin");
  assert.strictEqual(g.consecutiveFlags, 1, "one flag after first tick");
  assert.ok(!g.crisis, "one flag is not crisis");
  // Backdate the review a week and clear the tick throttle to simulate the
  // next weekly cycle; a second flag with 2+ hot borders -> CRISIS.
  g.reviews[g.reviews.length - 1].atMs = Date.now() - 8 * 24 * 60 * 60 * 1000;
  Life.resetForTests(); // clears the 30-min throttle (keeps corps state)
  Life.tickDiplomaticCorpsLife(makeDirector([]), Date.now() + 31 * 60 * 1000);
  g = Corps.corpsOf("misthalin");
  assert.strictEqual(g.consecutiveFlags, 2, "two flags recorded");
  assert.ok(g.crisis, "crisis declared");
  unSites(); unCareers(); unDiplo(); unTension(); unTreaties(); unEsp();
}

function testMediationOnCrisis() {
  fresh();
  const tensions = { "asgarnia:misthalin": 80 };
  const unSites = stubSites({ diana: "misthalin" });
  const unCareers = stubCareers({ diana: "ambassador" });
  const unDiplo = stubDiplomats();
  const unTension = stubTension(tensions);
  const unTreaties = stubTreaties();
  const unBank = stubBanking();
  const unEsp = stubEspionage([]);
  Corps.joinGuild("misthalin", "Diana");
  const g = Corps.corpsOf("misthalin");
  g.members["diana"].rank = Corps.RANK_AMBASSADOR;
  g.mediationFund = 1000;
  g.crisis = true; // drive mediation

  const bot = makeBot("Diana", 1000);
  Life.tickDiplomaticCorpsLife(makeDirector([bot]), Date.now());

  assert.strictEqual(tensions["asgarnia:misthalin"], 80 - Corps.MEDIATION_TENSION_DROP,
    "tick mediation cooled the real border");
  unSites(); unCareers(); unDiplo(); unTension(); unTreaties(); unBank(); unEsp();
}

function testTreasonAutoReport() {
  fresh();
  const unSites = stubSites({ spy: "misthalin" });
  const unCareers = stubCareers({ spy: "ambassador" });
  const unDiplo = stubDiplomats();
  const unTension = stubTension({});
  const unTreaties = stubTreaties();
  const unEsp = stubEspionage(["spy"]);
  Corps.joinGuild("misthalin", "Spy");

  const bot = makeBot("Spy", 1000);
  Life.tickDiplomaticCorpsLife(makeDirector([bot]), Date.now());

  const g = Corps.corpsOf("misthalin");
  const open = Object.values(g.cases).filter((c) => c.status === "open");
  assert.ok(open.length > 0, "treason case auto-opened for spy-cell member");
  unSites(); unCareers(); unDiplo(); unTension(); unTreaties(); unEsp();
}

function testSchoolAndPromotion() {
  fresh();
  const unSites = stubSites({ master: "misthalin", envoy: "misthalin" });
  const unCareers = stubCareers({ master: "ambassador", envoy: "ambassador" });
  const unDiplo = stubDiplomats();
  const unTension = stubTension({});
  const unTreaties = stubTreaties();
  const unEsp = stubEspionage([]);
  const unRep = stubReputation();
  Corps.joinGuild("misthalin", "Master");
  Corps.joinGuild("misthalin", "Envoy");
  Corps.corpsOf("misthalin").members["master"].rank = Corps.RANK_AMBASSADOR;

  const director = makeDirector([makeBot("Master", 1000), makeBot("Envoy", 1000)]);
  Life.tickDiplomaticCorpsLife(director, Date.now());

  assert.ok(Corps.corpsOf("misthalin").members["envoy"].trainingCredits >= 1, "envoy got training credit");
  unSites(); unCareers(); unDiplo(); unTension(); unTreaties(); unEsp(); unRep();
}

const tests = [
  testNeverThrows,
  testDuesCollection,
  testReviewFlagsAndCrisis,
  testMediationOnCrisis,
  testTreasonAutoReport,
  testSchoolAndPromotion,
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
console.log(`\n${passed}/${tests.length} CitizenDiplomaticCorpsLife tests passed`);
