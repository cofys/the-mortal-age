"use strict";

/**
 * CitizenMapGuildEvents.test.js — ::mapguild command contracts without a server.
 *
 * Run: node server/plugins/citizens/CitizenMapGuildEvents.test.js
 */

const assert = require("assert");
const path = require("path");

// --- stubs ---

const sitesPath = path.resolve(__dirname, "./lib/../brain/CitizenSites.js");
require.cache[sitesPath] = {
  id: sitesPath, filename: sitesPath, loaded: true,
  exports: { KINGDOM_IDS: ["varrock"], kingdomIdOf: () => "varrock" },
};

const fakeListings = { varrock: [] };
const fakeCartographers = new Set();
const mapsPath = path.resolve(__dirname, "./lib/CitizenMaps.js");
require.cache[mapsPath] = {
  id: mapsPath, filename: mapsPath, loaded: true,
  exports: {
    MAP_TYPES: ["world", "city", "dungeon", "treasure"],
    MAT_PAPYRUS: 970,
    isCartographer: (u) => fakeCartographers.has(String(u || "").toLowerCase()),
    registerCartographer: (u) => { fakeCartographers.add(String(u || "").toLowerCase()); return { ok: true }; },
    listingsFor: (kid) => fakeListings[String(kid)] || [],
    shopOf: (kid) => ({ kingdomId: kid, tile: { x: 3200, y: 3200, z: 0 } }),
    ensureShop: (kid) => ({ kingdomId: kid, tile: { x: 3200, y: 3200, z: 0 } }),
    listMap: () => true,
  },
};

// --- real modules under test ---

const Guilds = require("./lib/CitizenMapGuilds");
const { onMapGuildCommand, MAPGUILD_USAGE } = require("./CitizenMapGuildEvents");

function makePlayer(username, coins, isBot) {
  let c = coins;
  const messages = [];
  return {
    messages,
    getUsername: () => username,
    username,
    isBot: !!isBot,
    isRealPlayer: () => !isBot,
    getInventory: () => ({
      // Real ItemContainer API: getAmount(id), adds(id, amount), deleteNumber(id, amount).
      getAmount: (id) => (id === 995 ? c : 0),
      adds: (id, n) => { if (id === 995 && n > 0) c += n; },
      deleteNumber: (id, n) => { if (id === 995 && c >= n) c -= n; },
    }),
    sendMessage: (t) => messages.push(t),
    __coins: () => c,
  };
}

function reset() {
  Guilds.resetForTests();
  fakeCartographers.clear();
  fakeListings.varrock = [];
}

let passed = 0;
function test(name, fn) {
  reset();
  try {
    fn();
    passed++;
  } catch (e) {
    console.error(`FAIL: ${name}\n  ${e.message}`);
    process.exitCode = 1;
  }
}

function said(p) { return p.messages.join("\n"); }

test("bots are rejected", () => {
  const p = makePlayer("Bot1", 1000, true);
  onMapGuildCommand(p, ["status"]);
  assert.match(said(p), /own sessions/);
});

