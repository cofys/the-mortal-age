"use strict";

/**
 * Civil-war gate checks (Phase 10).
 *
 * A kingdom torn by civil war cannot project power outward: it may not
 * declare wars or lay sieges. A kingdom mid-succession-crisis fights at
 * reduced power (attack) and defends at reduced power (defense).
 *
 * These gates live in the shared check functions, so player-driven and
 * AI-council paths both honor them.
 */
const assert = require("node:assert/strict");
const { describe, it, beforeEach } = require("node:test");

const Wars = require("./Wars.Kingdoms");
const Siege = require("./Siege.Kingdoms");
const Castle = require("./Castle.Kingdoms");

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

function fundedCastle(kingdomId, store, coins = 10_000_000) {
  Castle.ensureCastle(kingdomId, store);
  Castle.depositWarChest(kingdomId, coins, store);
  return Castle.getCastle(kingdomId, store);
}

// Inject an open succession crisis for a kingdom, using the module's own
// data shape (SuccessionCrisis reads state.succession directly).
function injectCrisis(store, kingdomId) {
  const state = store.load();
  if (!state.succession) state.succession = { crises: [], civilWars: [], reigns: {} };
  state.succession.crises.push({
    id: `crisis-${kingdomId}`,
    kingdomId,
    status: "open",
    claimants: [],
    ticksLeft: 10,
  });
}

// Inject an active civil war for a kingdom.
function injectCivilWar(store, kingdomId) {
  const state = store.load();
  if (!state.succession) state.succession = { crises: [], civilWars: [], reigns: {} };
  state.succession.civilWars.push({
    id: `civilwar-${kingdomId}`,
    kingdomId,
    status: "active",
    sides: [{ name: "Side A", strength: 50 }, { name: "Side B", strength: 50 }],
    ticksLeft: 10,
    drained: 0,
  });
}

const A = "kingdom-a";
const B = "kingdom-b";

describe("civil-war power projection gates", () => {
  let store;
  beforeEach(() => {
    store = mockStore();
  });

  it("Wars.canDeclareWar refuses when the attacker is in civil war", () => {
    injectCivilWar(store, A);
    const r = Wars.canDeclareWar(A, B, store);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "in-civil-war");
  });

  it("Wars.canDeclareWar still allows attacking a kingdom that is in civil war", () => {
    injectCivilWar(store, B);
    const r = Wars.canDeclareWar(A, B, store);
    assert.equal(r.ok, true);
  });

  it("Wars.canDeclareWar allows declarations when neither side is in civil war", () => {
    const r = Wars.canDeclareWar(A, B, store);
    assert.equal(r.ok, true);
  });

  it("declareWarAi honors the civil-war gate", () => {
    fundedCastle(A, store);
    injectCivilWar(store, A);
    const r = Wars.declareWarAi(A, B, "loot", store);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "in-civil-war");
  });
});

describe("siege civil-war gate and crisis power penalties", () => {
  let store;
  beforeEach(() => {
    store = mockStore();
    fundedCastle(A, store);
    fundedCastle(B, store);
    setTension(store, A, B, 70); // hostile: siege relation gate passes
  });

  it("Siege.canDeclareSiege refuses when the attacker is in civil war", () => {
    injectCivilWar(store, A);
    const r = Siege.canDeclareSiege(A, B, store);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "in-civil-war");
  });

  it("Siege.canDeclareSiege allows sieging a defender that is in civil war", () => {
    injectCivilWar(store, B);
    const r = Siege.canDeclareSiege(A, B, store);
    assert.equal(r.ok, true);
  });

  it("declareSiege reduces attacker power when the attacker is mid-crisis", () => {
    // New castles are tier 0 (defense 0): power comes from coins alone.
    const basePower = Siege.siegePower(2_000_000, 0);
    injectCrisis(store, A);
    const r = Siege.declareSiege(A, B, 2_000_000, store);
    assert.equal(r.ok, true);
    const expected = Math.floor(basePower * Siege.SUCCESSION_CRISIS_ATTACK_FACTOR);
    assert.equal(r.siege.attackerPower, expected);
    assert.ok(r.siege.attackerPower < basePower);
  });

  it("declareSiege keeps full power when the attacker is not in crisis", () => {
    const basePower = Siege.siegePower(2_000_000, 0);
    const r = Siege.declareSiege(A, B, 2_000_000, store);
    assert.equal(r.ok, true);
    assert.equal(r.siege.attackerPower, basePower);
  });

  it("tickSiege weakens a defender that is mid-crisis", () => {
    // Defender at tier 2 (defense 25). Attacker invests 2.8M -> power 28.
    // Calm ratio 28/25 = 1.12 -> +3. Crisis defense floor(25*0.85) = 21,
    // crisis ratio 28/21 = 1.33 -> +8. The penalty flips the bracket.
    const mkSieged = (inCrisis) => {
      const s = mockStore();
      fundedCastle(A, s);
      fundedCastle(B, s);
      s.load().castles[B].fortTier = 2;
      setTension(s, A, B, 70);
      if (inCrisis) injectCrisis(s, B);
      const r = Siege.declareSiege(A, B, 2_800_000, s);
      assert.equal(r.ok, true);
      r.siege.lastTickAt = Date.now() - Siege.SIEGE_TICK_MS - 1000;
      return s;
    };
    const calm = mkSieged(false);
    const crisis = mkSieged(true);
    const rCalm = Siege.tickSiege(B, calm);
    const rCrisis = Siege.tickSiege(B, crisis);
    assert.equal(rCalm.ok, true);
    assert.equal(rCrisis.ok, true);
    assert.equal(rCalm.siege.progress, 3);
    assert.equal(rCrisis.siege.progress, 8);
    assert.ok(rCrisis.siege.progress > rCalm.siege.progress);
  });
});
