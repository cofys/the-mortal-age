"use strict";

/**
 * CitizenScienceLife.test.js — slow-tick tests for experimental science.
 *
 * Plain node:assert, no engine, no jest. Run with: node <this file>.
 */

const assert = require("node:assert");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const Science = require("./CitizenScience");
const Life = require("./CitizenScienceLife");

const tmpSave = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sciencelife-test-")), "science.json");
Science._setSavePathForTests(tmpSave);

function freshState() {
  Science.resetForTests();
  Science._setSavePathForTests(tmpSave);
  Life.resetForTests();
}

function fakeDirector(records = []) {
  const bots = new Map();
  return {
    roster: new Map(records.map((r) => [r.username, r])),
    kingdomIdOf: (r) => r.kingdomId,
    isOnline: (r) => !!r.online,
    getBot: (r) => {
      if (!r.online) return null;
      if (!bots.has(r.username)) {
        bots.set(r.username, {
          getSkills: () => ({ getLevel: (skill) => r.levels?.[skill] ?? 1 }),
        });
      }
      return bots.get(r.username);
    },
    log: () => {},
  };
}

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok: ${name}`);
  } catch (e) {
    console.error(`  FAIL: ${name}\n    ${e.message}`);
    process.exitCode = 1;
  }
}

console.log("CitizenScienceLife tick tests:");

// --- scientist registration ---

test("tick registers citizens with field skill 30+", () => {
  freshState();
  const director = fakeDirector([
    { username: "Herby", kingdomId: "varrock", online: true, levels: { herblore: 42 } },
    { username: "Weakling", kingdomId: "varrock", online: true, levels: { herblore: 5 } },
  ]);
  Life.tickScience(director, Date.now());
  assert.ok(Science.scientistFor("Herby"), "Herby registered");
  assert.strictEqual(Science.scientistFor("Weakling"), null, "Weakling not registered");
});

test("tick records the scientist's skill level", () => {
  freshState();
  const director = fakeDirector([
    { username: "Smithy", kingdomId: "varrock", online: true, levels: { smithing: 61 } },
  ]);
  Life.tickScience(director, Date.now());
  assert.strictEqual(Science.scientistFor("Smithy")?.skillLevel, 61);
});

test("offline citizens are not registered (no bot to read skills)", () => {
  freshState();
  const director = fakeDirector([
    { username: "Farmer", kingdomId: "lumbridge", online: false, levels: { farming: 35 } },
  ]);
  Life.tickScience(director, Date.now());
  assert.strictEqual(Science.scientistFor("Farmer"), null, "offline skills are unreadable");
});

// --- experiment resolution ---

test("completed experiment resolves via the success path", () => {
  freshState();
  Science.registerScientist("Ada", "medicine");
  Science.setSkillLevel("Ada", 99); // near-guaranteed success
  Science.labFor("varrock").level = 3;
  const exp = Science.startExperiment("Ada", "antiseptic_trial", "varrock");
  // Force completion by advancing to the tick threshold.
  for (let i = 0; i < 25; i++) Science.advanceExperiment(exp.id, 1);
  const director = fakeDirector([]);
  Life.tickScience(director, Date.now());
  const done = Science.load().experiments[exp.id];
  assert.strictEqual(done.status, "succeeded", "level-99 scientist should succeed");
  assert.ok(Science.hasDiscovery("varrock", "antisepsis"), "discovery recorded");
});

test("failed experiment marks failure without a discovery", () => {
  freshState();
  Science.registerScientist("Newbie", "medicine");
  Science.setSkillLevel("Newbie", 30); // minimum level
  Science.labFor("varrock").level = 3;
  const exp = Science.startExperiment("Newbie", "antiseptic_trial", "varrock");
  // Force a failure deterministically through the seam.
  Life._resolveExperiment.__testForceFail = true;
  const origRandom = Math.random;
  Math.random = () => 0.999; // above any success chance
  try {
    for (let i = 0; i < 25; i++) Science.advanceExperiment(exp.id, 1);
    Life.tickScience(fakeDirector([]), Date.now());
  } finally {
    Math.random = origRandom;
  }
  const done = Science.load().experiments[exp.id];
  assert.strictEqual(done.status, "failed");
  assert.strictEqual(Science.hasDiscovery("varrock", "antisepsis"), false);
});

test("high-skill findings are peer-reviewed (verified)", () => {
  freshState();
  Science.registerScientist("Genius", "medicine");
  Science.setSkillLevel("Genius", 85);
  Science.labFor("varrock").level = 3;
  const exp = Science.startExperiment("Genius", "antiseptic_trial", "varrock");
  for (let i = 0; i < 25; i++) Science.advanceExperiment(exp.id, 1);
  Life.tickScience(fakeDirector([]), Date.now());
  const d = Science.load().discoveries["varrock:antisepsis"];
  assert.ok(d, "discovery exists");
  assert.strictEqual(d.verified, true, "skill 85 >= peer review threshold");
});

// --- grants ---

test("overdue grants are revoked", () => {
  freshState();
  const g = Science.awardGrant("varrock", "Ada", "exp_9", 500);
  // Backdate the grant past the 30-day deadline.
  Science.load().grants[g.id].grantedAt = Date.now() - 31 * 24 * 3600 * 1000;
  Life.tickScience(fakeDirector([]), Date.now());
  assert.strictEqual(Science.load().grants[g.id], undefined, "grant revoked");
});

test("published grants survive the deadline", () => {
  freshState();
  const g = Science.awardGrant("varrock", "Ada", "exp_9", 500);
  Science.publish("Ada", "Findings", "medicine", false);
  Science.load().grants[g.id].grantedAt = Date.now() - 31 * 24 * 3600 * 1000;
  Life.tickScience(fakeDirector([]), Date.now());
  assert.ok(Science.load().grants[g.id], "published grant kept");
});

// --- never throws ---

test("curious citizens register as astronomers (no skill needed)", () => {
  freshState();
  const director = fakeDirector([
    {
      username: "Stargazer",
      kingdomId: "varrock",
      online: true,
      levels: {},
      traits: ["curious"],
    },
  ]);
  // The fake bot needs getAttribute for the curiosity check.
  const origGetBot = director.getBot;
  director.getBot = (r) => {
    const bot = origGetBot(r);
    if (!bot) return null;
    bot.getAttribute = () => ({ traits: r.traits ?? [] });
    return bot;
  };
  Life.tickScience(director, Date.now());
  const rec = Science.scientistFor("Stargazer");
  assert.ok(rec, "curious citizen registered");
  assert.strictEqual(rec.field, "astronomy");
});

test("tick never throws on empty/broken director", () => {
  freshState();
  Life.tickScience({}, Date.now());
  Life.tickScience(null, Date.now());
  Life.tickScience({ roster: null }, Date.now());
});

console.log(`\n${passed} tests passed.`);
