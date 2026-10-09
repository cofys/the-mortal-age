"use strict";

/**
 * Wars unit checks — formal war declarations with goals, peace treaties,
 * vassalage, and the siege-goal integration points.
 *
 * Phase 5: all functions take the passed store (mockable). Influence costs
 * gate every player-driven action.
 */
const assert = require("node:assert/strict");
const { describe, it, beforeEach } = require("node:test");

const Wars = require("./Wars.Kingdoms");

function mockStore() {
  const state = {};
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

function addActiveWar(store, a, b, goal = null) {
  const state = store.load();
  if (!Array.isArray(state.wars)) state.wars = [];
  const war = { attackerId: a, defenderId: b, active: true, goal, declaredAt: Date.now() };
  state.wars.push(war);
  return war;
}

function addEndedWar(store, a, b, endedAtMs) {
  const state = store.load();
  if (!Array.isArray(state.wars)) state.wars = [];
  const war = {
    attackerId: a,
    defenderId: b,
    active: false,
    outcome: "peace-treaty",
    declaredAt: endedAtMs - 1000,
    endedAt: endedAtMs,
  };
  state.wars.push(war);
  return war;
}

// Mock player with an attribute bag for influence (matches Influence module shape).
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
    username: "test-player",
    getAttribute: (key) => attrs[key] ?? null,
    setAttribute: (key, val) => {
      attrs[key] = val;
    },
  };
}

const A = "kingdom-a";
const B = "kingdom-b";
const C = "kingdom-c";

describe("Wars.Kingdoms — declaration gates", () => {
  let store;
  beforeEach(() => {
    store = mockStore();
  });

  it("rejects declaring on self", () => {
    assert.equal(Wars.canDeclareWar(A, A, store).reason, "cannot-war-self");
  });

  it("rejects declaring on an ally", () => {
    addAlliance(store, A, B);
    const r = Wars.canDeclareWar(A, B, store);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "allied-cannot-war");
  });

  it("rejects declaring while already at war", () => {
    addActiveWar(store, A, B);
    assert.equal(Wars.canDeclareWar(A, B, store).reason, "already-at-war");
  });

  it("enforces the post-war cooldown", () => {
    addEndedWar(store, A, B, Date.now() - 1000);
    assert.equal(Wars.canDeclareWar(A, B, store).reason, "on-cooldown");
  });

  it("allows declaring after the cooldown expires", () => {
    addEndedWar(store, A, B, Date.now() - Wars.WAR_DECLARE_COOLDOWN_MS - 1000);
    assert.equal(Wars.canDeclareWar(A, B, store).ok, true);
  });

  it("rejects a vassal declaring on its overlord", () => {
    Wars.setVassalState(A, B, store.load());
    assert.equal(Wars.canDeclareWar(A, B, store).reason, "vassal-cannot-declare");
  });

  it("allows a clean declaration", () => {
    assert.equal(Wars.canDeclareWar(A, B, store).ok, true);
  });
});

describe("Wars.Kingdoms — declareWar", () => {
  let store;
  beforeEach(() => {
    store = mockStore();
  });

  it("rejects an invalid goal", () => {
    const r = Wars.declareWar(mockPlayer({ [A]: 500 }), A, B, "annihilate", store);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "invalid-goal");
    assert.deepEqual(r.validGoals, Wars.WAR_GOALS);
  });

  it("rejects when influence is short", () => {
    const r = Wars.declareWar(mockPlayer({ [A]: 10 }), A, B, "loot", store);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "insufficient-influence");
  });

  it("declares with a goal, spends influence, and burns tension to 100", () => {
    const player = mockPlayer({ [A]: 500 });
    const r = Wars.declareWar(player, A, B, "territory", store);
    assert.equal(r.ok, true);
    assert.equal(r.goal, "territory");
    assert.equal(r.goalLabel, "Territory");
    assert.equal(r.influenceSpent, Wars.WAR_DECLARE_INFLUENCE_COST);

    const state = store.load();
    const war = state.wars.find((w) => w.active);
    assert.ok(war);
    assert.equal(war.goal, "territory");
    assert.equal(war.declaredBy, "test-player");
    assert.equal(state.tension[[A, B].sort().join(":")], 100);
  });

  it("records each goal on the war for siege resolution", () => {
    for (const goal of Wars.WAR_GOALS) {
      const s = mockStore();
      const r = Wars.declareWar(mockPlayer({ [A]: 500 }), A, B, goal, s);
      assert.equal(r.ok, true);
      assert.equal(Wars.warGoalBetween(A, B, s.load()), goal);
    }
  });
});

