"use strict";

/**
 * CitizenLawGuildLife.test.js — plain-node tests for the bar association tick.
 * No jest, no engine. The director is a stub; CitizenSites is stubbed.
 */

const assert = require("assert");

const Guilds = require("./CitizenLawGuilds");
const Life = require("./CitizenLawGuildLife");

function fresh() {
  Guilds.resetForTests();
  Life.resetForTests();
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  if (!fresh.tmp) {
    fresh.tmp = path.join(os.tmpdir(), `lawguildlife-test-${Date.now()}-${Math.floor(Math.random()*1e6)}.json`);
  }
  Guilds._setSavePathForTests(fresh.tmp);
}

function stubSites(kingdomMap) {
  const key = require.resolve("../brain/CitizenSites");
  const fake = {
    KINGDOM_IDS: ["varrock", "falador"],
    kingdomIdOf: (r) => {
      const name = (r?.getUsername?.() ?? r?.username ?? "").toLowerCase();
      return (kingdomMap || {})[name] || "varrock";
    },
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

function stubCivilLaw(ledger) {
  const key = require.resolve("./CitizenCivilLaw");
  const fake = {
    courthouseFor: () => ({ x: 3200, y: 3200, z: 0 }),
    disputesNeedingAdvocates: () => (ledger.needing || []).slice(),
    unpaidJudgments: () => [],
    disputeById: (id) => (ledger.disputes || {})[id] || null,
    advocateFor: () => null,
    allDisputes: () => [],
    hireAdvocate: () => ({ ok: true }),
  };
  require.cache[key] = { id: key, filename: key, loaded: true, exports: fake };
  return () => { delete require.cache[key]; };
}

function makeBot(username, coins) {
  const inv = {
    _coins: coins,
    getAmount: (id) => (id === 995 ? inv._coins : 0),
    // Canonical ItemContainer API: deleteNumber(id, amount).
    deleteNumber: (id, amt) => { if (id === 995) inv._coins = Math.max(0, inv._coins - amt); },
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
  const unCivil = stubCivilLaw({});
  const director = makeDirector([]);
  // Should not throw even with empty everything.
  Life.tickLawGuildLife(director, Date.now());
  Life.tickLawGuildLife(null, Date.now());
  Life.tickLawGuildLife(director);
  unSites(); unCareers(); unCivil();
  console.log("ok - never throws");
}

function testDuesCollection() {
  fresh();
  const unSites = stubSites({ alice: "varrock" });
  const unCareers = stubCareers({ alice: "lawyer" });
  const unCivil = stubCivilLaw({});
  Guilds.joinGuild("varrock", "Alice");
  // Force dues to be due.
  Guilds.guildOf("varrock").members["alice"].duesPaidUntilMs = Date.now() - 1000;

  const bot = makeBot("Alice", 1000);
  const director = makeDirector([bot]);
  Life.tickLawGuildLife(director, Date.now());

  const g = Guilds.guildOf("varrock");
  assert.ok(g.treasury > 0, "treasury got dues");
  assert.ok(g.probonoFund > 0, "pro bono fund got share");
  assert.strictEqual(bot.inventory._coins, 1000 - Guilds.DUES_WEEKLY, "coins taken from bot");
  unSites(); unCareers(); unCivil();
  console.log("ok - dues collection from online members");
}

function testDuesMissedWhenBroke() {
  fresh();
  const unSites = stubSites({ alice: "varrock" });
  const unCareers = stubCareers({ alice: "lawyer" });
  const unCivil = stubCivilLaw({});
  Guilds.joinGuild("varrock", "Alice");
  Guilds.guildOf("varrock").members["alice"].duesPaidUntilMs = Date.now() - 1000;

  const bot = makeBot("Alice", 5); // broke
  const director = makeDirector([bot]);
  Life.tickLawGuildLife(director, Date.now());

  const m = Guilds.memberOf("Alice");
  assert.strictEqual(m.missedDues, 1, "miss recorded");
  assert.ok(!m.suspended, "one miss is not suspension");
  unSites(); unCareers(); unCivil();
  console.log("ok - missed dues when broke");
}

function testOfflineSkipped() {
  fresh();
  const unSites = stubSites({});
  const unCareers = stubCareers({ alice: "lawyer" });
  const unCivil = stubCivilLaw({});
  Guilds.joinGuild("varrock", "Alice");
  Guilds.guildOf("varrock").members["alice"].duesPaidUntilMs = Date.now() - 1000;

  const director = makeDirector([]); // Alice offline
  Life.tickLawGuildLife(director, Date.now());

  const m = Guilds.memberOf("Alice");
  assert.strictEqual(m.missedDues, 0, "offline members never accrue misses");
  unSites(); unCareers(); unCivil();
  console.log("ok - offline members skipped");
}

function testProBonoFiling() {
  fresh();
  const unSites = stubSites({ bob: "varrock" });
  const unCareers = stubCareers({ bob: "lawyer" });
  const unCivil = stubCivilLaw({
    needing: [{ disputeId: "d1", party: "plaintiff" }],
    disputes: { d1: { id: "d1", advocates: {} } },
  });
  Guilds.joinGuild("varrock", "Bob");
  Guilds.guildOf("varrock").members["bob"].rank = Guilds.RANK_ADVOCATE;
  Guilds.guildOf("varrock").probonoFund = 500;

  const bot = makeBot("Bob", 1000);
  const director = makeDirector([bot]);
  Life.tickLawGuildLife(director, Date.now());

  const g = Guilds.guildOf("varrock");
  const claims = Object.values(g.probonoClaims);
  assert.ok(claims.length > 0, "pro bono claim filed");
  assert.ok(claims[0].advocate === "Bob" || claims[0].status === "open", "claim assigned or open");
  unSites(); unCareers(); unCivil();
  console.log("ok - pro bono filing");
}

function testTickThrottle() {
  fresh();
  const unSites = stubSites({});
  const unCareers = stubCareers({});
  const unCivil = stubCivilLaw({});
  const director = makeDirector([]);
  const now = Date.now();
  Life.tickLawGuildLife(director, now);
  // Second tick within cooldown should be skipped (no error, no double work).
  Life.tickLawGuildLife(director, now + 1000);
  unSites(); unCareers(); unCivil();
  console.log("ok - tick throttling");
}

// --- run ---------------------------------------------------------------------

const tests = [
  testNeverThrows,
  testDuesCollection,
  testDuesMissedWhenBroke,
  testOfflineSkipped,
  testProBonoFiling,
  testTickThrottle,
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
console.log(`\n${passed}/${tests.length} CitizenLawGuildLife tests passed`);
