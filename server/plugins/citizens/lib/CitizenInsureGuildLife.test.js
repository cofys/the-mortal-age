"use strict";

/**
 * CitizenInsureGuildLife.test.js — plain-node tests for the guild life tick.
 * The director, bots, insurance, and banking are stubbed; the tick must never
 * throw and must move real coins / file real claims on real state.
 */

const assert = require("assert");

const Guilds = require("./CitizenInsureGuilds");
const Life = require("./CitizenInsureGuildLife");

function fresh() {
  Guilds.resetForTests();
  Life.resetForTests();
}

// --- stubs --------------------------------------------------------------------

function makeBot(coins) {
  const items = coins > 0 ? [{ id: 995, amount: coins }] : [];
  return {
    inventory: {
      getAmount: (id) => (id === 995 ? coins : 0),
      count: (id) => (id === 995 ? coins : 0),
      remove: (id, n) => { if (id === 995 && coins >= n) { coins -= n; return true; } return false; },
      add: (id, n) => { if (id === 995) coins += n; },
      _coins: () => coins,
    },
    sendMessage: () => {},
    getUsername: () => "bot",
  };
}

function makeDirector(records) {
  // records: [{ username, kingdomId, bot }]
  const roster = new Map(records.map((r) => [r.username, r]));
  const bots = new Map(records.map((r) => [r.username, r.bot]));
  return {
    roster,
    isOnline: (r) => true,
    getBot: (r) => bots.get(r.username) || null,
    log: () => {},
  };
}

const POLICY_TYPES = {
  life: { label: "life", maxFace: 100000, minFace: 1000 },
  health: { label: "health", maxFace: 20000, minFace: 500 },
  property: { label: "property", maxFace: 50000, minFace: 1000 },
  travel: { label: "travel", maxFace: 25000, minFace: 500 },
};

function stubInsurance(ledger) {
  const key = require.resolve("./CitizenInsurance");
  const fake = {
    POLICY_TYPES,
    insurerFor: (u) => (ledger.insurers || {})[String(u || "").trim().toLowerCase()] || null,
    insurersIn: (kid) => Object.keys(ledger.insurers || {}).filter(
      (k) => (ledger.insurers[k] || {}).kingdomId === String(kid || "").toLowerCase()
    ),
    totalExposure: () => ledger.exposure ?? 0,
    poolBalance: () => ledger.pool ?? 0,
    officeTile: (kid) => ({ x: 3200, y: 3200, z: 0 }),
    coverOwedPayout: (u, amount) => {
      const k = String(u || "").trim().toLowerCase();
      const owed = (ledger.payoutsOwed || {})[k] || 0;
      const covered = Math.min(owed, Math.max(0, Math.floor(Number(amount) || 0)));
      if (covered > 0) {
        const rest = owed - covered;
        if (rest <= 0) delete ledger.payoutsOwed[k];
        else ledger.payoutsOwed[k] = rest;
      }
      return covered;
    },
    _data: () => ({
      policies: ledger.policies || {},
      pool: ledger.pool ?? 0,
      insurers: ledger.insurers || {},
      payoutsOwed: ledger.payoutsOwed || {},
    }),
    markDirty: () => {},
  };
  require.cache[key] = { id: key, filename: key, loaded: true, exports: fake };
  return () => { delete require.cache[key]; };
}

function stubBanking(accounts) {
  const key = require.resolve("./CitizenBanking");
  const fake = {
    _data: () => ({ accounts: accounts || {} }),
    markDirty: () => {},
  };
  require.cache[key] = { id: key, filename: key, loaded: true, exports: fake };
  return () => { delete require.cache[key]; };
}

function stubSites(kingdoms) {
  const brainKey = require.resolve("../brain/CitizenSites");
  const fake = {
    KINGDOM_IDS: kingdoms,
    kingdomIdOf: (record) => record?.kingdomId || null,
    siteTile: (player, site) => ({ x: 3200, y: 3200, z: 0 }),
  };
  require.cache[brainKey] = { id: brainKey, filename: brainKey, loaded: true, exports: fake };
  return () => { delete require.cache[brainKey]; };
}

function stubSayPublic() {
  const key = require.resolve("../chat/CitizenSayPublic");
  require.cache[key] = { id: key, filename: key, loaded: true, exports: { sayPublic: () => {} } };
  return () => { delete require.cache[key]; };
}

function baseLedger() {
  return {
    insurers: { alice: { kingdomId: "misthalin", appointedAt: 1 } },
    pool: 100000,
    exposure: 40000,
    payoutsOwed: {},
    policies: {},
  };
}

