"use strict";

// Plain-node tests for CitizenMusicGuildLife cross-kingdom scoping
// (the plain-record trap). These stubs MIRROR THE REAL CONTRACTS:
//
// - director.roster holds PLAIN records: { username, kingdomId, ... } —
//   they have no getAttribute, so the real brain kingdomIdOf(player) (which
//   reads player.getAttribute and falls back to KINGDOM_IDS[0]) pins every
//   record to the first kingdom. The Life tick must read record.kingdomId
//   FIRST, using the brain read only as a live-entity fallback.
// - Roster records can also be entity-shaped (carry getAttribute from a live
//   read path) while the kingdom attribute is unset — the old brain-first
//   order pinned THOSE to the first kingdom too, unreachable `||
//   record.kingdomId` fallback included.
// - Two kingdoms with asgarnia first, so the trap is observable.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const Guilds = require("./CitizenMusicGuilds");

function loadLifeFresh() {
  delete require.cache[require.resolve("./CitizenMusicGuildLife")];
  return require("./CitizenMusicGuildLife");
}

function freshSave(Life) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mgk-")), "save.json");
  Guilds._setSavePathForTests(p);
  Guilds.resetForTests();
  Life.resetForTests();
  return p;
}

// --- Real-mirror engine stubs ---
const Module = require("module");
const origRequire = Module.prototype.require;

const said = []; // { by, text }

// Mirrors the real brain/CitizenSites.kingdomIdOf: reads getAttribute,
// silently returns KINGDOM_IDS[0] for anything without a valid attribute
// (i.e. plain roster records AND entity-shaped records with it unset).
const KINGDOM_IDS = ["asgarnia", "kandarin"];
function realMirrorKingdomIdOf(player) {
  const id = player?.getAttribute?.("citizens:kingdom-id");
  return typeof id === "string" ? id : KINGDOM_IDS[0];
}

function fakeBot(username, coins) {
  const inv = {
    coins,
    getAmount: (id) => (id === 995 ? inv.coins : 0),
    delete: (id, n) => { if (id === 995 && inv.coins >= n) { inv.coins -= n; return true; } return false; },
  };
  return {
    getUsername: () => username,
    username,
    getInventory: () => inv,
  };
}

function installStubs() {
  const stubs = {
    "./CitizenMusicGuilds": Guilds,
    "../chat/CitizenSayPublic": {
      sayPublic: (bot, text) => { said.push({ by: bot?.getUsername?.() ?? "?", text }); },
    },
    "../brain/CitizenSites": {
      KINGDOM_IDS,
      kingdomIdOf: realMirrorKingdomIdOf,
      siteTileByKingdom: () => ({ x: 3200, y: 3200, z: 0 }),
    },
    "./CitizenMusicDance": {
      instrumentOf: () => null, // nobody owns instruments -> harmony audit fires
      isStageProfessional: () => false,
    },
    "./CitizenCareers": { careerOf: () => "bard" }, // everyone is a musician for joinGuild
  };
  Module.prototype.require = function (id) {
    if (Object.prototype.hasOwnProperty.call(stubs, id)) return stubs[id];
    return origRequire.apply(this, arguments);
  };
}
installStubs();

// Real-shape plain roster record: has kingdomId, no getAttribute.
function plainRecord(username, kingdomId, bot) {
  const rec = {
    username,
    kingdomId,
    role: "commoner",
    online: false,
    currentActivityId: null,
  };
  if (bot) rec.__bot = bot;
  return rec;
}

// Entity-shaped roster record: real kingdomId field, but ALSO getAttribute
// (from a live-entity read path) that yields nothing for the kingdom
// attribute — the shape the old brain-first order pinned to KINGDOM_IDS[0].
function entityRecord(username, kingdomId, bot) {
  const rec = plainRecord(username, kingdomId, bot);
  rec.getAttribute = () => undefined;
  return rec;
}

