"use strict";

/**
 * WarSupply unit checks — war demands, consumption, morale, and delivery
 * routing. All functions take the passed store (mockable).
 */
const assert = require("node:assert/strict");
const { describe, it, beforeEach } = require("node:test");

const WarSupply = require("./WarSupply.Kingdoms");

function mockStore() {
  const kingdoms = {
    asgarnia: { id: "asgarnia", name: "Asgarnia", capital: "Falador", flags: {}, treasury: 1_000_000 },
    misthalin: { id: "misthalin", name: "Misthalin", capital: "Varrock", flags: {}, treasury: 1_000_000 },
  };
  const state = { sieges: {} };
  return {
    load: () => state,
    save: () => {},
    getKingdom: (id) => kingdoms[id] ?? null,
    setFlag: (id, key, value) => {
      if (!kingdoms[id]) return;
      if (!kingdoms[id].flags) kingdoms[id].flags = {};
      kingdoms[id].flags[key] = value;
    },
    _kingdoms: () => kingdoms,
    _state: () => state,
  };
}

function activeWar(attackerId, defenderId) {
  return { attackerId, defenderId, active: true, goal: "loot", declaredAt: Date.now() };
}

describe("WarSupply", () => {
  let store;
  beforeEach(() => {
    store = mockStore();
  });

  it("generates demands for both belligerents when war breaks out", () => {
    const wars = [activeWar("asgarnia", "misthalin")];
    const atkDemands = WarSupply.ensureDemands("asgarnia", wars, store);
    const defDemands = WarSupply.ensureDemands("misthalin", wars, store);
    assert.equal(atkDemands.length, 1);
    assert.equal(defDemands.length, 1);
    assert.equal(atkDemands[0].role, "attacker");
    assert.equal(defDemands[0].role, "defender");
    // Attackers want more arrows/runes/materials; defenders want more food.
    assert.ok(atkDemands[0].categories.arrows.quota > defDemands[0].categories.arrows.quota);
    assert.ok(defDemands[0].categories.food.quota > atkDemands[0].categories.food.quota);
    assert.ok(defDemands[0].categories.materials.quota > atkDemands[0].categories.materials.quota);
    // Armies march with some supplies (50% seed).
    for (const cat of WarSupply.CATEGORIES) {
      const c = atkDemands[0].categories[cat];
      assert.ok(c.stock > 0 && c.stock < c.quota, cat);
    }
  });

  it("morale is 1 when no demand exists, and scales with fulfillment", () => {
    const key = WarSupply.warKeyFor("asgarnia", "misthalin");
    assert.equal(WarSupply.moraleOf("asgarnia", key, store), 1);
    WarSupply.ensureDemands("asgarnia", [activeWar("asgarnia", "misthalin")], store);
    // Top every category to full, then morale should peak.
    for (const cat of WarSupply.CATEGORIES) {
      const route = WarSupply.routeDelivery("asgarnia", cat, store);
      if (route) WarSupply.addStock("asgarnia", route.warKey, cat, route.remaining, store);
    }
    const full = WarSupply.moraleOf("asgarnia", key, store);
    assert.ok(full > 1 && full <= 1.15, `full morale ${full}`);
    // Drain everything: starving.
    for (let i = 0; i < 200; i++) WarSupply.consumeTick("asgarnia", store);
    const starved = WarSupply.moraleOf("asgarnia", key, store);
    assert.ok(Math.abs(starved - WarSupply.MORALE_MIN) < 0.001, `starved morale ${starved}`);
  });

  it("consumption burns food fastest and announces shortages", () => {
    WarSupply.ensureDemands("asgarnia", [activeWar("asgarnia", "misthalin")], store);
    const before = WarSupply.supplyStatus("asgarnia", store)[0];
    const foodBefore = before.categories.find((c) => c.cat === "food").stock;
    const matBefore = before.categories.find((c) => c.cat === "materials").stock;
    WarSupply.consumeTick("asgarnia", store);
    const after = WarSupply.supplyStatus("asgarnia", store)[0];
    const foodAfter = after.categories.find((c) => c.cat === "food").stock;
    const matAfter = after.categories.find((c) => c.cat === "materials").stock;
    assert.equal(foodBefore - foodAfter, WarSupply.CONSUME_PER_TICK.food);
    assert.equal(matBefore - matAfter, WarSupply.CONSUME_PER_TICK.materials);
    assert.ok(foodBefore - foodAfter > matBefore - matAfter);
  });

  it("retires demands when the war ends", () => {
    WarSupply.ensureDemands("asgarnia", [activeWar("asgarnia", "misthalin")], store);
    assert.equal(WarSupply.supplyStatus("asgarnia", store).length, 1);
    WarSupply.ensureDemands("asgarnia", [], store);
    assert.equal(WarSupply.supplyStatus("asgarnia", store).length, 0);
  });

  it("routes deliveries to the hungriest unfilled category and caps at quota", () => {
    WarSupply.ensureDemands("asgarnia", [activeWar("asgarnia", "misthalin")], store);
    const route = WarSupply.routeDelivery("asgarnia", "arrows", store);
    assert.ok(route, "expected a route for arrows");
    assert.ok(route.remaining > 0);
    // Overfill attempt: only quota-room is credited.
    const credited = WarSupply.addStock("asgarnia", route.warKey, "arrows", route.remaining + 5000, store);
    assert.equal(credited, route.remaining);
    const after = WarSupply.supplyStatus("asgarnia", store)[0];
    const arrows = after.categories.find((c) => c.cat === "arrows");
    assert.equal(arrows.stock, arrows.quota);
    // Full category no longer routes.
    assert.equal(WarSupply.routeDelivery("asgarnia", "arrows", store), null);
  });

  it("no route when at peace", () => {
    assert.equal(WarSupply.routeDelivery("asgarnia", "food", store), null);
    assert.deepEqual(WarSupply.supplyStatus("asgarnia", store), []);
  });

  it("siege without declared war raises smaller raid demands", () => {
    store._state().sieges = {
      misthalin: {
        attackerKingdomId: "asgarnia",
        defenderKingdomId: "misthalin",
        status: "active",
        progress: 10,
      },
    };
    const atkDemands = WarSupply.ensureDemands("asgarnia", [], store);
    assert.equal(atkDemands.length, 1);
    assert.equal(atkDemands[0].raid, true);
    assert.equal(atkDemands[0].role, "attacker");
    // Raid quotas are smaller than full-war attacker quotas.
    assert.ok(atkDemands[0].categories.food.quota < WarSupply.ATTACKER_QUOTA.food);
  });

  it("supplyStatus reports morale labels and per-category pct", () => {
    WarSupply.ensureDemands("misthalin", [activeWar("asgarnia", "misthalin")], store);
    const [d] = WarSupply.supplyStatus("misthalin", store);
    assert.equal(d.foeName, "Asgarnia");
    assert.equal(d.role, "defender");
    assert.ok(typeof d.moraleLabel === "string" && d.moraleLabel.length > 0);
    assert.equal(d.categories.length, 4);
    for (const c of d.categories) {
      assert.ok(c.pct >= 0 && c.pct <= 100, `${c.cat} pct ${c.pct}`);
      assert.ok(c.stock <= c.quota);
    }
  });

  it("morale labels degrade as stock drains", () => {
    WarSupply.ensureDemands("asgarnia", [activeWar("asgarnia", "misthalin")], store);
    const fresh = WarSupply.moraleLabel(WarSupply.moraleOf("asgarnia", WarSupply.warKeyFor("asgarnia", "misthalin"), store));
    for (let i = 0; i < 200; i++) WarSupply.consumeTick("asgarnia", store);
    const starved = WarSupply.moraleLabel(WarSupply.moraleOf("asgarnia", WarSupply.warKeyFor("asgarnia", "misthalin"), store));
    assert.notEqual(fresh, starved);
    assert.equal(starved, "Starving");
  });

  it("warKeyFor is order-independent", () => {
    assert.equal(WarSupply.warKeyFor("b", "a"), WarSupply.warKeyFor("a", "b"));
  });
});
