"use strict";

/**
 * CitizenSportsGuildLife.test.js — slow-tick contracts without a running server.
 *
 * Run: node server/plugins/citizens/lib/CitizenSportsGuildLife.test.js
 */

const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");

// --- stubs ---

const sitesPath = path.resolve(__dirname, "../brain/CitizenSites.js");
require.cache[sitesPath] = {
  id: sitesPath, filename: sitesPath, loaded: true,
  exports: { KINGDOM_IDS: ["varrock", "falador"], kingdomIdOf: () => "varrock" },
};

const fakeAthletics = {
  athletes: new Set(),
  records: Object.create(null),
};
const athleticsPath = path.resolve(__dirname, "./CitizenAthletics.js");
require.cache[athleticsPath] = {
  id: athleticsPath, filename: athleticsPath, loaded: true,
  exports: {
    SPORTS: ["running", "wrestling", "archery", "racing"],
    isAthlete: (u) => fakeAthletics.athletes.has(String(u || "").toLowerCase()),
    athleteInfo: (u) => {
      const n = String(u || "").toLowerCase();
      return fakeAthletics.athletes.has(n) ? { name: u, sport: "running", fitness: 60, skill: 10, trainedAt: Date.now() } : null;
    },
    recordFor: (kid, sport) => fakeAthletics.records[`${kid}:${sport}`] || null,
    stadiumTile: (kid) => ({ x: 3200, y: 3200, z: 0 }),
  },
};

const sayPath = path.resolve(__dirname, "../chat/CitizenSayPublic.js");
require.cache[sayPath] = {
  id: sayPath, filename: sayPath, loaded: true,
  exports: { sayPublic: () => {} },
};

const Guilds = require("./CitizenSportsGuilds.js");
const Life = require("./CitizenSportsGuildLife.js");

function fresh() {
  Guilds.resetForTests();
  Life.resetForTests();
  fakeAthletics.athletes = new Set();
  fakeAthletics.records = Object.create(null);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sportsguildlife-"));
  Guilds.setSaveFile(path.join(tmp, "save.json"));
}

function makeDirector(members) {
  // Minimal director stub: roster of online records, each with a bot.
  const roster = (members || []).map((name) => ({
    username: name,
    getUsername: () => name,
  }));
  return {
    roster,
    isOnline: () => true,
    getBot: (record) => ({
      inventory: {
        _coins: 1000,
        getAmount: function () { return this._coins; },
        count: function () { return this._coins; },
        remove: function (id, n) { this._coins -= n; },
      },
    }),
  };
}

let passed = 0;
function test(name, fn) {
  fresh();
  try { fn(); passed++; }
  catch (e) { console.error(`FAIL: ${name}\n  ${e.message}`); process.exitCode = 1; }
}

test("tick never throws with an empty world", () => {
  Life.tickSportsGuildLife(makeDirector([]), Date.now());
});

test("tick collects dues from online members with real coins", () => {
  fakeAthletics.athletes.add("bob");
  Guilds.joinGuild("Bob", "varrock");
  // Force dues to be due.
  Guilds.memberOf("Bob").duesPaidUntilMs = Date.now() - 1000;
  Life.tickSportsGuildLife(makeDirector(["Bob"]), Date.now());
  const g = Guilds.guildOf("varrock");
  assert.ok(g.treasury >= 20, "treasury got dues share");
  assert.ok(g.medicalFund >= 5, "medical fund got dues share");
});

test("tick skips offline members for dues (never penalized)", () => {
  fakeAthletics.athletes.add("bob");
  Guilds.joinGuild("Bob", "varrock");
  Guilds.memberOf("Bob").duesPaidUntilMs = Date.now() - 1000;
  // Bob is NOT in the online roster.
  Life.tickSportsGuildLife(makeDirector([]), Date.now() + 31 * 60 * 1000);
  const m = Guilds.memberOf("Bob");
  assert.strictEqual(m.missedDues, 0, "offline member not penalized");
  assert.ok(!m.suspended);
});

test("tick settles queued certifications", () => {
  fakeAthletics.athletes.add("bob");
  Guilds.joinGuild("Bob", "varrock");
  fakeAthletics.records["varrock:running"] = { holder: "Bob", mark: 250, at: Date.now() };
  const g = Guilds.guildOf("varrock");
  g.treasury = 1000;
  Guilds.submitRecord("Bob", "varrock", "running", Date.now());
  assert.ok(!Guilds.sealFor("varrock", "running"));
  Life.tickSportsGuildLife(makeDirector(["Bob"]), Date.now());
  assert.ok(Guilds.sealFor("varrock", "running"), "record certified on tick");
});

test("tick auto-reports doping and settles tribunal", () => {
  fakeAthletics.records["varrock:running"] = { holder: "Ghost", mark: 250, at: Date.now() };
  const d = makeDirector([]);
  Life.tickSportsGuildLife(d, Date.now());
  const cases = Object.values(Guilds.serialize().cases);
  assert.ok(cases.length > 0, "doping case auto-opened");
  // Fast-forward past the TTL: case settles (acquitted without votes).
  Life.tickSportsGuildLife(d, Date.now() + 31 * 60 * 1000);
  Life.tickSportsGuildLife(d, Date.now() + 25 * 60 * 60 * 1000);
  const settled = Object.values(Guilds.serialize().cases).filter((c) => c.settled);
  assert.ok(settled.length > 0, "case settled");
});

test("tick grants the golden laurel to the top record holder", () => {
  fakeAthletics.athletes.add("bob");
  fakeAthletics.athletes.add("ann");
  Guilds.joinGuild("Bob", "varrock");
  Guilds.joinGuild("Ann", "varrock");
  const g = Guilds.guildOf("varrock");
  g.treasury = 1000;
  fakeAthletics.records["varrock:running"] = { holder: "Bob", mark: 250, at: Date.now() };
  fakeAthletics.records["varrock:archery"] = { holder: "Bob", mark: 220, at: Date.now() };
  fakeAthletics.records["varrock:wrestling"] = { holder: "Ann", mark: 210, at: Date.now() };
  Guilds.submitRecord("Bob", "varrock", "running", Date.now());
  Guilds.settleCertification("varrock", "running", Date.now());
  Guilds.submitRecord("Bob", "varrock", "archery", Date.now());
  Guilds.settleCertification("varrock", "archery", Date.now());
  Guilds.submitRecord("Ann", "varrock", "wrestling", Date.now());
  Guilds.settleCertification("varrock", "wrestling", Date.now());
  const res = Guilds.grantLaurel("varrock", Date.now());
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.winner, "Bob");
  assert.strictEqual(res.records, 2);
});

console.log(`\n${passed} tests passed.`);
