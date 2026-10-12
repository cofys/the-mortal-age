"use strict";

/**
 * CitizenWarContributions checks — wartime surplus feeds the war machine.
 *
 * Uses the real KingdomStore (resetForTests, persist=false), the real
 * WarSupply demands, and the real OfficeTools.deliverSupplies — the same
 * quartermaster path players use. Verified end to end: items leave the
 * citizen's bank, war stock grows (origin-tagged), the treasury pays real
 * coins, and nothing is minted or lost.
 */
const assert = require("node:assert/strict");
const { describe, it, beforeEach } = require("node:test");
const Module = require("node:module");

// Tension.Kingdoms requires the TS Task class; stub it for plain node
// (same pattern as WarSupply.delivery.test.js).
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "../../src/main/typescript/elvarg/game/task/Task") {
    return { Task: class Task {} };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const Manifest = require("./SurplusManifest");
const { tickWarContributions, attemptContribution } = require("./CitizenWarContributions");
const Store = require("../../kingdoms/KingdomStore");
const WarSupply = require("../../kingdoms/WarSupply.Kingdoms");
const CitizenEvents = require("../CitizenEvents");
const { ATTR_KINGDOM_ID } = require("../constants");

const KINGDOM_ID = "asgarnia";
const FOE_ID = "misthalin";
const LOGS = 1511;

function mockContainer(amounts = {}) {
  const m = { ...amounts };
  return {
    getAmount: (id) => m[id] ?? 0,
    deleteNumber: (id, n) => {
      m[id] = Math.max(0, (m[id] ?? 0) - n);
    },
    delete: (id, n) => {
      m[id] = Math.max(0, (m[id] ?? 0) - n);
    },
    adds: (id, n) => {
      m[id] = (m[id] ?? 0) + n;
    },
    refreshItems: () => {},
    getFreeSlots: () => 27,
    _m: m,
  };
}

function citizenBot(bankAmounts, kingdomId = KINGDOM_ID) {
  const attrs = { [ATTR_KINGDOM_ID]: kingdomId };
  const bank = mockContainer(bankAmounts);
  const inv = mockContainer({});
  return {
    getBank: (tab) => (tab === 0 ? bank : null),
    getInventory: () => inv,
    getAttribute: (k) => attrs[k] ?? null,
    setAttribute: (k, v) => {
      attrs[k] = v;
    },
    getUsername: () => "ChopperCid",
    isPlayerBot: () => true,
    getLocalPlayers: () => [],
    getCombat: () => ({ isInCombat: () => false }),
    sendMessage: () => {},
    _bank: bank,
    _inv: inv,
  };
}

function activeWar() {
  return { attackerId: KINGDOM_ID, defenderId: FOE_ID, active: true, goal: "loot", declaredAt: Date.now() };
}

function materialsOf(kingdomId) {
  const [d] = WarSupply.supplyStatus(kingdomId, Store);
  return d.categories.find((c) => c.cat === "materials");
}

describe("CitizenWarContributions", () => {
  beforeEach(() => {
    Manifest._resetManifest();
    Store.resetForTests();
    Store.upsertKingdom({ id: KINGDOM_ID, name: "Asgarnia", capital: "Falador" });
    Store.upsertKingdom({ id: FOE_ID, name: "Misthalin", capital: "Varrock" });
    const k = Store.getKingdom(KINGDOM_ID);
    k.treasury = 1_000_000;
    k.flags = {};
    WarSupply.ensureDemands(KINGDOM_ID, [activeWar()], Store);
    CitizenEvents.onWarDeclared({ attackerId: KINGDOM_ID, defenderId: FOE_ID });
  });

  it("delivers banked timber surplus to the war effort for real coins", () => {
    const bot = citizenBot({ [LOGS]: 40 }); // 32 surplus logs
    const treasuryBefore = Store.getKingdom(KINGDOM_ID).treasury;
    const stockBefore = materialsOf(KINGDOM_ID).stock;

    // Materials demand: quota 150 (attacker), seeded 75 -> 75 units wanted.
    // 18 logs x 4 units = 72 units x 3c wartime rate = 216c.
    const paid = attemptContribution(bot, { username: "ChopperCid" }, KINGDOM_ID, () => 0);

    assert.equal(paid, 216);
    assert.equal(bot._bank.getAmount(LOGS), 22); // 18 hauled, reserve 8 kept
    assert.equal(bot._inv.getAmount(LOGS), 0); // delivered, not lingering
    assert.equal(bot._inv.getAmount(995), 216); // treasury paid the citizen
    assert.equal(Store.getKingdom(KINGDOM_ID).treasury, treasuryBefore - 216);
    assert.equal(materialsOf(KINGDOM_ID).stock, stockBefore + 72);
    // Origin-tagged for the future export design.
    const origins = materialsOf(KINGDOM_ID).origins ?? {};
    assert.equal(origins[KINGDOM_ID], 72);
    const [m] = Manifest.recentMovements(1);
    assert.equal(m.kind, "war-delivery");
    assert.equal(m.originKingdom, KINGDOM_ID);
    assert.equal(m.buyer, `quartermaster:${KINGDOM_ID}`);
    assert.equal(m.coins, 216);
  });

  it("does nothing in peacetime", () => {
    // kandarin has no declared war in this test's event feed.
    const bot = citizenBot({ [LOGS]: 40 }, "kandarin");
    const director = {
      roster: new Map([["ChopperCid", { username: "ChopperCid", kingdomId: "kandarin", _bot: bot }]]),
      isOnline: () => true,
      getBot: (r) => r._bot,
    };
    // kandarin was never declared at war in this test's event feed.
    const delivered = tickWarContributions(director, 12);
    assert.equal(delivered, 0);
    assert.equal(bot._bank.getAmount(LOGS), 40);
    assert.equal(Manifest.recentMovements(10).length, 0);
  });

  it("never overfills the demand and loses nothing when the coffers are empty", () => {
    Store.getKingdom(KINGDOM_ID).treasury = 100; // can't cover 216c
    const bot = citizenBot({ [LOGS]: 40 });
    const stockBefore = materialsOf(KINGDOM_ID).stock;

    const paid = attemptContribution(bot, { username: "ChopperCid" }, KINGDOM_ID, () => 0);

    assert.equal(paid, 0);
    assert.equal(Store.getKingdom(KINGDOM_ID).treasury, 100);
    assert.equal(materialsOf(KINGDOM_ID).stock, stockBefore);
    // Conservation: every log is still somewhere real (bank + pack).
    const total = bot._bank.getAmount(LOGS) + bot._inv.getAmount(LOGS);
    assert.equal(total, 40);
    assert.equal(bot._inv.getAmount(995), 0);
  });

  it("caps the haul at what the demand still wants", () => {
    // Fill the materials demand to 1 unit of room, then contribute.
    const key = WarSupply.warKeyFor(KINGDOM_ID, FOE_ID);
    WarSupply.addStock(KINGDOM_ID, key, "materials", 74, Store); // stock 149/150
    const bot = citizenBot({ [LOGS]: 40 });
    const paid = attemptContribution(bot, { username: "ChopperCid" }, KINGDOM_ID, () => 0);
    // 1 unit of room -> no whole log fits (4 units each) -> no delivery.
    assert.equal(paid, 0);
    assert.equal(bot._bank.getAmount(LOGS), 40);
    assert.equal(materialsOf(KINGDOM_ID).stock, 149);
  });
});
