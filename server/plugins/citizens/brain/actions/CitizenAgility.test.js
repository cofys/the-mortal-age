"use strict";

/**
 * CitizenAgility unit checks — run real agility courses for real XP.
 *
 * Proves the brain action's contracts without a running server:
 *   - Factory returns an action with id "citizenAgility".
 *   - No Agility plugin -> "failed" (fail fast, don't stall).
 *   - Busy mid-obstacle -> "running" (waits for the runner).
 *   - Next obstacle read from lap progress: none -> 1, same course -> +1,
 *     other course -> 1.
 *   - No obstacle object nearby -> "success" (no course here, re-decide).
 *   - Obstacle far -> "running" (walks toward it).
 *   - Obstacle close -> emits the real object interaction, "running".
 *   - Lap complete (progress at final index) -> "success" (one lap, re-decide).
 *   - Give-up timeout -> "success", never stalls the day.
 *   - _obstaclesAt / _finalIndex helpers.
 *   - Decision scoring: citizen_agility scores well for an industrious
 *     skilling-goal citizen, penalized when hurt/exhausted.
 *
 * Engine modules are stubbed in the require cache (same pattern as
 * CitizenRc.test.js) so plain-node tests stay engine-free. Note the
 * engine Skill enum (a .ts source) is unavailable in plain node, so
 * _agilityLevel falls back to 1 — the course-selection branches are
 * exercised through the mock plugin instead.
 */
const assert = require("node:assert/strict");
const path = require("node:path");

// --- mock course data ---------------------------------------------------------
const OBJ_LOG = 1001;
const OBJ_NET = 1002;
const OBJ_PIPE_A = 1003;
const OBJ_PIPE_B = 1004;

function mockCourse() {
  return {
    key: "gnome",
    name: "Gnome Stronghold Agility",
    finalIndex: 3,
    obstacles: [
      { object: OBJ_LOG, index: 1, level: 1 },
      { object: OBJ_NET, index: 2, level: 1 },
      { object: OBJ_PIPE_A, index: 3, level: 1 },
      { object: OBJ_PIPE_B, index: 3, level: 1 }, // alternate at same index
    ],
  };
}

// --- stubs --------------------------------------------------------------------
const emitted = [];
const approachCalls = [];

let mockAgility = null;
let busyFlag = false;
let lapProgress = null;

function defaultAgilityMock() {
  const course = mockCourse();
  return {
    findBestCourseForLevel: (level) => (level >= 1 ? course : null),
    isObstacleRunning: () => busyFlag,
    getLapProgress: () => lapProgress,
    courseLevel: (c) => 1,
    AGILITY_COURSES: [course],
  };
}

function stubEngineModules() {
  const stubs = {
    "../../../bots/brain/ActionState": require("../../../bots/brain/ActionState"),
    "../../../bots/behaviours/navigation/BotNavigation": {
      clearMovementRequest: () => {},
      approachObject: (player, object, opts) => {
        approachCalls.push({ player, object, opts });
        return true;
      },
    },
    "../../constants": require("../../constants"),
    "../../lib/humanizer": {
      agentRng: () => Math.random,
      personalSpot: (username, x, y) => ({ x: x + 2, y: y + 2 }),
      humanizerProfile: () => ({}),
    },
    "../../../skills/Agility.plugin": new Proxy(
      {},
      {
        get(_t, prop) {
          if (mockAgility && prop in mockAgility) {
            return mockAgility[prop];
          }
          return undefined;
        },
      }
    ),
  };
  for (const [rel, exports] of Object.entries(stubs)) {
    const full = path.join(__dirname, rel);
    const resolved = require.resolve(full);
    require.cache[resolved] = {
      id: resolved,
      filename: resolved,
      loaded: true,
      exports,
    };
  }
}
stubEngineModules();

const {
  createCitizenAgilityAction,
  _agilityLevel: agilityLevel,
  _nextObstacleIndex: nextObstacleIndex,
  _finalIndex: finalIndex,
  _obstaclesAt: obstaclesAt,
} = require("./CitizenAgility");
const { scoreActivity } = require("../CitizenDecisions");

// --- mock players ---------------------------------------------------------------

function mockObject(id, x, y) {
  return {
    getId: () => id,
    getLocation: () => ({
      getX: () => x,
      getY: () => y,
      getZ: () => 0,
    }),
  };
}

function mockPlayer({
  playerAt = { x: 10, y: 10 },
  attributes = {},
} = {}) {
  const queue = {
    walked: [],
    walkToObject(object, opts) {
      queue.walked.push({ object, opts });
    },
    size: () => 0,
  };
  return {
    getSkillManager: () => ({
      getCurrentLevel: () => {
        throw new Error("no enum in test");
      },
    }),
    getLocation: () => ({
      getX: () => playerAt.x,
      getY: () => playerAt.y,
      getZ: () => 0,
    }),
    getMovementQueue: () => queue,
    getForceMovement: () => null,
    getUsername: () => "Test Athlete",
    getAttribute: (key) => attributes[key] ?? null,
    getPrivateArea: () => null,
    __queue: queue,
  };
}

function mockWorld(objects = []) {
  return {
    log: () => {},
    objectSearch: {
      findCandidatesByIds: (player, ids) =>
        objects.filter((o) => ids.includes(o.getId())),
    },
    emitObjectInteraction: (evt) => {
      emitted.push(evt);
    },
  };
}

function mockCtx(player, nowMs = 1000) {
  return { player, nowMs, world: mockWorld() };
}

function freshAction(objects = []) {
  emitted.length = 0;
  approachCalls.length = 0;
  busyFlag = false;
  lapProgress = null;
  mockAgility = defaultAgilityMock();
  return createCitizenAgilityAction({}, mockWorld(objects));
}

