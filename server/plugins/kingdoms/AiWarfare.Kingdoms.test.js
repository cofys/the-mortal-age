"use strict";

/**
 * AiWarfare unit checks — the AI war council (Phase 6).
 *
 * Covers: temperament stability, war declaration gates (tension, funds,
 * strength, temperament), autonomous sieges, defensive sally/repair,
 * weariness-driven peace offers/acceptance, and vassal oath-breaking.
 * All randomness is injected via a fixed rng for determinism.
 */
const assert = require("node:assert/strict");
const { describe, it, beforeEach } = require("node:test");

const AiWarfare = require("./AiWarfare.Kingdoms");
const Wars = require("./Wars.Kingdoms");
const Castle = require("./Castle.Kingdoms");

const A = "kingdom-a";
const B = "kingdom-b";
const C = "kingdom-c";

/** Deterministic rng: always willing. */
const always = () => 0;
/** Deterministic rng: never willing. */
const never = () => 0.999999;

function mockStore() {
  const state = {
    kingdoms: [
      { id: A, name: "Aland", treasury: 100_000_000, flags: {} },
      { id: B, name: "Boria", treasury: 100_000_000, flags: {} },
      { id: C, name: "Corva", treasury: 100_000_000, flags: {} },
    ],
    castles: {},
    tension: {},
    wars: [],
    sieges: {},
    vassals: {},
    peaceOffers: [],
    alliances: [],
  };
  return {
    load: () => state,
    save: () => {},
    getKingdoms: () => state.kingdoms,
    getKingdom: (id) => state.kingdoms.find((k) => k.id === id) ?? null,
    _state: () => state,
  };
}

function setTension(store, a, b, score) {
  const state = store.load();
  if (!state.tension || typeof state.tension !== "object") state.tension = {};
  state.tension[[a, b].sort().join(":")] = score;
}

/** Give a kingdom a castle with a war chest (fort tier 2, staffed barracks). */
function giveCastle(store, id, warChest, fortTier = 2) {
  const state = store.load();
  if (!state.castles) state.castles = {};
  state.castles[id] = {
    kingdomId: id,
    fortTier,
    warChest,
    buildings: {
      barracks: { tier: 2, staffed: ["g1", "g2", "g3", "g4"] },
      guardhouse: { tier: 1, staffed: ["g5"] },
    },
  };
}

function addActiveWar(store, attackerId, defenderId, declaredAt = Date.now()) {
  const state = store.load();
  if (!Array.isArray(state.wars)) state.wars = [];
  const war = { attackerId, defenderId, active: true, goal: "loot", declaredAt, declaredBy: "ai-council" };
  state.wars.push(war);
  return war;
}

describe("temperament", () => {
  it("is stable across calls", () => {
    const t1 = AiWarfare.temperamentOf("some-kingdom");
    const t2 = AiWarfare.temperamentOf("some-kingdom");
    assert.equal(t1, t2);
  });

  it("morytania is always aggressive", () => {
    assert.equal(AiWarfare.temperamentOf("morytania"), AiWarfare.TEMPERAMENT_AGGRESSIVE);
  });

  it("returns a known temperament for arbitrary ids", () => {
    for (const id of ["x", "y", "zzz-123", "asgarnia"]) {
      assert.ok(
        [
          AiWarfare.TEMPERAMENT_AGGRESSIVE,
          AiWarfare.TEMPERAMENT_OPPORTUNISTIC,
          AiWarfare.TEMPERAMENT_STEADFAST,
          AiWarfare.TEMPERAMENT_CAUTIOUS,
        ].includes(AiWarfare.temperamentOf(id))
      );
    }
  });
});

