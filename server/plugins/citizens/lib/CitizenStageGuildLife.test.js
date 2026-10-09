"use strict";

/**
 * CitizenStageGuildLife.test.js — slow-tick contracts without a running server.
 *
 * Run: node server/plugins/citizens/lib/CitizenStageGuildLife.test.js
 */

const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");

// --- stubs ---

const sitesPath = path.resolve(__dirname, "../brain/CitizenSites.js");
require.cache[sitesPath] = {
  id: sitesPath, filename: sitesPath, loaded: true,
  exports: { KINGDOM_IDS: ["varrock"], kingdomIdOf: (r) => r._kingdom || "varrock" },
};

const fakeTheater = {
  playwrights: new Set(),
  plays: Object.create(null),
  troupes: Object.create(null),
  reviews: [],
};
const theaterPath = path.resolve(__dirname, "./CitizenTheater.js");
require.cache[theaterPath] = {
  id: theaterPath, filename: theaterPath, loaded: true,
  exports: {
    isPlaywright: (u) => fakeTheater.playwrights.has(String(u || "").toLowerCase()),
    playFor: (id) => fakeTheater.plays[String(id)] || null,
    playsBy: (u) => Object.values(fakeTheater.plays).filter((p) => p.playwrightLower === String(u || "").toLowerCase()),
    playsIn: (kid) => Object.values(fakeTheater.plays).filter((p) => !kid || String(p.kingdomId).toLowerCase() === String(kid).toLowerCase()),
    troupeFor: (name) => fakeTheater.troupes[String(name || "").toLowerCase()] || null,
    troupesIn: (kid) => Object.values(fakeTheater.troupes).filter((t) => !kid || String(t.homeKingdom).toLowerCase() === String(kid).toLowerCase()),
    troupeLocation: (t) => t ? { kingdomId: t._loc || t.homeKingdom, traveling: false } : null,
    recentReviews: () => fakeTheater.reviews.slice(),
    theaterTileFor: () => ({ x: 3200, y: 3200, z: 0 }),
  },
};

const careersPath = path.resolve(__dirname, "./CitizenCareers.js");
require.cache[careersPath] = {
  id: careersPath, filename: careersPath, loaded: true,
  exports: { careerOf: () => null },
};

const repPath = path.resolve(__dirname, "./CitizenReputation.js");
require.cache[repPath] = {
  id: repPath, filename: repPath, loaded: true,
  exports: { awardDeed: () => {} },
};

const said = [];
const chatPath = path.resolve(__dirname, "../chat/CitizenSayPublic.js");
require.cache[chatPath] = {
  id: chatPath, filename: chatPath, loaded: true,
  exports: { sayPublic: (bot, text) => { said.push(text); } },
};

// --- real modules ---

const Guilds = require("./CitizenStageGuilds");
const Life = require("./CitizenStageGuildLife");

const tmpSave = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "stageguild-life-")), "save.json");
Guilds._setSavePathForTests(tmpSave);

function makeBot(name, coins, kingdom = "varrock") {
  const inv = {
    coins,
    getAmount: () => inv.coins,
    // Canonical ItemContainer API: deleteNumber(id, amount).
    deleteNumber: (id, n) => { inv.coins = Math.max(0, inv.coins - n); },
  };
  return {
    _kingdom: kingdom,
    getUsername: () => name,
    username: name,
    inventory: inv,
    getInventory: () => inv,
  };
}

function makeDirector(bots) {
  const records = bots.map((b) => ({ _bot: b, _kingdom: b._kingdom, getUsername: b.getUsername, username: b.username }));
  return {
    roster: records,
    isOnline: () => true,
    getBot: (r) => r._bot,
    log: () => {},
  };
}

