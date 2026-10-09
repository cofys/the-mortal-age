"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const Faith = require("./CitizenFaith");

function tmpSave() {
  const p = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "faith-")),
    "citizen-faith.json"
  );
  Faith._setSavePathForTests(p);
  Faith.resetForTests();
  return p;
}

test("god catalog has six gods with required fields", () => {
  assert.equal(Faith.GOD_KEYS.length, 6);
  for (const key of Faith.GOD_KEYS) {
    const g = Faith.godOf(key);
    assert.ok(g.name, key);
    assert.ok(g.epithet, key);
    assert.ok(Array.isArray(g.domains) && g.domains.length > 0, key);
    assert.ok(Array.isArray(g.favoredTraits), key);
    assert.ok(Array.isArray(g.opposed), key);
    assert.ok(g.holyDay, key);
  }
});

test("saradomin and zamorak oppose each other", () => {
  assert.ok(Faith.godOf("saradomin").opposed.includes("zamorak"));
  assert.ok(Faith.godOf("zamorak").opposed.includes("saradomin"));
  assert.equal(Faith.godOf("guthix").opposed.length, 0);
});

test("faithOf returns null for the faithless (no auto-create)", () => {
  tmpSave();
  assert.equal(Faith.faithOf("Nobody Here"), null);
  assert.equal(Faith.devotionOf("Nobody Here"), 0);
  assert.equal(Faith.isPriest("Nobody Here"), false);
});

test("setFaith stores god and clamps devotion", () => {
  tmpSave();
  const rec = Faith.setFaith("Alice", "saradomin", 150);
  assert.equal(rec.god, "saradomin");
  assert.equal(rec.devotion, 100);
  assert.equal(Faith.faithOf("alice").god, "saradomin");
  Faith.setFaith("Bob", "zamorak", -20);
  assert.equal(Faith.devotionOf("bob"), 0);
});

test("setFaith rejects unknown gods", () => {
  tmpSave();
  assert.equal(Faith.setFaith("Alice", "not-a-god", 50), null);
});

test("adjustDevotion clamps to 0..100", () => {
  tmpSave();
  Faith.setFaith("Alice", "guthix", 90);
  Faith.adjustDevotion("alice", 30);
  assert.equal(Faith.devotionOf("alice"), 100);
  Faith.adjustDevotion("alice", -200);
  assert.equal(Faith.devotionOf("alice"), 0);
});

test("chooseGodFor: family faith wins", () => {
  const record = { personality: { traits: ["ambitious"] }, kingdomId: "asgarnia" };
  assert.equal(
    Faith.chooseGodFor(record, { familyGod: "guthix" }),
    "guthix"
  );
});

test("chooseGodFor: personality traits pick the god", () => {
  assert.equal(
    Faith.chooseGodFor({ personality: { traits: ["dutiful", "honest"] } }, {}),
    "saradomin"
  );
  assert.equal(
    Faith.chooseGodFor({ personality: { traits: ["ambitious", "bold"] } }, {}),
    "zamorak"
  );
  assert.equal(
    Faith.chooseGodFor({ personality: { traits: ["easygoing", "patient"] } }, {}),
    "guthix"
  );
});

test("chooseGodFor: kingdom patron as fallback", () => {
  assert.equal(
    Faith.chooseGodFor({ personality: { traits: [] }, kingdomId: "morytania" }, {}),
    "zamorak"
  );
  assert.equal(
    Faith.chooseGodFor({ personality: { traits: [] }, kingdomId: "nowhere" }, {}),
    "hearthmother"
  );
});

test("prayerBonus scales with devotion, priests pray deeper", () => {
  tmpSave();
  Faith.setFaith("Alice", "saradomin", 45);
  assert.equal(Faith.prayerBonus("alice"), 4);
  Faith.setPriest("alice", true);
  assert.equal(Faith.prayerBonus("alice"), 6);
  assert.equal(Faith.prayerBonus("nobody"), 0);
});

test("convert changes god and resets devotion", () => {
  tmpSave();
  Faith.setFaith("Alice", "saradomin", 90);
  Faith.setPriest("alice", true);
  const rec = Faith.convert("alice", "zamorak");
  assert.equal(rec.god, "zamorak");
  assert.equal(rec.devotion, 30);
  assert.equal(rec.priest, false);
});

test("forgetCitizen removes faith", () => {
  tmpSave();
  Faith.setFaith("Alice", "saradomin", 50);
  assert.equal(Faith.forgetCitizen("alice"), true);
  assert.equal(Faith.faithOf("alice"), null);
  assert.equal(Faith.forgetCitizen("alice"), false);
});

test("save and reload round-trip", () => {
  const p = tmpSave();
  Faith.setFaith("Alice", "wanderer", 66);
  Faith.setPriest("alice", true);
  assert.equal(Faith.save(), true);
  Faith.resetForTests();
  Faith._setSavePathForTests(p);
  assert.equal(Faith.faithOf("alice").god, "wanderer");
  assert.equal(Faith.isPriest("alice"), true);
  assert.equal(Faith.save(), false, "clean save returns false");
});

test("templeBonus returns 0 when Castle module is absent", () => {
  // Defensive: never throws, never NaN.
  const b = Faith.templeBonus("asgarnia");
  assert.ok(Number.isInteger(b) && b >= 0 && b <= 3);
});

test("holyWarBetween returns false without war state", () => {
  assert.equal(Faith.holyWarBetween("asgarnia", "morytania"), false);
  assert.equal(Faith.holyWarBetween("asgarnia", "asgarnia"), false);
  assert.equal(Faith.holyWarBetween("", "morytania"), false);
});

test("faithSummary returns readable record", () => {
  tmpSave();
  Faith.setFaith("Alice", "hearthmother", 72);
  const s = Faith.faithSummary("alice");
  assert.equal(s.godName, "The Hearthmother");
  assert.equal(s.devotion, 72);
  assert.equal(s.priest, false);
  assert.equal(Faith.faithSummary("nobody"), null);
});
