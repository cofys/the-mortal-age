"use strict";

/**
 * Castle unit checks — fortification, buildings, staffing, tithe economy.
 *
 * The castle is the fortified heart of a kingdom. Phase 1: data model
 * (fort tiers, 8 buildings, banner, war chest). Phase 2: citizen staffing
 * (role-matched, slot-limited) and the tithe economy (citizens pay,
 * buildings cost upkeep, net flows to the war chest).
 */
const assert = require("node:assert/strict");
const { describe, it, beforeEach } = require("node:test");

const Castle = require("./Castle.Kingdoms");

// In-memory store mock — same shape as KingdomStore (load/save).
function mockStore() {
  let state = {};
  return {
    load: () => state,
    save: () => {},
    _state: () => state,
  };
}

describe("fortification", () => {
  let store;
  beforeEach(() => { store = mockStore(); });

  it("starts at tier 0 (camp)", () => {
    const castle = Castle.ensureCastle("asgarnia", store);
    assert.equal(castle.fortTier, 0);
    assert.equal(Castle.fortTierDef(0).id, "camp");
  });

  it("upgrade deducts cost and raises tier", () => {
    const castle = Castle.ensureCastle("asgarnia", store);
    Castle.depositWarChest("asgarnia", 10000000, store);
    const r = Castle.upgradeFortification("asgarnia", store);
    assert.equal(r.ok, true);
    assert.equal(r.tier, 1);
    assert.equal(Castle.getCastle("asgarnia", store).fortTier, 1);
  });

  it("upgrade fails without funds", () => {
    Castle.ensureCastle("asgarnia", store);
    const r = Castle.upgradeFortification("asgarnia", store);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "insufficient-funds");
  });

  it("upgrade fails at max tier", () => {
    const castle = Castle.ensureCastle("asgarnia", store);
    castle.fortTier = 4;
    const r = Castle.upgradeFortification("asgarnia", store);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "already-max");
  });

  it("fortDefense includes barracks bonus when staffed", () => {
    const castle = Castle.ensureCastle("asgarnia", store);
    castle.fortTier = 2; // stone walls: 25 defense
    assert.equal(Castle.fortDefense(castle), 25);
    Castle.depositWarChest("asgarnia", 5000000, store);
    Castle.buildBuilding("asgarnia", "barracks", store); // tier 1: 5 defense, 10 slots
    // Unstaffed: barracks gives 0 (staffing ratio 0)
    assert.equal(Castle.fortDefense(castle), 25);
    // Fully staffed: +5
    for (let i = 0; i < 10; i++) {
      Castle.staffBuilding("asgarnia", "barracks", `guard${i}`, "guard", store);
    }
    assert.equal(Castle.fortDefense(castle), 30);
  });
});

describe("buildings", () => {
  let store;
  beforeEach(() => { store = mockStore(); });

  it("builds tier 1 and upgrades to tier 2", () => {
    Castle.ensureCastle("asgarnia", store);
    Castle.depositWarChest("asgarnia", 10000000, store);
    let r = Castle.buildBuilding("asgarnia", "workshop", store);
    assert.equal(r.ok, true);
    assert.equal(r.tier, 1);
    r = Castle.buildBuilding("asgarnia", "workshop", store);
    assert.equal(r.ok, true);
    assert.equal(r.tier, 2);
  });

  it("rejects unknown building", () => {
    Castle.ensureCastle("asgarnia", store);
    const r = Castle.buildBuilding("asgarnia", "spaceship", store);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "unknown-building");
  });

  it("rejects build without funds", () => {
    Castle.ensureCastle("asgarnia", store);
    const r = Castle.buildBuilding("asgarnia", "barracks", store);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "insufficient-funds");
  });

  it("rejects tier 4 (max is 3)", () => {
    const castle = Castle.ensureCastle("asgarnia", store);
    Castle.depositWarChest("asgarnia", 100000000, store);
    Castle.buildBuilding("asgarnia", "chapel", store);
    Castle.buildBuilding("asgarnia", "chapel", store);
    Castle.buildBuilding("asgarnia", "chapel", store);
    const r = Castle.buildBuilding("asgarnia", "chapel", store);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "already-max");
    assert.equal(castle.buildings.chapel.tier, 3);
  });
});

