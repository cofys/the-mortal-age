"use strict";

/**
 * Coalitions unit checks — Phase 8.
 *
 * Covers: component detection (chains, triangles, separate pairs),
 * the 3-member minimum, strength totals, coalitionOf lookup, reconcile
 * formation/dissolution events, and name persistence across membership
 * drift. Pure functions; fixed rng for deterministic names.
 */
const assert = require("node:assert/strict");
const { describe, it, beforeEach } = require("node:test");

const Coalitions = require("./Coalitions.Kingdoms");

/** Deterministic rng: always picks the first name. */
const always = () => 0;

function mockStore() {
  const state = { alliances: [] };
  return {
    load: () => state,
    save: () => {},
    getKingdom: (id) => ({ id, name: `Kingdom ${id}`, capital: `Cap${id}` }),
    _state: () => state,
  };
}

function addPact(store, a, b, strength = 1) {
  const [x, y] = [String(a), String(b)].sort();
  store.load().alliances.push({ a: x, b: y, pactName: `${x}-${y}`, strength, betrayalRisk: 0 });
}

function removePact(store, a, b) {
  const [x, y] = [String(a), String(b)].sort();
  const list = store.load().alliances;
  const idx = list.findIndex((r) => r.a === x && r.b === y);
  if (idx >= 0) list.splice(idx, 1);
}

describe("coalitionsOf", () => {
  let store;
  beforeEach(() => {
    store = mockStore();
  });

  it("returns no coalitions with no alliances", () => {
    assert.deepEqual(Coalitions.coalitionsOf(store), []);
  });

  it("returns no coalitions for a lone pair", () => {
    addPact(store, "a", "b");
    assert.deepEqual(Coalitions.coalitionsOf(store), []);
  });

  it("detects a chain of three as one coalition", () => {
    addPact(store, "a", "b");
    addPact(store, "b", "c");
    const coalitions = Coalitions.coalitionsOf(store, { rng: always });
    assert.equal(coalitions.length, 1);
    assert.deepEqual(coalitions[0].members, ["a", "b", "c"]);
    assert.equal(coalitions[0].pactCount, 2);
  });

  it("detects a triangle with three pacts", () => {
    addPact(store, "a", "b");
    addPact(store, "b", "c");
    addPact(store, "a", "c");
    const coalitions = Coalitions.coalitionsOf(store, { rng: always });
    assert.equal(coalitions.length, 1);
    assert.equal(coalitions[0].pactCount, 3);
  });

  it("ignores a separate pair alongside a coalition", () => {
    addPact(store, "a", "b");
    addPact(store, "b", "c");
    addPact(store, "x", "y");
    const coalitions = Coalitions.coalitionsOf(store, { rng: always });
    assert.equal(coalitions.length, 1);
    assert.deepEqual(coalitions[0].members, ["a", "b", "c"]);
  });

  it("detects two separate coalitions", () => {
    addPact(store, "a", "b");
    addPact(store, "b", "c");
    addPact(store, "x", "y");
    addPact(store, "y", "z");
    const coalitions = Coalitions.coalitionsOf(store, { rng: always });
    assert.equal(coalitions.length, 2);
  });

  it("totals pact strength across the coalition", () => {
    addPact(store, "a", "b", 3);
    addPact(store, "b", "c", 2);
    const [c] = Coalitions.coalitionsOf(store, { rng: always });
    assert.equal(c.totalStrength, 5);
  });

  it("names the coalition deterministically with a fixed rng", () => {
    addPact(store, "a", "b");
    addPact(store, "b", "c");
    const [c] = Coalitions.coalitionsOf(store, { rng: always });
    assert.equal(c.name, "the Capa League");
  });
});

describe("coalitionOf", () => {
  it("returns the coalition for a member, null otherwise", () => {
    const store = mockStore();
    addPact(store, "a", "b");
    addPact(store, "b", "c");
    const c = Coalitions.coalitionOf("a", store, { rng: always });
    assert.ok(c);
    assert.deepEqual(c.members, ["a", "b", "c"]);
    assert.equal(Coalitions.coalitionOf("zzz", store), null);
  });
});

describe("reconcileCoalitions", () => {
  let store;
  beforeEach(() => {
    store = mockStore();
  });

  it("emits coalition-formed when a third pact links up", () => {
    addPact(store, "a", "b");
    let events = Coalitions.reconcileCoalitions(store, { rng: always });
    assert.deepEqual(events, []);

    addPact(store, "b", "c");
    events = Coalitions.reconcileCoalitions(store, { rng: always });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "coalition-formed");
    assert.equal(events[0].coalition.name, "the Capa League");
    assert.deepEqual(events[0].coalition.members, ["a", "b", "c"]);
  });

  it("emits nothing on a steady state", () => {
    addPact(store, "a", "b");
    addPact(store, "b", "c");
    Coalitions.reconcileCoalitions(store, { rng: always });
    const events = Coalitions.reconcileCoalitions(store, { rng: always });
    assert.deepEqual(events, []);
  });

  it("emits coalition-dissolved when pacts break below three", () => {
    addPact(store, "a", "b");
    addPact(store, "b", "c");
    Coalitions.reconcileCoalitions(store, { rng: always });
    removePact(store, "b", "c");
    const events = Coalitions.reconcileCoalitions(store, { rng: always });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "coalition-dissolved");
    assert.equal(events[0].name, "the Capa League");
  });

  it("keeps the name when a fourth member joins", () => {
    addPact(store, "a", "b");
    addPact(store, "b", "c");
    Coalitions.reconcileCoalitions(store, { rng: always });
    addPact(store, "c", "d");
    const events = Coalitions.reconcileCoalitions(store, { rng: always });
    assert.deepEqual(events, []);
    const [c] = Coalitions.coalitionsOf(store, { rng: always });
    assert.equal(c.name, "the Capa League");
    assert.deepEqual(c.members, ["a", "b", "c", "d"]);
  });

  it("renames when the coalition is mostly replaced", () => {
    addPact(store, "a", "b");
    addPact(store, "b", "c");
    Coalitions.reconcileCoalitions(store, { rng: always });
    // Two of three leave; two newcomers join — a different league.
    removePact(store, "a", "b");
    removePact(store, "b", "c");
    addPact(store, "c", "x");
    addPact(store, "x", "y");
    const events = Coalitions.reconcileCoalitions(store, { rng: always });
    const formed = events.filter((e) => e.type === "coalition-formed");
    const dissolved = events.filter((e) => e.type === "coalition-dissolved");
    assert.equal(dissolved.length, 1);
    assert.equal(formed.length, 1);
    assert.notEqual(formed[0].coalition.name, "the Capa League");
  });
});
