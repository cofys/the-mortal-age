"use strict";

/**
 * CitizenTravel.test.js — brain action unit checks.
 *
 * Proves the travel action's contracts without a running server:
 *   - Factory returns an action with id "citizenTravel".
 *   - No journey: walks to departure point, then boards ("running").
 *   - Boarding deducts the fare and starts a journey.
 *   - Already traveling: waits in transit ("running").
 *   - Journey cleared (arrived): teleports to destination, "success".
 *   - Can't afford fare: "success" (brain re-decides).
 *   - Give-up timeout: "success", never stalls the day.
 *   - _cheapestOpenDestination: picks the cheapest open route.
 *
 * Engine modules are stubbed in the require cache (same pattern as
 * CitizenThieve.test.js) so plain-node tests stay engine-free.
 */
const assert = require("node:assert/strict");
const path = require("node:path");

// --- stubs ------------------------------------------------------------------

const movementCalls = [];

function stubEngineModules() {
  const stubs = {
    "../../../bots/brain/ActionState": {
      playerState: (action, player, init) => {
        if (!player.__travelState) player.__travelState = init();
        return player.__travelState;
      },
    },
    "../../../bots/behaviours/navigation/BotNavigation": {
      requestMovement: (player, x, y, opts) => {
        movementCalls.push({ player, x, y, opts });
        return true;
      },
      clearMovementRequest: () => {},
    },
    "../CitizenSites": {
      siteTile: (player, kind) =>
        kind === "dock" ? { x: 3000, y: 3000, z: 0 } : { x: 3100, y: 3100, z: 0 },
      siteTileByKingdom: (kingdomId, kind) => ({ x: 3200, y: 3200, z: 0 }),
      kingdomIdOf: () => "asgarnia",
    },
    "../../constants": require("../../constants"),
    "../../lib/humanizer": {
      agentRng: () => Math.random,
      personalSpot: (username, x, y) => ({ x: x + 2, y: y + 2 }),
      humanizerProfile: () => ({}),
    },
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

// Stub the travel data tier with an in-memory journey store.
const journeys = new Map();
const travelStub = {
  journeyOf: (username) => journeys.get(username.toLowerCase()) ?? null,
  allJourneys: () => [...journeys.values()],
  routeBetween: (from, to) => {
    if (from === to) return null;
    return {
      from, to, key: `${from}:${to}`, mode: "ship",
      distanceKm: 100, durationMs: 30 * 60 * 1000,
      fare: 100, banditRisk: 0.1, monsterRisk: 0.05,
    };
  },
  routesFrom: (kingdomId) => [
    { from: kingdomId, to: "misthalin", fare: 100, mode: "ship" },
    { from: kingdomId, to: "kandarin", fare: 150, mode: "ship" },
  ],
  routeOpen: () => true,
  kingdomName: (id) => id.charAt(0).toUpperCase() + id.slice(1),
  startJourney: (username, from, to, nowMs, player) => {
    const uname = username.toLowerCase();
    if (journeys.has(uname)) return { ok: false, reason: "already-traveling" };
    // Simulate fare deduction.
    const coins = player.__coins ?? 0;
    if (coins < 100) return { ok: false, reason: "no-fare" };
    player.__coins = coins - 100;
    const journey = {
      username: uname, from, to, mode: "ship",
      departsAt: nowMs, arrivesAt: nowMs + 30 * 60 * 1000,
      fare: 100, cargo: null,
    };
    journeys.set(uname, journey);
    return { ok: true, journey };
  },
  setCargo: () => true,
  buildCargo: () => [{ name: "spices", margin: 50 }],
  clearJourney: (username) => journeys.delete(username.toLowerCase()),
};
{
  const full = path.join(__dirname, "../../lib/CitizenTravel");
  const resolved = require.resolve(full);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: travelStub,
  };
}

const {
  createCitizenTravelAction,
  _cheapestOpenDestination,
  GIVE_UP_MS,
} = require("./CitizenTravel");

// --- mock players ------------------------------------------------------------

function mockPlayer({ x = 0, y = 0, coins = 1000 } = {}) {
  const player = {
    __coins: coins,
    __travelState: null,
    getUsername: () => "Traveler",
    getAttribute: () => ({}),
    getLocation: () => ({
      getX: () => x,
      getY: () => y,
      getZ: () => 0,
    }),
    getInventory: () => ({
      count: () => player.__coins,
      getAmount: () => player.__coins,
    }),
    teleport: (tx, ty, tz) => {
      player.__teleported = { x: tx, y: ty, z: tz };
    },
  };
  return player;
}

function ctxFor(player, nowMs) {
  return { player, world: {}, nowMs: nowMs ?? Date.now() };
}

beforeEach(() => {
  journeys.clear();
  movementCalls.length = 0;
});

// --- tests -------------------------------------------------------------------

describe("createCitizenTravelAction", () => {
  test("factory returns action with id citizenTravel", () => {
    const action = createCitizenTravelAction({}, null);
    expect(action.id).toBe("citizenTravel");
    expect(typeof action.update).toBe("function");
  });

  test("no journey: walks to departure point", () => {
    const player = mockPlayer({ x: 0, y: 0, coins: 1000 }); // far from dock
    const action = createCitizenTravelAction({}, null);
    const result = action.update(ctxFor(player));
    expect(result).toBe("running");
    expect(movementCalls.length).toBeGreaterThan(0);
    expect(movementCalls[0].opts.reason).toBe("citizen_travel_depart");
  });

  test("at departure point: boards and starts journey", () => {
    const player = mockPlayer({ x: 3002, y: 3002, coins: 1000 }); // at dock
    const action = createCitizenTravelAction({ destination: "misthalin" }, null);
    const result = action.update(ctxFor(player));
    expect(result).toBe("running");
    expect(travelStub.journeyOf("traveler")).toBeTruthy();
    expect(player.__coins).toBe(900); // fare deducted
  });

  test("already traveling: waits in transit", () => {
    const player = mockPlayer({ x: 3002, y: 3002, coins: 1000 });
    const action = createCitizenTravelAction({ destination: "misthalin" }, null);
    action.update(ctxFor(player, 1000)); // board
    expect(travelStub.journeyOf("traveler")).toBeTruthy();
    const result = action.update(ctxFor(player, 2000)); // still traveling
    expect(result).toBe("running");
  });

  test("journey cleared: teleports to destination and succeeds", () => {
    const player = mockPlayer({ x: 3002, y: 3002, coins: 1000 });
    const action = createCitizenTravelAction({ destination: "misthalin" }, null);
    action.update(ctxFor(player, 1000)); // board
    travelStub.clearJourney("traveler"); // slow tick processed arrival
    const result = action.update(ctxFor(player, 2000));
    expect(result).toBe("success");
    expect(player.__teleported).toBeTruthy();
  });

  test("can't afford fare: success (brain re-decides)", () => {
    const player = mockPlayer({ x: 3002, y: 3002, coins: 10 }); // broke
    const action = createCitizenTravelAction({ destination: "misthalin" }, null);
    const result = action.update(ctxFor(player));
    expect(result).toBe("success");
    expect(travelStub.journeyOf("traveler")).toBeNull();
  });

  test("give-up timeout: success, never stalls", () => {
    const player = mockPlayer({ x: 0, y: 0, coins: 1000 });
    const action = createCitizenTravelAction({}, null);
    // First tick sets giveUpAt.
    action.update(ctxFor(player, 1000));
    // Far future: give up.
    const result = action.update(ctxFor(player, 1000 + GIVE_UP_MS + 1));
    expect(result).toBe("success");
  });
});

describe("_cheapestOpenDestination", () => {
  test("picks the cheapest route", () => {
    const dest = _cheapestOpenDestination("asgarnia", () => 0.5);
    expect(dest).toBe("misthalin"); // fare 100 < 150
  });

  test("returns null when no routes", () => {
    const origRoutesFrom = travelStub.routesFrom;
    travelStub.routesFrom = () => [];
    try {
      expect(_cheapestOpenDestination("asgarnia", () => 0.5)).toBeNull();
    } finally {
      travelStub.routesFrom = origRoutesFrom;
    }
  });
});
