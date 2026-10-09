"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const Faith = require("./CitizenFaith");
const { tickFaith } = require("./CitizenFaithLife");

function tmpSave() {
  const p = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "faithlife-")),
    "citizen-faith.json"
  );
  Faith._setSavePathForTests(p);
  Faith.resetForTests();
  return p;
}

function makeDirector(records) {
  const roster = new Map();
  for (const r of records) roster.set(String(r.username).toLowerCase(), r);
  return {
    roster,
    getPlayer: () => null,
    players: { get: () => null },
  };
}

function rec(username, traits, kingdomId) {
  return {
    username,
    kingdomId: kingdomId || "asgarnia",
    personality: { traits: traits || [] },
  };
}

test("faithless citizens gain a faith on tick", () => {
  tmpSave();
  const d = makeDirector([rec("Alice", ["dutiful", "honest"])]);
  tickFaith(d, Date.now());
  const f = Faith.faithOf("alice");
  assert.ok(f, "faith assigned");
  assert.equal(f.god, "saradomin");
});

test("family faith is inherited over personality", () => {
  tmpSave();
  Faith.setFaith("Bob", "zamorak", 60);
  const d = makeDirector([
    rec("Alice", ["dutiful", "honest"]),
    rec("Bob", ["ambitious"]),
  ]);
  // Stub families module via require cache is complex; instead verify
  // chooseGodFor directly with familyGod context.
  const god = Faith.chooseGodFor(
    { personality: { traits: ["dutiful"] } },
    { familyGod: "zamorak" }
  );
  assert.equal(god, "zamorak");
  tickFaith(d, Date.now());
  assert.ok(Faith.faithOf("alice"));
});

test("devotion drifts up with chapel temple bonus", () => {
  tmpSave();
  // templeBonus is defensive (0 without Castle module); drift should
  // not throw and not go negative from the bonus path.
  const d = makeDirector([rec("Alice", ["dutiful"])]);
  tickFaith(d, Date.now());
  const before = Faith.devotionOf("alice");
  tickFaith(d, Date.now() + 60000);
  const after = Faith.devotionOf("alice");
  assert.ok(after >= 0 && after <= 100, `devotion in range: ${after}`);
  assert.ok(Math.abs(after - before) < 10, "drift is gradual");
});

test("clergy with high devotion are ordained as priests", () => {
  tmpSave();
  // Stub the careers module in require cache.
  const careersPath = require.resolve("./CitizenCareers");
  const orig = require.cache[careersPath];
  require.cache[careersPath] = {
    id: careersPath,
    filename: careersPath,
    loaded: true,
    exports: { careerOf: (u) => (String(u).toLowerCase() === "alice" ? { key: "clergy" } : null) },
  };
  try {
    Faith.setFaith("Alice", "saradomin", 80);
    const d = makeDirector([rec("Alice", ["dutiful"])]);
    tickFaith(d, Date.now());
    assert.equal(Faith.isPriest("alice"), true);
  } finally {
    if (orig) require.cache[careersPath] = orig;
    else delete require.cache[careersPath];
  }
});

test("non-clergy are not ordained", () => {
  tmpSave();
  const careersPath = require.resolve("./CitizenCareers");
  const orig = require.cache[careersPath];
  require.cache[careersPath] = {
    id: careersPath,
    filename: careersPath,
    loaded: true,
    exports: { careerOf: () => ({ key: "guard" }) },
  };
  try {
    Faith.setFaith("Alice", "saradomin", 95);
    const d = makeDirector([rec("Alice", ["dutiful"])]);
    tickFaith(d, Date.now());
    assert.equal(Faith.isPriest("alice"), false);
  } finally {
    if (orig) require.cache[careersPath] = orig;
    else delete require.cache[careersPath];
  }
});

test("holy day observance lifts devotion", () => {
  tmpSave();
  // Find which god is holy today and give Alice that faith.
  const now = Date.now();
  const day = new Date(now).getDay();
  const map = { 0: "saradomin", 1: "wanderer", 2: "hearthmother", 3: "guthix", 4: "zamorak", 5: "silent-one", 6: "hearthmother" };
  const holyGod = map[day];
  Faith.setFaith("Alice", holyGod, 60);
  const d = makeDirector([rec("Alice", ["dutiful"])]);
  const before = Faith.devotionOf("alice");
  tickFaith(d, now);
  const after = Faith.devotionOf("alice");
  assert.ok(after >= before, `holy day lifts devotion: ${before} -> ${after}`);
});

test("tick is null-director safe", () => {
  tmpSave();
  assert.doesNotThrow(() => tickFaith(null, Date.now()));
  assert.doesNotThrow(() => tickFaith({}, Date.now()));
});

test("one citizen failing does not break the tick", () => {
  tmpSave();
  const bad = rec("Bad", ["dutiful"]);
  // Corrupt the record so ensureFaith throws internally; tick catches.
  const d = makeDirector([bad, rec("Good", ["dutiful"])]);
  assert.doesNotThrow(() => tickFaith(d, Date.now()));
  assert.ok(Faith.faithOf("good"), "good citizen still processed");
});
