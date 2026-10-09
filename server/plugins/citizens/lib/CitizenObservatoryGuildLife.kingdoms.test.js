"use strict";

// Plain-node tests for CitizenObservatoryGuildLife cross-kingdom scoping
// (the plain-record trap). These stubs MIRROR THE REAL CONTRACTS:
//
// - director.roster holds PLAIN records: { username, kingdomId, ... } —
//   they have no getAttribute, so the real brain kingdomIdOf(player) (which
//   reads player.getAttribute and falls back to KINGDOM_IDS[0]) pins every
//   record to the first kingdom. The Life tick must read record.kingdomId
//   FIRST, using the brain read only as a live-entity fallback.
// - Two kingdoms with varrock first, so the trap is observable.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const Guilds = require("./CitizenObservatoryGuilds");

function loadLifeFresh() {
  delete require.cache[require.resolve("./CitizenObservatoryGuildLife")];
  return require("./CitizenObservatoryGuildLife");
}

function freshSave(Life) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ogk-")), "save.json");
  Guilds._setSavePathForTests(p);
  Guilds.resetForTests();
  Life.resetForTests();
  return p;
}

// --- Real-mirror engine stubs ---
const Module = require("module");
const origRequire = Module.prototype.require;

const said = []; // { by, text }
let careers = {};
let charts = [];
let activeEvent = null;

// Mirrors the real brain/CitizenSites.kingdomIdOf: reads getAttribute,
// silently returns KINGDOM_IDS[0] for anything without it (i.e. plain
// roster records).
const KINGDOM_IDS = ["varrock", "lumbridge"];
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
    "./CitizenObservatoryGuilds": Guilds,
    "../chat/CitizenSayPublic": {
      sayPublic: (bot, text) => { said.push({ by: bot?.getUsername?.() ?? "?", text }); },
    },
    "../brain/CitizenSites": {
      KINGDOM_IDS,
      kingdomIdOf: realMirrorKingdomIdOf,
      siteTileByKingdom: () => ({ x: 3200, y: 3200, z: 0 }),
    },
    "./CitizenAstronomy": {
      EVENTS: {
        meteor_shower: { label: "meteor shower", scheduleMonths: 1 },
        lunar_eclipse: { label: "lunar eclipse", scheduleMonths: 6 },
      },
      astronomerFor: () => null,
      astronomersFor: () => [],
      chartsFor: (kid) => charts.filter((c) => c.kingdomId === kid),
      observatoryFor: (kid) => ({ kingdomId: kid, tile: { x: 3300, y: 3300, z: 0 } }),
      activeEventFor: () => (activeEvent ? { kind: activeEvent, label: activeEvent.replace(/_/g, " ") } : null),
    },
    "./CitizenCareers": { careerOf: (u) => careers[String(u || "").toLowerCase()] || null },
    "./CitizenReputation": { awardDeed: () => {} },
    "./CitizenScience": { recentPublications: () => [] },
    "./CitizenBonds": { normalizeName: (s) => String(s || "").toLowerCase().trim() },
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
    personality: {},
    kingdomId,
    role: "commoner",
    online: false,
    currentActivityId: null,
  };
  if (bot) rec.__bot = bot;
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
  careers = {};
  charts = [];
  activeEvent = null;
  try {
    fn(Life);
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

// --- cross-kingdom announce ---

test("guild announcements fire for the second kingdom too, spoken by a citizen there", (Life) => {
  // 1 of 3 lumbridge members has real charts -> score 33 < 40 -> audit.
  careers["sky"] = "astronomer";
  careers["idle"] = "astronomer";
  careers["idle2"] = "astronomer";
  Guilds.joinGuild("Sky", "lumbridge");
  Guilds.joinGuild("Idle", "lumbridge");
  Guilds.joinGuild("Idle2", "lumbridge");
  charts.push({ id: "c1", astronomer: "Sky", kingdomId: "lumbridge", quality: 8 });
  const skyBot = fakeBot("Sky", 0);
  const director = fakeDirector([
    plainRecord("Sky", "lumbridge", skyBot),
    plainRecord("Idle", "lumbridge", fakeBot("Idle", 0)),
    plainRecord("Idle2", "lumbridge", fakeBot("Idle2", 0)),
  ]);
  Life.tickObservatoryGuildLife(director, Date.now());
  const auditSaid = said.filter((s) => /celestial audit/i.test(s.text));
  assert.ok(auditSaid.length > 0, "lumbridge audit was announced");
  assert.strictEqual(auditSaid[0].by, "Sky", "spoken by a lumbridge citizen's bot");
});

// --- dues are collected on the citizen's own kingdom pass ---

test("dues collected for a second-kingdom member come out of their bot", (Life) => {
  careers["sky"] = "astronomer";
  Guilds.joinGuild("Sky", "lumbridge");
  Guilds.memberOf("Sky").duesPaidUntilMs = Date.now() - 1000; // dues due
  const skyBot = fakeBot("Sky", 1000);
  const director = fakeDirector([plainRecord("Sky", "lumbridge", skyBot)]);
  Life.tickObservatoryGuildLife(director, Date.now());
  assert.strictEqual(Guilds.memberOf("Sky").duesPaidUntilMs > Date.now(), true,
    "lumbridge member paid dues");
  assert.strictEqual(Guilds.guildOf("lumbridge").treasury, Guilds.DUES_WEEKLY,
    "dues landed in the lumbridge treasury");
});

// --- star-chart school: a starmaster only teaches their own kingdom ---

test("a varrock starmaster does not teach lumbridge stargazers", (Life) => {
  careers["varsm"] = "astronomer";
  careers["lumsg"] = "astronomer";
  Guilds.joinGuild("VarSm", "varrock");
  Guilds.joinGuild("LumSg", "lumbridge");
  const sm = Guilds.memberOf("VarSm");
  sm.rank = Guilds.RANK_STARMASTER;
  Guilds.touch();
  const director = fakeDirector([
    plainRecord("VarSm", "varrock", fakeBot("VarSm", 0)),
    plainRecord("LumSg", "lumbridge", fakeBot("LumSg", 0)),
  ]);
  Life.tickObservatoryGuildLife(director, Date.now());
  assert.strictEqual(Guilds.memberOf("LumSg").trainingCredits || 0, 0,
    "lumbridge stargazer taught only by a lumbridge starmaster");
});

console.log(`\n${passed} tests passed`);
