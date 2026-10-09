"use strict";

/**
 * CitizenDigGuild.test.js — brain action contracts without a running server.
 * Engine modules are stubbed in the require cache so plain-node tests stay
 * engine-free (same pattern as CitizenGuildSurvey.test.js).
 *
 * Run: node server/plugins/citizens/brain/actions/CitizenDigGuild.test.js
 */

const assert = require("assert");
const path = require("path");

// --- stubs (must be installed before requiring the action) ---

const actionStatePath = path.resolve(__dirname, "../../../bots/brain/ActionState.js");
require.cache[actionStatePath] = {
  id: actionStatePath, filename: actionStatePath, loaded: true,
  exports: {
    playerState: (action, player, init) => {
      if (!player.__digState) player.__digState = init();
      return player.__digState;
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
const guildsPath = path.resolve(__dirname, "../../lib/CitizenDigGuilds.js");
require.cache[guildsPath] = {
  id: guildsPath, filename: guildsPath, loaded: true,
  exports: {
    RANK_DIGGER: "digger",
    RANK_EXCAVATOR: "excavator",
    RANK_CONSERVATOR: "conservator",
    isGuildMember: (u) => members.has(String(u || "").toLowerCase()),
    guildRankOf: (u) => (members.has(String(u || "").toLowerCase()) ? "excavator" : null),
    ensureGuild: () => ({ hallTile: { x: 3206, y: 3210, z: 0 } }),
    mentoredBy: () => null,
  },
};

// --- real module under test ---

const { createCitizenDigGuildAction } = require("./CitizenDigGuild");

const HALL_TILE = { x: 3206, y: 3210, z: 0 };
const HOME_TILE = { x: 3200, y: 3200, z: 0 };

function stubPlayer(username, position) {
  return {
    __digState: null,
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
  try {
    fn();
    passed++;
  } catch (e) {
    console.error(`FAIL: ${name}\n  ${e.message}`);
    process.exitCode = 1;
  }
}

test("factory creates the action", () => {
  const a = createCitizenDigGuildAction({}, {});
  assert.strictEqual(a.id, "citizenDigGuild");
  assert.strictEqual(typeof a.update, "function");
});

test("non-member walks home honestly", () => {
  const a = createCitizenDigGuildAction({}, {});
  const p = stubPlayer("Stranger", { x: 0, y: 0, z: 0 });
  let nowMs = 1000000;
  a.update({ player: p, nowMs });
  assert.deepStrictEqual(p.__movedTo, HOME_TILE); // heading home, not to the hall
  p.getPosition = () => ({ ...HOME_TILE });
  const { status } = runTicks(a, p, 50, 1000);
  assert.strictEqual(status, "success");
});

test("member walks to the hall, holds sessions, returns home", () => {
  members.add("gwen");
  const a = createCitizenDigGuildAction({}, {});
  const p = stubPlayer("Gwen", { x: 0, y: 0, z: 0 });
  let nowMs = 1000000;
  let status = a.update({ player: p, nowMs });
  assert.strictEqual(status, "running");
  assert.deepStrictEqual(p.__movedTo, HALL_TILE);
  // Arrive at the hall -> session rounds.
  p.getPosition = () => ({ ...HALL_TILE });
  for (let i = 0; i < 5; i++) { nowMs += 9000; status = a.update({ player: p, nowMs }); }
  assert.strictEqual(p.__digState.roundsDone, 3);
  // After sessions -> returning home.
  nowMs += 9000;
  status = a.update({ player: p, nowMs });
  assert.strictEqual(status, "running"); // walking home (hall is 12 tiles from home)
  assert.deepStrictEqual(p.__movedTo, HOME_TILE);
  p.getPosition = () => ({ ...HOME_TILE });
  const r2 = runTicks(a, p, 50, 1000, nowMs);
  assert.strictEqual(r2.status, "success");
});

test("give-up timeout sends the citizen home", () => {
  members.add("hank");
  const a = createCitizenDigGuildAction({}, {});
  const p = stubPlayer("Hank", { x: 0, y: 0, z: 0 });
  let nowMs = 1000000;
  a.update({ player: p, nowMs }); // init
  // Never move; jump past the give-up.
  const r = runTicks(a, p, 5, 1000, nowMs + 11 * 60 * 1000);
  assert.deepStrictEqual(p.__movedTo, HOME_TILE);
  assert.strictEqual(r.status, "running"); // heading home
});

test("null player is safe", () => {
  const a = createCitizenDigGuildAction({}, {});
  assert.strictEqual(a.update({ player: null, nowMs: 1000000 }), "success");
});

console.log(`CitizenDigGuild: ${passed} tests passed`);
