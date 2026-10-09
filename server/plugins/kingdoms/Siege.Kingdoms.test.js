"use strict";

/**
 * Siege unit checks — declaration, power, tick resolution, defense actions.
 *
 * Phase 3: castle siege warfare. Attackers declare sieges (war chest cost +
 * investment), sieges resolve over hourly ticks based on attacker power vs
 * defender fortifications, defenders can sally or repair.
 */
const assert = require("node:assert/strict");
const { describe, it, beforeEach } = require("node:test");

const Castle = require("./Castle.Kingdoms");
const Siege = require("./Siege.Kingdoms");

// In-memory store mock — same shape as KingdomStore (load/save).
function mockStore() {
  let state = {};
  return {
    load: () => state,
    save: () => {},
    _state: () => state,
  };
}

// Helper: give a kingdom a funded castle.
function fundedCastle(kingdomId, store, coins = 10_000_000) {
  Castle.ensureCastle(kingdomId, store);
  Castle.depositWarChest(kingdomId, coins, store);
  return Castle.getCastle(kingdomId, store);
}

// Helper: force a siege tick by rewinding lastTickAt.
function forceTickReady(siege) {
  siege.lastTickAt = Date.now() - Siege.SIEGE_TICK_MS - 1000;
}

describe("siege declaration", () => {
  let store;
  beforeEach(() => { store = mockStore(); });

  it("rejects sieging yourself", () => {
    fundedCastle("asgarnia", store);
    const r = Siege.declareSiege("asgarnia", "asgarnia", 0, store);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "cannot-siege-self");
  });

  it("rejects without funds for declaration cost", () => {
    fundedCastle("asgarnia", store, 500_000); // less than 1M declare cost
    fundedCastle("misthalin", store);
    const r = Siege.declareSiege("asgarnia", "misthalin", 0, store);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "insufficient-funds");
  });

  it("deducts declare cost + investment on success", () => {
    fundedCastle("asgarnia", store, 5_000_000);
    fundedCastle("misthalin", store);
    const before = Castle.getCastle("asgarnia", store).warChest;
    const r = Siege.declareSiege("asgarnia", "misthalin", 2_000_000, store);
    assert.equal(r.ok, true);
    assert.equal(r.siege.attackerKingdomId, "asgarnia");
    assert.equal(r.siege.defenderKingdomId, "misthalin");
    assert.equal(r.siege.investment, 2_000_000);
    assert.equal(r.siege.status, "active");
    assert.equal(r.siege.progress, 0);
    const after = Castle.getCastle("asgarnia", store).warChest;
    assert.equal(after, before - Siege.SIEGE_DECLARE_COST - 2_000_000);
  });

  it("rejects when defender already besieged", () => {
    fundedCastle("asgarnia", store, 5_000_000);
    fundedCastle("kandarin", store, 5_000_000);
    fundedCastle("misthalin", store);
    const r1 = Siege.declareSiege("asgarnia", "misthalin", 0, store);
    assert.equal(r1.ok, true);
    const r2 = Siege.declareSiege("kandarin", "misthalin", 0, store);
    assert.equal(r2.ok, false);
    assert.equal(r2.reason, "already-besieged");
  });

  it("enforces cooldown after a resolved siege", () => {
    fundedCastle("asgarnia", store, 20_000_000);
    fundedCastle("misthalin", store);
    const r1 = Siege.declareSiege("asgarnia", "misthalin", 0, store);
    assert.equal(r1.ok, true);
    // Resolve it as lifted, just now
    const lifted = Siege.liftSiege("asgarnia", "misthalin", store);
    assert.equal(lifted.ok, true);
    // Immediate re-declare should hit cooldown
    const r2 = Siege.declareSiege("asgarnia", "misthalin", 0, store);
    assert.equal(r2.ok, false);
    assert.equal(r2.reason, "on-cooldown");
  });
});

describe("siege power", () => {
  it("scales with investment (100k coins = 1 power)", () => {
    assert.equal(Siege.siegePower(0, 0), 0);
    assert.equal(Siege.siegePower(1_000_000, 0), 10);
    assert.equal(Siege.siegePower(5_000_000, 0), 50);
  });

  it("adds attacker fort tier defense as infrastructure", () => {
    const noFort = Siege.siegePower(1_000_000, 0);
    const withFort = Siege.siegePower(1_000_000, 4); // citadel = 100 defense
    assert.equal(withFort - noFort, 100);
  });

  it("defender power equals castle fortDefense", () => {
    const store = mockStore();
    const castle = fundedCastle("misthalin", store);
    assert.equal(Siege.defenderPower(castle), Castle.fortDefense(castle));
  });
});

