"use strict";

// Plain-node tests for CitizenObservatoryGuildLife (no jest, no engine).
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const Guilds = require("./CitizenObservatoryGuilds");

// NOTE: CitizenObservatoryGuildLife binds sayPublic at load time, so each
// test installs the require stubs first, then (re)loads the Life module
// fresh from the require cache. This keeps the ../chat/CitizenSayPublic
// stub effective.
function loadLifeFresh() {
  delete require.cache[require.resolve("./CitizenObservatoryGuildLife")];
  return require("./CitizenObservatoryGuildLife");
}

function freshSave(Life) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ogf-")), "save.json");
  Guilds._setSavePathForTests(p);
  Guilds.resetForTests();
  Life.resetForTests();
  return p;
}

// --- Engine stubs ---
const Module = require("module");
const origRequire = Module.prototype.require;

const said = [];
let careers = {};
let charts = [];
let activeEvent = null;

function fakeBot(username, coins) {
  const inv = {
    coins,
    getAmount: (id) => (id === 995 ? inv.coins : 0),
    // Canonical ItemContainer API: deleteNumber(id, amount).
    deleteNumber: (id, n) => { if (id === 995) inv.coins = Math.max(0, inv.coins - n); },
  };
  return {
    getUsername: () => username,
    username,
    getInventory: () => inv,
    sayPublic: (text) => { said.push(text); },
  };
}