// --- tests ----------------------------------------------------------------------

const { test } = require("node:test");

test("factory returns the citizenAgility action", () => {
  const action = freshAction();
  assert.equal(action.id, "citizenAgility");
  assert.equal(typeof action.update, "function");
  assert.equal(typeof action.stop, "function");
});

test("no Agility plugin -> failed", () => {
  mockAgility = null;
  const action = createCitizenAgilityAction({}, mockWorld());
  const player = mockPlayer();
  assert.equal(action.update(mockCtx(player)), "failed");
});

test("busy mid-obstacle -> running", () => {
  const action = freshAction([mockObject(OBJ_LOG, 12, 12)]);
  busyFlag = true;
  const player = mockPlayer({ playerAt: { x: 12, y: 12 } });
  assert.equal(action.update(mockCtx(player)), "running");
});

test("no obstacle object nearby -> success", () => {
  const action = freshAction([]); // empty world: no course here
  const player = mockPlayer();
  assert.equal(action.update(mockCtx(player)), "success");
});

test("obstacle far away -> running (walks toward it)", () => {
  const action = freshAction([mockObject(OBJ_LOG, 500, 500)]);
  const player = mockPlayer({ playerAt: { x: 10, y: 10 } });
  assert.equal(action.update(mockCtx(player)), "running");
  assert.equal(approachCalls.length, 1);
  assert.equal(approachCalls[0].object.getId(), OBJ_LOG);
});

test("obstacle close -> emits real object interaction, running", () => {
  const world = mockWorld([mockObject(OBJ_LOG, 12, 12)]);
  emitted.length = 0;
  approachCalls.length = 0;
  busyFlag = false;
  lapProgress = null;
  mockAgility = defaultAgilityMock();
  const action = createCitizenAgilityAction({}, world);
  const player = mockPlayer({ playerAt: { x: 12, y: 12 } });
  const ctx = { player, nowMs: 5000, world };
  assert.equal(action.update(ctx), "running");
  assert.equal(player.__queue.walked.length, 1);
  // Fire the deferred click to prove the real interaction is emitted.
  player.__queue.walked[0].opts.execute();
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].objectId, OBJ_LOG);
  assert.equal(emitted[0].clickType, 1);
});

test("lap complete -> success (one lap per decision)", () => {
  const action = freshAction([mockObject(OBJ_LOG, 12, 12)]);
  lapProgress = { course: "gnome", index: 3 }; // final index done
  const player = mockPlayer({ playerAt: { x: 12, y: 12 } });
  assert.equal(action.update(mockCtx(player)), "success");
});

test("give-up timeout -> success", () => {
  const action = freshAction([mockObject(OBJ_LOG, 12, 12)]);
  const player = mockPlayer({ playerAt: { x: 12, y: 12 } });
  // First tick arms the timer at nowMs=1000; jump past 6 minutes.
  assert.equal(action.update(mockCtx(player, 1000)), "running");
  assert.equal(action.update(mockCtx(player, 1000 + 6 * 60 * 1000 + 1)), "success");
});

test("_nextObstacleIndex: no progress -> 1", () => {
  mockAgility = defaultAgilityMock();
  const course = mockCourse();
  assert.equal(nextObstacleIndex(mockAgility, mockPlayer(), course), 1);
});

test("_nextObstacleIndex: same-course progress -> +1", () => {
  mockAgility = defaultAgilityMock();
  lapProgress = { course: "gnome", index: 1 };
  const course = mockCourse();
  assert.equal(nextObstacleIndex(mockAgility, mockPlayer(), course), 2);
});

test("_nextObstacleIndex: other-course progress -> 1", () => {
  mockAgility = defaultAgilityMock();
  lapProgress = { course: "varrock", index: 4 };
  const course = mockCourse();
  assert.equal(nextObstacleIndex(mockAgility, mockPlayer(), course), 1);
});

test("_finalIndex and _obstaclesAt helpers", () => {
  const course = mockCourse();
  assert.equal(finalIndex(course), 3);
  assert.equal(obstaclesAt(course, 1).length, 1);
  assert.equal(obstaclesAt(course, 3).length, 2); // alternates
  assert.equal(obstaclesAt(course, 99).length, 0);
});

test("_agilityLevel falls back to 1 without the engine enum", () => {
  assert.equal(agilityLevel(mockPlayer()), 1);
});

test("scoring: industrious skilling-goal citizen scores high", () => {
  const snap = {
    hp: 100,
    energy: 90,
    mood: 80,
    goal: { type: "master_trade" },
    personality: { traits: ["dutiful", "methodical"] },
    coins: 500,
    food: 3,
    freeSlots: 10,
    nearby: 2,
    logs: 0,
    ore: 0,
    gems: 0,
    rawFood: 0,
    herbs: 0,
    fletchLogs: 0,
    essence: 0,
    hour: 14,
  };
  const s = scoreActivity("citizen_agility", snap);
  assert.ok(s > 40, `expected a solid score, got ${s}`);
});

test("scoring: hurt citizen stays off the course", () => {
  const snap = {
    hp: 20,
    energy: 90,
    mood: 80,
    goal: { type: "master_trade" },
    personality: { traits: ["dutiful", "methodical"] },
    coins: 500,
    food: 3,
    freeSlots: 10,
    nearby: 2,
    logs: 0,
    ore: 0,
    gems: 0,
    rawFood: 0,
    herbs: 0,
    fletchLogs: 0,
    essence: 0,
    hour: 14,
  };
  const healthy = scoreActivity("citizen_agility", { ...snap, hp: 100 });
  const hurt = scoreActivity("citizen_agility", snap);
  assert.ok(hurt < healthy, `hurt (${hurt}) should score below healthy (${healthy})`);
});
