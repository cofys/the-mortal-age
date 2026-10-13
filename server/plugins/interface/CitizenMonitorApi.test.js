"use strict";

// CitizenMonitorApi skills-surfacing unit checks — plain node, no server.
// From server/: node plugins/interface/CitizenMonitorApi.test.js
//
// Covers the Jon 2026-10-13 ask ("any of em gaining skill levels in other
// skills"): per-citizen live skills from in-memory state, engine SkillManager
// for materialized citizens, data-tier skillStore snapshot for the rest,
// and the skillSummary gain aggregation.

const assert = require("node:assert/strict");
const path = require("node:path");

const API_PATH = path.resolve(__dirname, "CitizenMonitorApi.js");
const DIRECTOR_PATH = path.resolve(__dirname, "../citizens/director/CitizenDirector.js");
const SAY_PUBLIC_PATH = path.resolve(__dirname, "../citizens/chat/CitizenSayPublic.js");

function stubModule(resolvedPath, exportsObj) {
  const m = new (require("node:module").Module)(resolvedPath, module);
  m.exports = exportsObj;
  m.loaded = true;
  require.cache[resolvedPath] = m;
}

// --- fake roster -------------------------------------------------------------
const records = [
  { username: "Skill_Test_One", position: { x: 3200, y: 3200, z: 0 }, currentActivityId: "woodcutting" },
  { username: "Skill_Test_Two", position: { x: 3201, y: 3200, z: 0 }, currentActivityId: "idle" },
  { username: "Skill_Test_Three", position: { x: 3202, y: 3200, z: 0 }, currentActivityId: "idle" },
  { username: "Skill_Test_Four", position: { x: 3203, y: 3200, z: 0 }, currentActivityId: "idle" },
];

// Fake Skill enum: member name -> opaque token the fake SkillManager understands.
const FakeSkill = {
  ATTACK: "ATTACK", DEFENCE: "DEFENCE", STRENGTH: "STRENGTH", HITPOINTS: "HITPOINTS",
  RANGED: "RANGED", PRAYER: "PRAYER", MAGIC: "MAGIC", COOKING: "COOKING",
  WOODCUTTING: "WOODCUTTING", FLETCHING: "FLETCHING", FISHING: "FISHING",
  FIREMAKING: "FIREMAKING", CRAFTING: "CRAFTING", SMITHING: "SMITHING",
  MINING: "MINING", HERBLORE: "HERBLORE", AGILITY: "AGILITY", THIEVING: "THIEVING",
  SLAYER: "SLAYER", FARMING: "FARMING", RUNECRAFTING: "RUNECRAFTING",
  CONSTRUCTION: "CONSTRUCTION", HUNTER: "HUNTER",
};

function fakeSkillManager(xpByToken) {
  return {
    getExperience: (skill) => xpByToken[skill] ?? 0,
  };
}

const bots = {
  // One: materialized, engine holds the XP (source of truth while online).
  skill_test_one: {
    getSkillManager: () => fakeSkillManager({ WOODCUTTING: 200, FISHING: 50, HITPOINTS: 1154 }),
  },
  // Two: offline (no bot) — data-tier skillStore path.
  // Three: bot with no SkillManager — falls back to skillStore.
  skill_test_three: {},
  // Four: no bot, no store XP — empty skills.
};

const fakeDirector = {
  roster: new Map(records.map((r) => [r.username, r])),
  getBot: (record) => bots[String(record.username).toLowerCase()] ?? null,
};

stubModule(DIRECTOR_PATH, {
  getDirector: () => fakeDirector,
  CitizenDirector: {
    setDebugFakePlayer: () => {},
    clearDebugFakePlayers: () => {},
    getDebugFakePlayers: () => [],
  },
});
stubModule(SAY_PUBLIC_PATH, { recentSpeechEvents: () => [] });

