"use strict";

/**
 * AiDiplomacy unit checks — the AI diplomacy council (Phase 7).
 *
 * Covers: pact formation gates (tension, funds, temperament, cooldowns,
 * shared enemies), pact upkeep, mutual-defense calls (join / absent /
 * refuse / no-repeat / tension-war skip), betrayal (temperament gating,
 * temptation, risk drift), and loyalty math. All randomness is injected
 * via a fixed rng for determinism.
 */
const assert = require("node:assert/strict");
const { describe, it, beforeEach } = require("node:test");

const AiDiplomacy = require("./AiDiplomacy.Kingdoms");
const Wars = require("./Wars.Kingdoms");

/** Deterministic rng: always willing. */
const always = () => 0;
/** Deterministic rng: never willing. */
const never = () => 0.999999;

function mockStore(ids) {
  const state = {
    kingdoms: ids.map((id) => ({ id, name: id, treasury: 100_000_000, flags: {} })),
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

function addAlliance(store, a, b, { strength = 1, betrayalRisk = 0, pactName = "test" } = {}) {
  const state = store.load();
  if (!Array.isArray(state.alliances)) state.alliances = [];
  const [x, y] = [a, b].sort();
  state.alliances.push({ a: x, b: y, pactName, strength, betrayalRisk });
}

function addWar(store, attackerId, defenderId, declaredBy = "ai-council") {
  const state = store.load();
  if (!Array.isArray(state.wars)) state.wars = [];
  const war = { attackerId, defenderId, active: true, goal: "loot", declaredAt: Date.now(), declaredBy };
  state.wars.push(war);
  return war;
}

/** Find a kingdom id with the given temperament (hash-stable). */
function idFor(temperament, exclude = []) {
  for (let i = 0; i < 5000; i++) {
    const id = `k-${temperament}-${i}`;
    if (exclude.includes(id)) continue;
    if (AiDiplomacy.temperamentOf(id) === temperament) return id;
  }
  throw new Error(`no id for temperament ${temperament}`);
}

function pactEvents(events) {
  return events.filter((e) => e.type === "pact-formed");
}

// ---------------------------------------------------------------------------
// Pact formation
// ---------------------------------------------------------------------------

describe("considerPacts", () => {
  let A, B, store;
  beforeEach(() => {
    A = idFor("steadfast");
    B = idFor("cautious", [A]);
    store = mockStore([A, B]);
    giveCastle(store, A, 20_000_000);
    giveCastle(store, B, 20_000_000);
    setTension(store, A, B, 10);
  });

  it("seals a pact between calm, rich, neutral courts", () => {
    const events = AiDiplomacy.councilDiplomacyTick(store, { rng: always });
    const pacts = pactEvents(events);
    assert.equal(pacts.length, 1);
    assert.deepEqual([pacts[0].a, pacts[0].b].sort(), [A, B].sort());
    assert.ok(pacts[0].pactName);
  });

  it("charges both courts an embassy gift", () => {
    AiDiplomacy.councilDiplomacyTick(store, { rng: always });
    const state = store.load();
    assert.equal(state.castles[A].warChest, 20_000_000 - AiDiplomacy.PACT_EMBASSY_COST);
    assert.equal(state.castles[B].warChest, 20_000_000 - AiDiplomacy.PACT_EMBASSY_COST);
  });

  it("refuses when borders are hot", () => {
    setTension(store, A, B, 90);
    const events = AiDiplomacy.councilDiplomacyTick(store, { rng: always });
    assert.equal(pactEvents(events).length, 0);
  });

  it("refuses when a court cannot afford the embassy", () => {
    giveCastle(store, B, 1_000_000); // below cost + reserve
    const events = AiDiplomacy.councilDiplomacyTick(store, { rng: always });
    assert.equal(pactEvents(events).length, 0);
  });

  it("refuses courts already at war", () => {
    addWar(store, A, B);
    const events = AiDiplomacy.councilDiplomacyTick(store, { rng: always });
    assert.equal(pactEvents(events).length, 0);
  });

  it("refuses a pair on pact cooldown", () => {
    const state = store.load();
    state.pactCooldowns = { [[A, B].sort().join(":")]: Date.now() };
    const events = AiDiplomacy.councilDiplomacyTick(store, { rng: always });
    assert.equal(pactEvents(events).length, 0);
  });

  it("aggressive courts do not pact without a shared enemy", () => {
    const agg1 = "morytania"; // always aggressive
    const agg2 = idFor("aggressive", [A, B]);
    const s = mockStore([agg1, agg2]);
    giveCastle(s, agg1, 20_000_000);
    giveCastle(s, agg2, 20_000_000);
    setTension(s, agg1, agg2, 10);
    const events = AiDiplomacy.councilDiplomacyTick(s, { rng: always });
    assert.equal(pactEvents(events).length, 0);
  });

  it("aggressive courts pact against a shared enemy", () => {
    const agg1 = "morytania";
    const agg2 = idFor("aggressive", [A, B]);
    const foe = idFor("cautious", [A, B, agg2]);
    const s = mockStore([agg1, agg2, foe]);
    giveCastle(s, agg1, 20_000_000);
    giveCastle(s, agg2, 20_000_000);
    giveCastle(s, foe, 20_000_000);
    setTension(s, agg1, agg2, 10);
    addWar(s, agg1, foe);
    addWar(s, agg2, foe);
    const events = AiDiplomacy.councilDiplomacyTick(s, { rng: always });
    const pacts = pactEvents(events).filter(
      (e) => [e.a, e.b].sort().join() === [agg1, agg2].sort().join()
    );
    assert.equal(pacts.length, 1);
    assert.equal(pacts[0].sharedEnemy, foe);
  });

  it("never double-signs an existing pact", () => {
    addAlliance(store, A, B);
    const events = AiDiplomacy.councilDiplomacyTick(store, { rng: always });
    assert.equal(pactEvents(events).length, 0);
  });
});

describe("considerPactUpkeep", () => {
  it("deepens prosperous calm pacts", () => {
    const A = idFor("steadfast");
    const B = idFor("cautious", [A]);
    const store = mockStore([A, B]);
    giveCastle(store, A, 20_000_000);
    giveCastle(store, B, 20_000_000);
    setTension(store, A, B, 10);
    addAlliance(store, A, B, { strength: 1 });
    const events = AiDiplomacy.councilDiplomacyTick(store, { rng: always });
    const up = events.filter((e) => e.type === "pact-strengthened");
    assert.equal(up.length, 1);
    assert.equal(store.load().alliances[0].strength, 2);
  });

  it("does not deepen hot or poor pacts", () => {
    const A = idFor("steadfast");
    const B = idFor("cautious", [A]);
    const store = mockStore([A, B]);
    giveCastle(store, A, 1_000_000);
    giveCastle(store, B, 1_000_000);
    setTension(store, A, B, 50);
    addAlliance(store, A, B, { strength: 1 });
    const events = AiDiplomacy.councilDiplomacyTick(store, { rng: always });
    assert.equal(events.filter((e) => e.type === "pact-strengthened").length, 0);
    assert.equal(store.load().alliances[0].strength, 1);
  });
});

// ---------------------------------------------------------------------------
// Mutual defense
// ---------------------------------------------------------------------------

describe("considerDefenseCalls", () => {
  let attacker, defender, ally, store;
  beforeEach(() => {
    attacker = idFor("aggressive");
    defender = idFor("steadfast", [attacker]);
    ally = idFor("steadfast", [attacker, defender]);
    store = mockStore([attacker, defender, ally]);
    for (const k of [attacker, defender, ally]) giveCastle(store, k, 20_000_000);
    setTension(store, defender, ally, 10);
    addAlliance(store, defender, ally);
    addWar(store, attacker, defender, "ai-council");
  });

  it("a loyal ally marches to the defense", () => {
    const events = AiDiplomacy.councilDiplomacyTick(store, { rng: always });
    const joined = events.filter((e) => e.type === "defense-joined");
    assert.equal(joined.length, 1);
    assert.equal(joined[0].ally, ally);
    assert.equal(joined[0].defender, defender);
    assert.equal(joined[0].attacker, attacker);
    // The join is a real war through the shared machinery.
    assert.ok(Wars.activeWarBetween(ally, attacker, store));
  });

  it("does not answer the same call twice", () => {
    AiDiplomacy.councilDiplomacyTick(store, { rng: always });
    const events = AiDiplomacy.councilDiplomacyTick(store, { rng: always });
    assert.equal(events.filter((e) => e.type === "defense-joined").length, 0);
  });

  it("an ally consumed by its own war is excused in absence", () => {
    const other = idFor("cautious", [attacker, defender, ally]);
    store.load().kingdoms.push({ id: other, name: other, treasury: 0, flags: {} });
    giveCastle(store, other, 20_000_000);
    addWar(store, ally, other, "ai-council");
    const events = AiDiplomacy.councilDiplomacyTick(store, { rng: always });
    const absent = events.filter((e) => e.type === "defense-absent");
    assert.equal(absent.length, 1);
    // The pact dissolves in absence, not anger.
    assert.equal(store.load().alliances.length, 0);
  });

  it("a disloyal ally refuses — and that is betrayal", () => {
    const events = AiDiplomacy.councilDiplomacyTick(store, { rng: never });
    const refused = events.filter((e) => e.type === "defense-refused");
    assert.equal(refused.length, 1);
    assert.equal(refused[0].betrayer, ally);
    assert.equal(refused[0].betrayed, defender);
    assert.equal(refused[0].via, "war-refusal");
    assert.equal(store.load().alliances.length, 0);
  });

  it("tension-declared wars are left to Diplomacy's listener", () => {
    store.load().wars = [];
    addWar(store, attacker, defender, "tension");
    const events = AiDiplomacy.councilDiplomacyTick(store, { rng: always });
    assert.equal(events.filter((e) => e.type === "defense-joined").length, 0);
    assert.equal(events.filter((e) => e.type === "defense-refused").length, 0);
  });
});

describe("loyaltyOf", () => {
  it("steadfast courts are the most loyal", () => {
    const a = idFor("aggressive");
    const s = idFor("steadfast", [a]);
    const d = idFor("cautious", [a, s]);
    const store = mockStore([a, s, d]);
    for (const k of [a, s, d]) giveCastle(store, k, 20_000_000);
    addAlliance(store, s, d);
    addAlliance(store, a, d);
    assert.ok(AiDiplomacy.loyaltyOf(s, d, a, store) > AiDiplomacy.loyaltyOf(a, d, s, store));
  });

  it("stronger pacts hold better", () => {
    const s = idFor("steadfast");
    const d = idFor("cautious", [s]);
    const a = idFor("aggressive", [s, d]);
    const store = mockStore([a, s, d]);
    for (const k of [a, s, d]) giveCastle(store, k, 20_000_000);
    addAlliance(store, s, d, { strength: 1 });
    const weak = AiDiplomacy.loyaltyOf(s, d, a, store);
    store.load().alliances[0].strength = 5;
    const strong = AiDiplomacy.loyaltyOf(s, d, a, store);
    assert.ok(strong > weak);
  });
});

// ---------------------------------------------------------------------------
// Betrayal
// ---------------------------------------------------------------------------

describe("considerBetrayals", () => {
  it("an opportunistic court backstabs a rich ally", () => {
    const betrayer = idFor("opportunistic");
    const betrayed = idFor("steadfast", [betrayer]);
    const store = mockStore([betrayer, betrayed]);
    giveCastle(store, betrayer, 20_000_000);
    giveCastle(store, betrayed, 100_000_000); // fat prize
    setTension(store, betrayer, betrayed, 10);
    addAlliance(store, betrayer, betrayed, { pactName: "the Test Accord" });
    const events = AiDiplomacy.councilDiplomacyTick(store, { rng: always });
    const stabs = events.filter((e) => e.type === "betrayal");
    assert.equal(stabs.length, 1);
    assert.equal(stabs[0].betrayer, betrayer);
    assert.equal(stabs[0].betrayed, betrayed);
    assert.ok(stabs[0].via.startsWith("backstab-"));
    // The pact is shattered and steel follows.
    assert.equal(store.load().alliances.length, 0);
    assert.equal(stabs[0].warDeclared, true);
    assert.ok(Wars.activeWarBetween(betrayer, betrayed, store));
  });

  it("steadfast courts keep their word even when tempted", () => {
    const keeper = idFor("steadfast");
    const rich = idFor("cautious", [keeper]);
    const store = mockStore([keeper, rich]);
    giveCastle(store, keeper, 20_000_000);
    giveCastle(store, rich, 100_000_000);
    setTension(store, keeper, rich, 10);
    addAlliance(store, keeper, rich, { betrayalRisk: 100 });
    const events = AiDiplomacy.councilDiplomacyTick(store, { rng: always });
    assert.equal(events.filter((e) => e.type === "betrayal").length, 0);
    assert.equal(store.load().alliances.length, 1);
  });

  it("only one backstab per tick", () => {
    const b1 = idFor("opportunistic");
    const v1 = idFor("steadfast", [b1]);
    const b2 = idFor("opportunistic", [b1, v1]);
    const v2 = idFor("cautious", [b1, v1, b2]);
    const store = mockStore([b1, v1, b2, v2]);
    for (const k of [b1, b2]) giveCastle(store, k, 20_000_000);
    for (const k of [v1, v2]) giveCastle(store, k, 100_000_000);
    addAlliance(store, b1, v1);
    addAlliance(store, b2, v2);
    const events = AiDiplomacy.councilDiplomacyTick(store, { rng: always });
    assert.equal(events.filter((e) => e.type === "betrayal").length, 1);
  });

  it("hot borders bleed betrayal risk into the pact", () => {
    const A = idFor("steadfast");
    const B = idFor("cautious", [A]);
    const store = mockStore([A, B]);
    giveCastle(store, A, 20_000_000);
    giveCastle(store, B, 20_000_000);
    setTension(store, A, B, 50);
    addAlliance(store, A, B, { betrayalRisk: 0 });
    // rng never: no pacts form, no upkeep, no defense — only drift runs.
    AiDiplomacy.councilDiplomacyTick(store, { rng: never });
    assert.equal(store.load().alliances[0].betrayalRisk, 5);
  });

  it("calm borders do not bleed risk", () => {
    const A = idFor("steadfast");
    const B = idFor("cautious", [A]);
    const store = mockStore([A, B]);
    giveCastle(store, A, 1_000_000);
    giveCastle(store, B, 1_000_000);
    setTension(store, A, B, 10);
    addAlliance(store, A, B, { betrayalRisk: 0 });
    AiDiplomacy.councilDiplomacyTick(store, { rng: never });
    assert.equal(store.load().alliances[0].betrayalRisk, 0);
  });
});
