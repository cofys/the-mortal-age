"use strict";

// Plain-node tests for CitizenMusicGuildLife (no jest, no engine).
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const Guilds = require("./CitizenMusicGuilds");
const Life = require("./CitizenMusicGuildLife");

const Module = require("module");
const origRequire = Module.prototype.require;

function installStubs(opts = {}) {
  const stubs = {
    "./CitizenMusicGuilds": Guilds,
    "./CitizenMusicDance": {
      isStageProfessional: (u) => (opts.professionals || []).includes(u.toLowerCase()),
      ensembleOf: () => null,
      concertFor: (id) => (opts.concerts || {})[id] || null,
      instrumentOf: () => null,
    },
    "./CitizenCareers": { careerOf: () => null },
    "../brain/CitizenSites": {
      KINGDOM_IDS: ["varrock"],
      kingdomIdOf: () => "varrock",
    },
    "./CitizenReputation": { awardDeed: () => {} },
    "./CitizenBonds": { normalizeName: (s) => String(s || "").toLowerCase().trim() },
    "../chat/CitizenSayPublic": { sayPublic: () => {} },
  };
  Module.prototype.require = function (id) {
    if (Object.prototype.hasOwnProperty.call(stubs, id)) return stubs[id];
    return origRequire.apply(this, arguments);
  };
  return () => { Module.prototype.require = origRequire; };
}

function freshSave() {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mgl-")), "save.json");
  Guilds._setSavePathForTests(p);
  Guilds.resetForTests();
  Life.resetForTests();
}

function makeDirector(members = []) {
  // Minimal director stub: roster of online records with bots.
  const records = members.map((name) => ({
    username: name,
    getUsername: () => name,
  }));
  const bots = {};
  for (const name of members) {
    bots[name.toLowerCase()] = {
      coins: 1000,
      inventory: {
        getAmount: (id) => (id === 995 ? bots[name.toLowerCase()].coins : 0),
        remove: (id, amt) => { if (id === 995) bots[name.toLowerCase()].coins -= amt; },
      },
    };
  }
  return {
    roster: records,
    isOnline: () => true,
    getBot: (record) => bots[record.username.toLowerCase()] || null,
  };
}

let passed = 0;
function test(name, fn) {
  freshSave();
  const restore = installStubs({ professionals: ["lute larry", "maestro max"] });
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

test("tick never throws on empty state", () => {
  const director = makeDirector([]);
  Life.tickMusicGuildLife(director, Date.now());
  // No assertion needed — just didn't throw.
});

test("tick collects dues from online members", () => {
  const director = makeDirector(["Lute Larry"]);
  Guilds.joinGuild("Lute Larry", "varrock");
  // Force dues to be overdue.
  const st = Guilds.load();
  st.members["lute larry"].duesPaidUntilMs = Date.now() - 1000;
  Guilds.touch();
  Life.tickMusicGuildLife(director, Date.now());
  const m = Guilds.memberOf("Lute Larry");
  assert.ok(m.duesPaidUntilMs > Date.now());
  const t = Guilds.guildTreasuryFor("varrock");
  assert.strictEqual(t.treasury, 20);
});

test("tick skips offline members for dues", () => {
  const director = makeDirector([]); // nobody online
  Guilds.joinGuild("Lute Larry", "varrock");
  const st = Guilds.load();
  st.members["lute larry"].duesPaidUntilMs = Date.now() - 1000;
  st.members["lute larry"].missedDues = 0;
  Guilds.touch();
  Life.tickMusicGuildLife(director, Date.now());
  const m = Guilds.memberOf("Lute Larry");
  assert.strictEqual(m.missedDues, 0); // offline = never penalized
});

test("tick settles ripe tribunal cases", () => {
  const restore = installStubs({
    professionals: ["lute larry", "copy cat"],
    concerts: {
      "c1": { performers: ["Lute Larry"], quality: 8, title: "Disputed Song" },
      "c2": { performers: ["Copy Cat"], quality: 6, title: "Disputed Song" },
    },
  });
  try {
    Guilds.joinGuild("Lute Larry", "varrock");
    Guilds.joinGuild("Copy Cat", "varrock");
    const st = Guilds.load();
    st.members["lute larry"].rank = "minstrel";
    Guilds.touch();
    Guilds.certifyPerformance("varrock", "Lute Larry", "c1", "Disputed Song");
    Guilds.certifyPerformance("varrock", "Copy Cat", "c2", "Disputed Song");
    const rep = Guilds.reportPlagiarism("varrock", "Lute Larry", "Disputed Song");
    assert.strictEqual(rep.ok, true);
    const director = makeDirector([]);
    // Fast-forward past the case TTL.
    Life.tickMusicGuildLife(director, Date.now() + 25 * 3600 * 1000);
    // Case should be settled (dismissed — no votes, no quorum).
    const c = Guilds.load().cases[rep.caseId];
    assert.strictEqual(c.status, "dismissed");
  } finally { restore(); }
});

test("tick grants golden lyre quarterly", () => {
  const restore = installStubs({
    professionals: ["lute larry"],
    concerts: { "c1": { performers: ["Lute Larry"], quality: 9, title: "Hit Song" } },
  });
  try {
    Guilds.joinGuild("Lute Larry", "varrock");
    Guilds.certifyPerformance("varrock", "Lute Larry", "c1", "Hit Song");
    const director = makeDirector([]);
    Life.tickMusicGuildLife(director, Date.now());
    const g = Guilds.guildOf("varrock");
    assert.ok(g.lastLyreMs > 0);
  } finally { restore(); }
});

test("tick runs music school with maestro", () => {
  const director = makeDirector(["Maestro Max", "Lute Larry"]);
  Guilds.joinGuild("Maestro Max", "varrock");
  Guilds.joinGuild("Lute Larry", "varrock");
  const st = Guilds.load();
  st.members["maestro max"].rank = "maestro";
  Guilds.touch();
  Life.tickMusicGuildLife(director, Date.now());
  const m = Guilds.memberOf("Lute Larry");
  assert.strictEqual(m.trainingCredits, 1);
});

console.log(`\n${passed} tests passed`);
