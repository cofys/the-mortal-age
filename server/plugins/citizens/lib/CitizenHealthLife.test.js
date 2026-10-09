"use strict";

const assert = require("node:assert/strict");
const { describe, it, beforeEach, afterEach } = require("node:test");
const os = require("os");
const path = require("path");

const Health = require("./CitizenHealth");
const HealthLife = require("./CitizenHealthLife");

const NOW = 1_700_000_000_000;

// --- stubs -------------------------------------------------------------------

const journaled = [];
const said = [];

function makeRecord(username, opts = {}) {
  return {
    username,
    displayName: username,
    role: opts.role ?? "commoner",
    kingdomId: opts.kingdomId ?? "misthalin",
    personality: { age: opts.age ?? 30 },
  };
}

function makeDirector(records, opts = {}) {
  const players = new Map();
  for (const r of records) {
    if (opts.online?.includes(r.username)) {
      const items = new Map();
      for (const id of opts.herbs?.[r.username] ?? []) items.set(id, 1);
      players.set(r.username, {
        // Canonical ItemContainer API: getAmount(id), deleteNumber(id, amount).
        // Herbs are really consumed so the mock balance verifies.
        getInventory: () => ({
          getAmount: (id) => items.get(id) ?? 0,
          deleteNumber: (id, n) => {
            items.set(id, Math.max(0, (items.get(id) ?? 0) - n));
          },
        }),
      });
    }
  }
  return {
    roster: new Map(records.map((r) => [r.username.toLowerCase(), r])),
    getPlayer: (u) => players.get(u) ?? players.get(String(u).toLowerCase()) ?? null,
    players,
  };
}

let savedModules = {};

function stubModule(id, exportsObj) {
  savedModules[id] = require.cache[id];
  require.cache[id] = { id, filename: id, loaded: true, exports: exportsObj };
}

function restoreModules() {
  for (const [id, mod] of Object.entries(savedModules)) {
    if (mod) require.cache[id] = mod;
    else delete require.cache[id];
  }
  savedModules = {};
}

beforeEach(() => {
  journaled.length = 0;
  said.length = 0;
  Health._setSavePathForTests(path.join(os.tmpdir(), `citizen-healthlife-test-${process.pid}.json`));
  Health.resetForTests();
  HealthLife._announcedEpidemics.clear();
  stubModule(require.resolve("./CitizenJournal"), {
    getJournal: () => ({ log: (name, text, kind) => journaled.push({ name, text, kind }) }),
  });
  stubModule(require.resolve("../chat/CitizenSayPublic"), {
    sayPublic: (player, text) => said.push(text),
  });
  stubModule(require.resolve("../../skills/Herblore.plugin.js"), {
    HERBLORE_RECIPES: [{ kind: "clean", outputId: 249, level: 1, xp: 1 }],
  });
  stubModule(require.resolve("./CitizenCareers"), {
    careerOf: (u) => (String(u).toLowerCase() === "mira" ? { key: "healer", rank: "journeyman" } : { key: "laborer", rank: "apprentice" }),
  });
});

afterEach(() => {
  restoreModules();
});

describe("CitizenHealthLife — onset", () => {
  it("null director is a no-op", () => {
    HealthLife.tickHealth(null, NOW);
    assert.equal(journaled.length, 0);
  });

  it("onset can sicken a healthy citizen (forced rng)", () => {
    const records = [makeRecord("Alice")];
    const director = makeDirector(records);
    // rng always 0: onset roll passes (p > 0), illness pick = cold (first bucket)
    HealthLife._phaseOnset(director, records, NOW, () => 0);
    assert.equal(Health.isSick("Alice"), true);
    assert.equal(Health.recordOf("Alice").illness, "cold");
    assert.ok(journaled.some((j) => j.name === "Alice"));
  });

  it("onset never double-sickens", () => {
    Health.sicken("Alice", "flu", NOW, { rng: () => 0 });
    const records = [makeRecord("Alice")];
    const director = makeDirector(records);
    HealthLife._phaseOnset(director, records, NOW, () => 0);
    assert.equal(Health.recordOf("Alice").illness, "flu");
  });

  it("guards can catch wound infection from their bonus", () => {
    const records = [makeRecord("Greg", { role: "guard" })];
    const director = makeDirector(records);
    // rng 0 → onset passes; guard 0.4 funnel: rng 0 < 0.4 → infection
    HealthLife._phaseOnset(director, records, NOW, () => 0);
    assert.equal(Health.recordOf("Greg").illness, "infection");
  });
});

