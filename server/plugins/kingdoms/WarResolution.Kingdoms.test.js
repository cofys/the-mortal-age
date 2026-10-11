"use strict";

/**
 * WarResolution unit checks — the war spine: score from real fighting,
 * goal-shaped consequences, surrender, decisive margins, white peace.
 * All functions take the passed store (mockable).
 */
const assert = require("node:assert/strict");
const { describe, it, beforeEach } = require("node:test");

const WarResolution = require("./WarResolution.Kingdoms");
const Wars = require("./Wars.Kingdoms");

function mockStore() {
  const state = {
    kingdoms: {
      asgarnia: { id: "asgarnia", name: "Asgarnia", treasury: 100000 },
      misthalin: { id: "misthalin", name: "Misthalin", treasury: 100000 },
    },
    castles: {
      asgarnia: { warChest: 1000000, fortTier: 2, buildings: {} },
      misthalin: { warChest: 400000, fortTier: 1, buildings: {} },
    },
    wars: [],
    tension: {},
  };
  return {
    load: () => state,
    save: () => {},
    _state: () => state,
  };
}

function addWar(store, goal = "loot") {
  const state = store.load();
  const war = {
    attackerId: "asgarnia",
    defenderId: "misthalin",
    goal,
    declaredBy: "tester",
    reason: "test war",
    active: true,
    declaredAt: Date.now(),
    endedAt: null,
    outcome: null,
    resolveAt: Date.now() + 7 * 24 * 3600 * 1000,
    score: { attacker: 0, defender: 0 },
  };
  state.wars.push(war);
  return war;
}

describe("war score", () => {
  let store;
  beforeEach(() => {
    store = mockStore();
    addWar(store);
  });

  it("adds points to the scoring side only", () => {
    WarResolution.addWarScore("asgarnia", "misthalin", "asgarnia", 40, store);
    WarResolution.addWarScore("misthalin", "asgarnia", "misthalin", 25, store);
    const snap = WarResolution.warScoreBetween("asgarnia", "misthalin", store);
    assert.equal(snap.score.attacker, 40);
    assert.equal(snap.score.defender, 25);
    assert.equal(snap.leaderId, "asgarnia");
    assert.equal(snap.margin, 15);
  });

  it("returns null when no active war exists", () => {
    assert.equal(
      WarResolution.addWarScore("asgarnia", "kandarin", "asgarnia", 10, store),
      null
    );
  });
});

describe("resolveWar", () => {
  let store;
  beforeEach(() => {
    store = mockStore();
  });

  it("loot war: winner takes 25% reparations from the loser's war chest", () => {
    addWar(store, "loot");
    const r = WarResolution.resolveWar("asgarnia", "misthalin", "asgarnia", { reason: "expiry" }, store);
    assert.equal(r.ok, true);
    assert.equal(r.applied.reparations, 100000); // 25% of 400k
    const state = store.load();
    assert.equal(state.castles.misthalin.warChest, 300000);
    assert.equal(state.castles.asgarnia.warChest, 1100000);
    assert.equal(state.wars[0].active, false);
    assert.equal(state.wars[0].resolution.winnerId, "asgarnia");
    assert.equal(state.tension["asgarnia:misthalin"], 40);
  });

  it("reparations are capped at what the loser actually holds", () => {
    addWar(store, "loot");
    store.load().castles.misthalin.warChest = 0;
    const r = WarResolution.resolveWar("asgarnia", "misthalin", "asgarnia", {}, store);
    assert.equal(r.applied.reparations, 0);
    assert.equal(store.load().castles.asgarnia.warChest, 1000000);
  });

  it("vassalize war: the loser swears fealty", () => {
    addWar(store, "vassalize");
    const r = WarResolution.resolveWar("asgarnia", "misthalin", "asgarnia", {}, store);
    assert.equal(r.applied.vassalized, true);
    assert.equal(Wars.getVassalOverlord("misthalin", store), "asgarnia");
    // 15% standard reparations (not the loot rate).
    assert.equal(r.applied.reparations, 60000);
  });

  it("no winner + tied score = white peace: small drain, no reparations", () => {
    const war = addWar(store, "loot");
    war.score = { attacker: 30, defender: 25 };
    const r = WarResolution.resolveWar("asgarnia", "misthalin", null, { reason: "expiry" }, store);
    assert.equal(r.winnerId, null);
    assert.equal(r.applied.reparations, 0);
    const state = store.load();
    assert.equal(state.kingdoms.asgarnia.treasury, 95000); // 5% drain
    assert.equal(state.kingdoms.misthalin.treasury, 95000);
    assert.equal(state.tension["asgarnia:misthalin"], 25);
    assert.match(state.wars[0].outcome, /white peace/);
  });

  it("no winner + real margin = the score leader dictates", () => {
    const war = addWar(store, "territory");
    war.score = { attacker: 10, defender: 80 };
    const r = WarResolution.resolveWar("asgarnia", "misthalin", null, { reason: "expiry" }, store);
    assert.equal(r.winnerId, "misthalin");
    assert.equal(r.loserId, "asgarnia");
  });

  it("lifts active sieges and clears peace offers between the pair", () => {
    addWar(store, "loot");
    const state = store.load();
    state.sieges = {
      misthalin: { attackerKingdomId: "asgarnia", defenderKingdomId: "misthalin", status: "active" },
    };
    state.peaceOffers = [{ a: "asgarnia", b: "misthalin", offeredBy: "asgarnia", terms: { type: "white-peace" } }];
    WarResolution.resolveWar("asgarnia", "misthalin", "asgarnia", {}, store);
    assert.equal(state.sieges.misthalin.status, "lifted");
    assert.equal(state.peaceOffers.length, 0);
  });

  it("refuses when no active war exists", () => {
    assert.equal(
      WarResolution.resolveWar("asgarnia", "misthalin", "asgarnia", {}, store).reason,
      "not-at-war"
    );
  });
});