// Real skillStore (in-memory) + real CitizenXpSync — only the director and
// speech modules are stubbed above.
const { attach } = require(API_PATH);
const { skillStore } = require("../citizens/lib/CitizenSkilling");

let handler = null;
attach({
  core: { Skill: FakeSkill },
  registerContentEndpoint: (name, fn) => {
    assert.equal(name, "citizen-monitor");
    handler = fn;
  },
});
assert.ok(handler, "endpoint handler registered");

function poll(all) {
  const q = new Map();
  if (all) q.set("all", "1");
  return handler(q);
}

// Seed data-tier XP for the offline citizen (unique names — no cross-file state).
skillStore.addXp("Skill_Test_Two", "mining", 500);
skillStore.addXp("Skill_Test_Three", "cooking", 120);

let pass = 0;
function check(name, fn) {
  fn();
  pass += 1;
  console.log("ok -", name);
}

// 1) Materialized citizen reads the engine SkillManager live.
check("engine path: woodcutting xp/level surfaced", () => {
  const res = poll(true);
  const one = res.citizens.find((c) => c.name === "Skill_Test_One");
  assert.ok(one, "citizen present");
  assert.equal(one.skills.woodcutting.xp, 200);
  assert.equal(one.skills.woodcutting.level, 3); // OSRS table: 200xp -> level 3
  assert.equal(one.skills.fishing.xp, 50);
  assert.equal(one.skills.hitpoints.level, 10); // engine default, honest read
});

// 2) Offline citizen reads the data-tier in-memory snapshot (no file read).
check("store path: offline citizen mining xp surfaced", () => {
  const res = poll(true);
  const two = res.citizens.find((c) => c.name === "Skill_Test_Two");
  assert.ok(two, "citizen present");
  assert.equal(two.skills.mining.xp, 500);
  assert.ok(two.skills.mining.level >= 2);
});

// 3) Bot without SkillManager falls back to the store.
check("fallback path: bot without SM uses skillStore", () => {
  const res = poll(true);
  const three = res.citizens.find((c) => c.name === "Skill_Test_Three");
  assert.ok(three, "citizen present");
  assert.equal(three.skills.cooking.xp, 120);
});

// 4) No gains -> empty skills object, excluded from summary.
check("empty skills for untouched citizen", () => {
  const res = poll(true);
  const four = res.citizens.find((c) => c.name === "Skill_Test_Four");
  assert.ok(four, "citizen present");
  assert.deepEqual(four.skills, {});
});

// 5) skillSummary aggregates the gain signal (non-HP only).
check("skillSummary counts gainers across non-HP skills", () => {
  const res = poll(true);
  assert.equal(res.skillSummary.scope, "all");
  assert.equal(res.skillSummary.citizensChecked, 4);
  assert.equal(res.skillSummary.citizensWithNonHpXp, 3);
  assert.equal(res.skillSummary.skillsTouched.woodcutting, 1);
  assert.equal(res.skillSummary.skillsTouched.fishing, 1);
  assert.equal(res.skillSummary.skillsTouched.mining, 1);
  assert.equal(res.skillSummary.skillsTouched.cooking, 1);
  assert.ok(!("hitpoints" in res.skillSummary.skillsTouched), "HP excluded from gain signal");
});

// 6) Without a Skill enum the engine path is skipped (store fallback).
check("missing Skill enum: engine skipped, store still works", () => {
  let h2 = null;
  attach({
    core: {},
    registerContentEndpoint: (_n, fn) => { h2 = fn; },
  });
  const res = h2(new Map([["all", "1"]]));
  const one = res.citizens.find((c) => c.name === "Skill_Test_One");
  assert.deepEqual(one.skills, {}, "engine unreadable without enum, store empty for One");
  const two = res.citizens.find((c) => c.name === "Skill_Test_Two");
  assert.equal(two.skills.mining.xp, 500, "store path unaffected");
});

console.log(`\n${pass} checks passed`);
