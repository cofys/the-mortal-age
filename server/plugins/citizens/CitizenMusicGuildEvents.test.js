"use strict";

// Plain-node tests for the ::musicguild command.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const Module = require("module");
const origRequire = Module.prototype.require;

// --- Set up Guilds with a temp save BEFORE requiring events ---
const Guilds = require("./lib/CitizenMusicGuilds");
const savePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mge-")), "save.json");
Guilds._setSavePathForTests(savePath);
Guilds.resetForTests();

const stubs = {
  "./lib/CitizenMusicGuilds": Guilds,
  "./brain/CitizenSites": {
    kingdomIdOf: () => "varrock",
  },
  // Mutable so tests can stage professionals and concerts per case.
  "./CitizenMusicDance": {
    professionals: [],
    concerts: {},
    isStageProfessional: function (u) { return this.professionals.includes(String(u || "").toLowerCase()); },
    ensembleOf: () => null,
    concertFor: function (id) { return this.concerts[id] || null; },
    instrumentOf: () => null,
  },
  "./CitizenCareers": { careerOf: () => null },
  "./CitizenReputation": { awardDeed: () => {} },
};

Module.prototype.require = function (id) {
  if (Object.prototype.hasOwnProperty.call(stubs, id)) return stubs[id];
  return origRequire.apply(this, arguments);
};

const { onMusicGuildCommand } = require("./CitizenMusicGuildEvents");

function makePlayer(username, opts = {}) {
  const messages = [];
  return {
    username,
    getUsername: () => username,
    isPlayerBot: () => !!opts.isBot,
    coins: opts.coins ?? 1000,
    getInventory: () => ({
      // Real ItemContainer contract: getAmount(id), deleteNumber(id, amount),
      // adds(id, amount) for credits. There is no inv.count(id) and no
      // inv.remove(id, amount).
      getAmount: (id) => (id === 995 ? makePlayer.coinsRef.coins : 0),
      deleteNumber: (id, amt) => { if (id === 995) makePlayer.coinsRef.coins -= amt; },
      adds: (id, amt) => { if (id === 995 && amt > 0) makePlayer.coinsRef.coins += amt; },
    }),
    sendMessage: (text) => messages.push(text),
    _messages: messages,
  };
}
makePlayer.coinsRef = { coins: 1000 };

