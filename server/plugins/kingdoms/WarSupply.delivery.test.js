"use strict";

/**
 * WarSupply delivery integration — the full player loop:
 * war -> demands -> player delivers real items -> treasury pays real
 * coins + influence lands -> morale recovers.
 *
 * Uses the real KingdomStore with resetForTests() (persist=false: no
 * save file is written) and the Module._load Task stub, following the
 * OfficeDashboardApi.test.js pattern.
 */
const assert = require("node:assert/strict");
const { describe, it, beforeEach } = require("node:test");
const path = require("node:path");
const Module = require("node:module");

// Tension.Kingdoms requires the TS Task class; stub it for plain node.
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "../../src/main/typescript/elvarg/game/task/Task") {
    return { Task: class Task {} };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const Store = require("./KingdomStore");
const Membership = require("./Membership.Kingdoms");
const OfficeTools = require("./OfficeTools.Kingdoms");
const WarSupply = require("./WarSupply.Kingdoms");

const KINGDOM_ID = "asgarnia";
const FOE_ID = "misthalin";

function mockPlayer() {
  const attrs = {};
  const inv = { 886: 100, 2309: 50 }; // steel arrows, bread
  let coins = 0;
  return {
    getAttribute: (k) => (k === Membership.KINGDOM_ID_ATTRIBUTE ? KINGDOM_ID : attrs[k] ?? null),
    setAttribute: (k, v) => { attrs[k] = v; },
    getUsername: () => "SupplyTester",
    isPlayerBot: () => false,
    getInventory: () => ({
      getAmount: (id) => inv[id] ?? 0,
      delete: (id, n) => { inv[id] = Math.max(0, (inv[id] ?? 0) - n); },
      refreshItems: () => {},
      adds: (id, n) => { if (id === 995) coins += n; },
    }),
    sendMessage: () => {},
    _coins: () => coins,
    _inv: () => inv,
    _attrs: () => attrs,
  };
}

function activeWar() {
  return { attackerId: KINGDOM_ID, defenderId: FOE_ID, active: true, goal: "loot", declaredAt: Date.now() };
}

describe("WarSupply player delivery loop", () => {
  beforeEach(() => {
    Store.resetForTests();
    Store.upsertKingdom({ id: KINGDOM_ID, name: "Asgarnia", capital: "Falador" });
    Store.upsertKingdom({ id: FOE_ID, name: "Misthalin", capital: "Varrock" });
    const k = Store.getKingdom(KINGDOM_ID);
    k.treasury = 1_000_000;
    k.flags = {};
  });

  it("war generates demands; delivery pays coins and grants influence", () => {
    WarSupply.ensureDemands(KINGDOM_ID, [activeWar()], Store);
    const player = mockPlayer();
    const treasuryBefore = Store.getKingdom(KINGDOM_ID).treasury;

    // Deliver 50 steel arrows (5 units each = 250 units) against the arrows demand.
    // The demand only has room for 125 more units (quota 250, seeded 125),
    // so the delivery caps at 25 arrows — the cap is the point.
    const res = OfficeTools.deliverSupplies(player, KINGDOM_ID, 886, 50);
    assert.ok(res.ok, res.message);
    assert.match(res.message, /for 375c/); // 125 units x 3c wartime rate
    assert.match(res.message, /influence/);

    // Coins left the treasury and reached the player.
    const paid = treasuryBefore - Store.getKingdom(KINGDOM_ID).treasury;
    assert.equal(paid, 375);
    assert.equal(player._coins(), 375);
    // Items left the inventory.
    assert.equal(player._inv()[886], 75);
    // Influence landed on the player record.
    const inf = player._attrs()["kingdom:influence"];
    assert.ok(inf && inf[KINGDOM_ID] && inf[KINGDOM_ID].points > 0, "expected influence points");
    // The demand stock grew to exactly quota.
    const [d] = WarSupply.supplyStatus(KINGDOM_ID, Store);
    const arrows = d.categories.find((c) => c.cat === "arrows");
    assert.equal(arrows.stock, arrows.quota);
  });

  it("undersupply drops morale; resupply restores it", () => {
    WarSupply.ensureDemands(KINGDOM_ID, [activeWar()], Store);
    const key = WarSupply.warKeyFor(KINGDOM_ID, FOE_ID);
    const fresh = WarSupply.moraleOf(KINGDOM_ID, key, Store);
    assert.ok(fresh > 0.8, `fresh morale ${fresh}`);

    // Starve the army.
    for (let i = 0; i < 200; i++) WarSupply.consumeTick(KINGDOM_ID, Store);
    const starved = WarSupply.moraleOf(KINGDOM_ID, key, Store);
    assert.ok(starved < fresh, `starved ${starved} should be < fresh ${fresh}`);
    assert.ok(starved <= 0.7, `starved morale ${starved}`);

    // A bread convoy arrives.
    const player = mockPlayer();
    const res = OfficeTools.deliverSupplies(player, KINGDOM_ID, 2309, 50);
    assert.ok(res.ok, res.message);
    const recovered = WarSupply.moraleOf(KINGDOM_ID, key, Store);
    assert.ok(recovered > starved, `recovered ${recovered} should beat starved ${starved}`);
  });

  it("delivery caps at quota — no overfill, no overpay", () => {
    WarSupply.ensureDemands(KINGDOM_ID, [activeWar()], Store);
    const [d0] = WarSupply.supplyStatus(KINGDOM_ID, Store);
    const quota = d0.categories.find((c) => c.cat === "food").quota;
    const player = mockPlayer();
    player._inv()[2309] = 100000;
    const treasuryBefore = Store.getKingdom(KINGDOM_ID).treasury;
    const res = OfficeTools.deliverSupplies(player, KINGDOM_ID, 2309, 100000);
    assert.ok(res.ok, res.message);
    const [d] = WarSupply.supplyStatus(KINGDOM_ID, Store);
    const food = d.categories.find((c) => c.cat === "food");
    assert.ok(food.stock <= quota, `stock ${food.stock} <= quota ${quota}`);
    const paid = treasuryBefore - Store.getKingdom(KINGDOM_ID).treasury;
    assert.ok(paid <= quota * 3, `paid ${paid} bounded by quota ${quota}`);
  });

  it("non-members cannot supply the war effort", () => {
    WarSupply.ensureDemands(KINGDOM_ID, [activeWar()], Store);
    const player = mockPlayer();
    player.getAttribute = () => null; // no kingdom
    const res = OfficeTools.deliverSupplies(player, KINGDOM_ID, 886, 10);
    assert.equal(res.ok, false);
    assert.match(res.message, /must serve/);
  });

  it("peacetime with no order refuses deliveries", () => {
    const player = mockPlayer();
    const res = OfficeTools.deliverSupplies(player, KINGDOM_ID, 886, 10);
    assert.equal(res.ok, false);
    assert.match(res.message, /seeks no supplies/);
  });
});
