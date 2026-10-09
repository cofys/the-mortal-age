"use strict";

/**
 * SuccessionCrisis unit checks — ruler lifecycle, crisis opening and
 * resolution, civil wars, player backing, and the lore exemptions.
 *
 * Phase 9: pure logic over a mock store. Offices is the real module
 * (pure, no engine deps) but keeps a module-global registry, so every test
 * seeds a UNIQUE kingdom id to stay isolated.
 */
const assert = require("node:assert/strict");
const { describe, it, beforeEach } = require("node:test");

const Succession = require("./SuccessionCrisis.Kingdoms");
const Offices = require("./Offices.Kingdoms");

let kingdomSeq = 0;

function mockStore() {
  let state = {};
  return {
    load: () => state,
    save: () => {},
    _state: () => state,
  };
}

/** Seed a kingdom with a unique id; returns the kingdom record. */
function seedKingdom(store, overrides = {}) {
  const state = store.load();
  if (!state.kingdoms) state.kingdoms = {};
  const id = overrides.id ?? `testland-${kingdomSeq++}`;
  const kingdom = {
    id,
    name: "Testland",
    capital: "Test City",
    ruler: "King Testor",
    rulerTitle: "King",
    hierarchy: [],
    treasury: 1_000_000,
    flags: {},
    foundedAt: Date.now() - 10 * 24 * 3600 * 1000,
    ...overrides,
  };
  kingdom.id = id;
  state.kingdoms[id] = kingdom;
  return kingdom;
}

function seedOffices(kingdomId, names) {
  names.forEach((name, i) => {
    const officeId = `${kingdomId}:office-${i}`;
    Offices.defineOffice({ kingdomId, office: `office-${i}`, title: `Title ${i}`, description: "test" });
    const assigned = Offices.assignOffice(officeId, { kind: "ai", ref: name });
    assert.ok(assigned, `office ${officeId} should assign`);
  });
}

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
    username: "TestPlayer",
    getAttribute: (key) => attrs[key] ?? null,
    setAttribute: (key, val) => {
      attrs[key] = val;
    },
    _attrs: attrs,
  };
}

/** Deterministic rng: returns values from the sequence, then 0.5. */
function seqRng(...values) {
  let i = 0;
  return () => (i < values.length ? values[i++] : 0.5);
}

describe("SuccessionCrisis — lore exemptions", () => {
  it("never touches Misthalin, even with an ancient ruler", () => {
    const store = mockStore();
    seedKingdom(store, {
      id: "misthalin",
      name: "Misthalin",
      ruler: "Roald III",
      foundedAt: Date.now() - 900 * 24 * 3600 * 1000,
    });
    const events = Succession.councilSuccessionTick(store, { rng: seqRng(0.0) });
    assert.equal(events.length, 0);
    assert.equal(Succession.inSuccessionCrisis("misthalin", store.load()), false);
  });

  it("never kills great rulers by name", () => {
    for (const ruler of ["King Lathas", "Lowerniel Drakan", "Amik Varze"]) {
      const s2 = mockStore();
      seedKingdom(s2, { ruler, foundedAt: Date.now() - 900 * 24 * 3600 * 1000 });
      const events = Succession.councilSuccessionTick(s2, { rng: seqRng(0.0) });
      assert.equal(events.length, 0, `ruler ${ruler} should be exempt`);
    }
  });

  it("skips kingdoms with no ruler", () => {
    const store = mockStore();
    seedKingdom(store, { ruler: null });
    const events = Succession.councilSuccessionTick(store, { rng: seqRng(0.0) });
    assert.equal(events.length, 0);
  });
});

