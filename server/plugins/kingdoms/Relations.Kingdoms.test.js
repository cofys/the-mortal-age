"use strict";

/**
 * Relations unit checks — diplomatic stance labels, the siege gate,
 * alliance trade bonuses, and influence-cost diplomacy actions.
 *
 * Phase 4: relations read wars, alliances, tension, and sieges from the
 * passed store (mockable); envoy/ultimatum spend player influence.
 */
const assert = require("node:assert/strict");
const { describe, it, beforeEach } = require("node:test");

const Relations = require("./Relations.Kingdoms");
const Influence = require("./Influence.Kingdoms");

function mockStore() {
  let state = {};
  return {
    load: () => state,
    save: () => {},
    _state: () => state,
  };
}

function setTension(store, a, b, score) {
  const state = store.load();
  if (!state.tension || typeof state.tension !== "object") state.tension = {};
  state.tension[[a, b].sort().join(":")] = score;
}

function addAlliance(store, a, b) {
  const state = store.load();
  if (!Array.isArray(state.alliances)) state.alliances = [];
  const [x, y] = [a, b].sort();
  state.alliances.push({ a: x, b: y, pactName: "test", strength: 1, betrayalRisk: 0 });
}

function addWar(store, a, b) {
  const state = store.load();
  if (!Array.isArray(state.wars)) state.wars = [];
  state.wars.push({ attackerId: a, defenderId: b, active: true });
}

// Mock player with an attribute bag for influence.
function mockPlayer(influenceByKingdom = {}) {
  const attrs = {
    "kingdom:influence": Object.fromEntries(
      Object.entries(influenceByKingdom).map(([k, points]) => [
        k,
        { points, firstEarned: Date.now(), lastEarned: Date.now() },
      ])
    ),
  };
  return {
    getAttribute: (key) => attrs[key] ?? null,
    setAttribute: (key, val) => {
      attrs[key] = val;
    },
    _attrs: attrs,
  };
}

describe("relationOf", () => {
  let store;
  beforeEach(() => {
    store = mockStore();
  });

  it("defaults to neutral", () => {
    assert.equal(Relations.relationOf("asgarnia", "misthalin", store), "neutral");
  });

  it("self-targeting reads as self", () => {
    assert.equal(Relations.relationOf("asgarnia", "asgarnia", store), "self");
  });

  it("allied when a pact exists", () => {
    addAlliance(store, "asgarnia", "misthalin");
    assert.equal(Relations.relationOf("asgarnia", "misthalin", store), "allied");
    // Symmetric
    assert.equal(Relations.relationOf("misthalin", "asgarnia", store), "allied");
  });

  it("hostile at or above HOSTILE_TENSION", () => {
    setTension(store, "asgarnia", "misthalin", Relations.HOSTILE_TENSION);
    assert.equal(Relations.relationOf("asgarnia", "misthalin", store), "hostile");
    setTension(store, "asgarnia", "misthalin", Relations.HOSTILE_TENSION - 1);
    assert.equal(Relations.relationOf("asgarnia", "misthalin", store), "neutral");
  });

  it("at-war beats allied when both are set", () => {
    addAlliance(store, "asgarnia", "misthalin");
    addWar(store, "asgarnia", "misthalin");
    assert.equal(Relations.relationOf("asgarnia", "misthalin", store), "at-war");
  });

  it("at-war either direction", () => {
    addWar(store, "misthalin", "asgarnia");
    assert.equal(Relations.relationOf("asgarnia", "misthalin", store), "at-war");
  });

  it("active siege reads as at-war", () => {
    const state = store.load();
    state.sieges = {
      misthalin: {
        attackerKingdomId: "asgarnia",
        defenderKingdomId: "misthalin",
        status: "active",
      },
    };
    assert.equal(Relations.relationOf("asgarnia", "misthalin", store), "at-war");
  });

  it("ended wars do not count", () => {
    const state = store.load();
    state.wars = [{ attackerId: "asgarnia", defenderId: "misthalin", active: false }];
    assert.equal(Relations.relationOf("asgarnia", "misthalin", store), "neutral");
  });
});