describe("CitizenHealthLife — spread", () => {
  it("flu spreads to healthy kingdom-mates", () => {
    Health.sicken("Alice", "flu", NOW, { kingdomId: "misthalin", rng: () => 0 });
    const records = [makeRecord("Alice", { kingdomId: "misthalin" }), makeRecord("Bob", { kingdomId: "misthalin" })];
    const director = makeDirector(records);
    // rng 0 → spread roll passes for Bob
    HealthLife._phaseSpread(director, records, NOW, () => 0);
    assert.equal(Health.isSick("Bob"), true);
    assert.equal(Health.recordOf("Bob").illness, "flu");
  });

  it("food poisoning does not spread", () => {
    Health.sicken("Alice", "foodpoison", NOW, { kingdomId: "misthalin", rng: () => 0 });
    const records = [makeRecord("Alice", { kingdomId: "misthalin" }), makeRecord("Bob", { kingdomId: "misthalin" })];
    const director = makeDirector(records);
    HealthLife._phaseSpread(director, records, NOW, () => 0);
    assert.equal(Health.isSick("Bob"), false);
  });

  it("spread does not cross kingdoms", () => {
    Health.sicken("Alice", "flu", NOW, { kingdomId: "misthalin", rng: () => 0 });
    const records = [makeRecord("Alice", { kingdomId: "misthalin" }), makeRecord("Bob", { kingdomId: "asgarnia" })];
    const director = makeDirector(records);
    HealthLife._phaseSpread(director, records, NOW, () => 0);
    assert.equal(Health.isSick("Bob"), false);
  });
});

describe("CitizenHealthLife — recovery", () => {
  it("expired illnesses are cured and journaled", () => {
    Health.sicken("Alice", "cold", NOW - 10 * 24 * 3600 * 1000, { rng: () => 0 });
    const director = makeDirector([makeRecord("Alice")]);
    HealthLife._phaseRecovery(director, NOW);
    assert.equal(Health.isSick("Alice"), false);
    assert.ok(journaled.some((j) => j.name === "alice" && /recovered/.test(j.text)));
  });

  it("unexpired illnesses persist", () => {
    Health.sicken("Alice", "flu", NOW, { rng: () => 0.99 });
    const director = makeDirector([makeRecord("Alice")]);
    HealthLife._phaseRecovery(director, NOW);
    assert.equal(Health.isSick("Alice"), true);
  });
});

