"use strict";

/**
 * CitizenPrizePayout.test.js — vanishing-coins regression tests for the
 * press Inkwell award and the trade fair prize.
 *
 * Both flows used to deduct from their fund and record "paid" while the
 * winner's bank account was never credited. These tests pin the fix:
 * the coins must actually land in the winner's real bank account, and
 * unreachable banking must leave the prize honestly owed (never marked
 * paid, fund restored).
 *
 * Run: node server/plugins/citizens/lib/CitizenPrizePayout.test.js
 */

const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");

// --- stubs (must be installed before requiring the guild modules) ---

const sitesPath = path.resolve(__dirname, "../brain/CitizenSites.js");
require.cache[sitesPath] = {
  id: sitesPath, filename: sitesPath, loaded: true,
  exports: {
    KINGDOM_IDS: ["varrock"],
    kingdomIdOf: (r) => r?.kingdomId || "varrock",
    siteTile: () => ({ x: 3200, y: 3200, z: 0 }),
    siteTileByKingdom: () => ({ x: 3200, y: 3200, z: 0 }),
  },
};

// Controllable CitizenPress fake.
const fakeJournalists = new Set();
const fakeStories = [];
const pressPath = path.resolve(__dirname, "./CitizenPress.js");
require.cache[pressPath] = {
  id: pressPath, filename: pressPath, loaded: true,
  exports: {
    BEATS: ["war"],
    isJournalist: (u) => fakeJournalists.has(String(u || "").toLowerCase()),
    registerJournalist: (u) => { fakeJournalists.add(String(u || "").toLowerCase()); return { ok: true }; },
    storyCountFor: () => 0,
    storiesFor: (kid, beat, windowMs) => {
      const now = Date.now();
      return fakeStories.filter((s) => s.kingdomId === kid && s.beat === beat && now - s.publishedAt < windowMs);
    },
    eventFor: (id) => ({ id }),
    pressTileFor: () => ({ x: 3200, y: 3200, z: 0 }),
    SUBSCRIPTION_PRICE: 5,
  },
};

// Controllable CitizenBanking fake: real accountFor/markDirty contract,
// with a kill-switch to simulate unreachable banking.
const bankAccounts = Object.create(null); // lowerName -> { balance }
let bankingDown = false;
const bankingPath = path.resolve(__dirname, "./CitizenBanking.js");
require.cache[bankingPath] = {
  id: bankingPath, filename: bankingPath, loaded: true,
  exports: {
    accountFor: (username) => {
      if (bankingDown) throw new Error("banking unreachable");
      const key = String(username || "").toLowerCase();
      if (!bankAccounts[key]) bankAccounts[key] = { username, balance: 0 };
      return bankAccounts[key];
    },
    markDirty: () => {},
  },
};

// --- real modules under test ---

const PressGuilds = require("./CitizenPressGuilds");
const TradeGuilds = require("./CitizenTradeGuilds");

function tmpSave(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "prizepay-")), name);
}