describe("canSiegeRelation", () => {
  let store;
  beforeEach(() => {
    store = mockStore();
  });

  it("allows hostile", () => {
    setTension(store, "asgarnia", "misthalin", 70);
    const r = Relations.canSiegeRelation("asgarnia", "misthalin", store);
    assert.equal(r.ok, true);
    assert.equal(r.relation, "hostile");
  });

  it("allows at-war", () => {
    addWar(store, "asgarnia", "misthalin");
    const r = Relations.canSiegeRelation("asgarnia", "misthalin", store);
    assert.equal(r.ok, true);
    assert.equal(r.relation, "at-war");
  });

  it("blocks allies", () => {
    addAlliance(store, "asgarnia", "misthalin");
    const r = Relations.canSiegeRelation("asgarnia", "misthalin", store);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "allied-cannot-siege");
  });

  it("blocks neutrals", () => {
    const r = Relations.canSiegeRelation("asgarnia", "misthalin", store);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "not-hostile");
  });
});

describe("alliedTradeBonus", () => {
  let store;
  beforeEach(() => {
    store = mockStore();
  });

  it("is zero with no allies", () => {
    assert.equal(Relations.alliedTradeBonus("asgarnia", store), 0);
  });

  it("is 5% per ally", () => {
    addAlliance(store, "asgarnia", "misthalin");
    assert.equal(Relations.alliedTradeBonus("asgarnia", store), 0.05);
    addAlliance(store, "asgarnia", "kandarin");
    assert.equal(Relations.alliedTradeBonus("asgarnia", store), 0.1);
  });

  it("caps at 15%", () => {
    for (const k of ["b", "c", "d", "e"]) addAlliance(store, "asgarnia", k);
    assert.equal(Relations.alliedTradeBonus("asgarnia", store), 0.15);
  });

  it("counts only the kingdom's own pacts", () => {
    addAlliance(store, "misthalin", "kandarin");
    assert.equal(Relations.alliedTradeBonus("asgarnia", store), 0);
    assert.equal(Relations.alliedTradeBonus("misthalin", store), 0.05);
  });

  it("scales with pact strength", () => {
    addAlliance(store, "asgarnia", "misthalin");
    const state = store.load();
    state.alliances[0].strength = 3;
    assert.equal(Relations.alliedTradeBonus("asgarnia", store), 0.15);
  });

  it("defaults strength 1 for legacy pacts", () => {
    const state = store.load();
    state.alliances = [{ a: "asgarnia", b: "misthalin", pactName: "old" }];
    assert.equal(Relations.alliedTradeBonus("asgarnia", store), 0.05);
    assert.equal(Relations.pactStrengthOf("asgarnia", "misthalin", store), 1);
  });
});

describe("sendEnvoy", () => {
  let store;
  beforeEach(() => {
    store = mockStore();
  });

  it("cools a hostile border and spends influence", () => {
    setTension(store, "asgarnia", "misthalin", 70);
    const player = mockPlayer({ asgarnia: 200 });
    const r = Relations.sendEnvoy(player, "asgarnia", "misthalin", store);
    assert.equal(r.ok, true);
    assert.equal(r.tensionBefore, 70);
    assert.equal(r.tension, 55);
    assert.equal(r.influenceSpent, Relations.ENVOY_INFLUENCE_COST);
    assert.equal(Influence.effectiveInfluence(player, "asgarnia"), 150);
  });

  it("can cool all the way to neutral", () => {
    setTension(store, "asgarnia", "misthalin", 80);
    const player = mockPlayer({ asgarnia: 500 });
    const r1 = Relations.sendEnvoy(player, "asgarnia", "misthalin", store);
    assert.equal(r1.ok, true);
    assert.equal(r1.tension, 65);
    assert.equal(r1.relation, "hostile");
    const r = Relations.sendEnvoy(player, "asgarnia", "misthalin", store);
    assert.equal(r.ok, true);
    assert.equal(r.tension, 50);
    assert.equal(r.relation, "neutral");
  });

  it("refuses without influence", () => {
    setTension(store, "asgarnia", "misthalin", 70);
    const player = mockPlayer({ asgarnia: 10 });
    const r = Relations.sendEnvoy(player, "asgarnia", "misthalin", store);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "insufficient-influence");
    // Tension untouched
    assert.equal(Relations.tensionOf("asgarnia", "misthalin", store), 70);
  });

  it("refuses calm, allied, wartime, and self targets", () => {
    const player = mockPlayer({ asgarnia: 500 });
    assert.equal(Relations.sendEnvoy(player, "asgarnia", "misthalin", store).reason, "already-calm");
    addAlliance(store, "asgarnia", "kandarin");
    assert.equal(Relations.sendEnvoy(player, "asgarnia", "kandarin", store).reason, "already-allied");
    addWar(store, "asgarnia", "morytania");
    assert.equal(Relations.sendEnvoy(player, "asgarnia", "morytania", store).reason, "at-war-no-envoys");
    assert.equal(Relations.sendEnvoy(player, "asgarnia", "asgarnia", store).reason, "cannot-target-self");
  });
});