describe("SuccessionCrisis — ruler death and crisis opening", () => {
  let store;
  let kid;
  beforeEach(() => {
    store = mockStore();
    kid = seedKingdom(store).id;
  });

  it("a dying ruler with no heir opens a crisis", () => {
    // rng: death roll succeeds (0.0 < chance), deathbed heir roll fails (0.9 > 0.35).
    seedOffices(kid, ["Lord Commander A", "Chancellor B", "High Priest C"]);
    const events = Succession.councilSuccessionTick(store, { rng: seqRng(0.0, 0.9, 0.5) });
    const died = events.find((e) => e.type === "ruler-died");
    assert.ok(died, "expected a ruler-died event");
    assert.equal(Succession.inSuccessionCrisis(kid, store.load()), true);
  });

  it("a dying ruler can name a deathbed heir — no crisis", () => {
    // rng: death succeeds, deathbed heir succeeds.
    const events = Succession.councilSuccessionTick(store, { rng: seqRng(0.0, 0.1) });
    const changed = events.find((e) => e.type === "ruler-changed");
    assert.ok(changed, "expected a smooth ruler-changed event");
    assert.equal(Succession.inSuccessionCrisis(kid, store.load()), false);
  });

  it("crisis claimants come from real office holders", () => {
    seedOffices(kid, ["Lord Commander A", "Chancellor B"]);
    const kingdom = store.load().kingdoms[kid];
    const crisis = Succession.openSuccessionCrisis(kingdom, store, seqRng(0.5));
    assert.ok(crisis);
    assert.ok(crisis.claimants.length >= 2);
    const names = crisis.claimants.map((c) => c.name);
    assert.ok(names.includes("Lord Commander A"));
    assert.ok(names.includes("Chancellor B"));
    for (const c of crisis.claimants) {
      assert.ok(Succession.CLAIM_TYPES.includes(c.claim), `unknown claim type ${c.claim}`);
      assert.ok(c.strength >= 5 && c.strength <= 100);
    }
  });

  it("designated heir flag seeds a bloodline claimant with bonus strength", () => {
    seedOffices(kid, ["Lord Commander A", "Chancellor B"]);
    const kingdom = store.load().kingdoms[kid];
    kingdom.flags["succession:designated-heir"] = "Prince Testor";
    const crisis = Succession.openSuccessionCrisis(kingdom, store, seqRng(0.5));
    const heir = crisis.claimants.find((c) => c.name === "Prince Testor");
    assert.ok(heir);
    assert.equal(heir.claim, "bloodline");
    assert.ok(heir.strength >= 50, "designated heir should start strong");
  });

  it("does not open a second crisis while one is open", () => {
    seedOffices(kid, ["Lord Commander A", "Chancellor B"]);
    const kingdom = store.load().kingdoms[kid];
    const first = Succession.openSuccessionCrisis(kingdom, store, seqRng(0.5));
    assert.ok(first);
    const second = Succession.openSuccessionCrisis(kingdom, store, seqRng(0.5));
    assert.equal(second, null);
  });

  it("returns null when fewer than two claimants exist", () => {
    // No offices seeded for this unique kingdom: no claimants possible.
    const kingdom = store.load().kingdoms[kid];
    const crisis = Succession.openSuccessionCrisis(kingdom, store, seqRng(0.5));
    assert.equal(crisis, null);
  });
});

describe("SuccessionCrisis — crisis resolution", () => {
  let store;
  let kid;
  beforeEach(() => {
    store = mockStore();
    kid = seedKingdom(store).id;
    seedOffices(kid, ["Lord Commander A", "Chancellor B", "High Priest C"]);
  });

  function openCrisis() {
    const kingdom = store.load().kingdoms[kid];
    return Succession.openSuccessionCrisis(kingdom, store, seqRng(0.5));
  }

  it("a dominant claimant is crowned peacefully", () => {
    const crisis = openCrisis();
    crisis.claimants[0].strength = 90;
    crisis.claimants[1].strength = 10;
    crisis.claimants[2].strength = 10;
    crisis.ticksLeft = 1;
    const events = Succession.councilSuccessionTick(store, { rng: seqRng(0.5) });
    const changed = events.find((e) => e.type === "ruler-changed");
    assert.ok(changed, "expected peaceful coronation");
    assert.equal(changed.newRuler, crisis.claimants[0].name);
    assert.equal(Succession.inSuccessionCrisis(kid, store.load()), false);
  });

  it("a split court goes to civil war between the top two", () => {
    const crisis = openCrisis();
    for (const c of crisis.claimants) c.strength = 30;
    crisis.ticksLeft = 1;
    const events = Succession.councilSuccessionTick(store, { rng: seqRng(0.5) });
    const started = events.find((e) => e.type === "civil-war-started");
    assert.ok(started, "expected civil war");
    assert.equal(Succession.inCivilWar(kid, store.load()), true);
    assert.equal(Succession.inSuccessionCrisis(kid, store.load()), false);
  });

  it("crisisSummary reports shares and backers", () => {
    openCrisis();
    const summary = Succession.crisisSummary(kid, store);
    assert.ok(summary);
    assert.equal(summary.kingdomId, kid);
    assert.ok(Array.isArray(summary.claimants));
    assert.ok(summary.claimants.length >= 2);
    const totalShare = summary.claimants.reduce((s, c) => s + c.share, 0);
    assert.ok(totalShare >= 99 && totalShare <= 101, `shares sum to ${totalShare}`);
  });
});