function fakeDirector(records) {
  return {
    roster: records,
    isOnline: (r) => !!r.__bot,
    getBot: (r) => r.__bot || null,
  };
}

let passed = 0;
function test(name, fn) {
  const Life = loadLifeFresh();
  freshSave(Life);
  said.length = 0;
  try {
    fn(Life);
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

// --- dues are collected for second-kingdom members (regression) ---

test("dues collected for a kandarin member come out of their bot", (Life) => {
  Guilds.joinGuild("Lira", "kandarin");
  Guilds.memberOf("Lira").duesPaidUntilMs = Date.now() - 1000; // dues due
  const liraBot = fakeBot("Lira", 1000);
  const director = fakeDirector([
    entityRecord("Lira", "kandarin", liraBot),
    plainRecord("Lira2", "kandarin", fakeBot("Lira2", 1000)),
  ]);
  Life.tickMusicGuildLife(director, Date.now());
  assert.ok(Guilds.memberOf("Lira").duesPaidUntilMs > Date.now(), "kandarin member paid dues");
  assert.ok(liraBot.getInventory().getAmount(995) < 1000, "coins left the bot's inventory");
});

// --- music school: a maestro only teaches their own kingdom ---

test("a kandarin maestro teaches the kandarin novice, not the asgarnia one", (Life) => {
  Guilds.joinGuild("KMaestro", "kandarin");
  Guilds.joinGuild("KNoviee", "kandarin");
  Guilds.joinGuild("ANoviee", "asgarnia");
  const m = Guilds.memberOf("KMaestro");
  m.rank = Guilds.RANK_MAESTRO;
  Guilds.touch();
  const director = fakeDirector([
    entityRecord("KMaestro", "kandarin", fakeBot("KMaestro", 0)),
    entityRecord("KNoviee", "kandarin", fakeBot("KNoviee", 0)),
    entityRecord("ANoviee", "asgarnia", fakeBot("ANoviee", 0)),
  ]);
  Life.tickMusicGuildLife(director, Date.now());
  assert.strictEqual(Guilds.memberOf("KNoviee").trainingCredits || 0, 1,
    "kandarin novice taught by their own kingdom's maestro");
  assert.strictEqual(Guilds.memberOf("ANoviee").trainingCredits || 0, 0,
    "asgarnia novice not taught by a kandarin maestro");
});

// --- guild announcements fire for the second kingdom too ---

test("harmony audit announces for kandarin, spoken by a kandarin citizen", (Life) => {
  Guilds.joinGuild("KPenny", "kandarin");
  const director = fakeDirector([
    entityRecord("KPenny", "kandarin", fakeBot("KPenny", 0)),
  ]);
  Life.tickMusicGuildLife(director, Date.now());
  const auditSaid = said.filter((s) => /harmony audit/i.test(s.text));
  assert.ok(auditSaid.length > 0, "kandarin harmony audit was announced");
  assert.strictEqual(auditSaid[0].by, "KPenny", "spoken by a kandarin citizen's bot");
});

// --- plain records keep working (the old getAttribute guard covered these) ---

test("plain records resolve to their own kingdom (regression)", (Life) => {
  Guilds.joinGuild("PMaestro", "kandarin");
  Guilds.joinGuild("PNoviee", "kandarin");
  const m = Guilds.memberOf("PMaestro");
  m.rank = Guilds.RANK_MAESTRO;
  Guilds.touch();
  const director = fakeDirector([
    plainRecord("PMaestro", "kandarin", fakeBot("PMaestro", 0)),
    plainRecord("PNoviee", "kandarin", fakeBot("PNoviee", 0)),
  ]);
  Life.tickMusicGuildLife(director, Date.now());
  assert.strictEqual(Guilds.memberOf("PNoviee").trainingCredits || 0, 1,
    "kandarin novice taught (plain records)");
});

console.log(`\n${passed} tests passed`);
