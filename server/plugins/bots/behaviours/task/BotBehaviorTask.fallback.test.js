"use strict";

/**
 * Test for the humanNearbyAt fallback in BotBehaviorTask.resolveEntryStride.
 *
 * Background (Jon 2026-10-12): citizen brains were stuck at 1/10th speed
 * because the director's humanNearbyAt stamp wasn't reaching
 * BotBehaviorTask, AND the LOD session scan (isPlayerSessionConnected)
 * misses web-client sessions. The fallback does a direct position check
 * against World.players (bots filtered, no session filter).
 */

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const Module = require("module");

// Stub the TypeScript engine imports before requiring BotBehaviorTask.
const TASK_PATH = path.resolve(__dirname, "BotBehaviorTask.js");

function stubTsModules() {
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request.includes("src/main/typescript")) {
      if (request.includes("task/Task")) {
        return { Task: class Task {} };
      }
      if (request.includes("model/Location")) {
        return { Location: class Location {} };
      }
      if (request.includes("wilderness/Wilderness")) {
        return { Wilderness: {} };
      }
      if (request.includes("combat/CombatFactory")) {
        return { CanAttackResponse: {} };
      }
      return {};
    }
    if (request.includes("BotNavigation")) {
      return {
        chooseNextTarget: () => null,
        peekMovementRequest: () => null,
        randomInRange: (a, b) => a,
      };
    }
    if (request.includes("PlayerBotState")) {
      return {
        isPvpOnlyBotState: () => false,
        isTeleblocked: () => false,
        resetMovementState: () => {},
      };
    }
    if (request.includes("BotRecruitConstants")) {
      return { ATTR_RECRUIT_OWNER_USERNAME: "recruit-owner" };
    }
    if (request.includes("BotTickMetrics")) {
      return { createBotTickMetrics: () => ({}) };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  return () => {
    Module._load = originalLoad;
  };
}

function makeLocation(x, y, z = 0) {
  return {
    getX: () => x,
    getY: () => y,
    getZ: () => z,
    x, y, z,
  };
}

function makePlayer(username, x, y, z = 0, isBot = false) {
  return {
    getUsername: () => username,
    isPlayerBot: () => isBot,
    getLocation: () => makeLocation(x, y, z),
  };
}

function makeWorld(players) {
  return {
    getPlayers: () => ({
      forEach: (fn) => players.forEach(fn),
    }),
    isPlayerSessionConnected: () => false, // Simulate web-client miss
  };
}

function makeTask(worldPlayers) {
  const restore = stubTsModules();
  let Task;
  try {
    Task = require(TASK_PATH).BotBehaviorTask;
  } finally {
    restore();
  }
  const world = makeWorld(worldPlayers);
  const api = {
    getWorld: () => world,
    getRegionManager: () => ({}),
    getCombatFactory: () => ({}),
    getAreaManager: () => ({}),
    getServerPerf: () => ({}),
  };
  const task = new Task([], 600, {
    api,
    lodConfig: {
      enabled: true,
      nearDistanceTiles: 32,
      mediumDistanceTiles: 96,
      nearStride: 1,
      mediumStride: 3,
      farStride: 5,
      citizenFarStride: 10,
      chunkSizeTiles: 16,
      refreshIntervalMs: 5000,
      nearCacheMs: 2000,
      mediumCacheMs: 5000,
      farCacheMs: 10000,
    },
  });
  // Ensure World is set (constructor reads from api)
  task.World = world;
  return task;
}

describe("resolveEntryStride humanNearbyAt fallback", () => {
  it("uses nearStride when stamp is fresh (existing behavior)", () => {
    const bot = makePlayer("Citizen1", 3200, 3200, 0, true);
    const task = makeTask([]);
    const entry = {
      player: bot,
      state: { isCitizen: true, humanNearbyAt: Date.now() - 10000 },
    };
    const stride = task.resolveEntryStride(entry, Date.now());
    assert.equal(stride, 1, "fresh stamp should give nearStride");
  });

  it("falls back to direct check when stamp is stale and player is near", () => {
    const bot = makePlayer("Citizen1", 3200, 3200, 0, true);
    const jon = makePlayer("Jon", 3210, 3205, 0, false); // 10 tiles away
    const task = makeTask([jon]);
    const entry = {
      player: bot,
      state: { isCitizen: true, humanNearbyAt: Date.now() - 120000 }, // stale
    };
    const stride = task.resolveEntryStride(entry, Date.now());
    assert.equal(
      stride,
      1,
      "stale stamp + nearby real player should give nearStride via fallback"
    );
  });

  it("uses farStride when stamp is stale and no player is near", () => {
    const bot = makePlayer("Citizen1", 3200, 3200, 0, true);
    const jon = makePlayer("Jon", 3400, 3400, 0, false); // 200 tiles away
    const task = makeTask([jon]);
    const entry = {
      player: bot,
      state: { isCitizen: true, humanNearbyAt: 0 }, // never stamped
    };
    const stride = task.resolveEntryStride(entry, Date.now());
    assert.equal(stride, 10, "no stamp + far player should give citizenFarStride");
  });

  it("ignores bots in the direct fallback check", () => {
    const bot = makePlayer("Citizen1", 3200, 3200, 0, true);
    const otherBot = makePlayer("Citizen2", 3205, 3205, 0, true); // nearby but a bot
    const task = makeTask([otherBot]);
    const entry = {
      player: bot,
      state: { isCitizen: true, humanNearbyAt: 0 },
    };
    const stride = task.resolveEntryStride(entry, Date.now());
    assert.equal(
      stride,
      10,
      "nearby bots should not trigger the fallback"
    );
  });

  it("findNearestRealPlayerDistanceDirect returns Infinity with no players", () => {
    const bot = makePlayer("Citizen1", 3200, 3200, 0, true);
    const task = makeTask([]);
    const dist = task.findNearestRealPlayerDistanceDirect(bot, 32);
    assert.equal(dist, Number.POSITIVE_INFINITY);
  });
});
