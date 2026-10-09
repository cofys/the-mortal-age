"use strict";

// Plain-node tests for CitizenArtGuildLife (no jest, no engine).
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const Guilds = require("./CitizenArtGuilds");

function freshSave() {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agl-")), "save.json");
  Guilds._setSavePathForTests(p);
  Guilds.resetForTests();
  return p;
}

// --- Stub the engine reads ---
const Module = require("module");
const origRequire = Module.prototype.require;

const said = []; // captured sayPublic calls
let careers = {};
let artworks = {};
let artistWorks = {};

function installStubs() {
  const stubs = {
    "./CitizenArtGuilds": Guilds,
    "../chat/CitizenSayPublic": {
      sayPublic: (bot, text) => { said.push(text); },
    },
    "../brain/CitizenSites": {
      KINGDOM_IDS: ["varrock"],
      kingdomIdOf: () => "varrock",
      siteTileByKingdom: () => ({ x: 3200, y: 3200, z: 0 }),
    },
    "./CitizenArt": {
      QUALITY_MASTERPIECE: 85,
      artworksOf: (u) => (artistWorks[String(u || "").toLowerCase()] || []).map((id) => artworks[id]).filter(Boolean),
      artworkById: (id) => artworks[id] || null,
    },
    "./CitizenCareers": {
      careerOf: (u) => careers[String(u || "").toLowerCase()] || null,
    },
    "./CitizenReputation": { awardDeed: () => {} },
    "./CitizenBanking": { creditAccount: () => true },
    "./CitizenBonds": { normalizeName: (s) => String(s || "").toLowerCase().trim() },
  };
  Module.prototype.require = function (id) {
    if (Object.prototype.hasOwnProperty.call(stubs, id)) return stubs[id];
    return origRequire.apply(this, arguments);
  };
  return () => { Module.prototype.require = origRequire; };
}

const { tickArtGuildLife, resetForTests } = require("./CitizenArtGuildLife");

function makeRecord(username, opts = {}) {
  return {
    username,
    getUsername: () => username,
    coins: opts.coins ?? 1000,
    inventory: {
      getAmount: (id) => (id === 995 ? makeRecord.coinsRef.coins : 0),
      remove: (id, amt) => { if (id === 995) makeRecord.coinsRef.coins -= amt; },
    },
    getInventory() { return this.inventory; },
  };
}
makeRecord.coinsRef = { coins: 1000 };

function makeDirector(records) {
  const byName = new Map(records.map((r) => [r.username.toLowerCase(), r]));
  return {
    roster: records,
    isOnline: () => true,
    getBot: (record) => record,
    log: () => {},
  };
}

let passed = 0;
function test(name, fn) {
  freshSave();
  resetForTests();
  said.length = 0;
  careers = {};
  artworks = {};
  artistWorks = {};
  makeRecord.coinsRef.coins = 1000;
  const restore = installStubs();
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}: ${e.message}`);
    console.error(e.stack);
    process.exitCode = 1;
  } finally {
    restore();
  }
}

test("tick collects dues from online members with coins", () => {
  careers = { "painty pete": "artist" };
  Guilds.joinGuild("Painty Pete", "varrock");
  // Expire the free first week so dues are actually due.
  Guilds.memberOf("painty pete").duesPaidUntilMs = Date.now() - 1000;
  const rec = makeRecord("painty pete", { coins: 1000 });
  const director = makeDirector([rec]);
  tickArtGuildLife(director, Date.now());
  assert.ok(Guilds.memberOf("painty pete").duesPaidUntilMs > Date.now());
  assert.strictEqual(makeRecord.coinsRef.coins, 1000 - Guilds.DUES_WEEKLY);
});

test("tick records a miss (not a crime) for broke members", () => {
  careers = { "painty pete": "artist" };
  Guilds.joinGuild("Painty Pete", "varrock");
  Guilds.memberOf("painty pete").duesPaidUntilMs = Date.now() - 1000;
  makeRecord.coinsRef.coins = 0;
  const rec = makeRecord("painty pete", { coins: 0 });
  const director = makeDirector([rec]);
  tickArtGuildLife(director, Date.now());
  assert.strictEqual(Guilds.memberOf("painty pete").missedDues, 1);
  assert.ok(!Guilds.memberOf("painty pete").suspended);
});

test("tick never throws on a broken director", () => {
  tickArtGuildLife(null);
  tickArtGuildLife({});
  tickArtGuildLife({ roster: null });
});

test("tick is throttled by the cooldown", () => {
  careers = { "painty pete": "artist" };
  Guilds.joinGuild("Painty Pete", "varrock");
  Guilds.memberOf("painty pete").duesPaidUntilMs = Date.now() - 1000;
  const rec = makeRecord("painty pete");
  const director = makeDirector([rec]);
  const now = Date.now();
  tickArtGuildLife(director, now);
  const afterFirst = makeRecord.coinsRef.coins;
  // Second tick inside the cooldown: no second dues collection.
  tickArtGuildLife(director, now + 1000);
  assert.strictEqual(makeRecord.coinsRef.coins, afterFirst);
});

test("tick settles ripe tribunal cases", () => {
  careers = { "painty pete": "artist", "copy cat": "artist", "master moe": "artist" };
  artworks = {
    a1: { id: "a1", title: "Sunset", artist: "painty pete", quality: 90, medium: "painting" },
    a9: { id: "a9", title: "sunset", artist: "copy cat", quality: 88, medium: "painting" },
  };
  artistWorks = { "painty pete": ["a1"], "copy cat": ["a9"] };
  Guilds.joinGuild("Painty Pete", "varrock");
  Guilds.joinGuild("Copy Cat", "varrock");
  Guilds.joinGuild("Master Moe", "varrock");
  Guilds.creditTreasury("varrock", 1000);
  Guilds.certifyArtwork("varrock", "painty pete", "a1");
  Guilds.certifyArtwork("varrock", "copy cat", "a9");
  Guilds.load().members["painty pete"].rank = Guilds.RANK_ARTIST;
  Guilds.load().members["master moe"].rank = Guilds.RANK_ARTIST;
  const rep = Guilds.reportForgery("varrock", "painty pete", "Sunset");
  assert.strictEqual(rep.ok, true);
  Guilds.voteOnCase(rep.caseId, "painty pete", "guilty");
  Guilds.voteOnCase(rep.caseId, "master moe", "guilty");
  // Backdate the case so it is ripe, then tick.
  Guilds.load().cases[rep.caseId].openedMs = Date.now() - 25 * 60 * 60 * 1000;
  const rec = makeRecord("painty pete");
  const director = makeDirector([rec]);
  tickArtGuildLife(director, Date.now());
  const kase = Guilds.load().cases[rep.caseId];
  assert.strictEqual(kase.status, "convicted");
  assert.ok(!Guilds.isGuildMember("copy cat"));
});

console.log(`\n${passed} tests passed`);
