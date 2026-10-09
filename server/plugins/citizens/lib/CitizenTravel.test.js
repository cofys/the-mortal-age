"use strict";

/**
 * CitizenTravel.test.js — data tier tests for citizen transportation.
 *
 * Covers: route determinism, fares, war blocking, journey lifecycle,
 * honest fares, danger rolls, cargo.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");

const Travel = require("./CitizenTravel");

const TEST_SAVE = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "citizen-travel-test-")),
  "citizen-travel.json"
);

beforeEach(() => {
  Travel._setSavePathForTests(TEST_SAVE);
  Travel.resetForTests();
  try {
    fs.unlinkSync(TEST_SAVE);
  } catch {
    // ignore
  }
});

describe("route catalog", () => {
  test("routeBetween is deterministic", () => {
    const a = Travel.routeBetween("asgarnia", "misthalin");
    const b = Travel.routeBetween("misthalin", "asgarnia");
    expect(a).toBeTruthy();
    expect(a.key).toBe(b.key);
    expect(a.fare).toBe(b.fare);
    expect(a.mode).toBe(b.mode);
    expect(a.durationMs).toBe(b.durationMs);
  });

  test("same-kingdom and unknown kingdoms return null", () => {
    expect(Travel.routeBetween("asgarnia", "asgarnia")).toBeNull();
    expect(Travel.routeBetween("asgarnia", "narnia")).toBeNull();
    expect(Travel.routeBetween(null, "misthalin")).toBeNull();
  });

  test("ships where both ends have docks, caravans otherwise", () => {
    // keldagrim has no dock
    expect(Travel.routeBetween("asgarnia", "misthalin").mode).toBe("ship");
    expect(Travel.routeBetween("asgarnia", "keldagrim").mode).toBe("caravan");
    expect(Travel.routeBetween("keldagrim", "misthalin").mode).toBe("caravan");
  });

  test("fares are positive and journeys take real time", () => {
    const r = Travel.routeBetween("asgarnia", "misthalin");
    expect(r.fare).toBeGreaterThan(0);
    expect(r.durationMs).toBeGreaterThanOrEqual(20 * 60 * 1000);
  });

  test("routesFrom returns all other kingdoms", () => {
    const routes = Travel.routesFrom("asgarnia");
    expect(routes.length).toBe(4);
    expect(routes.every((r) => r.from === "asgarnia")).toBe(true);
  });

  test("kingdomName prettifies ids", () => {
    expect(Travel.kingdomName("asgarnia")).toBe("Asgarnia");
    expect(Travel.kingdomName("keldagrim")).toBe("Keldagrim");
  });
});

describe("war blocking", () => {
  test("routeOpen is true when nobody is at war", () => {
    expect(Travel.routeOpen("asgarnia", "misthalin", new Set())).toBe(true);
  });

  test("routeOpen is false when either endpoint is at war", () => {
    expect(Travel.routeOpen("asgarnia", "misthalin", new Set(["asgarnia"]))).toBe(false);
    expect(Travel.routeOpen("asgarnia", "misthalin", new Set(["misthalin"]))).toBe(false);
    expect(Travel.routeOpen("asgarnia", "kandarin", new Set(["misthalin"]))).toBe(true);
  });
});

describe("journey lifecycle", () => {
  function mockPlayer(coins) {
    let balance = coins;
    return {
      getInventory: () => ({
        getAmount: () => balance,
        deleteNumber: (id, n) => {
          balance = Math.max(0, balance - n);
        },
        adds: (id, n) => {
          balance += n;
        },
      }),
    };
  }

  test("startJourney creates a journey and deducts the fare", () => {
    const player = mockPlayer(10000);
    const route = Travel.routeBetween("asgarnia", "misthalin");
    const res = Travel.startJourney("Alice", "asgarnia", "misthalin", 1000, player);
    expect(res.ok).toBe(true);
    expect(res.journey.from).toBe("asgarnia");
    expect(res.journey.to).toBe("misthalin");
    expect(res.journey.arrivesAt).toBeGreaterThan(res.journey.departsAt);
    // Fare was deducted.
    expect(player.getInventory().count()).toBe(10000 - route.fare);
  });

  test("startJourney refuses when already traveling", () => {
    const player = mockPlayer(10000);
    expect(Travel.startJourney("Bob", "asgarnia", "misthalin", 1000, player).ok).toBe(true);
    const res = Travel.startJourney("Bob", "asgarnia", "kandarin", 1000, player);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("already-traveling");
  });

  test("startJourney refuses without fare and takes nothing", () => {
    const player = mockPlayer(10); // can't afford any route
    const res = Travel.startJourney("Carol", "asgarnia", "misthalin", 1000, player);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("no-fare");
    expect(player.getInventory().count()).toBe(10); // untouched
  });

  test("startJourney works without a player entity (offline)", () => {
    const res = Travel.startJourney("Dave", "asgarnia", "misthalin", 1000, null);
    expect(res.ok).toBe(true);
  });

  test("journeyOf and clearJourney", () => {
    Travel.startJourney("Erin", "asgarnia", "misthalin", 1000, null);
    expect(Travel.journeyOf("erin")).toBeTruthy();
    expect(Travel.journeyOf("Erin")).toBeTruthy(); // normalized
    expect(Travel.clearJourney("ERIN")).toBe(true);
    expect(Travel.journeyOf("erin")).toBeNull();
    expect(Travel.clearJourney("erin")).toBe(false);
  });

  test("dueArrivals and inTransit", () => {
    Travel.startJourney("Frank", "asgarnia", "misthalin", 1000, null);
    const j = Travel.journeyOf("frank");
    // Before arrival: in transit, not due.
    expect(Travel.inTransit(j.departsAt + 1000).length).toBe(1);
    expect(Travel.dueArrivals(j.departsAt + 1000).length).toBe(0);
    // After arrival: due, not in transit.
    expect(Travel.dueArrivals(j.arrivesAt + 1).length).toBe(1);
    expect(Travel.inTransit(j.arrivesAt + 1).length).toBe(0);
  });

  test("setCargo attaches a manifest", () => {
    Travel.startJourney("Gail", "asgarnia", "misthalin", 1000, null);
    const manifest = [{ name: "spices", margin: 50 }];
    expect(Travel.setCargo("gail", manifest)).toBe(true);
    expect(Travel.journeyOf("gail").cargo).toEqual(manifest);
    expect(Travel.setCargo("nobody", manifest)).toBe(false);
  });
});

describe("danger rolls", () => {
  test("rollDanger respects zero risk", () => {
    // Route with no randomness: use a fixed rng.
    const journey = { from: "asgarnia", to: "misthalin" };
    const rng = () => 0.999; // never below any risk threshold
    const d = Travel.rollDanger(journey, rng);
    expect(d.bandit).toBe(false);
    expect(d.monster).toBe(false);
    expect(d.damage).toBe(0);
  });

  test("rollDanger can trigger both", () => {
    const journey = { from: "asgarnia", to: "misthalin" };
    const rng = () => 0.0; // always below thresholds
    const d = Travel.rollDanger(journey, rng);
    expect(d.bandit).toBe(true);
    expect(d.monster).toBe(true);
    expect(d.coinsLost).toBeGreaterThan(0);
    expect(d.damage).toBeGreaterThan(0);
  });
});

describe("cargo", () => {
  test("buildCargo creates a manifest", () => {
    const manifest = Travel.buildCargo(() => 0.5);
    expect(manifest.length).toBeGreaterThanOrEqual(2);
    expect(manifest.length).toBeLessThanOrEqual(4);
    expect(Travel.cargoValue(manifest)).toBeGreaterThan(0);
  });

  test("cargoValue sums margins", () => {
    expect(
      Travel.cargoValue([
        { name: "spices", margin: 50 },
        { name: "silk", margin: 100 },
      ])
    ).toBe(150);
    expect(Travel.cargoValue(null)).toBe(0);
    expect(Travel.cargoValue([])).toBe(0);
  });
});

describe("persistence", () => {
  test("journeys survive save/load", () => {
    Travel.startJourney("Hank", "asgarnia", "misthalin", 1000, null);
    expect(Travel.save()).toBe(true);
    Travel.resetForTests();
    expect(Travel.journeyOf("hank")).toBeTruthy();
    expect(Travel.journeyOf("hank").to).toBe("misthalin");
  });
});