describe("siege tick", () => {
  let store;
  beforeEach(() => { store = mockStore(); });

  it("strong attacker gains progress", () => {
    fundedCastle("asgarnia", store, 50_000_000);
    fundedCastle("misthalin", store); // tier 0 camp, defense 0
    // 10M investment = 100 power vs ~1 defender power (camp)
    const r = Siege.declareSiege("asgarnia", "misthalin", 10_000_000, store);
    assert.equal(r.ok, true);
    forceTickReady(r.siege);
    const t = Siege.tickSiege("misthalin", store);
    assert.equal(t.ok, true);
    assert.ok(t.siege.progress > 0, `progress=${t.siege.progress}`);
    assert.equal(t.siege.ticksElapsed, 1);
  });

  it("weak attacker loses progress (defense pushes back)", () => {
    fundedCastle("asgarnia", store, 5_000_000);
    const def = fundedCastle("misthalin", store, 200_000_000);
    // Build up defender: fortified keep (tier 3) = 50 defense
    Castle.depositWarChest("misthalin", 0, store); // ensure exists
    def.fortTier = 3;
    // Minimal investment = 0 power + 0 infra vs 50 defense
    const r = Siege.declareSiege("asgarnia", "misthalin", 0, store);
    assert.equal(r.ok, true);
    // Give it some progress first, then watch it get pushed back
    r.siege.progress = 20;
    forceTickReady(r.siege);
    const t = Siege.tickSiege("misthalin", store);
    assert.equal(t.ok, true);
    assert.ok(t.siege.progress < 20, `progress=${t.siege.progress}`);
  });

  it("victory at 100 progress loots and damages", () => {
    fundedCastle("asgarnia", store, 50_000_000);
    const def = fundedCastle("misthalin", store, 10_000_000);
    def.fortTier = 2;
    // Build a barracks to be damaged (tier 1 costs 1M from the war chest)
    Castle.buildBuilding("misthalin", "barracks", store);
    const warChestBefore = Castle.getCastle("misthalin", store).warChest;
    const r = Siege.declareSiege("asgarnia", "misthalin", 20_000_000, store);
    assert.equal(r.ok, true);
    r.siege.progress = 95;
    forceTickReady(r.siege);
    const t = Siege.tickSiege("misthalin", store);
    assert.equal(t.ok, true);
    assert.equal(t.outcome, "victory");
    assert.equal(t.siege.status, "victory");
    // Loot: 25% of remaining war chest to attacker
    assert.equal(t.siege.loot, Math.floor(warChestBefore * Siege.VICTORY_LOOT_PCT));
    // Fort tier reduced
    assert.equal(Castle.getCastle("misthalin", store).fortTier, 1);
  });

  it("defeat when progress hits 0 after minimum ticks", () => {
    fundedCastle("asgarnia", store, 5_000_000);
    const def = fundedCastle("misthalin", store);
    def.fortTier = 4; // citadel, 100 defense vs ~0 attacker power
    const r = Siege.declareSiege("asgarnia", "misthalin", 0, store);
    assert.equal(r.ok, true);
    r.siege.ticksElapsed = Siege.SIEGE_MIN_TICKS_BEFORE_DEFEAT;
    r.siege.progress = 3; // will go to 0 (defense pushes back -5)
    forceTickReady(r.siege);
    const t = Siege.tickSiege("misthalin", store);
    assert.equal(t.ok, true);
    assert.equal(t.outcome, "defeat");
    assert.equal(t.siege.status, "defeat");
  });

  it("stalemate at max ticks", () => {
    fundedCastle("asgarnia", store, 50_000_000);
    fundedCastle("misthalin", store);
    // Balanced-ish: give attacker moderate power so progress hovers mid-range.
    // Use 0 investment vs tier 0 (defense ~1): ratio huge, so instead use
    // a defender with real defense and weak attacker to keep progress at 0,
    // but set ticks just below max and min-ticks already passed so defeat
    // would trigger — we want stalemate instead, so keep progress above 0.
    const def = Castle.getCastle("misthalin", store);
    def.fortTier = 1; // 10 defense
    // Attacker: 1M investment = 10 power vs 10 defense → ratio 1.0 → +3/tick
    const r = Siege.declareSiege("asgarnia", "misthalin", 1_000_000, store);
    assert.equal(r.ok, true);
    r.siege.ticksElapsed = Siege.SIEGE_MAX_TICKS - 1;
    r.siege.progress = 50;
    forceTickReady(r.siege);
    const t = Siege.tickSiege("misthalin", store);
    assert.equal(t.ok, true);
    assert.equal(t.outcome, "stalemate");
    assert.equal(t.siege.status, "stalemate");
  });

  it("refuses to tick too soon", () => {
    fundedCastle("asgarnia", store, 5_000_000);
    fundedCastle("misthalin", store);
    const r = Siege.declareSiege("asgarnia", "misthalin", 0, store);
    assert.equal(r.ok, true);
    // Don't rewind lastTickAt — too soon
    const t = Siege.tickSiege("misthalin", store);
    assert.equal(t.ok, false);
    assert.equal(t.reason, "too-soon");
  });
});