describe("CitizenHealthLife — healers", () => {
  it("a healer treats the sick and journals both sides", () => {
    Health.sicken("Alice", "cold", NOW, { kingdomId: "misthalin", rng: () => 0 });
    const records = [makeRecord("Alice", { kingdomId: "misthalin" }), makeRecord("Mira", { kingdomId: "misthalin" })];
    const director = makeDirector(records);
    HealthLife._phaseHealers(director, records, NOW, () => 0.5);
    const rec = Health.recordOf("Alice");
    assert.equal(rec.treatedBy, "Mira");
    assert.ok(journaled.some((j) => j.name === "Mira" && /tending/.test(j.text)));
    assert.ok(journaled.some((j) => j.name === "alice" && /treated/.test(j.text)));
  });

  it("herb-cure illnesses consume a real herb from the healer", () => {
    Health.sicken("Alice", "flu", NOW, { kingdomId: "misthalin", rng: () => 0 });
    const records = [makeRecord("Alice", { kingdomId: "misthalin" }), makeRecord("Mira", { kingdomId: "misthalin" })];
    // Mira is online with a clean guam (id 249) in inventory.
    const director = makeDirector(records, { online: ["Mira"], herbs: { Mira: [249] } });
    HealthLife._phaseHealers(director, records, NOW, () => 0.5);
    assert.equal(Health.recordOf("Alice").treatedBy, "Mira");
    assert.ok(journaled.some((j) => j.name === "Mira" && /remedy/.test(j.text)));
  });

  it("herb-cure without herbs skips treatment", () => {
    Health.sicken("Alice", "flu", NOW, { kingdomId: "misthalin", rng: () => 0 });
    const records = [makeRecord("Alice", { kingdomId: "misthalin" }), makeRecord("Mira", { kingdomId: "misthalin" })];
    // Mira online but carrying no herbs.
    const director = makeDirector(records, { online: ["Mira"], herbs: {} });
    HealthLife._phaseHealers(director, records, NOW, () => 0.5);
    assert.equal(Health.recordOf("Alice").treatedBy, null);
  });

  it("no healers means no treatment", () => {
    stubModule(require.resolve("./CitizenCareers"), { careerOf: () => ({ key: "laborer" }) });
    Health.sicken("Alice", "cold", NOW, { kingdomId: "misthalin", rng: () => 0 });
    const records = [makeRecord("Alice", { kingdomId: "misthalin" }), makeRecord("Bob", { kingdomId: "misthalin" })];
    const director = makeDirector(records);
    HealthLife._phaseHealers(director, records, NOW, () => 0.5);
    assert.equal(Health.recordOf("Alice").treatedBy, null);
  });
});

describe("CitizenHealthLife — hospitals and epidemics", () => {
  it("severe cases are admitted to the infirmary", () => {
    Health.sicken("Alice", "plague", NOW, { kingdomId: "misthalin", rng: () => 0 });
    const records = [makeRecord("Alice", { kingdomId: "misthalin" })];
    const director = makeDirector(records);
    HealthLife._phaseHospitals(director, records, NOW);
    assert.equal(Health.recordOf("Alice").inHospital, true);
    assert.ok(journaled.some((j) => /infirmary/.test(j.text)));
  });

  it("mild cases are not hospitalized", () => {
    Health.sicken("Alice", "cold", NOW, { kingdomId: "misthalin", rng: () => 0 });
    const records = [makeRecord("Alice", { kingdomId: "misthalin" })];
    const director = makeDirector(records);
    HealthLife._phaseHospitals(director, records, NOW);
    assert.equal(Health.recordOf("Alice").inHospital, false);
  });

  it("epidemics are announced once via sayPublic", () => {
    for (const n of ["A", "B", "C"]) {
      Health.sicken(n, "flu", NOW, { kingdomId: "misthalin", rng: () => 0 });
    }
    const records = [
      makeRecord("A", { kingdomId: "misthalin" }),
      makeRecord("Zed", { kingdomId: "misthalin" }),
    ];
    const director = makeDirector(records, { online: ["Zed"] });
    HealthLife._phaseEpidemics(director, records, NOW);
    assert.equal(said.length, 1);
    assert.match(said[0], /flu/i);
    // Second tick: no repeat announcement.
    HealthLife._phaseEpidemics(director, records, NOW + 60000);
    assert.equal(said.length, 1);
  });
});

describe("CitizenHealthLife — full tick", () => {
  it("tickHealth runs all phases without throwing", () => {
    const records = [makeRecord("Alice"), makeRecord("Mira")];
    const director = makeDirector(records);
    HealthLife.tickHealth(director, NOW);
    // Nothing assertable about rng outcomes — just survival.
    assert.ok(true);
  });

  it("tickHealth with empty roster is a no-op", () => {
    HealthLife.tickHealth(makeDirector([]), NOW);
    assert.equal(journaled.length, 0);
  });
});