let passed = 0;
function test(name, fn) {
  Guilds.resetForTests();
  Life.resetForTests();
  fakeTheater.playwrights = new Set();
  fakeTheater.plays = Object.create(null);
  fakeTheater.troupes = Object.create(null);
  fakeTheater.reviews = [];
  said.length = 0;
  try { fs.unlinkSync(tmpSave); } catch { /* ignore */ }
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

test("tick never throws with empty state", () => {
  const d = makeDirector([]);
  Life.tickStageGuildLife(d, Date.now());
  Life.tickStageGuildLife(d, Date.now()); // second tick is throttled, still safe
});

test("tick collects real-coin dues from online members", () => {
  fakeTheater.playwrights.add("will");
  Guilds.joinGuild("Will", "varrock");
  const m = Guilds.memberOf("Will");
  m.duesPaidUntilMs = Date.now() - 1000; // dues due
  const bot = makeBot("Will", 100);
  const d = makeDirector([bot]);
  Life.tickStageGuildLife(d, Date.now());
  assert.strictEqual(bot.inventory.coins, 75);
  assert.ok(m.duesPaidUntilMs > Date.now());
});

test("broke members accrue a miss, not a penalty", () => {
  fakeTheater.playwrights.add("will");
  Guilds.joinGuild("Will", "varrock");
  const m = Guilds.memberOf("Will");
  m.duesPaidUntilMs = Date.now() - 1000;
  const bot = makeBot("Will", 5); // can't afford 25
  const d = makeDirector([bot]);
  Life.tickStageGuildLife(d, Date.now());
  assert.strictEqual(m.missedDues, 1);
  assert.strictEqual(m.suspended, false);
});

test("tick settles the certification queue", () => {
  fakeTheater.playwrights.add("will");
  fakeTheater.plays["play-1"] = {
    id: "play-1", title: "A Triumph", genre: "comedy",
    playwright: "Will", playwrightLower: "will",
    kingdomId: "varrock", quality: 9, writtenAt: Date.now(),
  };
  Guilds.joinGuild("Will", "varrock");
  const g = Guilds.ensureGuild("varrock");
  g.treasury = 500;
  const bot = makeBot("Will", 100);
  const d = makeDirector([bot]);
  // manually queue (auto-submit needs the member's play unsealed + fee)
  Guilds.submitForCertification("play-1", "Will", "varrock");
  Life.tickStageGuildLife(d, Date.now());
  assert.ok(Guilds.sealFor("play-1"));
  assert.strictEqual(Guilds.sealFor("play-1").grade, "A");
});

test("plagiarism auto-scan opens a guild case", () => {
  fakeTheater.playwrights.add("will");
  fakeTheater.playwrights.add("marlowe");
  fakeTheater.plays["play-1"] = {
    id: "play-1", title: "Stolen Thunder", genre: "tragedy",
    playwright: "Will", playwrightLower: "will",
    kingdomId: "varrock", quality: 6, writtenAt: 1000,
  };
  fakeTheater.plays["play-2"] = {
    id: "play-2", title: "Stolen Thunder", genre: "tragedy",
    playwright: "Marlowe", playwrightLower: "marlowe",
    kingdomId: "varrock", quality: 5, writtenAt: 2000,
  };
  const d = makeDirector([]);
  Life.tickStageGuildLife(d, Date.now());
  const cases = Object.values(Guilds.load().cases);
  assert.strictEqual(cases.length, 1);
  assert.strictEqual(cases[0].accused, "Marlowe");
});

test("laurel is granted quarterly", () => {
  const g = Guilds.ensureGuild("varrock");
  g.treasury = 1000;
  fakeTheater.reviews = [{ troupe: "The Players", kingdomId: "varrock", stars: 5 }];
  fakeTheater.troupes["the players"] = { name: "The Players", members: [], homeKingdom: "varrock", treasury: 0 };
  const d = makeDirector([]);
  Life.tickStageGuildLife(d, Date.now());
  assert.strictEqual(Guilds.load().laurels.length, 1);
  // second immediate tick is throttled — no duplicate
  Life.tickStageGuildLife(d, Date.now() + 1000);
  assert.strictEqual(Guilds.load().laurels.length, 1);
});

console.log(`\n${passed} tests passed`);