describe("surrender", () => {
  it("ends the war with the other side winning at surrender reparations", () => {
    const store = mockStore();
    addWar(store, "territory");
    const player = { username: "coward" };
    const r = WarResolution.surrender(player, "misthalin", "asgarnia", store);
    assert.equal(r.ok, true);
    assert.equal(r.winnerId, "asgarnia");
    assert.equal(r.applied.reparations, 100000); // 25% of misthalin's 400k
    assert.equal(store.load().wars[0].resolution.surrender, true);
  });
});

describe("decisive margin", () => {
  it("ends the war once the margin reaches the threshold", () => {
    const store = mockStore();
    addWar(store, "loot");
    WarResolution.addWarScore("asgarnia", "misthalin", "asgarnia", 99, store);
    assert.equal(WarResolution.checkDecisiveWar("asgarnia", "misthalin", store), null);
    WarResolution.addWarScore("asgarnia", "misthalin", "asgarnia", 1, store);
    const r = WarResolution.checkDecisiveWar("asgarnia", "misthalin", store);
    assert.equal(r.ok, true);
    assert.equal(r.winnerId, "asgarnia");
    assert.equal(store.load().wars[0].active, false);
  });
});

describe("siege hook", () => {
  it("a siege victory feeds the score but does not end a loot war early", () => {
    const store = mockStore();
    addWar(store, "loot");
    const siege = { attackerKingdomId: "asgarnia", defenderKingdomId: "misthalin", outcome: "victory" };
    WarResolution.onSiegeResolved(siege, store);
    const snap = WarResolution.warScoreBetween("asgarnia", "misthalin", store);
    assert.equal(snap.score.attacker, WarResolution.WAR_RESOLUTION_CONFIG.SCORE_SIEGE_VICTORY);
    assert.equal(store.load().wars[0].active, true);
  });

  it("a held siege scores for the defender", () => {
    const store = mockStore();
    addWar(store, "loot");
    const siege = { attackerKingdomId: "asgarnia", defenderKingdomId: "misthalin", outcome: "defeat" };
    WarResolution.onSiegeResolved(siege, store);
    const snap = WarResolution.warScoreBetween("asgarnia", "misthalin", store);
    assert.equal(snap.score.defender, WarResolution.WAR_RESOLUTION_CONFIG.SCORE_SIEGE_HELD);
  });

  it("a vassalize siege victory closes the war and keeps the oath", () => {
    const store = mockStore();
    addWar(store, "vassalize");
    const siege = { attackerKingdomId: "asgarnia", defenderKingdomId: "misthalin", outcome: "victory" };
    WarResolution.onSiegeResolved(siege, store);
    assert.equal(store.load().wars[0].active, false);
    assert.equal(Wars.getVassalOverlord("misthalin", store), "asgarnia");
  });

  it("ignores sieges with no active war (raids)", () => {
    const store = mockStore();
    const siege = { attackerKingdomId: "asgarnia", defenderKingdomId: "misthalin", outcome: "victory" };
    assert.equal(WarResolution.onSiegeResolved(siege, store), null);
  });
});

describe("player war timeout", () => {
  it("declared wars carry a resolveAt and an empty score", () => {
    const store = mockStore();
    const state = store.load();
    state.kingdoms.asgarnia = { id: "asgarnia", name: "Asgarnia" };
    const before = Date.now();
    const war = Wars.declareWarAi("asgarnia", "misthalin", "loot", store, {});
    // AI path needs a funded war chest; fund it then re-declare cleanly.
    if (!war.ok) {
      state.castles.asgarnia.warChest = 5000000;
      const retry = Wars.declareWarAi("asgarnia", "misthalin", "loot", store, {});
      assert.equal(retry.ok, true);
      assert.ok(retry.war.resolveAt >= before + Wars.WAR_TIMEOUT_MS - 1000);
      assert.deepEqual(retry.war.score, { attacker: 0, defender: 0 });
    }
  });
});