describe("Wars AI functions", () => {
  let store;
  beforeEach(() => {
    store = mockStore();
    giveCastle(store, A, 50_000_000);
    giveCastle(store, B, 50_000_000);
  });

  it("declareWarAi writes a goal-carrying war and charges the war chest", () => {
    setTension(store, A, B, 85);
    const before = store.load().castles[A].warChest;
    const res = Wars.declareWarAi(A, B, "loot", store);
    assert.ok(res.ok);
    assert.equal(res.war.goal, "loot");
    assert.equal(res.war.declaredBy, "ai-council");
    assert.equal(store.load().castles[A].warChest, before - Wars.AI_WAR_MOBILIZATION_COST);
    assert.equal(store.load().tension[[A, B].sort().join(":")], 100);
  });

  it("declareWarAi respects the ally gate", () => {
    const state = store.load();
    state.alliances.push({ a: A, b: B, pactName: "x", strength: 1, betrayalRisk: 0 });
    setTension(store, A, B, 95);
    const res = Wars.declareWarAi(A, B, "loot", store);
    assert.ok(!res.ok);
    assert.equal(res.reason, "allied-cannot-war");
  });

  it("declareWarAi refuses when the war chest is too thin", () => {
    store.load().castles[A].warChest = 100;
    setTension(store, A, B, 95);
    const res = Wars.declareWarAi(A, B, "loot", store);
    assert.ok(!res.ok);
    assert.equal(res.reason, "insufficient-funds");
  });

  it("offerPeaceAi + acceptPeaceAi close a war without a player", () => {
    addActiveWar(store, A, B);
    const offered = Wars.offerPeaceAi(A, B, { type: "white-peace" }, store);
    assert.ok(offered.ok);
    const accepted = Wars.acceptPeaceAi(B, A, store);
    assert.ok(accepted.ok);
    assert.equal(accepted.outcome, "peace-treaty");
    assert.ok(!store.load().wars[0].active);
  });

  it("offerPeaceAi refuses when not at war", () => {
    const res = Wars.offerPeaceAi(A, B, { type: "white-peace" }, store);
    assert.ok(!res.ok);
    assert.equal(res.reason, "not-at-war");
  });

  it("breakVassalageAi frees an old vassal", () => {
    const state = store.load();
    state.vassals[B] = { overlordId: A, since: Date.now() - 31 * 24 * 3600 * 1000 };
    const res = Wars.breakVassalageAi(B, store);
    assert.ok(res.ok);
    assert.equal(res.formerOverlord, A);
    assert.equal(Wars.getVassalOverlord(B, store), null);
  });

  it("breakVassalageAi refuses a fresh oath", () => {
    const state = store.load();
    state.vassals[B] = { overlordId: A, since: Date.now() };
    const res = Wars.breakVassalageAi(B, store);
    assert.ok(!res.ok);
    assert.equal(res.reason, "too-soon");
  });
});

describe("councilTick: war declarations", () => {
  let store;
  beforeEach(() => {
    store = mockStore();
    giveCastle(store, A, 50_000_000);
    giveCastle(store, B, 50_000_000);
    giveCastle(store, C, 50_000_000);
  });

  it("declares war at high tension when funds and strength allow", () => {
    setTension(store, A, B, 100);
    setTension(store, A, C, 10);
    setTension(store, B, C, 10);
    const events = AiWarfare.councilTick(store, { rng: always });
    const declared = events.filter((e) => e.type === "war-declared");
    assert.ok(declared.length >= 1, "expected a war declaration");
    const d = declared[0];
    assert.ok([A, B].includes(d.attackerId));
    assert.ok(Wars.WAR_GOALS.includes(d.goal));
    // The war record is really there.
    assert.ok(store.load().wars.some((w) => w.active));
  });

  it("never declares below every temperament threshold", () => {
    setTension(store, A, B, 10);
    setTension(store, A, C, 10);
    setTension(store, B, C, 10);
    const events = AiWarfare.councilTick(store, { rng: always });
    assert.equal(events.filter((e) => e.type === "war-declared").length, 0);
  });

  it("a broke court cannot declare", () => {
    setTension(store, A, B, 100);
    store.load().castles[A].warChest = 0;
    store.load().castles[B].warChest = 0;
    const events = AiWarfare.councilTick(store, { rng: always });
    // Neither side can afford mobilization.
    const abWars = store.load().wars.filter(
      (w) => w.active && ((w.attackerId === A && w.defenderId === B) || (w.attackerId === B && w.defenderId === A))
    );
    assert.equal(abWars.length, 0);
    void events;
  });

  it("skips fledgling kingdoms", () => {
    const state = store.load();
    state.kingdoms.push({ id: "newbie", name: "Newbie", treasury: 1, flags: { "founding:fledgling": true } });
    setTension(store, A, "newbie", 100);
    setTension(store, A, B, 10);
    setTension(store, A, C, 10);
    setTension(store, B, C, 10);
    AiWarfare.councilTick(store, { rng: always });
    const wars = state.wars.filter((w) => w.active);
    assert.ok(wars.every((w) => w.attackerId !== "newbie" && w.defenderId !== "newbie"));
  });
});

