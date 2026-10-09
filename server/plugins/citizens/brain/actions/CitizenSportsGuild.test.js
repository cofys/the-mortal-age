"use strict";

/**
 * CitizenSportsGuild.test.js — brain action contracts without a running server.
 * Engine modules are stubbed in the require cache so plain-node tests stay
 * engine-free (same pattern as CitizenStageGuild.test.js).
 *
 * Run: node server/plugins/citizens/brain/actions/CitizenSportsGuild.test.js
 */

const assert = require("assert");
const path = require("path");

// --- stubs (must be installed before requiring the action) ---

const actionStatePath = path.resolve(__dirname, "../../../bots/brain/ActionState.js");
require.cache[actionStatePath] = {
  id: actionStatePath, filename: actionStatePath, loaded: true,
  exports: {
    playerState: (action, player, init) => {
      if (!player.__sportsState) player.__sportsState = init();
      return player.__sportsState;
    },
  },
};

const navPath = path.resolve(__dirname, "../../../bots/behaviours/navigation/BotNavigation.js");
require.cache[navPath] = {
  id: navPath, filename: navPath, loaded: true,
  exports: {
    requestMovement: (player, targetX, targetY, options = {}) => { player.__movedTo = { x: targetX, y: targetY, z: options?.z ?? 0 }; },
    clearMovementRequest: () => {},
  },
};

const sitesPath = path.resolve(__dirname, "../CitizenSites.js");
require.cache[sitesPath] = {
  id: sitesPath, filename: sitesPath, loaded: true,
  exports: {
    siteTile: () => ({ x: 3200, y: 3200, z: 0 }),
    kingdomIdOf: () => "varrock",
  },
};

const constPath = path.resolve(__dirname, "../../constants.js");
require.cache[constPath] = {
  id: constPath, filename: constPath, loaded: true,
  exports: { ATTR_CITIZEN_PERSONALITY: "citizens:personality" },
};

const humanizerPath = path.resolve(__dirname, "../../lib/humanizer.js");
require.cache[humanizerPath] = {
  id: humanizerPath, filename: humanizerPath, loaded: true,
  exports: {
    agentRng: () => () => 0.5,
    humanizerProfile: () => ({}),
  },
};

const journalPath = path.resolve(__dirname, "../../lib/CitizenJournal.js");
require.cache[journalPath] = {
  id: journalPath, filename: journalPath, loaded: true,
  exports: { getJournal: () => ({ log: () => true }) },
};

// Controllable guild membership.
const members = new Set();
const suspended = new Set();
const guildsPath = path.resolve(__dirname, "../../lib/CitizenSportsGuilds.js");
require.cache[guildsPath] = {
  id: guildsPath, filename: guildsPath, loaded: true,
  exports: {
    RANK_ROOKIE: "rookie",
    RANK_COMPETITOR: "competitor",
    RANK_GAMESMASTER: "gamesmaster",
    isGuildMember: (u) => members.has(String(u || "").toLowerCase()),
    guildRankOf: (u) => (members.has(String(u || "").toLowerCase()) ? "competitor" : null),
    memberOf: (u) => (members.has(String(u || "").toLowerCase())
      ? { suspended: suspended.has(String(u || "").toLowerCase()) }
      : null),
    ensureGuild: () => ({ hallTile: { x: 3208, y: 3194, z: 0 } }),
  },
};

// --- real module under test ---

const { createCitizenSportsGuildAction } = require("./CitizenSportsGuild");

const HALL_TILE = { x: 3208, y: 3194, z: 0 };
const HOME_TILE = { x: 3200, y: 3200, z: 0 };

function stubPlayer(username, position) {
  return {
    __sportsState: null,
    __movedTo: null,
    getUsername: () => username,
    username,
    getAttribute: () => ({}),
    getPosition: () => position || { x: 0, y: 0, z: 0 },
  };
}

function runTicks(action, player, ticks, stepMs, startMs = 1000000) {
  let nowMs = startMs;
  let status = "running";
  for (let i = 0; i < ticks && status === "running"; i++) {
    nowMs += stepMs;
    status = action.update({ player, nowMs });
  }
  return { status, nowMs };
}

let passed = 0;
function test(name, fn) {
  members.clear();
  suspended.clear();
  try {
    fn();
    passed++;
  } catch (e) {
    console.error(`FAIL: ${name}\n  ${e.message}`);
    process.exitCode = 1;
  }
}

test("factory creates the action", () => {
  const a = createCitizenSportsGuildAction({}, {});
  assert.strictEqual(a.id, "citizenSportsGuild");
  assert.strictEqual(typeof a.update, "function");
});

test("non-member walks home honestly", () => {
  const a = createCitizenSportsGuildAction({}, {});
  const p = stubPlayer("Stranger", { x: 0, y: 0, z: 0 });
  let nowMs = 1000000;
  a.update({ player: p, nowMs });
  assert.deepStrictEqual(p.__movedTo, HOME_TILE); // heading home, not to the hall
  p.getPosition = () => ({ ...HOME_TILE });
  const { status } = runTicks(a, p, 50, 1000);
  assert.strictEqual(status, "success");
});

test("suspended member walks home honestly", () => {
  members.add("gwen");
  suspended.add("gwen");
  const a = createCitizenSportsGuildAction({}, {});
  const p = stubPlayer("Gwen", { x: 0, y: 0, z: 0 });
  let nowMs = 1000000;
  a.update({ player: p, nowMs });
  assert.deepStrictEqual(p.__movedTo, HOME_TILE);
});

test("member walks to the hall, holds sessions, returns home", () => {
  members.add("gwen");
  const a = createCitizenSportsGuildAction({}, {});
  const p = stubPlayer("Gwen", { x: 0, y: 0, z: 0 });
  let nowMs = 1000000;
  a.update({ player: p, nowMs });
  assert.deepStrictEqual(p.__movedTo, HALL_TILE);
  // arrive at the hall
  p.getPosition = () => ({ ...HALL_TILE });
  const r1 = runTicks(a, p, 10, 9000); // 8s rounds, 3 rounds then returning
  assert.strictEqual(r1.status, "running");
  // after sessions, walks home
  p.getPosition = () => ({ ...HOME_TILE });
  const r2 = runTicks(a, p, 50, 1000, r1.nowMs);
  assert.strictEqual(r2.status, "success");
});

test("null player is safe", () => {
  const a = createCitizenSportsGuildAction({}, {});
  assert.strictEqual(a.update({ player: null, nowMs: 1000000 }), "success");
});

test("give-up timeout sends the member home", () => {
  members.add("gwen");
  const a = createCitizenSportsGuildAction({}, {});
  const p = stubPlayer("Gwen", { x: 0, y: 0, z: 0 });
  // Never arrives; after the give-up window the action must head home.
  const r = runTicks(a, p, 700, 60000); // 700 min > 10 min give-up
  assert.ok(p.__movedTo, "movement requested");
  assert.deepStrictEqual(p.__movedTo, HOME_TILE);
  // Simulate arrival home after the give-up redirect.
  p.getPosition = () => ({ ...HOME_TILE });
  const r2 = runTicks(a, p, 50, 1000, r.nowMs);
  assert.strictEqual(r2.status, "success");
});

console.log(`\n${passed} tests passed.`);
