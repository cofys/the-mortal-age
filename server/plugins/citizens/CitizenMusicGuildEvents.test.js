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
    isBot: !!opts.isBot,
    isRealPlayer: () => !opts.isBot,
    coins: opts.coins ?? 1000,
    getInventory: () => ({
      getAmount: (id) => (id === 995 ? makePlayer.coinsRef.coins : 0),
      remove: (id, amt) => { if (id === 995) makePlayer.coinsRef.coins -= amt; },
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

Module.prototype.require = origRequire;
console.log(`\n${passed} tests passed`);