describe("SuccessionCrisis — civil war", () => {
  let store;
  let kid;
  beforeEach(() => {
    store = mockStore();
    kid = seedKingdom(store).id;
    seedOffices(kid, ["Lord Commander A", "Chancellor B"]);
  });

  function startWar() {
    const kingdom = store.load().kingdoms[kid];
    const crisis = Succession.openSuccessionCrisis(kingdom, store, seqRng(0.5));
    for (const c of crisis.claimants) c.strength = 30;
    crisis.ticksLeft = 1;
    Succession.councilSuccessionTick(store, { rng: seqRng(0.5) });
    return store.load().succession.civilWars.find((w) => w.kingdomId === kid);
  }

  it("drains the treasury each tick", () => {
    const war = startWar();
    assert.ok(war && war.status === "active");
    const before = store.load().kingdoms[kid].treasury;
    war.ticksLeft = 5;
    Succession.councilSuccessionTick(store, { rng: seqRng(0.5) });
    const after = store.load().kingdoms[kid].treasury;
    assert.ok(after < before, "treasury should drain during civil war");
  });

  it("the stronger side wins and takes the crown", () => {
    const war = startWar();
    war.sides[0].strength = 90;
    war.sides[1].strength = 10;
    war.ticksLeft = 1;
    const events = Succession.councilSuccessionTick(store, { rng: seqRng(0.5) });
    const changed = events.find((e) => e.type === "ruler-changed");
    assert.ok(changed, "expected a victor crowned");
    assert.equal(changed.newRuler, war.sides[0].name);
    assert.equal(Succession.inCivilWar(kid, store.load()), false);
    const ended = events.find((e) => e.type === "civil-war-ended");
    assert.ok(ended);
    assert.ok(ended.drained >= 0);
  });

  it("civilWarSummary reports sides and drain", () => {
    startWar();
    const summary = Succession.civilWarSummary(kid, store);
    assert.ok(summary);
    assert.equal(summary.sides.length, 2);
    assert.ok(summary.ticksLeft > 0);
  });
});

describe("SuccessionCrisis — player backing", () => {
  let store;
  let kid;
  beforeEach(() => {
    store = mockStore();
    kid = seedKingdom(store).id;
    seedOffices(kid, ["Lord Commander A", "Chancellor B"]);
    const kingdom = store.load().kingdoms[kid];
    Succession.openSuccessionCrisis(kingdom, store, seqRng(0.5));
  });

  it("a player can back a claimant with influence", () => {
    const player = mockPlayer({ [kid]: 100 });
    const crisis = store.load().succession.crises[0];
    const claimant = crisis.claimants[0];
    const before = claimant.strength;
    const result = Succession.backClaimant(player, kid, claimant.id, store);
    assert.equal(result.ok, true);
    assert.ok(claimant.strength > before, "backing should boost strength");
    assert.ok(claimant.backers.includes("TestPlayer"));
  });

  it("a player cannot back two claimants in one crisis", () => {
    const player = mockPlayer({ [kid]: 100 });
    const crisis = store.load().succession.crises[0];
    const first = Succession.backClaimant(player, kid, crisis.claimants[0].id, store);
    assert.equal(first.ok, true);
    const second = Succession.backClaimant(player, kid, crisis.claimants[1].id, store);
    assert.equal(second.ok, false);
    assert.equal(second.reason, "already-backed");
  });

  it("backing fails without influence", () => {
    const player = mockPlayer({ [kid]: 5 });
    const crisis = store.load().succession.crises[0];
    const result = Succession.backClaimant(player, kid, crisis.claimants[0].id, store);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "insufficient");
  });

  it("backing fails with no open crisis", () => {
    const player = mockPlayer({ [kid]: 100 });
    const result = Succession.backClaimant(player, "otherland", "nope", store);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "no-crisis");
  });
});

describe("SuccessionCrisis — abdication", () => {
  it("a long-reigning ruler may abdicate and name a successor", () => {
    const store = mockStore();
    const kid = seedKingdom(store, { foundedAt: Date.now() - 100 * 24 * 3600 * 1000 }).id;
    seedOffices(kid, ["Lord Commander A"]);
    // rng: death roll fails (0.99 > chance), abdication succeeds (0.0), heir named (0.1).
    const events = Succession.councilSuccessionTick(store, { rng: seqRng(0.99, 0.0, 0.1) });
    const changed = events.find((e) => e.type === "ruler-changed");
    assert.ok(changed, "expected abdication with named successor");
  });
});