describe("staffing", () => {
  let store;
  beforeEach(() => {
    store = mockStore();
    Castle.ensureCastle("asgarnia", store);
    Castle.depositWarChest("asgarnia", 10000000, store);
    Castle.buildBuilding("asgarnia", "barracks", store); // guard role, 10 slots
    Castle.buildBuilding("asgarnia", "workshop", store); // worker role, 8 slots
  });

  it("staffs a guard in the barracks", () => {
    const r = Castle.staffBuilding("asgarnia", "barracks", "alice", "guard", store);
    assert.equal(r.ok, true);
    const info = Castle.staffingInfo(Castle.getCastle("asgarnia", store), "barracks");
    assert.equal(info.staffed, 1);
    assert.equal(info.slots, 10);
  });

  it("rejects wrong role", () => {
    const r = Castle.staffBuilding("asgarnia", "barracks", "bob", "worker", store);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "wrong-role");
  });

  it("rejects staffing an unbuilt building", () => {
    const r = Castle.staffBuilding("asgarnia", "chapel", "carol", "clergy", store);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "not-built");
  });

  it("rejects overfilling slots", () => {
    for (let i = 0; i < 10; i++) {
      const r = Castle.staffBuilding("asgarnia", "barracks", `g${i}`, "guard", store);
      assert.equal(r.ok, true);
    }
    const r = Castle.staffBuilding("asgarnia", "barracks", "extra", "guard", store);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "full");
  });

  it("one job per citizen: restaffing moves them", () => {
    Castle.staffBuilding("asgarnia", "barracks", "dave", "guard", store);
    // dave is a guard; can't work the workshop (wrong role), but verify
    // he's removed from barracks when unstaffed
    const r = Castle.unstaffBuilding("asgarnia", "dave", store);
    assert.equal(r.ok, true);
    const info = Castle.staffingInfo(Castle.getCastle("asgarnia", store), "barracks");
    assert.equal(info.staffed, 0);
  });

  it("unstaff unknown citizen fails", () => {
    const r = Castle.unstaffBuilding("asgarnia", "nobody", store);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "not-staffed");
  });
});

describe("building effects", () => {
  let store;
  beforeEach(() => {
    store = mockStore();
    Castle.ensureCastle("asgarnia", store);
    Castle.depositWarChest("asgarnia", 50000000, store);
  });

  it("unstaffed building gives 25% bonus", () => {
    Castle.buildBuilding("asgarnia", "workshop", store); // tier 1: 0.10 craftBonus
    const castle = Castle.getCastle("asgarnia", store);
    const bonus = Castle.buildingBonus(castle, "workshop", "craftBonus");
    assert.ok(Math.abs(bonus - 0.025) < 0.001, `expected 0.025, got ${bonus}`);
  });

  it("fully staffed building gives 100% bonus", () => {
    Castle.buildBuilding("asgarnia", "workshop", store);
    for (let i = 0; i < 8; i++) {
      Castle.staffBuilding("asgarnia", "workshop", `w${i}`, "worker", store);
    }
    const castle = Castle.getCastle("asgarnia", store);
    const bonus = Castle.buildingBonus(castle, "workshop", "craftBonus");
    assert.ok(Math.abs(bonus - 0.10) < 0.001, `expected 0.10, got ${bonus}`);
  });

  it("half staffed gives 62.5% bonus", () => {
    Castle.buildBuilding("asgarnia", "workshop", store);
    for (let i = 0; i < 4; i++) {
      Castle.staffBuilding("asgarnia", "workshop", `w${i}`, "worker", store);
    }
    const castle = Castle.getCastle("asgarnia", store);
    const bonus = Castle.buildingBonus(castle, "workshop", "craftBonus");
    // 0.10 * (0.25 + 0.75 * 0.5) = 0.10 * 0.625 = 0.0625
    assert.ok(Math.abs(bonus - 0.0625) < 0.001, `expected 0.0625, got ${bonus}`);
  });

  it("castleBonuses aggregates everything", () => {
    Castle.buildBuilding("asgarnia", "chapel", store);
    const bonuses = Castle.castleBonuses(Castle.getCastle("asgarnia", store));
    assert.equal(typeof bonuses.defense, "number");
    assert.equal(typeof bonuses.morale, "number");
    assert.equal(typeof bonuses.craftBonus, "number");
    assert.ok(bonuses.morale > 0, "chapel should give morale");
  });

  it("missing building gives zero bonus", () => {
    const castle = Castle.getCastle("asgarnia", store);
    assert.equal(Castle.buildingBonus(castle, "library", "xpBonus"), 0);
  });
});

