"use strict";

/**
 * CitizenTradeGuild.test.js — brain action contracts without a running server.
 * Engine modules are stubbed in the require cache so plain-node tests stay
 * engine-free (same pattern as CitizenBankGuild.test.js).
 *
 * Run: node server/plugins/citizens/brain/actions/CitizenTradeGuild.test.js
 */

const assert = require("assert");
const path = require("path");

// --- stubs (must be installed before requiring the action) ---

const actionStatePath = path.resolve(__dirname, "../../../bots/brain/ActionState.js");
require.cache[actionStatePath] = {
  id: actionStatePath, filename: actionStatePath, loaded: true,
  exports: {
    playerState: (action, player, init) => {
      if (!player.__tradeGuildState) player.__tradeGuildState = init();
      return player.__tradeGuildState;
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

// Controllable guild membership.
const members = new Map(); // lowerName -> { rank, suspended }
const HALL_TILE = { x: 3205, y: 3200, z: 0 };
const guildsPath = path.resolve(__dirname, "../../lib/CitizenTradeGuilds.js");
require.cache[guildsPath] = {
  id: guildsPath, filename: guildsPath, loaded: true,
  exports: {
    RANK_PEDDLER: "peddler",
    RANK_TRADER: "trader",
    RANK_MASTER: "merchantmaster",
    memberOf: (u) => {
      const m = members.get(String(u || "").toLowerCase());
      return m ? { rank: m.rank, suspended: !!m.suspended } : null;
    },
    hallTileFor: () => ({ ...HALL_TILE }),
  },
};

const journalPath = path.resolve(__dirname, "../../lib/CitizenJournal.js");
require.cache[journalPath] = {
  id: journalPath, filename: journalPath, loaded: true,
  exports: { getJournal: () => ({ log: () => {} }) },
};

// --- real module under test ---

const { createCitizenTradeGuildAction } = require("./CitizenTradeGuild");

const HOME_TILE = { x: 3200, y: 3200, z: 0 };

function stubPlayer(username, position) {
  return {
    __tradeGuildState: null,
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
  const a = createCitizenTradeGuildAction({}, {});
  assert.strictEqual(a.id, "citizenTradeGuild");
  assert.strictEqual(typeof a.update, "function");
});

test("non-member walks home honestly", () => {
  const a = createCitizenTradeGuildAction({}, {});
  const p = stubPlayer("Stranger", { x: 0, y: 0, z: 0 });
  a.update({ player: p, nowMs: 1000000 });
  assert.deepStrictEqual(p.__movedTo, HOME_TILE); // heading home, not to the hall
  p.getPosition = () => ({ ...HOME_TILE });
  const { status } = runTicks(a, p, 50, 1000);
  assert.strictEqual(status, "success");
});

test("suspended member walks home honestly", () => {
  members.set("susp", { rank: "trader", suspended: true });
  const a = createCitizenTradeGuildAction({}, {});
  const p = stubPlayer("Susp", { x: 0, y: 0, z: 0 });
  a.update({ player: p, nowMs: 1000000 });
  assert.deepStrictEqual(p.__movedTo, HOME_TILE);
});

test("member walks to the hall, holds sessions, returns home", () => {
  members.set("gwen", { rank: "trader", suspended: false });
  const a = createCitizenTradeGuildAction({}, {});
  const p = stubPlayer("Gwen", { x: 0, y: 0, z: 0 });
  a.update({ player: p, nowMs: 1000000 });
  assert.deepStrictEqual(p.__movedTo, HALL_TILE); // outbound toward the hall
  // Arrive at the hall.
  p.getPosition = () => ({ ...HALL_TILE });
  const { status } = runTicks(a, p, 60, 9000);
  assert.strictEqual(status, "success"); // sessions done, walked home
});

test("master sessions complete the full round count", () => {
  members.set("ed", { rank: "merchantmaster", suspended: false });
  const a = createCitizenTradeGuildAction({}, {});
  const p = stubPlayer("Ed", { ...HALL_TILE });
  const status = a.update({ player: p, nowMs: 1000000 });
  assert.strictEqual(status, "running"); // at hall -> session phase
  assert.strictEqual(p.__tradeGuildState.phase, "session");
});

test("null player is safe", () => {
  const a = createCitizenTradeGuildAction({}, {});
  assert.strictEqual(a.update({ player: null, nowMs: 1 }), "success");
});

test("give-up returns home", () => {
  members.set("slow", { rank: "peddler", suspended: false });
  const a = createCitizenTradeGuildAction({}, {});
  const p = stubPlayer("Slow", { x: 0, y: 0, z: 0 }); // never arrives
  let nowMs = 1000000;
  let status = "running";
  for (let i = 0; i < 700 && status === "running"; i++) {
    nowMs += 60 * 1000;
    status = a.update({ player: p, nowMs });
    if (p.__tradeGuildState.phase === "returning" && p.__movedTo) break; // give-up tripped
  }
  assert.strictEqual(p.__tradeGuildState.phase, "returning", "give-up trips");
  p.getPosition = () => ({ ...HOME_TILE }); // arrives home
  for (let i = 0; i < 10 && status === "running"; i++) {
    nowMs += 1000;
    status = a.update({ player: p, nowMs });
  }
  assert.strictEqual(status, "success");
});

console.log(`\n${passed} CitizenTradeGuild action tests passed.`);
