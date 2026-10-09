"use strict";

/**
 * Treasury no-sim-money tests — the crown mints nothing.
 *
 * Every coin in a kingdom treasury must be traceable to a real player
 * action (market taxes from buyer purses, fealty dues, donations,
 * treasury-to-treasury war demands, seized player-funded war chests).
 * These tests prove the three historical money printers are dead:
 *
 *   1. Simulation.stewardTick — no longer mints a base 180-420c per tick.
 *   2. Alliances.onTaxCollected — the 8% pact trade bonus no longer mints.
 *   3. OfficeTools charter petition — approving it no longer mints 200-400c.
 *
 * And that the real flows still credit the treasury AND the income ledger.
 *
 * Run: node --test server/plugins/kingdoms/Treasury.NoSimMoney.test.js
 */

const assert = require("node:assert/strict");
const { describe, it, beforeEach } = require("node:test");
const Module = require("node:module");

// Simulation.Kingdoms requires the TS Task class; stub it for plain node.
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "../../src/main/typescript/elvarg/game/task/Task") {
    return { Task: class Task {} };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const Store = require("./KingdomStore");
const Offices = require("./Offices.Kingdoms");
const OfficeTools = require("./OfficeTools.Kingdoms");
const Treasury = require("./Treasury.Kingdoms");
const Simulation = require("./Simulation.Kingdoms");
const Alliances = require("./Alliances.Kingdoms");

const KINGDOM = "test-mint-kingdom";

function mockPlayer({ coins = 1000, username = "taxpayer" } = {}) {
  const inv = {
    coins,
    getAmount: (id) => (id === Treasury.COINS_ID ? inv.coins : 0),
    delete: (id, n) => {
      if (id === Treasury.COINS_ID) inv.coins = Math.max(0, inv.coins - n);
    },
    refreshItems: () => {},
  };
  return {
    getUsername: () => username,
    isPlayerBot: () => false,
    setAttribute: () => {},
    getInventory: () => inv,
    sendMessage: () => {},
    _inv: inv,
  };
}

beforeEach(() => {
  Store.resetForTests();
  Store.upsertKingdom({ id: KINGDOM, name: "Mint Test Realm", treasury: 5000 });
  Offices.defineOffice({ kingdomId: KINGDOM, office: "steward" });
});

function treasuryOf() {
  return Store.getKingdom(KINGDOM)?.treasury ?? 0;
}

function seatSteward() {
  Offices.assignOffice(Offices.officeIdFor(KINGDOM, "steward"), {
    kind: "ai",
    ref: "test-steward",
  });
}

describe("sim-money is dead", () => {
  it("stewardTick never mints: treasury unchanged with a seated steward", () => {
    seatSteward();
    const before = treasuryOf();
    // Run the tick several times — a printer would compound.
    for (let i = 0; i < 5; i++) Simulation.stewardTick(Store.getKingdom(KINGDOM), []);
    assert.equal(treasuryOf(), before, "steward tick must not create coins");
  });

  it("stewardTick never mints during wartime either", () => {
    seatSteward();
    Store.declareWar({ attackerId: KINGDOM, defenderId: "test-foe" });
    const before = treasuryOf();
    const wars = Store.getActiveWars().filter(
      (w) => w.active && (w.attackerId === KINGDOM || w.defenderId === KINGDOM)
    );
    for (let i = 0; i < 3; i++) Simulation.stewardTick(Store.getKingdom(KINGDOM), wars);
    assert.equal(treasuryOf(), before, "wartime steward tick must not create coins");
  });

  it("stewardTick reports real income instead of minting it", () => {
    seatSteward();
    // Real income first: a fealty tax from a player's purse.
    const player = mockPlayer({ coins: 1000 });
    const taken = Treasury.collectTax(player, KINGDOM, "fealty", null);
    assert.ok(taken > 0, "fealty tax should take real coins");
    const reported = Simulation.stewardTick(Store.getKingdom(KINGDOM), []);
    assert.equal(reported, taken, "steward reports the real income, nothing more");
  });

  it("alliance trade bonus is dead: onTaxCollected grants nothing", () => {
    const before = treasuryOf();
    Alliances.onTaxCollected({ kingdomId: KINGDOM, amount: 1000 });
    Alliances.onTaxCollected({ kingdomId: KINGDOM, amount: 1000, wartime: true });
    assert.equal(treasuryOf(), before, "tax-collected listener must not mint");
  });

  it("charter petition approval grants no coins", () => {
    seatSteward();
    // Approve a charter petition through the same path the template uses.
    const charter = {
      id: "test-charter",
      kind: "charter",
      text: "A guildmaster seeks a trading charter — honor, not coin.",
      cost: 0,
      filedAt: Date.now(),
    };
    Store.setFlag(KINGDOM, "sim:petitions", [charter]);
    const before = treasuryOf();
    assert.ok(OfficeTools.approvePetition(KINGDOM, "test-charter", "test-steward"));
    assert.equal(treasuryOf(), before, "charter approval must not mint coins");
    assert.equal(
      OfficeTools.getPetitions(KINGDOM).find((p) => p.id === "test-charter"),
      undefined,
      "petition leaves the queue"
    );
  });
});

describe("real flows still credit the treasury and the ledger", () => {
  it("fealty tax: player purse -> treasury, ledgered as fealty", () => {
    const player = mockPlayer({ coins: 1000 });
    const beforeTreasury = treasuryOf();
    const taken = Treasury.collectTax(player, KINGDOM, "fealty", null);
    assert.ok(taken > 0);
    assert.equal(treasuryOf(), beforeTreasury + taken);
    assert.equal(player._inv.coins, 1000 - taken, "coins leave the player's purse");
    assert.equal(Store.getIncomeTotals(KINGDOM).fealty, taken);
  });

  it("recordIncome accumulates per-source totals and recent income", () => {
    Store.recordIncome(KINGDOM, "player-stall", 95);
    Store.recordIncome(KINGDOM, "player-stall", 5);
    Store.recordIncome(KINGDOM, "donation", 500);
    const totals = Store.getIncomeTotals(KINGDOM);
    assert.equal(totals["player-stall"], 100);
    assert.equal(totals.donation, 500);
    assert.equal(Store.getRecentIncome(KINGDOM, 60 * 1000), 600);
    assert.equal(Store.getRecentIncome(KINGDOM, 0), 0, "zero window finds nothing");
  });

  it("income ledger is bounded", () => {
    for (let i = 0; i < 150; i++) Store.recordIncome(KINGDOM, "player-stall", 1);
    const ledger = Store.getKingdom(KINGDOM).flags["treasury:income-ledger"];
    assert.ok(ledger.length <= 100, "ledger stays bounded");
    assert.equal(Store.getIncomeTotals(KINGDOM)["player-stall"], 150, "totals keep everything");
  });
});

describe("market tax rate follows the steward's seal", () => {
  it("defaults to 5% with no steward action", () => {
    assert.equal(Store.getMarketTaxRate(KINGDOM), 0.05);
  });

  it("steward tax-rate seal scales the real market tax", () => {
    assert.ok(OfficeTools.setTaxRate(KINGDOM, 2, "test"));
    assert.ok(Math.abs(Store.getMarketTaxRate(KINGDOM) - 0.1) < 1e-9);
    assert.ok(OfficeTools.setTaxRate(KINGDOM, 0.5, "test"));
    assert.ok(Math.abs(Store.getMarketTaxRate(KINGDOM) - 0.025) < 1e-9);
  });

  it("rejects invalid tax rates, keeping the last good one", () => {
    assert.ok(OfficeTools.setTaxRate(KINGDOM, 1.5, "test"));
    assert.equal(OfficeTools.setTaxRate(KINGDOM, 99, "test"), false);
    assert.ok(Math.abs(Store.getMarketTaxRate(KINGDOM) - 0.075) < 1e-9);
  });

  it("unknown kingdom falls back to the base rate", () => {
    assert.equal(Store.getMarketTaxRate("no-such-kingdom"), 0.05);
  });
});