function installStubs() {
  const stubs = {
    "./CitizenObservatoryGuilds": Guilds,
    "../chat/CitizenSayPublic": {
      sayPublic: (bot, text) => { said.push(text); },
    },
    "../brain/CitizenSites": {
      KINGDOM_IDS: ["varrock"],
      kingdomIdOf: () => "varrock",
      siteTileByKingdom: () => ({ x: 3200, y: 3200, z: 0 }),
    },
    "./CitizenAstronomy": {
      EVENTS: {
        meteor_shower: { label: "meteor shower", scheduleMonths: 1 },
        comet: { label: "comet", scheduleMonths: 3 },
        lunar_eclipse: { label: "lunar eclipse", scheduleMonths: 6 },
        solar_eclipse: { label: "solar eclipse", scheduleMonths: 12 },
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

function fakeDirector(records) {
  return {
    roster: records,
    isOnline: () => true,
    getBot: (r) => r.__bot || null,
  };
}

function memberRecord(bot) {
  const rec = { getUsername: bot.getUsername, username: bot.username, __bot: bot };
  return rec;
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

// --- dues ---

test("tick collects real dues from online members; skips the paid-up", (Life) => {
  careers["sky"] = "astronomer";
  careers["broke"] = "astronomer";
  Guilds.joinGuild("Sky", "varrock");
  Guilds.joinGuild("Broke", "varrock");
  Guilds.memberOf("Sky").duesPaidUntilMs = Date.now() - 1000; // dues due
  Guilds.memberOf("Broke").duesPaidUntilMs = Date.now() - 1000; // dues due
  const skyBot = fakeBot("Sky", 1000);
  const brokeBot = fakeBot("Broke", 0);
  const director = fakeDirector([memberRecord(skyBot), memberRecord(brokeBot)]);
  // First tick: Sky pays, Broke misses.
  Life.tickObservatoryGuildLife(director, Date.now());
  assert.strictEqual(Guilds.memberOf("Sky").duesPaidUntilMs > Date.now(), true);
  assert.strictEqual(Guilds.memberOf("Broke").missedDues, 1);
  assert.strictEqual(Guilds.guildOf("varrock").treasury, Guilds.DUES_WEEKLY);
  // Second tick after cooldown: Sky is paid up (skipped), Broke misses again -> suspended.
  Life.tickObservatoryGuildLife(director, Date.now() + 31 * 60 * 1000);
  assert.strictEqual(Guilds.memberOf("Sky").missedDues, 0);
  assert.strictEqual(Guilds.memberOf("Broke").suspended, true);
});

test("tick retries owed bounties when the treasury refills", (Life) => {
  careers["sky"] = "astronomer";
  Guilds.joinGuild("Sky", "varrock");
  charts.push({ id: "c1", astronomer: "Sky", kingdomId: "varrock", quality: 9, createdAt: 1 });
  Guilds.certifyChart("varrock", "Sky", "c1"); // broke: 120 owed
  const cert = Object.values(Guilds.load().certifications)[0];
  assert.strictEqual(cert.bountyOwed, 120);
  Guilds.creditTreasury("varrock", 200);
  Life.tickObservatoryGuildLife(fakeDirector([]), Date.now());
  assert.strictEqual(Guilds.chartCertFor(cert.id).bountyOwed, 0);
});

test("tick confirms open predictions and announces them", (Life) => {
  careers["seer"] = "astronomer";
  Guilds.joinGuild("Seer", "varrock");
  const sm = Guilds.memberOf("Seer");
  sm.rank = Guilds.RANK_STARMASTER;
  Guilds.touch();
  const p = Guilds.predictEvent("varrock", "Seer", "lunar_eclipse");
  assert.strictEqual(p.ok, true);
  activeEvent = "lunar_eclipse";
  const watchDir = fakeDirector([memberRecord(fakeBot("Watcher", 0))]);
  Life.tickObservatoryGuildLife(watchDir, p.predictedForMs + 1000);
  const pred = Guilds.predictionsFor("varrock")[0];
  assert.strictEqual(pred.status, "confirmed");
  assert.ok(said.some((t) => /foretold the lunar eclipse/i.test(t)), "confirmation announced");
});

test("tick settles ripe fabrication cases and announces the count", (Life) => {
  careers["sky"] = "astronomer";
  careers["judge"] = "astronomer";
  Guilds.joinGuild("Sky", "varrock");
  Guilds.joinGuild("Judge", "varrock");
  const jm = Guilds.memberOf("Judge");
  jm.rank = Guilds.RANK_ASTRONOMER;
  Guilds.touch();
  charts.push({ id: "c1", astronomer: "Sky", kingdomId: "varrock", quality: 5, createdAt: 1 });
  // A false-attribution attempt auto-opens a case.
  const bad = Guilds.certifyChart("varrock", "Judge", "c1");
  assert.ok(bad.caseId);
  Guilds.voteOnCase(bad.caseId, "Judge", "innocent");
  // Needs a second voter for quorum.
  careers["arb"] = "astronomer";
  Guilds.joinGuild("Arb", "varrock");
  const am = Guilds.memberOf("Arb");
  am.rank = Guilds.RANK_ASTRONOMER;
  Guilds.touch();
  Guilds.voteOnCase(bad.caseId, "Arb", "innocent");
  const watchDir2 = fakeDirector([memberRecord(fakeBot("Watcher", 0))]);
  Life.tickObservatoryGuildLife(watchDir2, Date.now() + 25 * 3600 * 1000);
  assert.strictEqual(Guilds.load().cases[bad.caseId].status, "dismissed");
  assert.ok(said.some((t) => /settled 1 fabrication case/i.test(t)), "settlement announced");
});

test("tick announces a celestial audit when accuracy collapses", (Life) => {
  careers["sky"] = "astronomer";
  careers["idle"] = "astronomer";
  careers["idle2"] = "astronomer";
  Guilds.joinGuild("Sky", "varrock");
  Guilds.joinGuild("Idle", "varrock");
  Guilds.joinGuild("Idle2", "varrock");
  charts.push({ id: "c1", astronomer: "Sky", kingdomId: "varrock", quality: 8, createdAt: 1 });
  // 1 of 3 members has real charts -> score 33 < 40.
  const watchDir3 = fakeDirector([memberRecord(fakeBot("Watcher", 0))]);
  Life.tickObservatoryGuildLife(watchDir3, Date.now());
  assert.ok(said.some((t) => /celestial audit/i.test(t)), "audit announced");
});

test("tick never throws on a hostile director", (Life) => {
  assert.doesNotThrow(() => Life.tickObservatoryGuildLife(null, Date.now()));
  assert.doesNotThrow(() => Life.tickObservatoryGuildLife({}, Date.now()));
});

console.log(`\n${passed} tests passed`);
