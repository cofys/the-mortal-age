"use strict";

/**
 * CitizenCompete.test.js — brain action contracts without a running server.
 * Engine modules are stubbed in the require cache so plain-node tests stay
 * engine-free (same pattern as CitizenThieve.test.js).
 */

const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

const ACTIONS_DIR = __dirname;
const LIB_DIR = path.join(__dirname, "..", "..", "lib");

// --- stubs -------------------------------------------------------------------

const movementCalls = [];
const moodCalls = [];

function stubModule(requestPath, exports) {
  const resolved = Module._resolveFilename(requestPath, { id: "test", filename: __filename, paths: Module._nodeModulePaths(__dirname) });
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

stubModule("../../../bots/brain/ActionState", {
  playerState: () => ({ personality: { competitive: 0.9 } }),
});
stubModule("../../../bots/behaviours/navigation/BotNavigation", {
  requestMovement: (player, tile) => movementCalls.push({ player, tile }),
  clearMovementRequest: () => {},
});
stubModule("../../lib/humanizer", {
  agentRng: () => () => 0.5,
  personalSpot: (player, tile) => tile,
  humanizerProfile: () => ({ pace: 1 }),
});

// CitizenTournaments: use the REAL data tier (it's engine-free).
const T = require(path.join(LIB_DIR, "CitizenTournaments"));
const os = require("node:os");
const fs = require("node:fs");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cc-test-"));
T._setSavePathForTests(path.join(TMP, "citizen-tournaments.json"));

// CitizenSites stub: kingdom + market tile (data tier uses
// ../brain/CitizenSites siteTileByKingdom from lib/).
stubModule("../CitizenSites", {
  kingdomIdOf: () => "varrock",
  siteTileByKingdom: () => ({ x: 0, y: 0, z: 0 }),
});

const { createCitizenCompeteAction } = require(path.join(ACTIONS_DIR, "CitizenCompete.js"));

let passed = 0;
function test(name, fn) {
  T.resetForTests();
  movementCalls.length = 0;
  moodCalls.length = 0;
  try {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}: ${e.message}`);
    console.error(e.stack?.split("\n").slice(0, 4).join("\n"));
    process.exitCode = 1;
  }
}

function mockPlayer(username, coins, atVenue) {
  return {
    username,
    _coins: coins,
    getPosition: () => (atVenue ? { x: 10, y: 0, z: 0 } : { x: 500, y: 500, z: 0 }),
    getInventory: () => ({
      count: (id) => (id === 995 ? coins : 0),
      remove: (id, n) => { if (id === 995) coins -= n; },
      add: (id, n) => { if (id === 995) coins += n; },
    }),
    getSkills: () => ({ getLevel: () => 50 }),
  };
}

const NOW = Date.now(); // real time — the action uses Date.now() for entry windows

test("factory returns action with id citizenCompete", () => {
  const a = createCitizenCompeteAction({ citizen: { username: "Bob" } }, {});
  assert.equal(a.id, "citizenCompete");
  assert.equal(typeof a.tick, "function");
});

test("no open tournament: trains at arena, running", () => {
  const player = mockPlayer("Bob", 1000, false); // far from venue
  const a = createCitizenCompeteAction({ citizen: { username: "Bob" } }, {});
  const res = a.tick(player, { director: {} });
  assert.equal(res, "running");
  assert.ok(movementCalls.length > 0); // walking to venue
});

test("open tournament, far: walks to venue", () => {
  T.openTournament("varrock", "arena", NOW);
  const player = mockPlayer("Bob", 1000, false);
  const a = createCitizenCompeteAction({ citizen: { username: "Bob" } }, {});
  const res = a.tick(player, { director: {} });
  assert.equal(res, "running");
  assert.ok(movementCalls.length > 0);
});

test("open tournament, at venue: enters and pays real fee", () => {
  const t = T.openTournament("varrock", "arena", NOW);
  const player = mockPlayer("Bob", 1000, true); // at venue (10,0)
  const a = createCitizenCompeteAction({ citizen: { username: "Bob" } }, {});
  const res = a.tick(player, { director: {} });
  assert.equal(res, "success");
  const after = T.tournamentById(t.id);
  assert.ok(after.entries.some((e) => e.username === "Bob"));
  assert.equal(after.pool, T.ARENA_ENTRY_FEE);
});

test("broke citizen cannot enter", () => {
  const t = T.openTournament("varrock", "arena", NOW);
  const player = mockPlayer("Broke", 5, true);
  const a = createCitizenCompeteAction({ citizen: { username: "Broke" } }, {});
  const res = a.tick(player, { director: {} });
  assert.equal(res, "success");
  assert.ok(!T.tournamentById(t.id).entries.some((e) => e.username === "Broke"));
});

test("already entered: trains, mood boost path doesn't throw", () => {
  const t = T.openTournament("varrock", "arena", NOW);
  T.enterTournament(t.id, "Bob", 150, NOW);
  const player = mockPlayer("Bob", 1000, true);
  // Stub CitizenNeeds lazily required in tick.
  const needsPath = require.resolve("../CitizenNeeds");
  require.cache[needsPath] = {
    id: needsPath, filename: needsPath, loaded: true,
    exports: { addMood: (p, n) => moodCalls.push(n) },
  };
  const a = createCitizenCompeteAction({ citizen: { username: "Bob" } }, {});
  const res = a.tick(player, { director: {} });
  assert.ok(["running", "success"].includes(res));
  delete require.cache[needsPath];
});

console.log(`\n${passed} tests passed`);