describe("Wars.Kingdoms — peace treaties", () => {
  let store;
  beforeEach(() => {
    store = mockStore();
  });

  it("cannot offer peace without an active war", () => {
    const r = Wars.offerPeace(mockPlayer({ [A]: 500 }), A, B, { type: "white-peace" }, store);
    assert.equal(r.reason, "not-at-war");
  });

  it("rejects invalid terms", () => {
    addActiveWar(store, A, B);
    const r = Wars.offerPeace(mockPlayer({ [A]: 500 }), A, B, { type: "unconditional" }, store);
    assert.equal(r.reason, "invalid-terms");
  });

  it("rejects absurd tribute amounts", () => {
    addActiveWar(store, A, B);
    const r = Wars.offerPeace(
      mockPlayer({ [A]: 500 }),
      A,
      B,
      { type: "tribute", amount: Wars.MAX_TRIBUTE + 1 },
      store
    );
    assert.equal(r.reason, "invalid-tribute");
  });

  it("blocks a second offer while one is pending", () => {
    addActiveWar(store, A, B);
    const first = Wars.offerPeace(mockPlayer({ [A]: 500 }), A, B, { type: "white-peace" }, store);
    assert.equal(first.ok, true);
    const second = Wars.offerPeace(mockPlayer({ [B]: 500 }), B, A, { type: "white-peace" }, store);
    assert.equal(second.reason, "offer-pending");
  });

  it("accepting white peace ends the war and cools the border", () => {
    addActiveWar(store, A, B);
    setTension(store, A, B, 100);
    Wars.offerPeace(mockPlayer({ [A]: 500 }), A, B, { type: "white-peace" }, store);

    const r = Wars.acceptPeace(mockPlayer({ [B]: 500 }), B, A, store);
    assert.equal(r.ok, true);
    assert.equal(r.outcome, "peace-treaty");
    assert.deepEqual(r.applied, { type: "white-peace" });

    const state = store.load();
    assert.equal(state.wars.every((w) => !w.active), true);
    assert.equal(state.tension[[A, B].sort().join(":")], Wars.PEACE_TENSION);
    assert.equal(state.peaceOffers.length, 0);
  });

  it("tribute moves coins from the loser to the winner", () => {
    addActiveWar(store, A, B);
    const state = store.load();
    state.castles = { [B]: { warChest: 1_000_000 }, [A]: { warChest: 100 } };

    // A offers; B accepts — B is the loser (did not offer), pays A.
    Wars.offerPeace(mockPlayer({ [A]: 500 }), A, B, { type: "tribute", amount: 200_000 }, store);
    const r = Wars.acceptPeace(mockPlayer({ [B]: 500 }), B, A, store);
    assert.equal(r.ok, true);
    assert.equal(r.applied.paid, 200_000);
    assert.equal(state.castles[B].warChest, 800_000);
    assert.equal(state.castles[A].warChest, 200_100);
  });

  it("tribute is capped by what the loser holds", () => {
    addActiveWar(store, A, B);
    const state = store.load();
    state.castles = { [B]: { warChest: 50 }, [A]: { warChest: 0 } };

    Wars.offerPeace(mockPlayer({ [A]: 500 }), A, B, { type: "tribute", amount: 200_000 }, store);
    const r = Wars.acceptPeace(mockPlayer({ [B]: 500 }), B, A, store);
    assert.equal(r.applied.paid, 50);
    assert.equal(state.castles[B].warChest, 0);
    assert.equal(state.castles[A].warChest, 50);
  });

  it("vassalize terms swear the loser to the winner", () => {
    addActiveWar(store, A, B);
    Wars.offerPeace(mockPlayer({ [A]: 500 }), A, B, { type: "vassalize" }, store);
    const r = Wars.acceptPeace(mockPlayer({ [B]: 500 }), B, A, store);
    assert.equal(r.ok, true);
    assert.equal(Wars.isVassalOf(B, A, store), true);
    assert.equal(Wars.getVassalOverlord(B, store), A);
  });

  it("cannot accept without an offer", () => {
    addActiveWar(store, A, B);
    assert.equal(Wars.acceptPeace(mockPlayer({ [B]: 500 }), B, A, store).reason, "no-offer");
  });
});

