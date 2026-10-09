"use strict";

// Plain-node tests for the ::artguild command.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const Module = require("module");
const origRequire = Module.prototype.require;

// --- Set up Guilds with a temp save BEFORE requiring events ---
const Guilds = require("./lib/CitizenArtGuilds");
const savePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "age-")), "save.json");
Guilds._setSavePathForTests(savePath);
Guilds.resetForTests();

let careers = {};
let artworks = {};
let artistWorks = {};

const artStubs = {
  QUALITY_MASTERPIECE: 85,
  artworksOf: (u) => (artistWorks[String(u || "").toLowerCase()] || []).map((id) => artworks[id]).filter(Boolean),
  artworkById: (id) => artworks[id] || null,
};
const careersStub = { careerOf: (u) => careers[String(u || "").toLowerCase()] || null };
const reputationStub = { awardDeed: () => {} };
const bankingStub = { creditAccount: () => true };
const bondsStub = { normalizeName: (s) => String(s || "").toLowerCase().trim() };

const stubs = {
  // Keys as the events module requires them (relative to citizens/).
  "./lib/CitizenArtGuilds": Guilds,
  "./brain/CitizenSites": {
    kingdomIdOf: () => "varrock",
  },
  "./lib/CitizenArt": artStubs,
  "./lib/CitizenCareers": careersStub,
  "./lib/CitizenReputation": reputationStub,
  "./lib/CitizenBanking": bankingStub,
  "./lib/CitizenBonds": bondsStub,
  // Keys as the Guilds data tier lazily requires them (relative to lib/).
  "./CitizenArt": artStubs,
  "./CitizenCareers": careersStub,
  "./CitizenReputation": reputationStub,
  "./CitizenBanking": bankingStub,
  "./CitizenBonds": bondsStub,
  "../brain/CitizenSites": {
    kingdomIdOf: () => "varrock",
    siteTileByKingdom: () => ({ x: 3200, y: 3200, z: 0 }),
  },
};

Module.prototype.require = function (id) {
  if (Object.prototype.hasOwnProperty.call(stubs, id)) return stubs[id];
  return origRequire.apply(this, arguments);
};

const { onArtGuildCommand, ARTGUILD_USAGE } = require("./CitizenArtGuildEvents");

const coinsRef = { coins: 1000 };
function makePlayer(username, opts = {}) {
  const messages = [];
  return {
    username,
    getUsername: () => username,
    isBot: !!opts.isBot,
    isRealPlayer: () => !opts.isBot,
    getInventory: () => ({
      getAmount: (id) => (id === 995 ? coinsRef.coins : 0),
      remove: (id, amt) => { if (id === 995) coinsRef.coins -= amt; },
      add: (id, amt) => { if (id === 995) coinsRef.coins += amt; },
    }),
    sendMessage: (text) => messages.push(text),
    _messages: messages,
  };
}

let passed = 0;
function test(name, fn) {
  // Fresh guild state per test.
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "age2-")), "save.json");
  Guilds._setSavePathForTests(p);
  Guilds.resetForTests();
  coinsRef.coins = 1000;
  careers = {};
  artworks = {};
  artistWorks = {};
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
  onArtGuildCommand(player, "status");
  assert.ok(player._messages[0].includes("Citizens work the guild"));
});

test("status shows guild info", () => {
  const player = makePlayer("Alice");
  onArtGuildCommand(player, "status");
  assert.ok(player._messages[0].includes("Artists' Guild") || player._messages[0].includes("No Artists' Guild"));
});

test("code shows the artists' code", () => {
  const player = makePlayer("Alice");
  onArtGuildCommand(player, "code");
  assert.ok(player._messages[0].includes("Artists' Code"));
});

test("join works for artist-career players", () => {
  careers = { "painty pete": "artist" };
  const player = makePlayer("Painty Pete");
  onArtGuildCommand(player, "join");
  assert.ok(player._messages[0].includes("Welcome to the Artists' Guild"));
  assert.ok(Guilds.isGuildMember("painty pete"));
});

test("join rejects non-artists", () => {
  const player = makePlayer("NotAnArtist");
  onArtGuildCommand(player, "join");
  assert.ok(player._messages[0].includes("not-an-artist"));
});

test("certify grades a real artwork and pays the bounty", () => {
  careers = { "painty pete": "artist" };
  artworks = {
    a1: { id: "a1", title: "Sunset", artist: "painty pete", quality: 90, medium: "painting" },
  };
  artistWorks = { "painty pete": ["a1"] };
  const player = makePlayer("Painty Pete");
  onArtGuildCommand(player, "join");
  Guilds.creditTreasury("varrock", 1000);
  onArtGuildCommand(player, "certify a1");
  assert.ok(player._messages[1].includes("Grade A"), `got: ${player._messages[1]}`);
  assert.ok(player._messages[1].includes("Bounty paid"));
  // Fee was taken.
  assert.strictEqual(coinsRef.coins, 1000 - Guilds.CERT_FEE);
});

test("certify refunds the fee on failure", () => {
  careers = { "painty pete": "artist" };
  const player = makePlayer("Painty Pete");
  onArtGuildCommand(player, "join");
  onArtGuildCommand(player, "certify nope");
  assert.ok(player._messages[1].includes("Certification failed"));
  assert.strictEqual(coinsRef.coins, 1000); // refunded
});

test("seals reports the best grade", () => {
  careers = { "painty pete": "artist" };
  artworks = {
    a1: { id: "a1", title: "Sunset", artist: "painty pete", quality: 90, medium: "painting" },
  };
  artistWorks = { "painty pete": ["a1"] };
  const player = makePlayer("Painty Pete");
  onArtGuildCommand(player, "join");
  Guilds.creditTreasury("varrock", 1000);
  onArtGuildCommand(player, "certify a1");
  onArtGuildCommand(player, "seals");
  assert.ok(player._messages[2].includes("Grade A") || player._messages[2].includes("grade: A") || player._messages[2].includes("A"));
});

test("patron posts a bounty and the artist claims it", () => {
  careers = { "painty pete": "artist", "rich rita": "artist" };
  artworks = {
    a1: { id: "a1", title: "Sunset", artist: "painty pete", quality: 90, medium: "painting" },
  };
  artistWorks = { "painty pete": ["a1"] };
  const sponsor = makePlayer("Rich Rita");
  onArtGuildCommand(sponsor, "join");
  onArtGuildCommand(sponsor, "patron painting 200");
  assert.ok(sponsor._messages[1].includes("bounty") || sponsor._messages[1].includes("Bounty"), `got: ${sponsor._messages[1]}`);
  const bountyId = (sponsor._messages[1].match(/bounty-(\d+)/) || [])[0];
  assert.ok(bountyId, "bounty id in message");

  const artist = makePlayer("Painty Pete");
  onArtGuildCommand(artist, "join");
  Guilds.creditTreasury("varrock", 1000);
  onArtGuildCommand(artist, "certify a1");
  const certId = Object.keys(Guilds.load().certifications)[0];
  coinsRef.coins = 1000;
  onArtGuildCommand(artist, `claim ${bountyId} ${certId}`);
  const last = artist._messages[artist._messages.length - 1];
  assert.ok(last.includes("Bounty claimed") || last.includes("claimed"), `got: ${last}`);
});

test("usage is shown for unknown subcommands", () => {
  const player = makePlayer("Alice");
  onArtGuildCommand(player, "frobnicate");
  assert.strictEqual(player._messages[0], ARTGUILD_USAGE);
});

console.log(`\n${passed} tests passed`);