let passed = 0;
function test(name, fn) {
  fresh();
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}: ${e.message}`);
    console.error(e.stack);
    process.exitCode = 1;
  }
}

test("tick never throws with no director state", () => {
  const unS = stubSites([]);
  const unI = stubInsurance(baseLedger());
  const unP = stubSayPublic();
  Life.tickInsureGuildLife({ roster: new Map(), log: () => {} }, Date.now());
  unS(); unI(); unP();
});

test("tick collects dues from online members with real coins", () => {
  const unS = stubSites(["misthalin"]);
  const unI = stubInsurance(baseLedger());
  const unP = stubSayPublic();
  Guilds.joinGuild("alice", "misthalin");
  // force dues overdue
  Guilds.memberOf("alice").duesPaidUntil = Date.now() - 1000;
  const bot = makeBot(1000);
  const director = makeDirector([{ username: "alice", kingdomId: "misthalin", bot }]);
  const before = bot.inventory._coins();
  Life.tickInsureGuildLife(director, Date.now());
  assert.ok(bot.inventory._coins() < before, "dues should be taken from the real inventory");
  assert.strictEqual(bot.inventory._coins(), before - Guilds.DUES_WEEKLY);
  const g = Guilds.guildOf("misthalin");
  assert.ok(g.treasury > 0);
  assert.ok(g.reinsuranceFund > 0);
  unS(); unI(); unP();
});

test("tick records a miss for broke members, never throws", () => {
  const unS = stubSites(["misthalin"]);
  const unI = stubInsurance(baseLedger());
  const unP = stubSayPublic();
  Guilds.joinGuild("alice", "misthalin");
  Guilds.memberOf("alice").duesPaidUntil = Date.now() - 1000;
  const bot = makeBot(0); // broke
  const director = makeDirector([{ username: "alice", kingdomId: "misthalin", bot }]);
  Life.tickInsureGuildLife(director, Date.now());
  assert.strictEqual(Guilds.memberOf("alice").missedDues, 1);
  unS(); unI(); unP();
});

test("tick files and pays reinsurance claims when the pool is insolvent", () => {
  const ledger = baseLedger();
  ledger.pool = 10000;
  ledger.exposure = 40000;
  ledger.payoutsOwed = { bob: 4000 };
  const accounts = { bob: { balance: 50 } };
  const unS = stubSites(["misthalin"]);
  const unI = stubInsurance(ledger);
  const unB = stubBanking(accounts);
  const unP = stubSayPublic();
  Guilds.ensureGuild("misthalin");
  Guilds.contributeToFund("misthalin", 10000);
  // force insolvency
  Guilds.conductReview("misthalin", "guild");
  Guilds.conductReview("misthalin", "guild");
  assert.strictEqual(Guilds.poolStatus("misthalin"), "insolvent");
  const director = makeDirector([]);
  Life.tickInsureGuildLife(director, Date.now());
  // bob's owed claim should be paid from the reinsurance fund
  assert.strictEqual(accounts.bob.balance, 4050);
  assert.strictEqual(ledger.payoutsOwed.bob, undefined);
  unS(); unI(); unB(); unP();
});

test("tick auto-reports verifiable fraud once", () => {
  const ledger = baseLedger();
  ledger.policies = {
    mallory: { life: { type: "life", faceValue: 999999999, premium: 100, status: "active" }, health: null, property: null, travel: null },
  };
  const unS = stubSites(["misthalin"]);
  const unI = stubInsurance(ledger);
  const unP = stubSayPublic();
  const director = makeDirector([]);
  Life.tickInsureGuildLife(director, Date.now());
  const cases = Guilds.openCases("misthalin");
  assert.ok(cases.some((c) => c.accused === "mallory"), "fraud should be auto-reported");
  // second tick does not duplicate
  Life.resetForTests();
  Life.tickInsureGuildLife(director, Date.now() + 31 * 60 * 1000);
  const cases2 = Guilds.openCases("misthalin");
  assert.strictEqual(cases2.filter((c) => c.accused === "mallory").length, 1);
  unS(); unI(); unP();
});

test("tick settles old tribunal cases", () => {
  const ledger = baseLedger();
  ledger.insurers.mallory = { kingdomId: "misthalin", appointedAt: 1 };
  ledger.policies = {
    mallory: { life: { type: "life", faceValue: 999999999, premium: 100, status: "active" }, health: null, property: null, travel: null },
  };
  const unS = stubSites(["misthalin"]);
  const unI = stubInsurance(ledger);
  const unP = stubSayPublic();
  // stub reputation so the deed award doesn't throw
  const repKey = require.resolve("./CitizenReputation");
  require.cache[repKey] = { id: repKey, filename: repKey, loaded: true, exports: { awardDeed: () => {} } };
  Guilds.joinGuild("mallory", "misthalin");
  const r = Guilds.reportFraud("guild", "mallory");
  assert.ok(r.ok);
  // age the case past the settle window by hand
  const st = Guilds; // access via public API only
  const director = makeDirector([]);
  // first tick: not yet settleable
  Life.tickInsureGuildLife(director, Date.now());
  assert.strictEqual(Guilds.openCases("misthalin").length, 1);
  // vote guilty, then tick far in the future
  Guilds.joinGuild("alice", "misthalin");
  Guilds.memberOf("alice").rank = Guilds.RANK_ACTUARY;
  Guilds.voteOnCase("alice", r.caseId, true);
  Life.resetForTests();
  Life.tickInsureGuildLife(director, Date.now() + 25 * 60 * 60 * 1000);
  assert.strictEqual(Guilds.openCases("misthalin").length, 0);
  assert.strictEqual(Guilds.isGuildMember("mallory"), false);
  delete require.cache[repKey];
  unS(); unI(); unP();
  void st;
});

console.log(`\n${passed} tests passed`);
