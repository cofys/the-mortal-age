"use strict";

/**
 * CitizenResearch.test.js — brain action tests for citizen science.
 *
 * Plain node:assert, no engine, no jest. Run with: node <this file>.
 * Uses require-cache stubs for the engine modules the action imports.
 */

const assert = require("node:assert");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

// --- stub engine modules before requiring the action ---

const MODULE_PATH = path.resolve(__dirname, "CitizenResearch.js");

// ActionState stub: player position.
require.cache[require.resolve("../../../bots/brain/ActionState")] = {
  id: "stub",
  filename: require.resolve("../../../bots/brain/ActionState"),
  loaded: true,
  exports: {
    playerState: () => ({ position: { x: 3000, y: 3000 } }),
  },
};

// BotNavigation stub: movement is a no-op that "arrives" instantly.
require.cache[require.resolve("../../../bots/behaviours/navigation/BotNavigation")] = {
  id: "stub",
  filename: require.resolve("../../../bots/behaviours/navigation/BotNavigation"),
  loaded: true,
  exports: {
    requestMovement: () => {},
    clearMovementRequest: () => {},
  },
};

// CitizenSites stub: deterministic lab tile AT the player position (arrived).
require.cache[require.resolve("../CitizenSites")] = {
  id: "stub",
  filename: require.resolve("../CitizenSites"),
  loaded: true,
  exports: {
    siteTile: () => ({ x: 3000, y: 3000 }),
    siteTileByKingdom: () => ({ x: 3000, y: 3000 }),
    kingdomIdOf: () => "varrock",
  },
};

// constants stub
require.cache[require.resolve("../../constants")] = {
  id: "stub",
  filename: require.resolve("../../constants"),
  loaded: true,
  exports: { ATTR_CITIZEN_PERSONALITY: "citizens:personality" },
};

// humanizer stub
require.cache[require.resolve("../../lib/humanizer")] = {
  id: "stub",
  filename: require.resolve("../../lib/humanizer"),
  loaded: true,
  exports: {
    agentRng: () => Math.random(),
    personalSpot: () => ({ x: 3000, y: 3000 }),
    humanizerProfile: () => ({}),
  },
};

const Science = require("../../lib/CitizenScience");
const { createCitizenResearchAction } = require("./CitizenResearch");

const tmpSave = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "research-test-")), "science.json");
Science._setSavePathForTests(tmpSave);

function freshState() {
  Science.resetForTests();
  Science._setSavePathForTests(tmpSave);
}

// Fake player with a real-ish inventory.
function fakePlayer(username, items = {}, traits = []) {
  const inv = { ...items };
  return {
    username,
    getUsername: () => username,
    getPosition: () => ({ x: 3000, y: 3000 }),
    getAttribute: (key) =>
      key === "citizens:personality" ? { traits } : undefined,
    getInventory: () => ({
      getAmount: (id) => inv[id] ?? 0,
      count: (id) => inv[id] ?? 0,
      deleteNumber: (id, n) => {
        inv[id] = Math.max(0, (inv[id] ?? 0) - n);
      },
    }),
    getSkills: () => ({ getLevel: (skill) => 99 }),
    _inv: inv,
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

console.log("CitizenResearch brain action tests:");

// --- factory ---

test("action factory creates a tickable action", () => {
  freshState();
  const player = fakePlayer("Ada");
  const action = createCitizenResearchAction(player, {});
  assert.strictEqual(action.id, "citizenResearch");
  assert.strictEqual(typeof action.tick, "function");
});

test("null player fails safe", () => {
  freshState();
  const action = createCitizenResearchAction(null, {});
  assert.strictEqual(action.tick(), "success");
});

test("non-scientist fails safe (honest end)", () => {
  freshState();
  const player = fakePlayer("Bob");
  const action = createCitizenResearchAction(player, {});
  // Bob is not registered as a scientist; first tick walks outbound,
  // second tick arrives and finds no scientist record → success.
  action.tick();
  assert.strictEqual(action.tick(), "success");
});

// --- experiment flow ---

test("scientist with materials starts an experiment", () => {
  freshState();
  Science.registerScientist("Ada", "medicine");
  Science.setSkillLevel("Ada", 99);
  Science.labFor("varrock").level = 3;
  // antiseptic_trial needs clean_herb x5 + vial x3. clean_herb resolves via
  // the Herblore plugin (absent here → null), so give papyrus-heavy
  // star_charting materials instead: papyrus x8 + vial x1.
  Science.registerScientist("Stargazer", "astronomy");
  const player = fakePlayer("Stargazer", { 970: 20, 229: 5 }, ["curious"]);
  const action = createCitizenResearchAction(player, {});
  action.tick(); // outbound
  const result = action.tick(); // working: starts star_charting
  const exp = Science.experimentFor("Stargazer");
  assert.ok(exp, "experiment started");
  assert.strictEqual(exp.templateId, "star_charting");
  // Materials consumed from the real inventory.
  assert.ok(player._inv[970] < 20, "papyrus consumed");
});

test("scientist without materials ends honestly", () => {
  freshState();
  Science.registerScientist("Broke", "medicine");
  Science.setSkillLevel("Broke", 99);
  Science.labFor("varrock").level = 3;
  const player = fakePlayer("Broke", {}); // empty inventory
  const action = createCitizenResearchAction(player, {});
  action.tick();
  assert.strictEqual(action.tick(), "success");
  assert.strictEqual(Science.experimentFor("Broke"), null);
});

test("scientist with running experiment tinkers (progress boost)", () => {
  freshState();
  Science.registerScientist("Ada", "medicine");
  Science.setSkillLevel("Ada", 99);
  Science.labFor("varrock").level = 3;
  const started = Science.startExperiment("Ada", "antiseptic_trial", "varrock");
  const player = fakePlayer("Ada");
  const action = createCitizenResearchAction(player, {});
  action.tick(); // outbound
  action.tick(); // working: tinkers (+2 progress)
  const exp = Science.load().experiments[started.id];
  assert.ok(exp.progress >= 2, `progress boosted, got ${exp.progress}`);
});

test("action never throws on broken player", () => {
  freshState();
  const action = createCitizenResearchAction({}, {});
  assert.doesNotThrow(() => action.tick());
});

console.log(`\n${passed} tests passed.`);
