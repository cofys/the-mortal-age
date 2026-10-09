"use strict";

/**
 * CitizenTravelLife.test.js — arrival processing, danger, cargo, cleanup.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");

const Travel = require("./CitizenTravel");
const { tickTravel, processArrival } = require("./CitizenTravelLife");

const TEST_SAVE = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "citizen-travellife-test-")),
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

function mockDirector(records) {
  const roster = new Map();
  for (const r of records) roster.set(r.username.toLowerCase(), { ...r });
  return {
    roster,
    getPlayer: () => null,
    players: { get: () => null },
    log: () => {},
  };
}

function mockPlayer(coins) {
  let balance = coins;
  return {
    getUsername: () => "Alice",
    getInventory: () => ({
      count: () => balance,
      getAmount: () => balance,
      remove: (id, n) => {
        balance = Math.max(0, balance - n);
      },
      add: (id, n) => {
        balance += n;
      },
    }),
    getLocation: () => ({ getX: () => 3200, getY: () => 3200, getZ: () => 0 }),
    teleport: () => {},
  };
}

describe("processArrival", () => {
  test("moves the citizen to the destination kingdom", () => {
    const director = mockDirector([
      { username: "alice", kingdomId: "asgarnia" },
    ]);
    Travel.startJourney("alice", "asgarnia", "misthalin", 1000, null);
    const journey = Travel.journeyOf("alice");
    const result = processArrival(director, journey, journey.arrivesAt + 1);
    expect(result.to).toBe("misthalin");
    expect(director.roster.get("alice").kingdomId).toBe("misthalin");
    expect(Travel.journeyOf("alice")).toBeNull(); // cleared
  });

  test("cargo profit is journaled", () => {
    const director = mockDirector([
      { username: "bob", kingdomId: "asgarnia" },
    ]);
    Travel.startJourney("bob", "asgarnia", "misthalin", 1000, null);
    Travel.setCargo("bob", [{ name: "spices", margin: 50 }]);
    const journey = Travel.journeyOf("bob");
    const result = processArrival(director, journey, journey.arrivesAt + 1);
    expect(result.cargoProfit).toBe(50);
  });

  test("handles missing roster record gracefully", () => {
    const director = mockDirector([]);
    Travel.startJourney("ghost", "asgarnia", "misthalin", 1000, null);
    const journey = Travel.journeyOf("ghost");
    const result = processArrival(director, journey, journey.arrivesAt + 1);
    expect(result.uname).toBe("ghost");
    expect(Travel.journeyOf("ghost")).toBeNull();
  });
});

describe("tickTravel", () => {
  test("processes due arrivals", () => {
    const director = mockDirector([
      { username: "carol", kingdomId: "asgarnia" },
    ]);
    Travel.startJourney("carol", "asgarnia", "kandarin", 1000, null);
    const journey = Travel.journeyOf("carol");
    const results = tickTravel(director, journey.arrivesAt + 1);
    expect(results.length).toBe(1);
    expect(results[0].to).toBe("kandarin");
    expect(director.roster.get("carol").kingdomId).toBe("kandarin");
  });

  test("ignores journeys not yet due", () => {
    const director = mockDirector([
      { username: "dave", kingdomId: "asgarnia" },
    ]);
    Travel.startJourney("dave", "asgarnia", "kandarin", 1000, null);
    const journey = Travel.journeyOf("dave");
    const results = tickTravel(director, journey.departsAt + 1000);
    expect(results.length).toBe(0);
    expect(director.roster.get("dave").kingdomId).toBe("asgarnia");
  });

  test("clears stale journeys for vanished citizens", () => {
    const director = mockDirector([]);
    Travel.startJourney("vanished", "asgarnia", "kandarin", 1000, null);
    expect(Travel.journeyOf("vanished")).toBeTruthy();
    tickTravel(director, Date.now() + 10 * 3600 * 1000);
    expect(Travel.journeyOf("vanished")).toBeNull();
  });

  test("never throws on a broken director", () => {
    Travel.startJourney("erin", "asgarnia", "kandarin", 1000, null);
    expect(() => tickTravel(null, Date.now())).not.toThrow();
    expect(() => tickTravel({}, Date.now())).not.toThrow();
  });
});

describe("displayName", () => {
  test("capitalizes", () => {
    const { displayName } = require("./CitizenTravelLife");
    expect(displayName("alice")).toBe("Alice");
  });
});