describe("councilTick: sieges and defense", () => {
  let store;
  beforeEach(() => {
    store = mockStore();
    giveCastle(store, A, 50_000_000);
    giveCastle(store, B, 50_000_000);
    setTension(store, A, B, 10);
  });

  it("lays a siege once at war", () => {
    addActiveWar(store, A, B);
    const events = AiWarfare.councilTick(store, { rng: always });
    const sieges = events.filter((e) => e.type === "siege-declared");
    assert.ok(sieges.length >= 1);
    const s = store.load().sieges[B] ?? store.load().sieges[A];
    assert.ok(s && s.status === "active");
    assert.ok(s.investment >= 2_000_000);
  });

  it("does not stack a second siege on the same defender", () => {
    addActiveWar(store, A, B);
    AiWarfare.councilTick(store, { rng: always });
    const events = AiWarfare.councilTick(store, { rng: always });
    const sieges = events.filter((e) => e.type === "siege-declared" && e.defenderId === B);
    assert.equal(sieges.length, 0);
  });

  it("a besieged court sallies when the siege grinds on", () => {
    const state = store.load();
    state.sieges[B] = {
      attackerKingdomId: A,
      defenderKingdomId: B,
      progress: 60,
      investment: 5_000_000,
      attackerPower: 100,
      declaredAt: Date.now() - 20 * 3600 * 1000,
      lastTickAt: Date.now() - 2 * 3600 * 1000,
      ticksElapsed: 20,
      status: "active",
      lastSallyAt: 0,
    };
    const before = state.sieges[B].progress;
    const events = AiWarfare.councilTick(store, { rng: always });
    const sally = events.find((e) => e.type === "sally");
    assert.ok(sally, "expected a sally event");
    assert.ok(state.sieges[B].progress < before);
  });
});

describe("councilTick: peace", () => {
  let store;
  beforeEach(() => {
    store = mockStore();
    giveCastle(store, A, 50_000_000);
    giveCastle(store, B, 50_000_000);
  });

  it("weariness grows with the days", () => {
    const fresh = addActiveWar(store, A, B, Date.now());
    const old = addActiveWar(store, A, C, Date.now() - 5 * 24 * 3600 * 1000);
    // End the second war record confusion: only compare fresh vs old.
    assert.ok(AiWarfare.wearinessOf(A, old, store) > AiWarfare.wearinessOf(A, fresh, store));
  });

  it("a weary court offers white peace", () => {
    addActiveWar(store, A, B, Date.now() - 10 * 24 * 3600 * 1000);
    const events = AiWarfare.councilTick(store, { rng: always });
    const offered = events.find((e) => e.type === "peace-offered");
    assert.ok(offered, "expected a peace offer");
    assert.equal(offered.terms, "white-peace");
  });

  it("a weary court accepts an old offer (not one from this tick)", () => {
    const war = addActiveWar(store, A, B, Date.now() - 10 * 24 * 3600 * 1000);
    void war;
    // Seed an old offer: A offered white peace 3h ago; B is weary.
    const state = store.load();
    state.peaceOffers.push({
      a: A,
      b: B,
      offeredBy: A,
      offeredByPlayer: "ai-council",
      terms: { type: "white-peace" },
      offeredAt: Date.now() - 3 * 3600 * 1000,
    });
    const events = AiWarfare.councilTick(store, { rng: always });
    const accepted = events.find((e) => e.type === "peace-accepted");
    assert.ok(accepted, "expected the old offer to be accepted");
    assert.ok(!state.wars.some((w) => w.active));
  });

  it("does not accept an offer created this same tick", () => {
    addActiveWar(store, A, B, Date.now() - 10 * 24 * 3600 * 1000);
    const events = AiWarfare.councilTick(store, { rng: always });
    // First tick: offer goes out. It must NOT be accepted instantly.
    const offered = events.find((e) => e.type === "peace-offered");
    assert.ok(offered, "expected a peace offer");
    assert.ok(!events.some((e) => e.type === "peace-accepted"));
    assert.ok(store.load().wars.some((w) => w.active), "war must still be active");
  });
});

describe("councilTick: vassalage", () => {
  it("an old vassal may break its oath", () => {
    const store = mockStore();
    const state = store.load();
    state.vassals[B] = { overlordId: A, since: Date.now() - 40 * 24 * 3600 * 1000 };
    const events = AiWarfare.councilTick(store, { rng: always });
    const broke = events.find((e) => e.type === "vassalage-broken");
    assert.ok(broke, "expected a vassalage break");
    assert.equal(broke.vassalId, B);
    assert.equal(Wars.getVassalOverlord(B, store), null);
  });
});

describe("councilTick: event sanity", () => {
  it("a calm realm produces no events", () => {
    const store = mockStore();
    giveCastle(store, A, 50_000_000);
    giveCastle(store, B, 50_000_000);
    setTension(store, A, B, 15);
    const events = AiWarfare.councilTick(store, { rng: always });
    assert.equal(events.length, 0);
  });
});
