"use strict";

/**
 * CitizenEntertainment.test.js — data tier tests for citizen entertainment.
 *
 * Covers: venue catalog, drunkenness, honest drinks, honest dice,
 * bard performances, theater, arena.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");

const Entertain = require("./CitizenEntertainment");

const TEST_SAVE = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "citizen-entertain-test-")),
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
});

// --- mock player ---------------------------------------------------------------
function mockPlayer(coins) {
  let _coins = coins;
  return {
    _coins,
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
      return "TestCitizen";
    },
    getAttribute() {
      return null;
    },
  };
}

describe("venue catalog", () => {
  test("every kingdom has a tavern", () => {
    for (const kingdom of ["misthalin", "asgarnia", "kandarin", "morytania", "keldagrim"]) {
      const tavern = Entertain.tavernOfKingdom(kingdom);
      expect(tavern).toBeTruthy();
      expect(tavern.name).toBeTruthy();
      expect(tavern.kingdomId).toBe(kingdom);
    }
  });

  test("unknown kingdom returns null", () => {
    expect(Entertain.tavernOfKingdom("narnia")).toBeNull();
    expect(Entertain.tavernOfKingdom(null)).toBeNull();
  });

  test("theater and arena exist", () => {
    expect(Entertain.theater().name).toBeTruthy();
    expect(Entertain.arena().name).toBeTruthy();
  });
});

describe("drunkenness", () => {
  test("sober by default", () => {
    expect(Entertain.drunkennessOf("TestCitizen")).toBe(0);
    expect(Entertain.isDrunk("TestCitizen")).toBe(false);
    expect(Entertain.workPenaltyFor("TestCitizen")).toBe(0);
  });

  test("soberUp reduces drunkenness", () => {
    const player = mockPlayer(100);
    Entertain.buyDrink("TestCitizen", player);
    Entertain.buyDrink("TestCitizen", player);
    expect(Entertain.isDrunk("TestCitizen")).toBe(true);
    expect(Entertain.workPenaltyFor("TestCitizen")).toBe(Entertain.DRUNK_WORK_PENALTY);
    Entertain.soberUp("TestCitizen", 10); // 10 hours
    expect(Entertain.isDrunk("TestCitizen")).toBe(false);
  });
});

describe("honest drinks", () => {
  test("buyDrink takes real coins", () => {
    const player = mockPlayer(100);
    const before = player.countCoins();
    const result = Entertain.buyDrink("TestCitizen", player);
    expect(result.ok).toBe(true);
    expect(player.countCoins()).toBe(before - Entertain.DRINK_PRICE);
    expect(result.drunkenness).toBe(Entertain.DRUNK_PER_DRINK);
  });

  test("broke citizens can't drink", () => {
    const player = mockPlayer(2);
    const result = Entertain.buyDrink("TestCitizen", player);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("broke");
    expect(player.countCoins()).toBe(2); // untouched
  });

  test("drunkenness accumulates", () => {
    const player = mockPlayer(100);
    Entertain.buyDrink("TestCitizen", player);
    Entertain.buyDrink("TestCitizen", player);
    expect(Entertain.drunkennessOf("TestCitizen")).toBe(Entertain.DRUNK_PER_DRINK * 2);
  });
});

describe("honest dice", () => {
  test("bad bets rejected", () => {
    const player = mockPlayer(100);
    expect(Entertain.playDice("TestCitizen", player, 5).ok).toBe(false);
    expect(Entertain.playDice("TestCitizen", player, 100).ok).toBe(false);
    expect(Entertain.playDice("TestCitizen", player, NaN).ok).toBe(false);
  });

  test("broke citizens can't gamble", () => {
    const player = mockPlayer(5);
    const result = Entertain.playDice("TestCitizen", player, 10);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("broke");
  });

  test("win pays 2x (deterministic rng)", () => {
    const player = mockPlayer(100);
    const before = player.countCoins();
    const result = Entertain.playDice("TestCitizen", player, 20, () => 0.1); // always win
    expect(result.ok).toBe(true);
    expect(result.won).toBe(true);
    expect(result.payout).toBe(40);
    expect(player.countCoins()).toBe(before - 20 + 40);
  });

  test("loss takes the bet (deterministic rng)", () => {
    const player = mockPlayer(100);
    const before = player.countCoins();
    const result = Entertain.playDice("TestCitizen", player, 20, () => 0.9); // always lose
    expect(result.ok).toBe(true);
    expect(result.won).toBe(false);
    expect(result.payout).toBe(0);
    expect(player.countCoins()).toBe(before - 20);
  });
});

describe("bard performances", () => {
  test("recordPerformance tracks", () => {
    expect(Entertain.lastPerformanceAt("BardBob")).toBe(0);
    Entertain.recordPerformance("BardBob", 12345);
    expect(Entertain.lastPerformanceAt("BardBob")).toBe(12345);
  });

  test("enjoyPerformance tips the bard", () => {
    const listener = mockPlayer(100);
    const bard = mockPlayer(10);
    const listenerBefore = listener.countCoins();
    const bardBefore = bard.countCoins();
    const result = Entertain.enjoyPerformance(listener, bard);
    expect(result.ok).toBe(true);
    expect(result.tipped).toBe(Entertain.PERFORMANCE_TIP);
    expect(listener.countCoins()).toBe(listenerBefore - Entertain.PERFORMANCE_TIP);
    expect(bard.countCoins()).toBe(bardBefore + Entertain.PERFORMANCE_TIP);
  });

  test("broke listener doesn't tip", () => {
    const listener = mockPlayer(1);
    const bard = mockPlayer(10);
    const result = Entertain.enjoyPerformance(listener, bard);
    expect(result.ok).toBe(true);
    expect(result.tipped).toBe(0);
    expect(bard.countCoins()).toBe(10);
  });
});

describe("theater", () => {
  test("watchShow takes real coins", () => {
    const player = mockPlayer(100);
    const before = player.countCoins();
    const result = Entertain.watchShow("TestCitizen", player);
    expect(result.ok).toBe(true);
    expect(player.countCoins()).toBe(before - Entertain.THEATER_PRICE);
  });

  test("broke citizens can't watch", () => {
    const player = mockPlayer(5);
    const result = Entertain.watchShow("TestCitizen", player);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("broke");
  });

  test("recordShow and recentShows", () => {
    Entertain.recordShow("Hamlet", "misthalin", 1000);
    Entertain.recordShow("Macbeth", "misthalin", 2000);
    const shows = Entertain.recentShows(5);
    expect(shows.length).toBe(2);
    expect(shows[0].title).toBe("Macbeth"); // most recent first
  });
});

describe("arena", () => {
  test("recordFight and recentFights", () => {
    Entertain.recordFight("Alice", "Bob", "Alice", 1000);
    const fights = Entertain.recentFights(5);
    expect(fights.length).toBe(1);
    expect(fights[0].winner).toBe("alice"); // normalized
  });

  test("awardPrize pays the winner", () => {
    const winner = mockPlayer(50);
    const before = winner.countCoins();
    Entertain.awardPrize(winner, true);
    expect(winner.countCoins()).toBe(before + Entertain.ARENA_PRIZE);
  });

  test("awardPrize doesn't pay the loser", () => {
    const loser = mockPlayer(50);
    const before = loser.countCoins();
    Entertain.awardPrize(loser, false);
    expect(loser.countCoins()).toBe(before);
  });
});

describe("persistence", () => {
  test("save and load round-trip", () => {
    const player = mockPlayer(100);
    Entertain.buyDrink("TestCitizen", player);
    expect(Entertain.save()).toBe(true);
    Entertain.resetForTests();
    expect(Entertain.drunkennessOf("TestCitizen")).toBe(Entertain.DRUNK_PER_DRINK);
  });
});
