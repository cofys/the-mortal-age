"use strict";

/**
 * Diplomacy checks for the 2026-10-11 design: the goodwill ladder,
 * marriage glue, daily drift, treaty teeth (NAP + trade rights), and
 * espionage (real intel + sabotage with war-treason consequences).
 */
const assert = require("node:assert/strict");
const { describe, it, beforeEach } = require("node:test");

const Relations = require("./Relations.Kingdoms");
const Wars = require("./Wars.Kingdoms");
const WarSupply = require("./WarSupply.Kingdoms");
const Espionage = require("./Espionage.Kingdoms");

function mockStore() {
  const state = {
    kingdoms: {
      asgarnia: { id: "asgarnia", name: "Asgarnia", treasury: 0, flags: {} },
      misthalin: { id: "misthalin", name: "Misthalin", treasury: 0, flags: {} },
    },
    castles: {
      asgarnia: { warChest: 3000000, fortTier: 2, buildings: {} },
      misthalin: { warChest: 3000000, fortTier: 1, buildings: {} },
    },
    wars: [],
    tension: {},
    goodwill: {},
  };
  return {
    load: () => state,
    save: () => {},
    getKingdom: (id) => state.kingdoms[id] ?? null,
    setFlag: (id, key, value) => {
      if (state.kingdoms[id]) state.kingdoms[id].flags[key] = value;
    },
    _state: () => state,
  };
}

function mockPlayer(influencePoints) {
  const attrs = new Map();
  if (influencePoints != null) {
    attrs.set("kingdom:influence", {
      asgarnia: { points: influencePoints, lastEarned: Date.now() },
      misthalin: { points: influencePoints, lastEarned: Date.now() },
    });
  }
  return {
    username: "diplomat",
    getUsername() { return "diplomat"; },
    getAttribute(k) { return attrs.get(k); },
    setAttribute(k, v) { attrs.set(k, v); },
    _attrs: attrs,
  };
}

describe("goodwill ladder", () => {
  let store;
  beforeEach(() => {
    store = mockStore();
  });

  it("walks the rungs as goodwill moves", () => {
    assert.equal(Relations.relationOf("asgarnia", "misthalin", store), "neutral");
    Relations.addGoodwill("asgarnia", "misthalin", 25, store);
    assert.equal(Relations.relationOf("asgarnia", "misthalin", store), "cordial");
    Relations.addGoodwill("asgarnia", "misthalin", 40, store);
    assert.equal(Relations.relationOf("asgarnia", "misthalin", store), "friendly");
    Relations.addGoodwill("asgarnia", "misthalin", -90, store);
    assert.equal(Relations.relationOf("asgarnia", "misthalin", store), "tense");
    Relations.addGoodwill("asgarnia", "misthalin", -50, store);
    assert.equal(Relations.relationOf("asgarnia", "misthalin", store), "hostile");
  });

  it("hot tension reads hostile regardless of goodwill", () => {
    Relations.addGoodwill("asgarnia", "misthalin", 80, store);
    store.load().tension["asgarnia:misthalin"] = 75;
    assert.equal(Relations.relationOf("asgarnia", "misthalin", store), "hostile");
  });

  it("a siege needs tense or worse now", () => {
    assert.equal(Relations.canSiegeRelation("asgarnia", "misthalin", store).ok, false);
    Relations.addGoodwill("asgarnia", "misthalin", -30, store);
    assert.equal(Relations.relationOf("asgarnia", "misthalin", store), "tense");
    assert.equal(Relations.canSiegeRelation("asgarnia", "misthalin", store).ok, true);
  });

  it("marriage glue: goodwill cannot fall below neutral while bonded", () => {
    store.load().kingdoms.asgarnia.flags["royals:marriage-bond:misthalin"] = true;
    store.load().kingdoms.misthalin.flags["royals:marriage-bond:asgarnia"] = true;
    Relations.addGoodwill("asgarnia", "misthalin", -80, store);
    assert.equal(Relations.goodwillOf("asgarnia", "misthalin", store), 0);
    assert.equal(Relations.relationOf("asgarnia", "misthalin", store), "neutral");
  });

  it("drift steps toward neutral once a day, and only once", () => {
    Relations.addGoodwill("asgarnia", "misthalin", 30, store);
    const now = Date.now();
    assert.equal(Relations.driftGoodwill(store, now), 1);
    assert.equal(Relations.goodwillOf("asgarnia", "misthalin", store), 29);
    assert.equal(Relations.driftGoodwill(store, now + 1000), 0); // gated
    assert.equal(Relations.goodwillOf("asgarnia", "misthalin", store), 29);
  });

  it("trade-rights pairs warm under drift instead of cooling", () => {
    store.load().tradeRights = { "asgarnia:misthalin": true };
    Relations.addGoodwill("asgarnia", "misthalin", 10, store);
    Relations.driftGoodwill(store, Date.now());
    assert.equal(Relations.goodwillOf("asgarnia", "misthalin", store), 12);
    assert.equal(Relations.hasTradeRights("asgarnia", "misthalin", store), true);
  });

  it("envoys and ultimatums move goodwill, not just tension", () => {
    const player = mockPlayer(1000);
    store.load().tension["asgarnia:misthalin"] = 70; // hostile border
    const env = Relations.sendEnvoy(player, "asgarnia", "misthalin", store);
    assert.equal(env.ok, true);
    assert.equal(env.goodwill, Relations.GOODWILL_ENVOY);
    const ult = Relations.issueUltimatum(player, "asgarnia", "misthalin", store);
    assert.equal(ult.ok, true);
    assert.equal(ult.goodwill, Relations.GOODWILL_ENVOY + Relations.GOODWILL_ULTIMATUM);
  });
});