let passed = 0;
function test(name, fn) {
  // Fresh guild state per test.
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mge2-")), "save.json");
  Guilds._setSavePathForTests(p);
  Guilds.resetForTests();
  makePlayer.coinsRef.coins = 1000;
  stubs["./CitizenMusicDance"].professionals = [];
  stubs["./CitizenMusicDance"].concerts = {};
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

test("bots are rejected", () => {
  const player = makePlayer("BotBob", { isBot: true });
  onMusicGuildCommand(player, "status");
  assert.ok(player._messages[0].includes("Citizens work the guild"));
});

test("status shows guild info", () => {
  const player = makePlayer("Alice");
  onMusicGuildCommand(player, "status");
  // No guild yet — honest message.
  assert.ok(player._messages[0].includes("No Minstrels' Guild") || player._messages[0].includes("Minstrels' Guild"));
});

test("code shows the minstrels' code", () => {
  const player = makePlayer("Alice");
  onMusicGuildCommand(player, "code");
  assert.ok(player._messages[0].includes("Minstrels' Code"));
});

test("usage on unknown subcommand", () => {
  const player = makePlayer("Alice");
  onMusicGuildCommand(player, "frobnicate");
  assert.ok(player._messages[0].includes("::musicguild"));
});

test("certify requires concert id and title", () => {
  const player = makePlayer("Alice");
  onMusicGuildCommand(player, "certify");
  assert.ok(player._messages[0].includes("Usage"));
});

test("vote requires case id and verdict", () => {
  const player = makePlayer("Alice");
  onMusicGuildCommand(player, "vote");
  assert.ok(player._messages[0].includes("Usage"));
});

test("contribute requires positive coins", () => {
  const player = makePlayer("Alice");
  onMusicGuildCommand(player, "contribute -5");
  assert.ok(player._messages[0].includes("Usage"));
});

test("certify takes no coins when validation fails (pre-flight before payment)", () => {
  // Alice is a member, but she did NOT play in concert c1 — the old code
  // took the 50-coin fee first and then failed, silently eating the coins.
  stubs["./CitizenMusicDance"].professionals = ["alice"];
  stubs["./CitizenMusicDance"].concerts = {
    c1: { performers: ["Bob"], quality: 8, title: "Bob's Song" },
  };
  const player = makePlayer("Alice");
  onMusicGuildCommand(player, "join");
  assert.ok(Guilds.isGuildMember("Alice"));
  onMusicGuildCommand(player, "certify c1 My Song");
  assert.ok(player._messages.some((m) => m.includes("Certification failed: not-a-performer.")),
    `expected validation failure, got: ${player._messages.join(" | ")}`);
  assert.strictEqual(makePlayer.coinsRef.coins, 1000, "fee must not be taken on failed validation");
  assert.deepStrictEqual(Object.keys(Guilds.load().certifications), [], "no certification created");
});

test("certify success takes the fee exactly once and certifies", () => {
  stubs["./CitizenMusicDance"].professionals = ["alice"];
  stubs["./CitizenMusicDance"].concerts = {
    c2: { performers: ["Alice"], quality: 9, title: "Hit Song" },
  };
  const player = makePlayer("Alice");
  onMusicGuildCommand(player, "join");
  onMusicGuildCommand(player, "certify c2 Hit Song");
  assert.ok(player._messages.some((m) => m.includes("Grade A")),
    `expected grade A, got: ${player._messages.join(" | ")}`);
  assert.strictEqual(makePlayer.coinsRef.coins, 950, "exactly the 50-coin fee taken once");
  assert.strictEqual(Object.keys(Guilds.load().certifications).length, 1);
});

test("certify delivers the bounty into the player's inventory", () => {
  // FAIL-before: the guild deducted the bounty from its treasury and the
  // message said "Bounty paid", but the player never received the coins.
  stubs["./CitizenMusicDance"].professionals = ["alice"];
  stubs["./CitizenMusicDance"].concerts = {
    c3: { performers: ["Alice"], quality: 9, title: "Hit Song" },
  };
  const player = makePlayer("Alice");
  onMusicGuildCommand(player, "join");
  Guilds.contributeToFund("varrock", 200); // backs the bounty via the fund
  onMusicGuildCommand(player, "certify c3 Hit Song");
  const msg = player._messages[player._messages.length - 1];
  assert.ok(msg.includes("Bounty paid: 120 coins."), `got: ${msg}`);
  assert.strictEqual(makePlayer.coinsRef.coins, 1000 - Guilds.CERT_FEE + Guilds.CERT_BOUNTY.A,
    "the bounty must actually land in the player's inventory");
});

test("certify records the bounty as owed when the coin credit fails", () => {
  // A player whose inventory credit silently fails: the command must not
  // claim payment, and the bounty must be re-recorded as owed — never
  // invented, never destroyed.
  stubs["./CitizenMusicDance"].professionals = ["alice"];
  stubs["./CitizenMusicDance"].concerts = {
    c4: { performers: ["Alice"], quality: 9, title: "Hit Song" },
  };
  const messages = [];
  const broken = {
    username: "Alice",
    getUsername: () => "Alice",
    isRealPlayer: () => true,
    getInventory: () => ({
      getAmount: (id) => (id === 995 ? makePlayer.coinsRef.coins : 0),
      deleteNumber: (id, amt) => { if (id === 995) makePlayer.coinsRef.coins -= amt; },
      adds: (id, amt) => { /* broken credit: the coins never arrive */ },
    }),
    sendMessage: (t) => messages.push(t),
  };
  onMusicGuildCommand(broken, "join");
  Guilds.contributeToFund("varrock", 200);
  onMusicGuildCommand(broken, "certify c4 Hit Song");
  assert.ok(messages.some((m) => m.includes("could not be delivered")),
    `expected honest failure message, got: ${messages.join(" | ")}`);
  assert.ok(!messages.some((m) => m.includes("Bounty paid:")),
    "must not claim the bounty was paid");
  const certs = Object.values(Guilds.load().certifications);
  assert.strictEqual(certs.length, 1);
  assert.strictEqual(certs[0].bountyPaid, 0, "no bounty claimed as paid");
  assert.strictEqual(certs[0].bountyOwed, Guilds.CERT_BOUNTY.A, "bounty re-recorded as owed");
  const treas = Guilds.guildTreasuryFor("varrock");
  assert.strictEqual(treas.treasury, 0);
  assert.strictEqual(treas.instrumentFund, 200, "fund restored — no coins invented or destroyed");
});

test("certify fails honestly when the player cannot pay", () => {
  stubs["./CitizenMusicDance"].professionals = ["alice"];
  stubs["./CitizenMusicDance"].concerts = {
    c2: { performers: ["Alice"], quality: 9, title: "Hit Song" },
  };
  makePlayer.coinsRef.coins = 10; // cannot afford the 50-coin fee
  const player = makePlayer("Alice");
  onMusicGuildCommand(player, "join");
  onMusicGuildCommand(player, "certify c2 Hit Song");
  assert.ok(player._messages.some((m) => m.includes("Certification costs 50 coins.")),
    `expected fee message, got: ${player._messages.join(" | ")}`);
  assert.strictEqual(makePlayer.coinsRef.coins, 10, "no coins taken");
  assert.deepStrictEqual(Object.keys(Guilds.load().certifications), [], "no certification without payment");
});

test("mentored novice certifies free (normalized mentorship lookup)", () => {
  stubs["./CitizenMusicDance"].professionals = ["maestro max", "novice nora"];
  stubs["./CitizenMusicDance"].concerts = {
    c3: { performers: ["Novice Nora"], quality: 7, title: "First Song" },
  };
  const master = makePlayer("Maestro Max");
  const novice = makePlayer("Novice Nora");
  onMusicGuildCommand(master, "join");
  onMusicGuildCommand(novice, "join");
  Guilds.load().members["maestro max"].rank = "maestro";
  Guilds.touch();
  const ap = Guilds.takeApprentice("Maestro Max", "Novice Nora");
  assert.strictEqual(ap.ok, true);
  makePlayer.coinsRef.coins = 0; // broke — a fee would fail
  onMusicGuildCommand(novice, "certify c3 First Song");
  assert.ok(novice._messages.some((m) => m.includes("Performance certified!")),
    `expected free certification, got: ${novice._messages.join(" | ")}`);
  assert.strictEqual(Object.keys(Guilds.load().certifications).length, 1);
});

Module.prototype.require = origRequire;
console.log(`\n${passed} tests passed`);