test("join requires cartographer status", () => {
  const p = makePlayer("Newbie", 1000, false);
  onMapGuildCommand(p, ["join"]);
  assert.match(said(p), /Only registered cartographers/);
  fakeCartographers.add("newbie");
  onMapGuildCommand(p, ["join"]);
  assert.match(said(p), /Welcome to the Grand Cartographers' Guild/);
  assert.ok(Guilds.isGuildMember("Newbie"));
});

test("status shows rank, certs, dues", () => {
  fakeCartographers.add("pat");
  const p = makePlayer("Pat", 1000, false);
  onMapGuildCommand(p, ["join"]);
  onMapGuildCommand(p, ["status"]);
  assert.match(said(p), /Guild rank: apprentice/);
  assert.match(said(p), /Certified maps: 0/);
});

test("dues moves real coins", () => {
  fakeCartographers.add("quinn");
  const p = makePlayer("Quinn", 100, false);
  onMapGuildCommand(p, ["join"]);
  onMapGuildCommand(p, ["dues"]);
  assert.strictEqual(p.__coins(), 75);
  assert.strictEqual(Guilds.guildTreasuryFor("varrock"), 25);
  assert.match(said(p), /Dues paid/);
});

test("certify flow: fee, review, honest failures", () => {
  fakeCartographers.add("rae");
  const p = makePlayer("Rae", 1000, false);
  onMapGuildCommand(p, ["join"]);
  // No map id.
  onMapGuildCommand(p, ["certify"]);
  assert.match(said(p), /Certify what/);
  // Not listed.
  onMapGuildCommand(p, ["certify", "nope"]);
  assert.match(said(p), /not listed in the guild's map shop/);
  // Listed and good -> submitted.
  fakeListings.varrock.push({ map: { id: "rm1", creator: "Rae", type: "world", quality: 8 }, price: 100 });
  const before = p.__coins();
  onMapGuildCommand(p, ["certify", "rm1"]);
  assert.strictEqual(p.__coins(), before - 50);
  assert.match(said(p), /Submitted for guild review/);
  // Settle and check the seal.
  Guilds.creditTreasury("varrock", 1000);
  Guilds.processCertifications(Date.now());
  assert.strictEqual(Guilds.certifiedGradeFor("rm1"), "B");
});

test("certify failure refunds the fee honestly", () => {
  fakeCartographers.add("sam");
  const p = makePlayer("Sam", 1000, false);
  onMapGuildCommand(p, ["join"]);
  onMapGuildCommand(p, ["certify", "ghost"]);
  assert.strictEqual(p.__coins(), 1000); // refunded
  assert.strictEqual(Guilds.guildTreasuryFor("varrock"), 0);
});

test("bounty post and claim with real coins", () => {
  fakeCartographers.add("tess");
  const p = makePlayer("Tess", 1000, false);
  onMapGuildCommand(p, ["join"]);
  onMapGuildCommand(p, ["post", "dungeon", "200"]);
  assert.strictEqual(p.__coins(), 800);
  assert.match(said(p), /Survey bounty posted/);
  onMapGuildCommand(p, ["bounties"]);
  assert.match(said(p), /dungeon chart/);
  // Claim without proof fails.
  const b = Guilds.activeBounties("varrock")[0];
  onMapGuildCommand(p, ["claim", b.id]);
  assert.match(said(p), /need a guild-certified chart/);
  // Certify a dungeon chart, then claim.
  fakeListings.varrock.push({ map: { id: "tm1", creator: "Tess", type: "dungeon", quality: 7 }, price: 100 });
  onMapGuildCommand(p, ["certify", "tm1"]);
  Guilds.processCertifications(Date.now());
  onMapGuildCommand(p, ["claim", b.id]);
  assert.match(said(p), /Bounty claimed! 200 coins/);
});

test("archive lists sealed charts", () => {
  fakeCartographers.add("uma");
  const p = makePlayer("Uma", 1000, false);
  onMapGuildCommand(p, ["join"]);
  onMapGuildCommand(p, ["archive"]);
  assert.match(said(p), /archive is empty/);
  fakeListings.varrock.push({ map: { id: "um1", creator: "Uma", type: "city", quality: 9 }, price: 100 });
  onMapGuildCommand(p, ["certify", "um1"]);
  Guilds.processCertifications(Date.now());
  onMapGuildCommand(p, ["archive"]);
  assert.match(said(p), /\[A\] city by Uma/);
});

test("leave works and usage is exported", () => {
  fakeCartographers.add("vic");
  const p = makePlayer("Vic", 1000, false);
  onMapGuildCommand(p, ["join"]);
  assert.ok(Guilds.isGuildMember("Vic"));
  onMapGuildCommand(p, ["leave"]);
  assert.ok(!Guilds.isGuildMember("Vic"));
  assert.match(said(p), /left the guild/);
  assert.ok(MAPGUILD_USAGE.includes("::mapguild"));
});

console.log(`CitizenMapGuildEvents: ${passed} tests passed`);
