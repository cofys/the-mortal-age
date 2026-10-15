"use strict";

/**
 * CitizenProximityBackoff.test.js — proximity-tick A* churn regression test.
 *
 * Covers the 2026-10-14 tick-overrun fix: CitizenDirector._proximityMovementTick
 * used to re-dispatch EVERY pending movement request on every ~10s proximity
 * tick, ignoring the navigator's nextDispatchAtMs backoff (the bot brain's own
 * dispatch honors it — BotBrain.js). A failed route search (unreachable wander
 * target, stuck citizen) therefore burned one full engine A*
 * (PathFinder.calculateRoute) per stuck citizen per tick. At ~25ms per A* on
 * the live box ("60 citizens x pathfinding = 1500ms tick overrun" —
 * CitizenDirector.js), a few dozen stuck citizens saturate the 600ms tick
 * budget: the measured ~1.6s ProximityTask slow_task_tick.
 *
 * The harness boots the REAL director (3110-citizen roster), the REAL
 * BotNavigation (with a scripted fake PathFinder that counts A* calls), and
 * drives the REAL tickProximity(). Engine boundaries are stubbed.
 *
 * Run with: node --test server/plugins/citizens/director/CitizenProximityBackoff.test.js
 * (from the repo root; uses node:test, no external deps)
 */

const { describe, it, before, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

// ---------------------------------------------------------------------------
// Engine-boundary stubs (installed before CitizenDirector loads).
// ---------------------------------------------------------------------------

class StubLocation {
  constructor(x, y, z) {
    this.x = x;
    this.y = y;
    this.z = z;
  }
  clone() {
    return new StubLocation(this.x, this.y, this.z);
  }
}

function genericStub() {
  const noop = () => {};
  return new Proxy(
    {},
    {
      get: (target, prop) => (typeof prop === "string" ? noop : undefined),
    }
  );
}

// A* call ledger + scripted world. Destinations in `blockedDests` ("x,y")
// always fail (0 steps); everything else succeeds and fills the fake
// movement queue the way the engine's applyRsmodRoute does.
const astarCalls = [];
const blockedDests = new Set();
const FakePathFinder = {
  calculateRoute(
    entity,
    size,
    destX,
    destY,
    xLength,
    yLength,
    direction,
    blockingMask,
    basicPather
  ) {
    astarCalls.push({
      username: entity?.getUsername?.() ?? "?",
      destX,
      destY,
    });
    if (blockedDests.has(destX + "," + destY)) {
      return 0;
    }
    const q = entity.getMovementQueue?.();
    if (q && typeof q.__testFill === "function") {
      q.__testFill(destX, destY);
    }
    return 5;
  },
};

// Modules loaded for REAL (everything else the director/libs pull is a
// generic noop-proxy stub). Matched by basename so both "../lib/X" and
// "./X" style relative requires hit.
const REAL_BASES = new Set([
  "constants", // citizens/constants.js
  "CitizenSites",
  "personalities",
  "humanizer",
  "CitizenAnchor",
  "CitizenBonds",
  "CitizenTimingDesync",
  "CitizenTickLod",
  "CitizenAlive",
  "CitizenWorkLoops",
  "CitizenShopkeeping",
  "BotNavigation",
  "BotLongRoutes",
  "BotRuntimeRegistry",
]);

function isRealRequest(request) {
  if (typeof request !== "string") return false;
  const base = request.split("/").pop();
  return REAL_BASES.has(base);
}

function installStubs() {
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (typeof request === "string" && request.includes("src/main/typescript")) {
      if (request.endsWith("/Task")) {
        return { Task: class Task {} };
      }
      if (request.endsWith("/Location")) {
        return { Location: StubLocation };
      }
      if (request.endsWith("/Flag")) {
        return { Flag: { APPEARANCE: 1 } };
      }
      if (request.includes("PathFinder")) {
        return { PathFinder: FakePathFinder };
      }
      if (request.includes("RsmodRouteFinding")) {
        return { RsmodRouteFinding: class RsmodRouteFinding {} };
      }
      if (request.includes("collision/RegionManager")) {
        // Detour route planner reads clipping flags; 0 = fully walkable.
        return { RegionManager: { getClipping: () => 0 } };
      }
      return {};
    }
    if (typeof request === "string") {
      if (request.includes("WildernessHotspotRegistry")) {
        return { isOutsideWildernessHotspots: () => true };
      }
      if (
        request.endsWith("navigation/LongRoutePlanner") ||
        request === "./LongRoutePlanner" ||
        request.endsWith("/LongRoutePlanner")
      ) {
        return { planRoute: () => null };
      }
    }
    const parentFile = parent && parent.filename ? parent.filename : "";
    const inDirector = parentFile.endsWith(
      path.join("director", "CitizenDirector.js")
    );
    const inLibUnderTest = /citizens[\\/]lib[\\/]Citizen(TickLod|Alive|WorkLoops|Shopkeeping|TimingDesync)\.js$/.test(
      parentFile
    );
    if (inDirector || inLibUnderTest) {
      if (request.endsWith("behaviours/navigation/BotNavigation")) {
        // Wrap the director's dispatch with a call counter so the backoff
        // guard can be tested in isolation: the engine's own retry machinery
        // (unreachable-segment tracker windows, detour planner, timing) is
        // deliberately out of scope for the director regression tests.
        const real = originalLoad.call(this, request, parent, isMain);
        const calls = (globalThis.__directorDispatchCalls ??= []);
        return {
          ...real,
          dispatchMovementRequest(player, req, state) {
            calls.push({ username: player?.getUsername?.() ?? "?" });
            return real.dispatchMovementRequest(player, req, state);
          },
        };
      }
      if (isRealRequest(request)) {
        return originalLoad.call(this, request, parent, isMain);
      }
      return genericStub();
    }
    return originalLoad.call(this, request, parent, isMain);
  };
}

