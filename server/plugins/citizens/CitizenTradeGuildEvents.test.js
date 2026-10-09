"use strict";

/**
 * CitizenTradeGuildEvents.test.js — plain-node tests for the ::tradeguild
 * command. Players and engine modules are stubbed; bots must be rejected
 * and every subcommand must fail honestly without engine state.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const Guilds = require("./lib/CitizenTradeGuilds");
const tmpSave = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tradeguild-ev-")), "save.json");
Guilds._setSavePathForTests(tmpSave);

// Stub engine modules BEFORE requiring the events module.
const sitesKey = require.resolve("./lib/../brain/CitizenSites");
require.cache[sitesKey] = {
  id: sitesKey, filename: sitesKey, loaded: true,
  exports: { kingdomIdOf: (p) => p?.kingdomId || null },
};

const { onTradeGuildCommand, TRADEGUILD_USAGE } = require("./CitizenTradeGuildEvents");

function fresh() {
  Guilds.resetForTests();
}

function makePlayer(username, opts = {}) {
  let coins = opts.coins ?? 0;
  const said = [];
  return {
    username,
    kingdomId: opts.kingdomId ?? "misthalin",
    isBot: !!opts.bot,
    isRealPlayer: () => !opts.bot,
    getUsername: () => username,
    getInventory: () => ({
      getAmount: (id) => (id === 995 ? coins : 0),
      count: (id) => (id === 995 ? coins : 0),
      remove: (id, n) => { if (id === 995 && coins >= n) { coins -= n; return true; } return false; },
    }),
    getAttribute: (k) => (k === "citizens:market-wares" && opts.wares ? JSON.stringify(opts.wares) : null),
    sendMessage: (t) => said.push(t),
    _said: said,
    _coins: () => coins,
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
    console.error(`FAIL: ${name}\n  ${e.message}`);
    process.exitCode = 1;
  }
}

test("bot rejected", () => {
  const p = makePlayer("Bot1", { bot: true, coins: 1000 });
  onTradeGuildCommand(p, ["status"]);
  assert.ok(p._said.join(" ").includes("not this command"), "bots get the rejection line");
});

test("status with no guild", () => {
  const p = makePlayer("Alice", { coins: 100 });
  onTradeGuildCommand(p, ["status"]);
  assert.ok(p._said.join(" ").includes("No merchants' association"), "honest empty state");
});

test("join requires trader proof", () => {
  const p = makePlayer("Bob", { coins: 100 });
  onTradeGuildCommand(p, ["join"]);
  assert.ok(p._said.join(" ").includes("Only real traders"), "non-trader rejected honestly");
  assert.strictEqual(Guilds.isGuildMember("Bob"), false);
});

test("stallholder can join", () => {
  const p = makePlayer("Cara", { coins: 100, wares: [{ id: 1, price: 10 }] });
  onTradeGuildCommand(p, ["join"]);
  assert.strictEqual(Guilds.isGuildMember("Cara"), true, "wares attribute proves stallholder");
  assert.ok(p._said.join(" ").includes("Welcome"));
});

test("dues honest failures", () => {
  const p = makePlayer("Dan", { coins: 0, wares: [{ id: 1, price: 10 }] });
  onTradeGuildCommand(p, ["dues"]);
  assert.ok(p._said.join(" ").includes("not a member"));
  onTradeGuildCommand(p, ["join"]);
  onTradeGuildCommand(p, ["dues"]);
  assert.ok(p._said.join(" ").includes("need 25 coins"), "broke member told honestly");
});

test("dues paid moves real coins", () => {
  const p = makePlayer("Eli", { coins: 1000, wares: [{ id: 1, price: 10 }] });
  onTradeGuildCommand(p, ["join"]);
  // join grants a first week; force dues due
  const g = Guilds.guildOf("misthalin");
  g.members["eli"].duesPaidUntilMs = Date.now() - 1;
  onTradeGuildCommand(p, ["dues"]);
  assert.strictEqual(p._coins(), 1000 - Guilds.DUES_WEEKLY);
  assert.ok(p._said.join(" ").includes("Dues paid"));
});

test("license flow", () => {
  const p = makePlayer("Fay", { coins: 50, wares: [{ id: 1, price: 10 }] });
  onTradeGuildCommand(p, ["license"]);
  assert.ok(p._said.join(" ").includes("Members only"));
  onTradeGuildCommand(p, ["join"]);
  onTradeGuildCommand(p, ["license"]);
  assert.ok(p._said.join(" ").includes("costs 100 coins"), "broke told the price");
  const rich = makePlayer("Fay", { coins: 500, wares: [{ id: 1, price: 10 }] });
  // note: same username, fresh player object with coins
  const g = Guilds.guildOf("misthalin");
  g.members["fay"] = g.members["fay"]; // keep membership
  onTradeGuildCommand(rich, ["license"]);
  assert.strictEqual(Guilds.licenseFor("Fay").valid, true);
  assert.strictEqual(rich._coins(), 400);
});

test("certify requires standing", () => {
  const p = makePlayer("Gus", { coins: 100 });
  onTradeGuildCommand(p, ["certify"]);
  assert.ok(p._said.join(" ").includes("good standing"));
  const t = makePlayer("Gus", { coins: 100, wares: [{ id: 1, price: 10 }] });
  onTradeGuildCommand(t, ["join"]);
  onTradeGuildCommand(t, ["certify"]);
  assert.ok(t._said.join(" ").includes("+3% profit"));
});

test("code lists standards", () => {
  const p = makePlayer("Hal", {});
  onTradeGuildCommand(p, ["code"]);
  assert.strictEqual(p._said.length, 1 + Guilds.STANDARDS_CODE.length);
});

test("report usage + honest no-record", () => {
  const p = makePlayer("Ivy", { coins: 100, wares: [{ id: 1, price: 10 }] });
  onTradeGuildCommand(p, ["join"]);
  onTradeGuildCommand(p, ["report"]);
  assert.ok(p._said.join(" ").includes("Usage:"));
  onTradeGuildCommand(p, ["report", "Nobody", "unlicensed"]);
  assert.ok(p._said.join(" ").includes("no record"), "strangers cannot be reported");
});

test("vote restricted to merchantmasters", () => {
  const p = makePlayer("Jay", { coins: 100, wares: [{ id: 1, price: 10 }] });
  onTradeGuildCommand(p, ["join"]);
  onTradeGuildCommand(p, ["vote", "case_x", "guilty"]);
  assert.ok(p._said.join(" ").includes("merchantmasters only"));
});

test("school shows progress", () => {
  const p = makePlayer("Kim", { coins: 100, wares: [{ id: 1, price: 10 }] });
  onTradeGuildCommand(p, ["school"]);
  assert.ok(p._said.join(" ").includes("not a member"));
  onTradeGuildCommand(p, ["join"]);
  onTradeGuildCommand(p, ["school"]);
  assert.ok(p._said.join(" ").includes("Rank: peddler"));
});

test("unknown subcommand shows usage", () => {
  const p = makePlayer("Leo", {});
  onTradeGuildCommand(p, ["frobnicate"]);
  assert.ok(p._said[p._said.length - 1].includes("::tradeguild"), "usage line shown");
  assert.ok(TRADEGUILD_USAGE.includes("::tradeguild"));
});

test("fairs honest empty", () => {
  const p = makePlayer("Mia", {});
  onTradeGuildCommand(p, ["fairs"]);
  assert.ok(p._said.join(" ").includes("No trade fairs"));
});

console.log(`\n${passed} CitizenTradeGuildEvents tests passed.`);