describe("defense actions", () => {
  let store;
  beforeEach(() => { store = mockStore(); });

  it("sally forth reduces progress and costs funds", () => {
    fundedCastle("asgarnia", store, 50_000_000);
    fundedCastle("misthalin", store, 5_000_000);
    const r = Siege.declareSiege("asgarnia", "misthalin", 10_000_000, store);
    assert.equal(r.ok, true);
    r.siege.progress = 50;
    const before = Castle.getCastle("misthalin", store).warChest;
    const s = Siege.sallyForth("misthalin", store);
    assert.equal(s.ok, true);
    assert.equal(s.progress, 50 - Siege.SALLY_PROGRESS_HIT);
    assert.equal(
      Castle.getCastle("misthalin", store).warChest,
      before - Siege.SALLY_COST
    );
  });

  it("sally has a cooldown", () => {
    fundedCastle("asgarnia", store, 50_000_000);
    fundedCastle("misthalin", store, 5_000_000);
    const r = Siege.declareSiege("asgarnia", "misthalin", 10_000_000, store);
    r.siege.progress = 50;
    const s1 = Siege.sallyForth("misthalin", store);
    assert.equal(s1.ok, true);
    const s2 = Siege.sallyForth("misthalin", store);
    assert.equal(s2.ok, false);
    assert.equal(s2.reason, "sally-on-cooldown");
  });

  it("sally fails without funds", () => {
    fundedCastle("asgarnia", store, 50_000_000);
    // Defender has just enough for declare but we drain it
    fundedCastle("misthalin", store, 100_000);
    const r = Siege.declareSiege("asgarnia", "misthalin", 10_000_000, store);
    r.siege.progress = 50;
    const s = Siege.sallyForth("misthalin", store);
    assert.equal(s.ok, false);
    assert.equal(s.reason, "insufficient-funds");
  });

  it("repair walls reduces progress", () => {
    fundedCastle("asgarnia", store, 50_000_000);
    fundedCastle("misthalin", store, 5_000_000);
    const r = Siege.declareSiege("asgarnia", "misthalin", 10_000_000, store);
    r.siege.progress = 40;
    const before = Castle.getCastle("misthalin", store).warChest;
    const rp = Siege.repairWalls("misthalin", store);
    assert.equal(rp.ok, true);
    assert.equal(rp.progress, 40 - Siege.REPAIR_PROGRESS_HIT);
    assert.equal(
      Castle.getCastle("misthalin", store).warChest,
      before - Siege.REPAIR_COST
    );
  });

  it("defense actions fail without an active siege", () => {
    fundedCastle("misthalin", store, 5_000_000);
    assert.equal(Siege.sallyForth("misthalin", store).ok, false);
    assert.equal(Siege.repairWalls("misthalin", store).ok, false);
  });
});

describe("lift siege", () => {
  let store;
  beforeEach(() => { store = mockStore(); });

  it("attacker can lift their siege", () => {
    fundedCastle("asgarnia", store, 5_000_000);
    fundedCastle("misthalin", store);
    Siege.declareSiege("asgarnia", "misthalin", 0, store);
    const r = Siege.liftSiege("asgarnia", "misthalin", store);
    assert.equal(r.ok, true);
    assert.equal(Siege.getSiege("misthalin", store).status, "lifted");
  });

  it("non-attacker cannot lift", () => {
    fundedCastle("asgarnia", store, 5_000_000);
    fundedCastle("kandarin", store, 5_000_000);
    fundedCastle("misthalin", store);
    Siege.declareSiege("asgarnia", "misthalin", 0, store);
    const r = Siege.liftSiege("kandarin", "misthalin", store);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "not-your-siege");
  });
});

describe("queries", () => {
  let store;
  beforeEach(() => { store = mockStore(); });

  it("getSiege returns null when none exists", () => {
    assert.equal(Siege.getSiege("misthalin", store), null);
  });

  it("getSiegesByAttacker lists attacker's sieges", () => {
    fundedCastle("asgarnia", store, 10_000_000);
    fundedCastle("misthalin", store);
    fundedCastle("kandarin", store);
    // Declare on misthalin, lift it (ends cooldown-free for test), then kandarin
    Siege.declareSiege("asgarnia", "misthalin", 0, store);
    Siege.liftSiege("asgarnia", "misthalin", store);
    // Cooldown blocks immediate re-declare on misthalin; kandarin is fine
    const r = Siege.declareSiege("asgarnia", "kandarin", 0, store);
    assert.equal(r.ok, true);
    const list = Siege.getSiegesByAttacker("asgarnia", store);
    assert.equal(list.length, 2);
  });
});
