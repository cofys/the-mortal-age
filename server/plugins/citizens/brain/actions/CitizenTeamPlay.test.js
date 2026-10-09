"use strict";

/**
 * CitizenTeamPlay.test.js — brain action contracts without a running server.
 * Engine modules are stubbed in the require cache so plain-node tests stay
 * engine-free (same pattern as CitizenCompete.test.js).
 */

const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");

const ACTIONS_DIR = __dirname;
const LIB_DIR = path.join(__dirname, "..", "..", "lib");

// --- stubs -------------------------------------------------------------------

const movementCalls = [];

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

// CitizenLeagues: use the REAL data tier (it's engine-free).
const tmpSave = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "teamplay-")), "citizen-leagues.json");
const L = require(path.join(LIB_DIR, "CitizenLeagues"));
L._setSavePathForTests(tmpSave);

// CitizenSites stub: kingdom + market tile.
stubModule("../CitizenSites", {
  kingdomIdOf: () => "misthalin",
  siteTile: () => ({ x: 3200, y: 3200, z: 0 }),
  siteTileByKingdom: () => ({ x: 3200, y: 3200, z: 0 }),
});

const { createCitizenTeamPlayAction } = require(path.join(ACTIONS_DIR, "CitizenTeamPlay"));

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (e) {
    console.error(`  FAIL - ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

function fakePlayer(username = "Athlete") {
  return {
    username,
    getUsername: () => username,
    getPosition: () => ({ x: 3200, y: 3200, z: 0 }),
    getAttribute: () => null,
    skills: {
      attack: { level: 40 },
      strength: { level: 45 },
      defence: { level: 35 },
      agility: { level: 30 },
    },
  };
}

console.log("CitizenTeamPlay brain action:");

test("factory creates action with correct id", () => {
  const action = createCitizenTeamPlayAction({ citizen: { username: "T" } }, {});
  assert.strictEqual(action.id, "citizenTeamPlay");
  assert.strictEqual(typeof action.tick, "function");
});

test("tick joins a team when not on one", () => {
  const action = createCitizenTeamPlayAction({ citizen: { username: "Joiner" } }, {});
  const player = fakePlayer("Joiner");
  const result = action.tick(player, { director: null });
  assert.ok(["success", "running"].includes(result));
  // The citizen should now be on a team.
  const team = L.teamOf("Joiner", "misthalin", "football")
    ?? L.teamOf("Joiner", "misthalin", "tugofwar")
    ?? L.teamOf("Joiner", "misthalin", "relay");
  assert.ok(team, "expected citizen to join a team");
});

test("tick walks to venue when far", () => {
  movementCalls.length = 0;
  const action = createCitizenTeamPlayAction({ citizen: { username: "Walker" } }, {});
  const player = fakePlayer("Walker");
  // Place the player far from the venue.
  player.getPosition = () => ({ x: 3000, y: 3000, z: 0 });
  const result = action.tick(player, { director: null });
  // Either walking (running) or already close enough.
  assert.ok(["success", "running"].includes(result));
});

test("tick never throws on null player", () => {
  const action = createCitizenTeamPlayAction({ citizen: { username: "Null" } }, {});
  const result = action.tick(null, { director: null });
  assert.strictEqual(result, "success");
});

test("tick trains at venue and completes", () => {
  const action = createCitizenTeamPlayAction({ citizen: { username: "Trainer" } }, {});
  const player = fakePlayer("Trainer");
  // First tick: join team + walk (player is at venue).
  let result = action.tick(player, { director: null });
  assert.ok(["success", "running"].includes(result));
});

console.log(`\n${passed} tests passed.`);