describe("issueUltimatum", () => {
  let store;
  beforeEach(() => {
    store = mockStore();
  });

  it("heats a neutral border and spends influence", () => {
    const player = mockPlayer({ asgarnia: 200 });
    const r = Relations.issueUltimatum(player, "asgarnia", "misthalin", store);
    assert.equal(r.ok, true);
    assert.equal(r.tensionBefore, 20); // default
    assert.equal(r.tension, 35);
    assert.equal(r.relation, "neutral");
    assert.equal(Influence.effectiveInfluence(player, "asgarnia"), 160);
  });

  it("can push neutral to hostile", () => {
    setTension(store, "asgarnia", "misthalin", 50);
    const player = mockPlayer({ asgarnia: 500 });
    const r = Relations.issueUltimatum(player, "asgarnia", "misthalin", store);
    assert.equal(r.ok, true);
    assert.equal(r.tension, 65);
    assert.equal(r.relation, "hostile");
  });

  it("caps below war — ultimatums alone don't declare it", () => {
    setTension(store, "asgarnia", "misthalin", 90);
    const player = mockPlayer({ asgarnia: 500 });
    const r = Relations.issueUltimatum(player, "asgarnia", "misthalin", store);
    assert.equal(r.ok, true);
    assert.ok(r.tension <= 99, `tension=${r.tension}`);
    assert.equal(r.tension, 99);
    assert.equal(r.relation, "hostile");
  });

  it("refuses without influence", () => {
    const player = mockPlayer({ asgarnia: 5 });
    const r = Relations.issueUltimatum(player, "asgarnia", "misthalin", store);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "insufficient-influence");
  });

  it("refuses allied, wartime, and self targets", () => {
    const player = mockPlayer({ asgarnia: 500 });
    addAlliance(store, "asgarnia", "kandarin");
    assert.equal(Relations.issueUltimatum(player, "asgarnia", "kandarin", store).reason, "allied-cannot-threaten");
    addWar(store, "asgarnia", "morytania");
    assert.equal(Relations.issueUltimatum(player, "asgarnia", "morytania", store).reason, "already-at-war");
    assert.equal(Relations.issueUltimatum(player, "asgarnia", "asgarnia", store).reason, "cannot-target-self");
  });
});

describe("spendInfluence", () => {
  it("deducts from settled points and returns remaining", () => {
    const player = mockPlayer({ asgarnia: 200 });
    const r = Influence.spendInfluence(player, "asgarnia", 75);
    assert.equal(r.ok, true);
    assert.equal(r.remaining, 125);
    assert.equal(Influence.effectiveInfluence(player, "asgarnia"), 125);
  });

  it("refuses when short", () => {
    const player = mockPlayer({ asgarnia: 10 });
    const r = Influence.spendInfluence(player, "asgarnia", 75);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "insufficient");
    assert.equal(Influence.effectiveInfluence(player, "asgarnia"), 10);
  });

  it("refuses with no record", () => {
    const player = mockPlayer({});
    const r = Influence.spendInfluence(player, "asgarnia", 10);
    assert.equal(r.ok, false);
  });
});