describe("treaty teeth", () => {
  let store;
  beforeEach(() => {
    store = mockStore();
    const state = store.load();
    state.wars.push({
      attackerId: "asgarnia",
      defenderId: "misthalin",
      goal: "loot",
      active: true,
      declaredAt: Date.now(),
      score: { attacker: 0, defender: 0 },
    });
  });

  it("a nap treaty blocks re-declaration until it lapses", () => {
    const player = mockPlayer(1000);
    const offer = Wars.offerPeace(player, "asgarnia", "misthalin", { type: "nap", days: 14 }, store);
    assert.equal(offer.ok, true);
    const accept = Wars.acceptPeace(player, "misthalin", "asgarnia", store);
    assert.equal(accept.ok, true);
    assert.equal(accept.applied.napDays, 14);
    assert.equal(Wars.napActive("asgarnia", "misthalin", store), true);
    const gate = Wars.canDeclareWar("asgarnia", "misthalin", store);
    assert.equal(gate.ok, false);
    assert.equal(gate.reason, "nap-active");
  });

  it("trade-rights terms are recorded on acceptance", () => {
    const player = mockPlayer(1000);
    Wars.offerPeace(player, "asgarnia", "misthalin", { type: "trade-rights" }, store);
    const accept = Wars.acceptPeace(player, "misthalin", "asgarnia", store);
    assert.equal(accept.applied.tradeRights, true);
    assert.equal(store.load().tradeRights["asgarnia:misthalin"], true);
  });

  it("nap days are clamped to the treaty maximum", () => {
    const player = mockPlayer(1000);
    const offer = Wars.offerPeace(player, "asgarnia", "misthalin", { type: "nap", days: 400 }, store);
    assert.equal(offer.offer.terms.days, Wars.NAP_MAX_DAYS);
  });
});

describe("espionage", () => {
  let store;
  beforeEach(() => {
    store = mockStore();
    const state = store.load();
    state.wars.push({
      attackerId: "asgarnia",
      defenderId: "misthalin",
      goal: "loot",
      active: true,
      declaredAt: Date.now(),
      score: { attacker: 0, defender: 0 },
    });
    // A live supply demand for misthalin in this war.
    WarSupply.ensureDemands("misthalin", state.wars, store);
  });

  it("intel reads real state for enemies only", () => {
    const intel = Espionage.intelFor("asgarnia", store);
    assert.ok(intel.misthalin);
    assert.equal(typeof intel.misthalin.garrison, "number");
    assert.equal(intel.misthalin.fortTier, 1);
    assert.equal(typeof intel.misthalin.morale, "number");
  });

  it("sabotage burns real stock from the fullest category", () => {
    const key = WarSupply.warKeyFor("asgarnia", "misthalin");
    const totalStock = () =>
      WarSupply.supplyStatus("misthalin", store)
        .find((w) => w.warKey === key)
        .categories.reduce((s, c) => s + c.stock, 0);
    const totalBefore = totalStock();
    const r = Espionage.sabotage(null, "asgarnia", "misthalin", store, () => 0.99);
    assert.equal(r.ok, true);
    assert.equal(r.caught, false);
    assert.ok(r.removed > 0);
    assert.equal(totalBefore - totalStock(), r.removed);
  });

  it("a caught saboteur takes war-treason hatred and chills goodwill", () => {
    const player = mockPlayer(100);
    player.username = "spy";
    const r = Espionage.sabotage(player, "asgarnia", "misthalin", store, () => 0.0);
    assert.equal(r.ok, true);
    assert.equal(r.caught, true);
    const rec = player._attrs.get("kingdom:influence")?.misthalin;
    assert.ok(rec && rec.points < 100);
    assert.equal(rec.lastReason, "war-treason");
    assert.equal(Relations.goodwillOf("asgarnia", "misthalin", store), Relations.GOODWILL_CRIME);
  });

  it("you cannot sabotage a friend", () => {
    store.load().wars = [];
    const r = Espionage.sabotage(null, "asgarnia", "misthalin", store, () => 0.99);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "not-an-enemy");
  });
});