describe("Wars.Kingdoms — vassalage", () => {
  let store;
  beforeEach(() => {
    store = mockStore();
  });

  it("records and queries vassalage", () => {
    Wars.setVassalState(A, B, store.load());
    assert.equal(Wars.getVassalOverlord(A, store), B);
    assert.equal(Wars.getVassalOverlord(C, store), null);
    assert.deepEqual(Wars.getVassalsOf(B, store).map((v) => v.vassalId), [A]);
    Wars.clearVassalState(A, store.load());
    assert.equal(Wars.getVassalOverlord(A, store), null);
  });

  it("vassal tribute is 10% of positive net tithe", () => {
    Wars.setVassalState(A, B, store.load());
    const r = Wars.vassalTributeOf(A, 10_000, store.load());
    assert.equal(r.tribute, 1_000);
    assert.equal(r.overlordId, B);
  });

  it("no tribute when net is not positive", () => {
    Wars.setVassalState(A, B, store.load());
    assert.equal(Wars.vassalTributeOf(A, -500, store.load()).tribute, 0);
    assert.equal(Wars.vassalTributeOf(C, 10_000, store.load()).tribute, 0);
  });

  it("breaking vassalage too soon is refused", () => {
    Wars.setVassalState(A, B, store.load());
    const r = Wars.breakVassalage(mockPlayer({ [A]: 500 }), A, store);
    assert.equal(r.reason, "too-soon");
  });

  it("breaking vassalage after 30 days costs influence and burns the border", () => {
    const state = store.load();
    Wars.setVassalState(A, B, state);
    state.vassals[A].since = Date.now() - 31 * 24 * 3600 * 1000;

    const r = Wars.breakVassalage(mockPlayer({ [A]: 500 }), A, store);
    assert.equal(r.ok, true);
    assert.equal(r.formerOverlord, B);
    assert.equal(r.influenceSpent, Wars.BREAK_VASSALAGE_INFLUENCE_COST);
    assert.equal(Wars.getVassalOverlord(A, store), null);
    assert.equal(state.tension[[A, B].sort().join(":")], 80);
  });

  it("breaking vassalage without standing is refused", () => {
    assert.equal(Wars.breakVassalage(mockPlayer({ [C]: 500 }), C, store).reason, "not-a-vassal");
  });
});

describe("Wars.Kingdoms — queries", () => {
  it("getWars lists active wars with goal labels", () => {
    const store = mockStore();
    const player = mockPlayer({ [A]: 500 });
    Wars.declareWar(player, A, B, "vassalize", store);
    const wars = Wars.getWars(A, store);
    assert.equal(wars.length, 1);
    assert.equal(wars[0].goal, "vassalize");
    assert.equal(wars[0].goalLabel, "Vassalize");
    assert.equal(Wars.getWars(C, store).length, 0);
  });
});

describe("Wars.Kingdoms — war goals shape siege victories", () => {
  const Siege = require("./Siege.Kingdoms");

  function warState(goal) {
    const store = mockStore();
    const state = store.load();
    state.wars = [
      {
        attackerId: A,
        defenderId: B,
        active: true,
        goal,
        declaredAt: Date.now(),
      },
    ];
    state.castles = {
      [A]: { warChest: 1_000, buildings: {}, fortTier: 2 },
      [B]: {
        warChest: 1_000_000,
        buildings: {
          barracks: { tier: 2, staff: [] },
          chapel: { tier: 1, staff: [] },
          workshop: { tier: 3, staff: [] },
        },
        fortTier: 3,
      },
    };
    return state;
  }

  function freshSiege() {
    return {
      attackerKingdomId: A,
      defenderKingdomId: B,
      progress: 100,
      status: "active",
    };
  }

  it("a vassalize war ends with the defender sworn as vassal", () => {
    const state = warState("vassalize");
    const outcome = Siege.resolveVictory(freshSiege(), state);
    assert.equal(outcome, "victory");
    assert.equal(Wars.isVassalOfState(B, A, state), true);
    // Subjugation takes a token loot, not the full plunder.
    assert.equal(state.castles[B].warChest, 900_000);
    assert.equal(state.castles[A].warChest, 101_000);
  });

  it("a territory war razes fortifications twice as hard", () => {
    const state = warState("territory");
    Siege.resolveVictory(freshSiege(), state);
    assert.equal(state.castles[B].fortTier, 1); // 3 - 2
  });

  it("a loot war takes a bigger cut of the war chest", () => {
    const state = warState("loot");
    Siege.resolveVictory(freshSiege(), state);
    assert.equal(state.castles[B].warChest, 650_000); // 35% of 1M
    assert.equal(state.castles[A].warChest, 351_000);
  });

  it("a goal-less raid takes the default spoils", () => {
    const state = warState(null);
    Siege.resolveVictory(freshSiege(), state);
    assert.equal(state.castles[B].warChest, 750_000); // 25% of 1M
    assert.equal(state.castles[B].fortTier, 2); // 3 - 1
    assert.equal(Wars.getVassalOverlordState(B, state), null);
  });
});
