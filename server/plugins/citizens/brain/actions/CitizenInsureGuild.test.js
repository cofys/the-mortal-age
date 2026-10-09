"use strict";

/**
 * CitizenInsureGuild.test.js — brain action contracts without a running server.
 * Engine modules are stubbed in the require cache so plain-node tests stay
 * engine-free (same pattern as CitizenBankGuild.test.js).
 *
 * Run: node server/plugins/citizens/brain/actions/CitizenInsureGuild.test.js
 */

const assert = require("assert");
const path = require("path");

// --- stubs (must be installed before requiring the action) ---

const actionStatePath = path.resolve(__dirname, "../../../bots/brain/ActionState.js");
require.cache[actionStatePath] = {
  id: actionStatePath, filename: actionStatePath, loaded: true,
  exports: {
    playerState: (action, player, init) => {
      if (!player.__insureGuildState) player.__insureGuildState = init();
      return player.__insureGuildState;
    },
  },
};

const navPath = path.resolve(__dirname, "../../../bots/behaviours/navigation/BotNavigation.js");
require.cache[navPath] = {
  id: navPath, filename: navPath, loaded: true,
  exports: {
    requestMovement: (player, tile) => { player.__movedTo = tile; },
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

// Controllable guild membership.
const members = new Set();
const actuaries = new Set();
const guildsPath = path.resolve(__dirname, "../../lib/CitizenInsureGuilds.js");
require.cache[guildsPath] = {
  id: guildsPath, filename: guildsPath, loaded: true,
  exports: {
    RANK_AGENT: "agent",
    RANK_BROKER: "broker",
    RANK_ACTUARY: "actuary",
    isGuildMember: (u) => members.has(String(u || "").toLowerCase()),
    guildRankOf: (u) => (actuaries.has(String(u || "").toLowerCase()) ? "actuary" : members.has(String(u || "").toLowerCase()) ? "agent" : null),
    ensureGuild: () => ({ hallTile: { x: 3206, y: 3200, z: 0 } }),
  },
};

const journalPath = path.resolve(__dirname, "../../lib/CitizenJournal.js");
require.cache[journalPath] = {
  id: journalPath, filename: journalPath, loaded: true,
  exports: { getJournal: () => ({ log: () => {} }) },
};

// --- real module under test ---

const { createCitizenInsureGuildAction } = require("./CitizenInsureGuild");

const HALL_TILE = { x: 3206, y: 3200, z: 0 };
const HOME_TILE = { x: 3200, y: 3200, z: 0 };

function stubPlayer(username, position) {
  return {
    __insureGuildState: null,
    __movedTo: null,
    getUsername: () => username,
    username,
    getAttribute: () => ({}),
    getPosition: () => position || { x: 0, y: 0, z: 0 },
  };
}

function runTicks(action, player, ticks, stepMs) {
  let nowMs = 1000000;
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
  actuaries.clear();
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL: ${name}\n  ${e.message}`);
    process.exitCode = 1;
  }
}

test("factory creates the action", () => {
  const a = createCitizenInsureGuildAction({}, {});
  assert.strictEqual(a.id, "citizenInsureGuild");
  assert.strictEqual(typeof a.update, "function");
});

test("non-member walks home honestly", () => {
  const a = createCitizenInsureGuildAction({}, {});
  const p = stubPlayer("Stranger", { x: 0, y: 0, z: 0 });
  a.update({ player: p, nowMs: 1000000 });
  assert.deepStrictEqual(p.__movedTo, HOME_TILE); // heading home, not to the hall
  p.getPosition = () => ({ ...HOME_TILE });
  const { status } = runTicks(a, p, 50, 1000);
  assert.strictEqual(status, "success");
});

test("member walks to the hall, holds sessions, returns home", () => {
  members.add("gwen");
  const a = createCitizenInsureGuildAction({}, {});
  const p = stubPlayer("Gwen", { x: 0, y: 0, z: 0 });
  let nowMs = 1000000;
  a.update({ player: p, nowMs });
  assert.deepStrictEqual(p.__movedTo, HALL_TILE); // outbound toward the hall
  // Arrive at the hall.
  p.getPosition = () => ({ ...HALL_TILE });
  const { status } = runTicks(a, p, 60, 9000);
  assert.strictEqual(status, "success"); // sessions done, walked home
});

test("actuary sessions complete the full round count", () => {
  members.add("ed");
  actuaries.add("ed");
  const a = createCitizenInsureGuildAction({}, {});
  const p = stubPlayer("Ed", { ...HALL_TILE });
  let nowMs = 1000000;
  let status = a.update({ player: p, nowMs });
  assert.strictEqual(status, "running"); // at hall -> session phase
  const res = runTicks(a, p, 60, 9000);
  assert.strictEqual(res.status, "success");
});

test("null player is safe", () => {
  const a = createCitizenInsureGuildAction({}, {});
  assert.strictEqual(a.update({ player: null, nowMs: 1000000 }), "success");
});

test("give-up timeout sends a stuck member home", () => {
  members.add("slow");
  const a = createCitizenInsureGuildAction({}, {});
  const p = stubPlayer("Slow", { x: 0, y: 0, z: 0 }); // never arrives at the hall
  let res = runTicks(a, p, 20, 60000); // 20 minutes — past the 10-min give-up
  assert.strictEqual(p.__insureGuildState.phase, "returning");
  assert.deepStrictEqual(p.__movedTo, HOME_TILE); // heading home now
  p.getPosition = () => ({ ...HOME_TILE }); // arrives home
  res = runTicks(a, p, 20, 60000);
  assert.strictEqual(res.status, "success");
});

console.log(`\n${passed} tests passed`);
