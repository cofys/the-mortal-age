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
  // Mirrors the REAL CitizenSites.kingdomIdOf contract: it needs a player
  // entity with getAttribute; plain roster records silently fall back to
  // KINGDOM_IDS[0]. This is the exact trap the guild life tick must not fall
  // into when resolving a citizen's kingdom from a roster record.
  exports: {
    KINGDOM_IDS: ["varrock", "falador"],
    kingdomIdOf: (player) => {
      try {
        const id = player && typeof player.getAttribute === "function"
          ? player.getAttribute("citizens:kingdom-id") : null;
        return (id === "varrock" || id === "falador") ? id : "varrock";
      } catch { return "varrock"; }
    },
  },
};

const fakeListings = { varrock: [], falador: [] };
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
  require("./CitizenJournal").getJournal().resetForTests();
  fakeCartographers.clear();
  fakeListings.varrock = [];
  fakeListings.falador = [];
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

test("suspension is journaled with the canonical (name, kind, text) shape", () => {
  const { getJournal } = require("./CitizenJournal");
  fakeCartographers.add("yara");
  Guilds.joinGuild("Yara", "varrock");
  const m = Guilds.memberOf("Yara");
  m.duesPaidUntil = Date.now() - 1000;
  const bot = makeBot("Yara", 0); // broke
  const d = makeDirector([makeRecord("Yara", bot, "varrock")]);
  tickMapGuildLife(d, Date.now());
  resetForTests(); // bypass the 30-min throttle for the second collection
  m.duesPaidUntil = Date.now() - 1000;
  tickMapGuildLife(d, Date.now());
  assert.ok(Guilds.memberOf("Yara").suspended);
  // Regression: the old journal helper called log(kind, data) with no text,
  // so CitizenJournal.log() returned null and nothing was ever recorded.
  const events = getJournal().recent("Yara");
  const e = events.find((x) => x.kind === "guild-suspended");
  assert.ok(e, "expected a guild-suspended journal entry for Yara");
  assert.ok(e.text && e.text.length > 0, "journal text must be non-empty");
});

test("auto-submit resolves the citizen's real kingdom, not KINGDOM_IDS[0]", () => {
  fakeCartographers.add("fay");
  Guilds.joinGuild("Fay", "falador");
  Guilds.creditTreasury("falador", 1000);
  fakeListings.falador.push({ map: { id: "fm1", creator: "Fay", type: "world", quality: 8 }, price: 100 });
  const bot = makeBot("Fay", 200);
  const d = makeDirector([makeRecord("Fay", bot, "falador")]);
  tickMapGuildLife(d, Date.now());
  // Regression: the old helper fed the roster record into
  // CitizenSites.kingdomIdOf, which silently returned KINGDOM_IDS[0]
  // ("varrock") for any non-player object, so falador members never
  // auto-submitted and falador announcements never found a bot.
  assert.strictEqual(Guilds.certifiedGradeFor("fm1"), "B");
  assert.strictEqual(Guilds.guildTreasuryFor("varrock"), 0);
  // Fee (50) credited to the falador treasury; grade-B bounty (60) paid out.
  assert.strictEqual(Guilds.guildTreasuryFor("falador"), 1000 - 60 + 50);
});

console.log(`CitizenMapGuildLife: ${passed} tests passed`);
