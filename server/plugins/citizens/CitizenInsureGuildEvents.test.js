"use strict";

/**
 * CitizenInsureGuildEvents.test.js — plain-node tests for the ::insureguild command.
 * The player is stubbed; the guild module is real with a stubbed insurance API.
 */

const assert = require("assert");

const Guilds = require("./lib/CitizenInsureGuilds");
const { onInsureGuildCommand } = require("./CitizenInsureGuildEvents");

function fresh() {
  Guilds.resetForTests();
}

const POLICY_TYPES = {
  life: { label: "life", maxFace: 100000, minFace: 1000 },
  health: { label: "health", maxFace: 20000, minFace: 500 },
  property: { label: "property", maxFace: 50000, minFace: 1000 },
  travel: { label: "travel", maxFace: 25000, minFace: 500 },
};

function stubInsurance(ledger) {
  const key = require.resolve("./lib/CitizenInsurance");
  const fake = {
    POLICY_TYPES,
    insurerFor: (u) => (ledger.insurers || {})[String(u || "").trim().toLowerCase()] || null,
    insurersIn: (kid) => Object.keys(ledger.insurers || {}).filter(
      (k) => (ledger.insurers[k] || {}).kingdomId === String(kid || "").toLowerCase()
    ),
    totalExposure: () => ledger.exposure ?? 0,
    poolBalance: () => ledger.pool ?? 0,
    officeTile: (kid) => ({ x: 3200, y: 3200, z: 0 }),
    coverOwedPayout: () => 0,
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
        count: (id) => (id === 995 ? coins : 0),
        getAmount: (id) => (id === 995 ? coins : 0),
        remove: (id, n) => { if (id === 995 && coins >= n) { coins -= n; return true; } return false; },
      }),
    },
    said,
    coinsLeft: () => coins,
  };
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
  const restoreI = stubInsurance(baseLedger());
  const restoreS = stubSites();
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL: ${name}\n  ${e.message}`);
    process.exitCode = 1;
  } finally {
    restoreI(); restoreS();
  }
}

test("bots are rejected", () => {
  const { player, said } = stubPlayer("bot1", 100, true);
  onInsureGuildCommand(player, ["status"]);
  assert.ok(said.join(" ").includes("not this command"));
});

test("status shows the guild", () => {
  const { player, said } = stubPlayer("alice", 1000, false);
  onInsureGuildCommand(player, ["join"]);
  said.length = 0;
  onInsureGuildCommand(player, ["status"]);
  const text = said.join(" ");
  assert.ok(text.includes("Underwriters' association"));
  assert.ok(text.includes("misthalin"));
});

test("status is honest before the guild exists", () => {
  const { player, said } = stubPlayer("alice", 1000, false);
  onInsureGuildCommand(player, ["status"]);
  assert.ok(said.join(" ").includes("No underwriters' association here yet"));
});

test("join requires a real insurer", () => {
  const { player, said } = stubPlayer("mallory", 1000, false);
  onInsureGuildCommand(player, ["join"]);
  assert.ok(said.join(" ").includes("Only registered insurers"));
  assert.ok(!Guilds.isGuildMember("mallory"));
});

test("join works for a registered insurer", () => {
  const { player, said } = stubPlayer("alice", 1000, false);
  onInsureGuildCommand(player, ["join"]);
  assert.ok(said.join(" ").includes("Welcome"));
  assert.ok(Guilds.isGuildMember("alice"));
});

test("dues takes real coins", () => {
  const ctx = stubPlayer("alice", 1000, false);
  onInsureGuildCommand(ctx.player, ["join"]);
  const before = ctx.coinsLeft();
  onInsureGuildCommand(ctx.player, ["dues"]);
  assert.strictEqual(ctx.coinsLeft(), before - Guilds.DUES_WEEKLY);
  assert.ok(ctx.said.join(" ").includes("Dues paid"));
});

test("dues fails honestly when broke", () => {
  const ctx = stubPlayer("alice", 0, false);
  onInsureGuildCommand(ctx.player, ["join"]);
  onInsureGuildCommand(ctx.player, ["dues"]);
  assert.ok(ctx.said.join(" ").includes("need 25 coins"));
});

test("code prints the standards", () => {
  const { player, said } = stubPlayer("alice", 100, false);
  onInsureGuildCommand(player, ["code"]);
  assert.ok(said.join(" ").includes("Reserves"));
});

test("reviews lists past reviews", () => {
  const { player, said } = stubPlayer("alice", 100, false);
  onInsureGuildCommand(player, ["reviews"]);
  assert.ok(said.join(" ").includes("No reviews yet"));
  Guilds.conductReview("misthalin", "guild");
  said.length = 0;
  onInsureGuildCommand(player, ["reviews"]);
  assert.ok(said.join(" ").includes("PASS"));
});

test("review requires actuary rank", () => {
  const { player, said } = stubPlayer("alice", 100, false);
  onInsureGuildCommand(player, ["join"]);
  onInsureGuildCommand(player, ["review"]);
  assert.ok(said.join(" ").includes("Only actuary-rank"));
});

test("report needs a name and real evidence", () => {
  const { player, said } = stubPlayer("alice", 100, false);
  onInsureGuildCommand(player, ["report"]);
  assert.ok(said.join(" ").includes("Usage"));
  said.length = 0;
  onInsureGuildCommand(player, ["report", "bob"]);
  assert.ok(said.join(" ").includes("no-evidence"));
});

test("cases shows open cases", () => {
  const { player, said } = stubPlayer("alice", 100, false);
  onInsureGuildCommand(player, ["cases"]);
  assert.ok(said.join(" ").includes("No open ethics cases"));
});

test("vote usage is explained", () => {
  const { player, said } = stubPlayer("alice", 100, false);
  onInsureGuildCommand(player, ["vote"]);
  assert.ok(said.join(" ").includes("Usage"));
});

test("reinsurance shows the fund", () => {
  const { player, said } = stubPlayer("alice", 100, false);
  onInsureGuildCommand(player, ["reinsurance"]);
  const text = said.join(" ");
  assert.ok(text.includes("Reinsurance"));
  assert.ok(text.includes("fund holds 0 coins"));
});

test("contribute takes real coins and grows the fund", () => {
  const ctx = stubPlayer("alice", 1000, false);
  onInsureGuildCommand(ctx.player, ["contribute", "200"]);
  assert.strictEqual(ctx.coinsLeft(), 800);
  assert.strictEqual(Guilds.reinsuranceFundOf("misthalin"), 200);
  assert.ok(ctx.said.join(" ").includes("Contributed 200 coins"));
});

test("contribute rejects bad amounts", () => {
  const { player, said } = stubPlayer("alice", 1000, false);
  onInsureGuildCommand(player, ["contribute", "0"]);
  assert.ok(said.join(" ").includes("Usage"));
  onInsureGuildCommand(player, ["contribute"]);
  assert.ok(said.join(" ").includes("Usage"));
});

test("school reports rank and progress", () => {
  const { player, said } = stubPlayer("alice", 100, false);
  onInsureGuildCommand(player, ["join"]);
  said.length = 0;
  onInsureGuildCommand(player, ["school"]);
  const text = said.join(" ");
  assert.ok(text.includes("Rank: agent"));
  assert.ok(text.includes("Training credits: 0"));
});

test("leave removes membership", () => {
  const { player, said } = stubPlayer("alice", 100, false);
  onInsureGuildCommand(player, ["join"]);
  assert.ok(Guilds.isGuildMember("alice"));
  onInsureGuildCommand(player, ["leave"]);
  assert.ok(!Guilds.isGuildMember("alice"));
  assert.ok(said.join(" ").includes("left the underwriters' association"));
});

test("unknown subcommand prints usage", () => {
  const { player, said } = stubPlayer("alice", 100, false);
  onInsureGuildCommand(player, ["frobnicate"]);
  assert.ok(said.join(" ").includes("::insureguild"));
});

console.log(`\n${passed} tests passed`);