installStubs();

const {
  CitizenDirector,
} = require("./CitizenDirector");
const {
  requestMovement,
  peekMovementRequest,
  dispatchMovementRequest,
  clearMovementRequest,
} = require("../../bots/behaviours/navigation/Navigation.PlayerBots.js");
const {
  setActiveBotRuntime,
} = require("../../bots/runtime/RuntimeRegistry.PlayerBots.js");

// ---------------------------------------------------------------------------
// Fake world: 60 online citizen bots clustered around a fake player.
// ---------------------------------------------------------------------------

const PLAYER_X = 3200;
const PLAYER_Y = 3200;
const _originalRandom = Math.random;
const ONLINE_COUNT = 60;
const STUCK_COUNT = 40;

function stubBot(username, x, y) {
  const loc = { x, y, z: 0 };
  let queuePoints = [];
  return {
    getUsername: () => username,
    isPlayerBot: () => true,
    getLocation: () => ({
      getX: () => loc.x,
      getY: () => loc.y,
      getZ: () => loc.z,
    }),
    getMovementQueue: () => ({
      size: () => queuePoints.length,
      clear: () => {
        queuePoints = [];
      },
      __testFill: (dx, dy) => {
        queuePoints = [{ x: dx, y: dy }];
      },
    }),
    getForceMovement: () => null,
    getLocalPlayers: () => [],
    getAnimation: () => null,
    performAnimation: () => {},
    setPositionToFaceCoordinates: () => {},
    getUpdateFlag: () => ({ flag: () => {} }),
    forceChat: () => {},
    _loc: loc,
  };
}

