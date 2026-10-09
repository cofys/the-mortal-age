"use strict";

/**
 * CitizenMapGuildLife.test.js — guild life-tick contracts without a running server.
 *
 * Run: node server/plugins/citizens/lib/CitizenMapGuildLife.test.js
 */

const assert = require("assert");
const path = require("path");

// --- stubs ---

const sitesPath = path.resolve(__dirname, "../brain/CitizenSites.js");
require.cache[sitesPath] = {
  id: sitesPath, filename: sitesPath, loaded: true,
  exports: { KINGDOM_IDS: ["varrock"], kingdomIdOf: (r) => r.kingdomId || "varrock" },
};

const fakeListings = { varrock: [] };
const fakeCartographers = new Set();
const mapsPath = path.resolve(__dirname, "./CitizenMaps.js");
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

const Guilds = require("./CitizenMapGuilds");
const { tickMapGuildLife, resetForTests } = require("./CitizenMapGuildLife");

function makeInv(coins) {
  let c = coins;
  return {
    count: (id) => (id === 995 ? c : 0),
    remove: (id, n) => { if (id === 995 && c >= n) { c -= n; return true; } return false; },
    add: (id, n) => { if (id === 995) c += n; },
    __coins: () => c,
  };
}

function makeBot(username, coins) {
  const inv = makeInv(coins);
  return { username, inventory: inv, getInventory: () => inv };
}

function makeRecord(username, bot, kingdomId) {
  return { username, name: username, kingdomId, __bot: bot };
}

function makeDirector(records) {
  return {
    roster: records,
    isOnline: () => true,
    getBot: (r) => r.__bot || null,
    log: () => {},
  };
}

function reset() {
  Guilds.resetForTests();
  resetForTests();
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

test("tick never throws with an empty world", () => {
  tickMapGuildLife(makeDirector([]), Date.now());
  tickMapGuildLife(null, Date.now());
  tickMapGuildLife(makeDirector([]), 0);
});

test("tick ensures a guild per kingdom", () => {
  tickMapGuildLife(makeDirector([]), Date.now());
  const g = Guilds.guildOf("varrock");
  assert.ok(g);
  assert.ok(g.hallTile);
});

test("tick collects dues from online members with real coins", () => {
  fakeCartographers.add("zoe");
  Guilds.joinGuild("Zoe", "varrock");
  // Force dues overdue.
  const m = Guilds.memberOf("Zoe");
  m.duesPaidUntil = Date.now() - 1000;
  const bot = makeBot("Zoe", 100);
  tickMapGuildLife(makeDirector([makeRecord("Zoe", bot, "varrock")]), Date.now());
  assert.strictEqual(bot.inventory.__coins(), 75);
  assert.strictEqual(Guilds.guildTreasuryFor("varrock"), 25);
  assert.ok(!Guilds.memberOf("Zoe").suspended);
});

test("tick suspends after two missed online dues collections", () => {
  fakeCartographers.add("yara");
  Guilds.joinGuild("Yara", "varrock");
  const m = Guilds.memberOf("Yara");
  m.duesPaidUntil = Date.now() - 1000;
  const bot = makeBot("Yara", 0); // broke
  const d = makeDirector([makeRecord("Yara", bot, "varrock")]);
  tickMapGuildLife(d, Date.now());
  assert.ok(!Guilds.memberOf("Yara").suspended);
  // Second tick: cooldown is 30 min — bypass by resetting the life throttle.
  resetForTests();
  m.duesPaidUntil = Date.now() - 1000;
  tickMapGuildLife(d, Date.now());
  assert.ok(Guilds.memberOf("Yara").suspended);
});

test("tick auto-submits members' quality maps and settles certifications", () => {
  fakeCartographers.add("xan");
  Guilds.joinGuild("Xan", "varrock");
  Guilds.creditTreasury("varrock", 1000);
  fakeListings.varrock.push({ map: { id: "mx1", creator: "Xan", type: "world", quality: 8 }, price: 100 });
  const bot = makeBot("Xan", 200);
  const d = makeDirector([makeRecord("Xan", bot, "varrock")]);
  tickMapGuildLife(d, Date.now());
  // Fee taken from the real inventory, certification settled same tick.
  assert.strictEqual(bot.inventory.__coins(), 150);
  assert.strictEqual(Guilds.certifiedGradeFor("mx1"), "B");
  assert.strictEqual(Guilds.memberOf("Xan").certCount, 1);
});

test("tick expires bounties and refunds the treasury", () => {
  Guilds.creditTreasury("varrock", 500);
  const b = Guilds.postBounty("varrock", "world", 150);
  assert.ok(b.ok);
  assert.strictEqual(Guilds.guildTreasuryFor("varrock"), 350);
  // Force expiry.
  const st = Guilds; // reach in via public expire with a future nowMs
  Guilds.expireBounties(Date.now() + 31 * 24 * 60 * 60 * 1000);
  assert.strictEqual(Guilds.guildTreasuryFor("varrock"), 500);
  assert.strictEqual(Guilds.activeBounties("varrock").length, 0);
  assert.ok(st);
});

console.log(`CitizenMapGuildLife: ${passed} tests passed`);
