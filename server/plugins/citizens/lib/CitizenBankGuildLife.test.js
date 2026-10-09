"use strict";

/**
 * CitizenBankGuildLife.test.js — plain-node tests for the guild life tick.
 * The director, bots, and banking are stubbed; the tick must never throw
 * and must move real coins / file real claims on real state.
 */

const assert = require("assert");

const Guilds = require("./CitizenBankGuilds");
const Life = require("./CitizenBankGuildLife");

function fresh() {
  Guilds.resetForTests();
  Life.resetForTests();
}

// --- stubs --------------------------------------------------------------------

function makeBot(coins) {
  const items = coins > 0 ? [{ id: 995, amount: coins }] : [];
  return {
    inventory: {
      count: (id) => (id === 995 ? coins : 0),
      remove: (id, n) => { if (id === 995 && coins >= n) { coins -= n; return true; } return false; },
      add: (id, n) => { if (id === 995) coins += n; },
      _coins: () => coins,
    },
    sendMessage: () => {},
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

// --- tests ----------------------------------------------------------------------

fresh();
{
  // Never throws on an empty director.
  const restoreB = stubBanking(baseLedger());
  const restoreS = stubSites(["misthalin"]);
  Life.tickBankGuildLife(makeDirector([]), 1000);
  restoreB(); restoreS();
}
console.log("ok - never-throws");

fresh();
{
  // Dues: online member pays real coins; treasury + insurance fund credited.
  const restoreB = stubBanking(baseLedger());
  const restoreS = stubSites(["misthalin"]);
  Guilds.joinGuild("alice", "misthalin");
  const m = Guilds.memberOf("alice");
  m.duesPaidUntil = 0; // due now
  const bot = makeBot(100);
  const director = makeDirector([{ username: "alice", kingdomId: "misthalin", bot }]);
  Life.tickBankGuildLife(director, 10_000);
  // Dues (25) + insurance premium (1% of alice's 5000 balance = 50) both collected.
  assert.strictEqual(bot.inventory._coins(), 25, "dues + premium taken from real inventory");
  assert.strictEqual(Guilds.guildTreasuryFor("misthalin"), Guilds.DUES_WEEKLY - Guilds.DUES_INSURANCE_SHARE);
  assert.strictEqual(Guilds.insuranceFundFor("misthalin"), Guilds.DUES_INSURANCE_SHARE + 50);
  assert.ok(m.duesPaidUntil > 10_000, "dues extended");
  assert.strictEqual(Guilds.isCovered("alice", 20_000), true, "premium buys coverage");
  restoreB(); restoreS();
}
console.log("ok - dues collection");

fresh();
{
  // Broke member misses dues; two misses suspend.
  const restoreB = stubBanking(baseLedger());
  const restoreS = stubSites(["misthalin"]);
  Guilds.joinGuild("alice", "misthalin");
  const m = Guilds.memberOf("alice");
  m.duesPaidUntil = 0;
  const bot = makeBot(0); // broke
  const director = makeDirector([{ username: "alice", kingdomId: "misthalin", bot }]);
  Life.tickBankGuildLife(director, 10_000);
  assert.strictEqual(m.missedDues, 1);
  assert.strictEqual(m.suspended, false, "one miss does not suspend");
  // Second tick (force past cooldown by resetting life state).
  m.duesPaidUntil = 0;
  Life.resetForTests();
  Life.tickBankGuildLife(director, 10_000 + 31 * 60 * 1000);
  assert.strictEqual(m.suspended, true, "two misses suspend");
  restoreB(); restoreS();
}
console.log("ok - dues suspension");

fresh();
{
  // Premiums: online depositor pays 1% and becomes covered.
  const restoreB = stubBanking(baseLedger());
  const restoreS = stubSites(["misthalin"]);
  const bot = makeBot(500); // bob has 2000 in the bank -> 20 premium
  const director = makeDirector([{ username: "bob", kingdomId: "misthalin", bot }]);
  Life.tickBankGuildLife(director, 10_000);
  assert.strictEqual(bot.inventory._coins(), 480, "premium taken from real inventory");
  assert.strictEqual(Guilds.insuranceFundFor("misthalin"), 20);
  assert.strictEqual(Guilds.isCovered("bob", 20_000), true, "bob is covered");
  restoreB(); restoreS();
}
console.log("ok - premium collection");

fresh();
{
  // Audits run automatically; a clean ledger passes and certifies.
  const restoreB = stubBanking(baseLedger());
  const restoreS = stubSites(["misthalin"]);
  Life.tickBankGuildLife(makeDirector([]), 10_000);
  const audits = Guilds.auditsFor("misthalin");
  assert.strictEqual(audits.length, 1, "auto-audit ran");
  assert.strictEqual(audits[0].verdict, "pass");
  assert.strictEqual(audits[0].auditor, "guild");
  restoreB(); restoreS();
}
console.log("ok - auto audit");

fresh();
{
  // Failed branch files real claims for covered depositors.
  const ledger = baseLedger();
  ledger.loans = {
    dave: { principal: 20000, owed: 25000, borrowedAt: 1, dueAt: 2, lastInterest: 1 },
  };
  const restoreB = stubBanking(ledger);
  const restoreS = stubSites(["misthalin"]);
  Guilds.markCovered("alice", 10_000);
  Guilds.markCovered("bob", 10_000);
  Life.tickBankGuildLife(makeDirector([]), 10_000);
  assert.strictEqual(Guilds.isBranchFailed("misthalin"), false, "one flag is not failure");
  Life.resetForTests();
  Life.tickBankGuildLife(makeDirector([]), 10_000 + 8 * 24 * 3600 * 1000);
  assert.strictEqual(Guilds.isBranchFailed("misthalin"), true, "two flags fail the branch");
  const claims = Guilds.openClaims("misthalin");
  assert.strictEqual(claims.length, 2, "both covered depositors get claims");
  restoreB(); restoreS();
}
console.log("ok - branch failure and claims");

Guilds.resetForTests();
console.log("ALL BANKGUILD LIFE TESTS PASS");
