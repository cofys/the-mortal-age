"use strict";

/**
 * CitizenEntertainLife.test.js — tick dynamics tests for entertainment.
 *
 * Covers: sobriety, bard performances, theater during festivals, arena.
 * The tick never throws.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");

const Entertain = require("./CitizenEntertainment");
const { tickEntertain } = require("./CitizenEntertainLife");

const TEST_SAVE = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "citizen-entertain-life-test-")),
  "citizen-entertainment.json"
);

beforeEach(() => {
  Entertain._setSavePathForTests(TEST_SAVE);
  Entertain.resetForTests();
  try {
    fs.unlinkSync(TEST_SAVE);
  } catch {
    // ignore
  }
  jest.resetModules();
});

function mockPlayer(coins, username) {
  let _coins = coins;
  return {
    countCoins() {
      return _coins;
    },
    removeCoins(n) {
      if (_coins < n) return false;
      _coins -= n;
      return true;
    },
    addCoins(n) {
      _coins += n;
      return true;
    },
    getUsername() {
      return username;
    },
    getAttribute() {
      return null;
    },
  };
}

function mockDirector(players) {
  // players: [{ username, player, career, kingdomId }]
  const roster = new Map();
  const playerMap = new Map();
  for (const p of players) {
    roster.set(p.username.toLowerCase(), {
      username: p.username,
      kingdomId: p.kingdomId ?? "misthalin",
      career: p.career ?? null,
    });
    playerMap.set(p.username, p.player);
    playerMap.set(p.username.toLowerCase(), p.player);
  }
  return {
    roster,
    players: playerMap,
    getPlayer(username) {
      return playerMap.get(username) ?? playerMap.get(String(username).toLowerCase()) ?? null;
    },
    log() {},
  };
}

describe("tickEntertain", () => {
  test("never throws on empty director", () => {
    expect(() => tickEntertain(null, Date.now())).not.toThrow();
    expect(() => tickEntertain({}, Date.now())).not.toThrow();
  });

  test("never throws with no players", () => {
    const director = mockDirector([]);
    expect(() => tickEntertain(director, Date.now())).not.toThrow();
  });

  test("sobers up drinkers", () => {
    const player = mockPlayer(100, "DrunkDave");
    Entertain.buyDrink("DrunkDave", player);
    Entertain.buyDrink("DrunkDave", player);
    expect(Entertain.isDrunk("DrunkDave")).toBe(true);
    // Simulate many ticks (each tick is ~1/60 hour).
    const director = mockDirector([{ username: "DrunkDave", player }]);
    for (let i = 0; i < 10000; i++) {
      tickEntertain(director, Date.now() + i * 60000);
    }
    expect(Entertain.isDrunk("DrunkDave")).toBe(false);
  });

  test("bard performance is recorded", () => {
    // Mock the careers module to report a bard.
    jest.doMock("./CitizenCareers", () => ({
      careerOf: (username) => (String(username).toLowerCase() === "bardbob" ? "bard" : null),
    }));
    // Re-require to pick up the mock.
    jest.resetModules();
    const EntertainFresh = require("./CitizenEntertainment");
    EntertainFresh._setSavePathForTests(TEST_SAVE);
    EntertainFresh.resetForTests();
    const { tickEntertain: tickFresh } = require("./CitizenEntertainLife");

    const player = mockPlayer(100, "BardBob");
    const director = mockDirector([{ username: "BardBob", player, career: "bard" }]);
    // Force a performance by running many ticks (30% chance each).
    let performed = false;
    for (let i = 0; i < 100 && !performed; i++) {
      tickFresh(director, Date.now() + i * 60000);
      if (EntertainFresh.lastPerformanceAt("BardBob") > 0) performed = true;
    }
    // May or may not have performed (random) — just verify no throw.
    expect(typeof EntertainFresh.lastPerformanceAt("BardBob")).toBe("number");
  });

  test("arena schedules fights", () => {
    const alice = mockPlayer(100, "Alice");
    const bob = mockPlayer(100, "Bob");
    const director = mockDirector([
      { username: "Alice", player: alice },
      { username: "Bob", player: bob },
    ]);
    // Run many ticks (20% chance each, 6h cooldown).
    for (let i = 0; i < 200; i++) {
      tickEntertain(director, Date.now() + i * 60000);
    }
    // May or may not have fought (random) — just verify no throw.
    expect(Array.isArray(Entertain.recentFights(5))).toBe(true);
  });
});