describe("proximity tick honors navigator backoff", () => {
  let director;
  let entriesByUsername;
  let onlineUsernames;

  before(() => {
    director = new CitizenDirector({ api: {}, registry: {} });
    director.startTask = () => {};
    director.log = () => {};
    director.boot();
    assert.ok(
      director.roster.size >= 3000,
      `expected a full roster, got ${director.roster.size}`
    );

    // 60 citizens "materialized" in a grid around the fake player.
    entriesByUsername = new Map();
    onlineUsernames = [];
    let i = 0;
    for (const record of director.roster.values()) {
      if (i >= ONLINE_COUNT) break;
      const bx = PLAYER_X - 20 + (i % 10) * 4;
      const by = PLAYER_Y - 20 + Math.floor(i / 10) * 4;
      const bot = stubBot(record.username, bx, by);
      entriesByUsername.set(record.username, { player: bot });
      onlineUsernames.push(record.username);
      i += 1;
    }
    setActiveBotRuntime({
      entriesByUsername,
      botStatesByName: new Map(),
    });
    CitizenDirector.setDebugFakePlayer(PLAYER_X, PLAYER_Y, 0);
  });

  beforeEach(() => {
    astarCalls.length = 0;
    blockedDests.clear();
    // Kill wander noise: the wander branch rolls Math.random() < 0.15.
    // This isolates the pending-request dispatch path under test.
    Math.random = () => 0.999;
  });

  afterEach(() => {
    CitizenDirector.clearDebugFakePlayers();
    CitizenDirector.setDebugFakePlayer(PLAYER_X, PLAYER_Y, 0);
    Math.random = _originalRandom; // restore
  });

  function botFor(username) {
    return entriesByUsername.get(username).player;
  }

  function drainAllQueues() {
    for (const username of onlineUsernames) {
      try {
        botFor(username).getMovementQueue().clear();
      } catch {
        // Non-fatal.
      }
    }
  }

  // Arm `count` citizens with a FAILED movement request: target tile is
  // unreachable, one dispatch runs so nextDispatchAtMs backoff is set —
  // exactly the state a stuck citizen is in on the live server.
  // Returns the armed usernames plus their armed destination keys; the
  // proximity tick also fires its own desync-gated random wander
  // (Math.random() < 0.15), so churn must be measured against the ARMED
  // destinations, not just by username.
  function armStuckCitizens(count) {
    const armed = [];
    const armedDests = new Set();
    for (let i = 0; i < count; i += 1) {
      const username = onlineUsernames[i];
      const bot = botFor(username);
      const tx = bot._loc.x + 10;
      const ty = bot._loc.y + 10;
      blockedDests.add(tx + "," + ty);
      requestMovement(bot, tx, ty, {
        reason: "test_stuck",
        basicPather: true,
      });
      const req = peekMovementRequest(bot);
      assert.ok(req, `expected a pending request for ${username}`);
      const result = dispatchMovementRequest(bot, req);
      assert.equal(result?.hasRoute, false, "setup: request must fail");
      assert.ok(
        Number(req.nextDispatchAtMs) > Date.now(),
        "setup: backoff must be armed"
      );
      armed.push(username);
      armedDests.add(tx + "," + ty);
    }
    return { armed, armedDests };
  }

  it("does not re-dispatch backed-off requests on the proximity tick", async () => {
    const { armed, armedDests } = armStuckCitizens(STUCK_COUNT);
    const armedSet = new Set(armed);
    const records = armed.map((u) => director.roster.get(u.toLowerCase()));
    assert.ok(
      records.every(Boolean),
      "setup: all armed citizens have roster records"
    );
    drainAllQueues();
    astarCalls.length = 0; // drop the setup dispatches

    // Drive the director's movement tick directly for the 40 stuck citizens
    // (no brain/alive layer, so nothing re-arms backoffs behind the test).
    // Each round holds the navigator backoff 10s in the future — the engine
    // would re-arm it on every failed retry; the test holds it manually so
    // the DIRECTOR GUARD is what is under test, not the engine's backoff
    // math. The 1500ms gaps exceed the engine's own 1200ms segment-tracker
    // window, so without the guard each round re-dispatches (~40 A* calls);
    // with the guard, zero churn.
    for (let t = 0; t < 3; t += 1) {
      for (const username of armed) {
        const r = peekMovementRequest(botFor(username));
        if (r) r.nextDispatchAtMs = Date.now() + 10000;
      }
      for (const record of records) {
        director._proximityMovementTick(record, t);
      }
      await new Promise((r) => setTimeout(r, 1500));
    }

    // Measured by armed destination, not just username: the alive layer is
    // not ticked here, but any stray dispatch (e.g. drift) to another tile
    // must not count as backoff churn.
    const churn = astarCalls.filter(
      (c) => armedSet.has(c.username) && armedDests.has(c.destX + "," + c.destY)
    );
    assert.equal(
      churn.length,
      0,
      `expected no A* churn on backed-off requests, got ${churn.length} calls`
    );
  });

  it("unit: _proximityMovementTick honors backoff (no alive-layer interference)", () => {
    const username = onlineUsernames[STUCK_COUNT + 2];
    const bot = botFor(username);
    const record = director.roster.get(username.toLowerCase());
    assert.ok(record, "setup: record exists");
    bot.getMovementQueue().clear();
    // The harness wraps the director's dispatchMovementRequest with a call
    // counter (see installStubs): the guard under test is "dispatch or not",
    // so counting director dispatches is deterministic where counting engine
    // A* calls is not (tracker windows, detour planner, timing).
    const directorCalls = () =>
      (globalThis.__directorDispatchCalls ?? []).filter(
        (c) => c.username === username
      ).length;
    const resetDirectorCalls = () => {
      globalThis.__directorDispatchCalls.length = 0;
    };

    // Case 1: backed-off request -> the director must not dispatch.
    const tx = bot._loc.x + 10;
    const ty = bot._loc.y + 10;
    blockedDests.add(tx + "," + ty);
    requestMovement(bot, tx, ty, { reason: "test_unit_stuck", basicPather: true });
    const req = peekMovementRequest(bot);
    assert.equal(dispatchMovementRequest(bot, req)?.hasRoute, false);
    assert.ok(Number(req.nextDispatchAtMs) > Date.now(), "backoff armed");
    resetDirectorCalls();
    director._proximityMovementTick(record, 0);
    assert.equal(
      directorCalls(),
      0,
      "backed-off request must not re-dispatch"
    );

    // Case 2: backoff expired -> the director dispatches exactly once.
    req.nextDispatchAtMs = Date.now() - 1;
    director._proximityMovementTick(record, 0);
    assert.equal(
      directorCalls(),
      1,
      "expired backoff must dispatch exactly once"
    );

    // Case 3: fresh request (never dispatched) -> dispatches immediately.
    clearMovementRequest(bot);
    bot.getMovementQueue().clear();
    const fx = bot._loc.x + 4;
    const fy = bot._loc.y + 2;
    requestMovement(bot, fx, fy, { reason: "test_unit_fresh", basicPather: true });
    resetDirectorCalls();
    director._proximityMovementTick(record, 0);
    assert.equal(
      directorCalls(),
      1,
      "fresh request must dispatch (safety net)"
    );
  });

  it("still dispatches fresh requests (safety net intact)", () => {
    const username = onlineUsernames[STUCK_COUNT]; // an idle citizen
    const bot = botFor(username);
    bot.getMovementQueue().clear(); // the safety-net branch needs an empty queue
    const tx = bot._loc.x + 5;
    const ty = bot._loc.y + 3;
    requestMovement(bot, tx, ty, { reason: "test_fresh", basicPather: true });
    assert.ok(peekMovementRequest(bot), "setup: fresh request pending");
    assert.equal(bot.getMovementQueue().size(), 0);
    astarCalls.length = 0;

    director.tickProximity();

    const mine = astarCalls.filter((c) => c.username === username);
    assert.ok(
      mine.length >= 1,
      `expected the fresh request to dispatch, got ${mine.length} A* calls`
    );
    // Success fills the movement queue (engine behavior) so later ticks skip.
    assert.ok(bot.getMovementQueue().size() > 0, "queue should be filled");
  });

  it("retries after the backoff expires", () => {
    const username = onlineUsernames[STUCK_COUNT + 1]; // an idle citizen
    const bot = botFor(username);
    bot.getMovementQueue().clear();
    const tx = bot._loc.x + 10;
    const ty = bot._loc.y + 10;
    blockedDests.add(tx + "," + ty);
    requestMovement(bot, tx, ty, { reason: "test_retry", basicPather: true });
    const setupResult = dispatchMovementRequest(bot, peekMovementRequest(bot));
    assert.equal(setupResult?.hasRoute, false, "setup: request must fail");
    const directorCalls = () =>
      (globalThis.__directorDispatchCalls ?? []).filter(
        (c) => c.username === username
      ).length;
    globalThis.__directorDispatchCalls.length = 0;

    // Backoff still in the future: the director must not dispatch.
    director.tickProximity();
    assert.equal(
      directorCalls(),
      0,
      "should not dispatch while backed off"
    );

    // Expire the backoff: the director must dispatch exactly once. (Counted
    // at the director boundary, so the engine's own tracker/planner windows
    // cannot make this flaky.)
    peekMovementRequest(bot).nextDispatchAtMs = Date.now() - 1;
    director.tickProximity();
    assert.equal(
      directorCalls(),
      1,
      "should dispatch once the backoff expires"
    );
  });

  it("benchmark: full-tick JS cost without pathfinding churn", () => {
    // No stuck citizens here: measures the pure-JS cost of the proximity
    // tick (5 roster scans over ~3110 records + LOD + alive/work/shop layers)
    // to bound the non-pathfinding contribution.
    const times = [];
    for (let t = 0; t < 3; t += 1) {
      const t0 = Date.now();
      director.tickProximity();
      times.push(Date.now() - t0);
    }
    const worst = Math.max(...times);
    console.log(
      `proximity tick JS cost (3110 roster, 60 online, no A* churn): ${times.join(", ")}ms`
    );
    assert.ok(
      worst < 2000,
      `pure-JS tick cost suspiciously high: ${worst}ms`
    );
  });
});
