/**
 * CitizenXpSync.test.js — XP unification (Jon 2026-10-12).
 *
 * Verifies the single-source-of-truth contract:
 * - Hydrate: skillStore -> SkillManager on materialize
 * - Persist: SkillManager -> skillStore on dematerialize
 * - Grant: routes to engine when materialized, store when not
 * - Round-trip: no XP lost across materialize/dematerialize cycles
 */

"use strict";

const {
  SKILL_ID_TO_ENUM,
  getSkillEnum,
  hydrateSkillsFromStore,
  persistSkillsToStore,
  grantXp,
} = require("./CitizenXpSync");

// --- Mocks -----------------------------------------------------------------

// Minimal Skill enum mock (mirrors api.core.Skill shape).
const Skill = {};
for (const enumName of new Set(Object.values(SKILL_ID_TO_ENUM))) {
  Skill[enumName] = { name: enumName, getIndex: () => 0 };
}

// Mock SkillManager: simple XP map.
function mockSkillManager() {
  const xp = new Map();
  return {
    _xp: xp,
    setExperience(skill, amount) {
      xp.set(skill.name, amount);
    },
    getExperience(skill) {
      return xp.get(skill.name) ?? 0;
    },
    addExperiences(skill, amount) {
      xp.set(skill.name, (xp.get(skill.name) ?? 0) + amount);
    },
  };
}

function mockBot() {
  const sm = mockSkillManager();
  return {
    getSkillManager: () => sm,
    _sm: sm,
  };
}

// Mock skillStore: mirrors CitizenSkilling.skillStore interface.
function mockSkillStore() {
  const data = new Map(); // normalized name -> { skillId: xp }
  const norm = (n) => String(n ?? "").toLowerCase();
  return {
    _data: data,
    getXp(name, skillId) {
      return data.get(norm(name))?.[skillId] ?? 0;
    },
    addXp(name, skillId, amount) {
      const key = norm(name);
      let entry = data.get(key);
      if (!entry) {
        entry = {};
        data.set(key, entry);
      }
      entry[skillId] = (entry[skillId] ?? 0) + amount;
      return { leveled: false, level: 1 };
    },
    setXp(name, skillId, xp) {
      const key = norm(name);
      let entry = data.get(key);
      if (!entry) {
        entry = {};
        data.set(key, entry);
      }
      entry[skillId] = Math.max(0, Math.floor(xp));
    },
  };
}

// Simple levelForXp (1 xp per level for test simplicity).
const levelForXp = (xp) => Math.max(1, Math.floor(xp / 100) + 1);

// --- Tests -----------------------------------------------------------------

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL: ${name} — ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

console.log("CitizenXpSync tests:");

test("getSkillEnum maps skillStore IDs to Skill enum", () => {
  assert(getSkillEnum(Skill, "cooking") === Skill.COOKING, "cooking");
  assert(getSkillEnum(Skill, "fishing") === Skill.FISHING, "fishing");
  assert(getSkillEnum(Skill, "woodcutting") === Skill.WOODCUTTING, "woodcutting");
  assert(getSkillEnum(Skill, "nonexistent") === null, "unknown -> null");
  assert(getSkillEnum(null, "cooking") === null, "null Skill -> null");
});

test("hydrateSkillsFromStore copies store XP to SkillManager", () => {
  const store = mockSkillStore();
  store.setXp("TestBot", "cooking", 1500);
  store.setXp("TestBot", "fishing", 2500);
  const bot = mockBot();

  hydrateSkillsFromStore(bot, "TestBot", Skill, store);

  assert(bot._sm.getExperience(Skill.COOKING) === 1500, "cooking hydrated");
  assert(bot._sm.getExperience(Skill.FISHING) === 2500, "fishing hydrated");
  assert(bot._sm.getExperience(Skill.MINING) === 0, "mining untouched");
});

test("hydrateSkillsFromStore handles missing bot/Skill/store gracefully", () => {
  const store = mockSkillStore();
  // Should not throw.
  hydrateSkillsFromStore(null, "TestBot", Skill, store);
  hydrateSkillsFromStore(mockBot(), "TestBot", null, store);
  hydrateSkillsFromStore(mockBot(), "TestBot", Skill, null);
  hydrateSkillsFromStore(mockBot(), "", Skill, store);
});

test("persistSkillsToStore copies SkillManager XP to store", () => {
  const store = mockSkillStore();
  const bot = mockBot();
  bot._sm.setExperience(Skill.COOKING, 3000);
  bot._sm.setExperience(Skill.MINING, 1000);

  persistSkillsToStore(bot, "TestBot", Skill, store);

  assert(store.getXp("TestBot", "cooking") === 3000, "cooking persisted");
  assert(store.getXp("TestBot", "mining") === 1000, "mining persisted");
  assert(store.getXp("TestBot", "fishing") === 0, "fishing untouched");
});

test("persistSkillsToStore handles missing bot gracefully", () => {
  const store = mockSkillStore();
  persistSkillsToStore(null, "TestBot", Skill, store);
  // Should not throw, store unchanged.
  assert(store.getXp("TestBot", "cooking") === 0, "store unchanged");
});

test("grantXp routes to engine when materialized", () => {
  const store = mockSkillStore();
  const bot = mockBot();
  const director = { getBot: () => bot };

  const result = grantXp(director, "TestBot", "cooking", 500, Skill, store, levelForXp);

  assert(result.via === "engine", "routed to engine");
  assert(bot._sm.getExperience(Skill.COOKING) === 500, "engine got XP");
  assert(store.getXp("TestBot", "cooking") === 0, "store untouched");
});

test("grantXp routes to store when not materialized", () => {
  const store = mockSkillStore();
  const director = { getBot: () => null };

  const result = grantXp(director, "TestBot", "cooking", 500, Skill, store, levelForXp);

  assert(result.via === "store", "routed to store");
  assert(store.getXp("TestBot", "cooking") === 500, "store got XP");
});

test("grantXp detects level-ups via engine", () => {
  const store = mockSkillStore();
  const bot = mockBot();
  bot._sm.setExperience(Skill.COOKING, 50); // level 1 (50/100)
  const director = { getBot: () => bot };

  const result = grantXp(director, "TestBot", "cooking", 100, Skill, store, levelForXp);

  assert(result.leveled === true, "leveled detected");
  assert(result.level === 2, "level 2");
});

test("ROUND-TRIP: no XP lost across materialize/dematerialize", () => {
  const store = mockSkillStore();
  // Citizen has 1000 cooking XP in the store (from background sim).
  store.setXp("RoundTrip", "cooking", 1000);

  // 1. Materialize: hydrate.
  const bot = mockBot();
  hydrateSkillsFromStore(bot, "RoundTrip", Skill, store);
  assert(bot._sm.getExperience(Skill.COOKING) === 1000, "hydrated 1000");

  // 2. While materialized: gain 500 XP via engine (real skilling).
  const director = { getBot: () => bot };
  grantXp(director, "RoundTrip", "cooking", 500, Skill, store, levelForXp);
  assert(bot._sm.getExperience(Skill.COOKING) === 1500, "engine has 1500");

  // 3. Dematerialize: persist.
  persistSkillsToStore(bot, "RoundTrip", Skill, store);
  assert(store.getXp("RoundTrip", "cooking") === 1500, "store has 1500");

  // 4. Rematerialize: hydrate again.
  const bot2 = mockBot();
  hydrateSkillsFromStore(bot2, "RoundTrip", Skill, store);
  assert(bot2._sm.getExperience(Skill.COOKING) === 1500, "re-hydrated 1500");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
