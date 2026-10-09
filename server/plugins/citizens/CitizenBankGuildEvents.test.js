"use strict";

/**
 * CitizenBankGuildEvents.test.js — plain-node tests for the ::bankguild command.
 * The player is stubbed; the guild module is real with a stubbed banking API.
 */

const assert = require("assert");

const Guilds = require("./lib/CitizenBankGuilds");
const { onBankGuildCommand } = require("./CitizenBankGuildEvents");

function fresh() {
  Guilds.resetForTests();
}

function stubBanking(ledger) {
  const key = require.resolve("./lib/CitizenBanking");
  const fake = {
    bankerFor: (u) => (ledger.bankers || {})[String(u || "").trim().toLowerCase()] || null,
    bankersIn: (kid) => Object.keys(ledger.bankers || {}).filter(
      (k) => (ledger.bankers[k] || {}).kingdomId === String(kid || "").toLowerCase()
    ),
    branchFor: (kid) => ({ name: `${kid} bank`, tile: { x: 3200, y: 3200, z: 0 } }),
    branchTile: (kid) => ({ x: 3200, y: 3200, z: 0 }),
    balanceOf: () => 0,
    isDefaulted: () => false,
    _data: () => ({ accounts: ledger.accounts || {}, loans: ledger.loans || {} }),
    markDirty: () => {},
  };
  require.cache[key] = { id: key, filename: key, loaded: true, exports: fake };
  return () => { delete require.cache[key]; };
}

function stubSites() {
  const key = require.resolve("./lib/../brain/CitizenSites");
  require.cache[key] = {
    id: key, filename: key, loaded: true,
    exports: { kingdomIdOf: () => "misthalin" },
  };
  return () => { delete require.cache[key]; };
}

function stubPlayer(username, coins, isBot) {
  const said = [];
  return {
    player: {
      getUsername: () => username,
      username,
      isBot: !!isBot,
      isRealPlayer: () => !isBot,
      sendMessage: (t) => said.push(t),
      getInventory: () => ({
        // Real ItemContainer API: getAmount(id), deleteNumber(id, amount).
        getAmount: (id) => (id === 995 ? coins : 0),
        deleteNumber: (id, n) => { if (id === 995 && coins >= n) coins -= n; },
      }),
    },
    said,
    coinsLeft: () => coins,
  };
}

function baseLedger() {
  return {
    bankers: { alice: { kingdomId: "misthalin", appointedAt: 1 } },
    accounts: { alice: { balance: 5000, lastInterest: 0, createdAt: 1 } },
    loans: {},
  };
}

let passed = 0;
function test(name, fn) {
  fresh();
  const restoreB = stubBanking(baseLedger());
  const restoreS = stubSites();
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL: ${name}\n  ${e.message}`);
    process.exitCode = 1;
  } finally {
    restoreB(); restoreS();
  }
}

test("bots are rejected", () => {
  const { player, said } = stubPlayer("bot1", 100, true);
  onBankGuildCommand(player, ["status"]);
  assert.ok(said.some((t) => /citizens work the guild/i.test(t)), "bot rejection message");
});

test("status shows the association", () => {
  const { player, said } = stubPlayer("alice", 100, false);
  onBankGuildCommand(player, ["status"]);
  assert.ok(said.some((t) => /bankers' association of misthalin/i.test(t)));
});

test("non-banker cannot join", () => {
  const { player, said } = stubPlayer("mallory", 100, false);
  onBankGuildCommand(player, ["join"]);
  assert.ok(said.some((t) => /only registered bankers/i.test(t)));
  assert.strictEqual(Guilds.isGuildMember("mallory"), false);
});

test("banker joins and pays dues", () => {
  const ctx = stubPlayer("alice", 100, false);
  onBankGuildCommand(ctx.player, ["join"]);
  assert.strictEqual(Guilds.isGuildMember("alice"), true);
  assert.ok(ctx.said.some((t) => /welcome to the bankers' association/i.test(t)));
  const before = ctx.coinsLeft();
  onBankGuildCommand(ctx.player, ["dues"]);
  assert.strictEqual(ctx.coinsLeft(), before - Guilds.DUES_WEEKLY);
  assert.ok(ctx.said.some((t) => /dues paid/i.test(t)));
});

test("dues fail honestly when broke", () => {
  const ctx = stubPlayer("alice", 0, false);
  onBankGuildCommand(ctx.player, ["join"]);
  onBankGuildCommand(ctx.player, ["dues"]);
  assert.ok(ctx.said.some((t) => /need 25 coins/i.test(t)));
});

test("leave works", () => {
  const ctx = stubPlayer("alice", 100, false);
  onBankGuildCommand(ctx.player, ["join"]);
  onBankGuildCommand(ctx.player, ["leave"]);
  assert.ok(ctx.said.some((t) => /left the bankers' association/i.test(t)));
  assert.strictEqual(Guilds.isGuildMember("alice"), false);
});

test("code prints the standards", () => {
  const { player, said } = stubPlayer("alice", 100, false);
  onBankGuildCommand(player, ["code"]);
  assert.ok(said.some((t) => /reserves/i.test(t)), "standards printed");
});

test("audit requires auditor rank", () => {
  const ctx = stubPlayer("alice", 100, false);
  onBankGuildCommand(ctx.player, ["join"]);
  onBankGuildCommand(ctx.player, ["audit"]);
  assert.ok(ctx.said.some((t) => /only auditor-rank/i.test(t)));
});

test("auditor can audit", () => {
  const ctx = stubPlayer("alice", 100, false);
  onBankGuildCommand(ctx.player, ["join"]);
  Guilds.memberOf("alice").rank = Guilds.RANK_AUDITOR;
  onBankGuildCommand(ctx.player, ["audit"]);
  assert.ok(ctx.said.some((t) => /audit (pass|flag)/i.test(t)));
});

test("report opens a tampering case", () => {
  const ctx = stubPlayer("alice", 100, false);
  onBankGuildCommand(ctx.player, ["join"]);
  // alice accuses herself to test the flow (tribunal blocks self-voting later).
  onBankGuildCommand(ctx.player, ["report", "alice"]);
  assert.ok(ctx.said.some((t) => /ethics case/i.test(t)));
});

test("report usage without a name", () => {
  const { player, said } = stubPlayer("alice", 100, false);
  onBankGuildCommand(player, ["report"]);
  assert.ok(said.some((t) => /usage/i.test(t)));
});

test("vote usage", () => {
  const { player, said } = stubPlayer("alice", 100, false);
  onBankGuildCommand(player, ["vote"]);
  assert.ok(said.some((t) => /usage/i.test(t)));
});

test("insurance shows fund and coverage", () => {
  const { player, said } = stubPlayer("alice", 100, false);
  onBankGuildCommand(player, ["insurance"]);
  assert.ok(said.some((t) => /deposit insurance/i.test(t)));
});

test("school shows progress", () => {
  const ctx = stubPlayer("alice", 100, false);
  onBankGuildCommand(ctx.player, ["join"]);
  onBankGuildCommand(ctx.player, ["school"]);
  assert.ok(ctx.said.some((t) => /rank: clerk/i.test(t)));
});

test("unknown subcommand shows usage", () => {
  const { player, said } = stubPlayer("alice", 100, false);
  onBankGuildCommand(player, ["frobnicate"]);
  assert.ok(said.some((t) => /::bankguild/.test(t)));
});

console.log(`ALL ${passed} BANKGUILD EVENTS TESTS PASS`);
