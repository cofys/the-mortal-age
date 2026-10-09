"use strict";

/**
 * CitizenSpyGuildLife.test.js — plain-node tests for the shadow guild
 * slow tick. No jest, no engine.
 */

const assert = require("assert");

const Life = require("./CitizenSpyGuildLife");
const Guilds = require("./CitizenSpyGuilds");

function fresh() {
  Guilds.resetForTests();
  Life.resetForTests();
  const os = require("os");
  const path = require("path");
  if (!fresh.tmp) {
    fresh.tmp = path.join(os.tmpdir(), `spyguildlife-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`);
  }
  Guilds._setSavePathForTests(fresh.tmp);
}

function stubSites(kingdomIds) {
  const key = require.resolve("../brain/CitizenSites");
  const fake = {
    KINGDOM_IDS: kingdomIds || ["misthalin"],
    kingdomIdOf: (r) => r._kid || "misthalin",
    siteTile: (who, kind) => ({ x: 3200, y: 3200, z: 0 }),
  };
  require.cache[key] = { id: key, filename: key, loaded: true, exports: fake };
  return () => { delete require.cache[key]; };
}

function stubCareers(careerMap) {
  const key = require.resolve("./CitizenCareers");
  const fake = {
    careerOf: (u) => {
      const c = (careerMap || {})[String(u || "").trim().toLowerCase()];
      return c ? { key: c } : null;
    },
  };
  require.cache[key] = { id: key, filename: key, loaded: true, exports: fake };
  return () => { delete require.cache[key]; };
}

function stubEspionage(cfg) {
  const key = require.resolve("./CitizenEspionage");
  const c = cfg || {};
  const fake = {
    networkFor: () => null,
    cellFor: () => null,
    cellsIn: (kid) => (c.cellsIn || {})[String(kid || "").toLowerCase()] || [],
    counterAgentsOf: () => [],
    isHandler: () => false,
    interrogate: () => [],
    interrogationsOf: () => [],
  };
  require.cache[key] = { id: key, filename: key, loaded: true, exports: fake };
  return () => { delete require.cache[key]; };
}

function stubSayPublic() {
  const key = require.resolve("../chat/CitizenSayPublic");
  const said = [];
  const fake = { sayPublic: (bot, text) => { said.push(text); } };
  require.cache[key] = { id: key, filename: key, loaded: true, exports: fake };
  const un = () => { delete require.cache[key]; };
  return { un, said };
}

function makeDirector(records) {
  const bots = {};
  return {
    roster: records || [],
    isOnline: () => true,
    getBot: (rec) => {
      const name = rec.username;
      if (!bots[name]) {
        bots[name] = {
          username: name,
          inventory: {
            _coins: rec._coins ?? 0,
            getAmount: function () { return this._coins; },
            // Canonical ItemContainer API: deleteNumber(id, amount).
            deleteNumber: function (id, amt) { this._coins = Math.max(0, this._coins - amt); },
          },
        };
      }
      return bots[name];
    },
    log: () => {},
  };
}

function cleanup(...uns) {
  for (const u of uns) { try { u(); } catch { /* cleaned */ } }
}

// --- tests -------------------------------------------------------------------

function testNeverThrows() {
  fresh();
  const un = [stubSites(), stubCareers({}), stubEspionage({}), stubSayPublic().un];
  const d = makeDirector([]);
  Life.tickSpyGuildLife(d, Date.now());
  Life.tickSpyGuildLife(null, Date.now()); // null director
  Life.tickSpyGuildLife({}, Date.now()); // empty director
  cleanup(...un);
}

function testDuesCollection() {
  fresh();
  const un = [stubSites(["misthalin"]), stubCareers({ alice: "spymaster", broke: "spymaster" }), stubEspionage({}), stubSayPublic().un];
  Guilds.joinGuild("misthalin", "Alice");
  Guilds.joinGuild("misthalin", "Broke");
  // Force dues due.
  const g = Guilds.guildOf("misthalin");
  g.members["alice"].duesPaidUntilMs = Date.now() - 1000;
  g.members["broke"].duesPaidUntilMs = Date.now() - 1000;
  const d = makeDirector([
    { username: "Alice", _kid: "misthalin", _coins: 1000 },
    { username: "Broke", _kid: "misthalin", _coins: 0 },
  ]);
  Life.tickSpyGuildLife(d, Date.now() + 31 * 60 * 1000);
  assert.strictEqual(g.treasury, Guilds.DUES_WEEKLY - Guilds.DUES_TRADECRAFT_SHARE, "dues collected from Alice");
  const broke = Guilds.memberOf("Broke");
  assert.strictEqual(broke.missedDues, 1, "broke member accrues a miss, not a crime");
  assert.ok(!broke.suspended, "one miss does not suspend");
  cleanup(...un);
}