let passed = 0;
function test(name, fn) {
  PressGuilds.resetForTests();
  TradeGuilds.resetForTests();
  fakeJournalists.clear();
  fakeStories.length = 0;
  for (const k of Object.keys(bankAccounts)) delete bankAccounts[k];
  bankingDown = false;
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

function balanceOf(username) {
  const a = bankAccounts[String(username).toLowerCase()];
  return a ? a.balance : 0;
}

// --- press Inkwell award ---

test("press grantAward credits the winner's bank account (no more vanishing)", () => {
  fakeJournalists.add("nell");
  PressGuilds.joinGuild("Nell", "varrock");
  PressGuilds.creditTreasury("varrock", 500);
  fakeStories.push({
    id: "s1", eventId: "e1", beat: "war", author: "Nell",
    kingdomId: "varrock", headline: "H", quality: 8, publishedAt: Date.now(),
  });
  const r = PressGuilds.grantAward("varrock", "war");
  assert.ok(r.ok, "award should be granted");
  assert.strictEqual(r.award.prizeOwed, 0);
  assert.strictEqual(balanceOf("Nell"), PressGuilds.AWARD_PRIZE,
    "winner's bank account must actually receive the prize");
  assert.strictEqual(PressGuilds.guildTreasuryFor("varrock"), 500 - PressGuilds.AWARD_PRIZE);
});

test("press grantAward leaves prize honestly owed when banking is down", () => {
  fakeJournalists.add("nell");
  PressGuilds.joinGuild("Nell", "varrock");
  PressGuilds.creditTreasury("varrock", 500);
  fakeStories.push({
    id: "s1", eventId: "e1", beat: "war", author: "Nell",
    kingdomId: "varrock", headline: "H", quality: 8, publishedAt: Date.now(),
  });
  bankingDown = true;
  const r = PressGuilds.grantAward("varrock", "war");
  assert.ok(r.ok, "award is still granted (the honor stands)");
  assert.strictEqual(r.award.prizeOwed, PressGuilds.AWARD_PRIZE,
    "full prize must be honestly owed, not marked paid");
  assert.strictEqual(PressGuilds.guildTreasuryFor("varrock"), 500,
    "treasury must be restored when the credit failed");
  assert.strictEqual(balanceOf("Nell"), 0);
});

// --- trade fair prize ---

function setupFair(winnerName) {
  const kid = "varrock";
  TradeGuilds.ensureGuild(kid);
  const g = TradeGuilds.guildOf(kid);
  g.fairFund = 1000; // seed the fair fund directly (honestly tracked coins)
  return { kid, g };
}

test("trade resolveFair credits the winner's bank account", () => {
  const { kid } = setupFair();
  // enterFair requires licensed members; seed the fair record directly then resolve.
  const g = TradeGuilds.guildOf(kid);
  g.fairFund = 1000;
  g.fairs.push({
    id: "fair1", atMs: Date.now(), entries: ["Nell"], winner: null,
    prizePaid: 0, prizeOwed: 0, resolved: false,
  });
  // inspectionsFor must return a passing inspection for Nell.
  TradeGuilds.recordInspection(kid, "Zed", "Nell", { pass: true, worstRatio: 1.0 }, Date.now());
  // Nell needs a valid license to be eligible (buyLicense takes kingdomId first).
  const lic = TradeGuilds.buyLicense(kid, "Nell", Date.now());
  assert.ok(lic.ok, "Nell should get a license");
  const r = TradeGuilds.resolveFair(kid, null, Date.now());
  assert.ok(r.ok, "fair should resolve, got " + JSON.stringify(r));
  assert.ok(r.winner, "fair should crown a winner");
  assert.strictEqual(r.winner, "Nell");
  assert.strictEqual(balanceOf("Nell"), r.prizePaid,
    "winner's bank account must actually receive the prize");
  assert.strictEqual(r.prizeOwed, Math.max(0, TradeGuilds.FAIR_PRIZE - r.prizePaid));
});

test("trade retryFairOwed delivers honestly-owed prizes when funds return", () => {
  const { kid } = setupFair();
  const g = TradeGuilds.guildOf(kid);
  g.fairFund = 500;
  g.fairs.push({
    id: "fair1", atMs: Date.now(), entries: ["Nell"], winner: "Nell",
    prizePaid: 0, prizeOwed: 200, resolved: true,
  });
  const r = TradeGuilds.retryFairOwed(kid);
  assert.ok(r.ok);
  assert.strictEqual(r.paid, 200);
  assert.strictEqual(balanceOf("Nell"), 200);
  assert.strictEqual(g.fairs[0].prizeOwed, 0);
});

test("trade retryFairOwed keeps prize owed when banking is down", () => {
  const { kid } = setupFair();
  const g = TradeGuilds.guildOf(kid);
  g.fairFund = 500;
  g.fairs.push({
    id: "fair1", atMs: Date.now(), entries: ["Nell"], winner: "Nell",
    prizePaid: 0, prizeOwed: 200, resolved: true,
  });
  bankingDown = true;
  const r = TradeGuilds.retryFairOwed(kid);
  assert.ok(r.ok);
  assert.strictEqual(r.paid, 0);
  assert.strictEqual(g.fairs[0].prizeOwed, 200, "prize stays honestly owed");
  assert.strictEqual(g.fairFund, 500, "fund restored when the credit failed");
  assert.strictEqual(balanceOf("Nell"), 0);
});

console.log(`\n${passed} prize-payout tests passed`);