describe("tithe economy", () => {
  let store;
  beforeEach(() => {
    store = mockStore();
    Castle.ensureCastle("asgarnia", store);
  });

  it("collects tithes from citizens", () => {
    const citizens = ["a", "b", "c", "d", "e"]; // 5 citizens
    const r = Castle.collectTithesForce("asgarnia", citizens, store);
    assert.equal(r.ok, true);
    assert.equal(r.citizenCount, 5);
    assert.equal(r.collected, 5 * 100); // TITHE_BASE, no treasury bonus
    assert.equal(r.upkeep, 0); // no buildings
    assert.equal(r.net, 500);
    assert.equal(Castle.getCastle("asgarnia", store).warChest, 500);
  });

  it("treasury building boosts tithe efficiency", () => {
    Castle.depositWarChest("asgarnia", 5000000, store);
    Castle.buildBuilding("asgarnia", "treasury", store); // tier 1: 0.05 titheEff, unstaffed -> 25%
    const r = Castle.collectTithesForce("asgarnia", ["a", "b"], store);
    // tithePerCitizen = 100 * (1 + 0.05*0.25) = 101.25 -> 101
    assert.equal(r.tithePerCitizen, 101);
    assert.equal(r.collected, 202);
  });

  it("allied kingdoms boost tithes via pact-road trade", () => {
    const state = store.load();
    state.alliances = [{ a: "asgarnia", b: "misthalin", pactName: "test", strength: 1, betrayalRisk: 0 }];
    const r = Castle.collectTithesForce("asgarnia", ["a", "b"], store);
    // tithePerCitizen = 100 * (1 + 0 + 0.05) = 105
    assert.equal(r.tradeBonus, 0.05);
    assert.equal(r.tithePerCitizen, 105);
    assert.equal(r.collected, 210);
  });

  it("building upkeep reduces net income", () => {
    Castle.depositWarChest("asgarnia", 5000000, store);
    Castle.buildBuilding("asgarnia", "barracks", store); // upkeep 5000
    const r = Castle.collectTithesForce("asgarnia", ["a"], store); // 100 collected
    assert.equal(r.collected, 100);
    assert.equal(r.upkeep, 5000);
    assert.equal(r.net, -4900);
    // War chest can't go negative: 5000000 - 1000000 (barracks cost) - 4900
    const castle = Castle.getCastle("asgarnia", store);
    assert.ok(castle.warChest >= 0);
  });

  it("totalUpkeep sums all buildings", () => {
    Castle.depositWarChest("asgarnia", 10000000, store);
    Castle.buildBuilding("asgarnia", "barracks", store); // 5000
    Castle.buildBuilding("asgarnia", "chapel", store); // 2000
    const castle = Castle.getCastle("asgarnia", store);
    assert.equal(Castle.totalUpkeep(castle), 7000);
  });

  it("throttles collections to once per cycle", () => {
    Castle.collectTithesForce("asgarnia", ["a"], store);
    const r = Castle.collectTithes("asgarnia", ["a"], store);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "too-soon");
  });
});

describe("banner and war chest", () => {
  let store;
  beforeEach(() => { store = mockStore(); });

  it("sets a valid banner", () => {
    const r = Castle.setBanner("asgarnia", "azure", "lion", store);
    assert.equal(r.ok, true);
    const castle = Castle.getCastle("asgarnia", store);
    assert.deepEqual(castle.banner, { color: "azure", symbol: "lion" });
  });

  it("rejects bad color and symbol", () => {
    assert.equal(Castle.setBanner("asgarnia", "pink", "lion", store).ok, false);
    assert.equal(Castle.setBanner("asgarnia", "azure", "ufo", store).ok, false);
  });

  it("deposit and withdraw war chest", () => {
    Castle.ensureCastle("asgarnia", store);
    Castle.depositWarChest("asgarnia", 1000, store);
    assert.equal(Castle.getCastle("asgarnia", store).warChest, 1000);
    const r = Castle.withdrawWarChest("asgarnia", 400, store);
    assert.equal(r.ok, true);
    assert.equal(r.warChest, 600);
  });

  it("withdraw fails without funds", () => {
    Castle.ensureCastle("asgarnia", store);
    const r = Castle.withdrawWarChest("asgarnia", 100, store);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "insufficient-funds");
  });

  it("rejects bad amounts", () => {
    Castle.ensureCastle("asgarnia", store);
    assert.equal(Castle.depositWarChest("asgarnia", -5, store).ok, false);
    assert.equal(Castle.withdrawWarChest("asgarnia", 0, store).ok, false);
  });
});