function testSanctuarySkipsDues() {
  fresh();
  const un = [stubSites(["misthalin"]), stubCareers({ alice: "spymaster" }), stubEspionage({}), stubSayPublic().un];
  Guilds.joinGuild("misthalin", "Alice");
  const g = Guilds.guildOf("misthalin");
  g.members["alice"].duesPaidUntilMs = Date.now() - 1000;
  g.members["alice"].sanctuaryUntilMs = Date.now() + 10 * 24 * 60 * 60 * 1000; // in hiding, past tick time
  const d = makeDirector([{ username: "Alice", _kid: "misthalin", _coins: 1000 }]);
  Life.tickSpyGuildLife(d, Date.now() + 31 * 60 * 1000);
  assert.strictEqual(g.treasury, 0, "no dues from a member in sanctuary");
  assert.strictEqual(Guilds.memberOf("Alice").missedDues, 0, "no miss accrued in sanctuary");
  cleanup(...un);
}

function testDropPruning() {
  fresh();
  const un = [stubSites(["misthalin"]), stubCareers({ alice: "spymaster", bob: "spymaster" }), stubEspionage({}), stubSayPublic().un];
  Guilds.joinGuild("misthalin", "Alice");
  Guilds.joinGuild("misthalin", "Bob");
  Guilds.leaveDrop("misthalin", "Alice", "Bob", "stale", Date.now() - Guilds.DROP_TTL_MS - 1000);
  const d = makeDirector([]);
  Life.tickSpyGuildLife(d, Date.now() + 31 * 60 * 1000);
  assert.strictEqual(Object.keys(Guilds.guildOf("misthalin").drops).length, 0, "expired drop pruned on tick");
  cleanup(...un);
}

function testMoleAutoReport() {
  fresh();
  const un = [stubSites(["misthalin"]), stubCareers({ alice: "spymaster", mole: "spymaster" }), stubEspionage({
    cellsIn: { misthalin: [{ spy: "Mole", homeKingdom: "kandarin", targetKingdom: "misthalin" }] },
  }), stubSayPublic().un];
  Guilds.joinGuild("misthalin", "Alice");
  Guilds.joinGuild("misthalin", "Mole");
  const d = makeDirector([{ username: "Alice", _kid: "misthalin", _coins: 1000 }]);
  Life.tickSpyGuildLife(d, Date.now() + 31 * 60 * 1000);
  const cases = Object.values(Guilds.guildOf("misthalin").cases);
  assert.ok(cases.some((c) => c.status === "open" && c.kind === "mole"), "mole case auto-opened");
  // Second tick: no duplicate (seenMoles).
  Life.tickSpyGuildLife(d, Date.now() + 62 * 60 * 1000);
  const cases2 = Object.values(Guilds.guildOf("misthalin").cases);
  assert.strictEqual(cases2.length, cases.length, "no duplicate mole case");
  cleanup(...un);
}

function testTribunalSettlement() {
  fresh();
  const un = [stubSites(["misthalin"]), stubCareers({ alice: "spymaster", mole: "spymaster" }), stubEspionage({
    cellsIn: { misthalin: [{ spy: "Mole", homeKingdom: "kandarin", targetKingdom: "misthalin" }] },
  }), stubSayPublic().un];
  Guilds.joinGuild("misthalin", "Alice");
  Guilds.joinGuild("misthalin", "Mole");
  const g = Guilds.guildOf("misthalin");
  g.members["alice"].rank = Guilds.RANK_SPYMASTER;
  const rep = Guilds.reportMisconduct("misthalin", "Mole", "mole", "guild");
  // Backdate the case past the settle window.
  g.cases[rep.caseId].filedAtMs = Date.now() - 25 * 60 * 60 * 1000;
  const d = makeDirector([{ username: "Alice", _kid: "misthalin", _coins: 1000 }]);
  Life.tickSpyGuildLife(d, Date.now() + 31 * 60 * 1000);
  assert.strictEqual(g.cases[rep.caseId].status, "decided", "ripe case settled on tick");
  cleanup(...un);
}

const tests = [
  testNeverThrows,
  testDuesCollection,
  testSanctuarySkipsDues,
  testDropPruning,
  testMoleAutoReport,
  testTribunalSettlement,
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
console.log(`\n${passed}/${tests.length} CitizenSpyGuildLife tests passed`);
