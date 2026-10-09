"use strict";

/**
 * CitizenScience.test.js — data-tier tests for experimental citizen science.
 *
 * Plain node:assert, no engine, no jest. Run with: node <this file>.
 */

const assert = require("node:assert");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const Science = require("./CitizenScience");

// Redirect saves to a temp file so tests never touch the real one.
const tmpSave = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "science-test-")), "science.json");
Science._setSavePathForTests(tmpSave);
Science.resetForTests();

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok: ${name}`);
  } catch (e) {
    console.error(`  FAIL: ${name}\n    ${e.message}`);
    process.exitCode = 1;
  }
}

console.log("CitizenScience data-tier tests:");

// --- fields & catalog ---

test("five science fields are defined", () => {
  assert.deepStrictEqual(Science.FIELD_IDS.sort(), ["agriculture", "alchemy", "astronomy", "medicine", "metallurgy"].sort());
});

test("medicine maps to herblore, astronomy has no skill", () => {
  assert.strictEqual(Science.FIELDS.medicine.skill, "herblore");
  assert.strictEqual(Science.FIELDS.astronomy.skill, null);
});

test("experiment catalog has 10 experiments across all fields", () => {
  assert.strictEqual(Science.experimentIds().length, 10);
  const fields = new Set(Science.experimentIds().map((id) => Science.experiment(id).field));
  assert.strictEqual(fields.size, 5);
});

test("every experiment maps to a real discovery", () => {
  for (const id of Science.experimentIds()) {
    const tmpl = Science.experiment(id);
    assert.ok(Science.DISCOVERIES[tmpl.discoveryId], `missing discovery ${tmpl.discoveryId}`);
  }
});

test("unknown experiment id returns null", () => {
  assert.strictEqual(Science.experiment("nope"), null);
});

// --- scientists ---

test("register scientist creates a record", () => {
  const rec = Science.registerScientist("Ada", "medicine");
  assert.ok(rec);
  assert.strictEqual(rec.field, "medicine");
  assert.strictEqual(Science.scientistFor("ada").username, "Ada");
});

test("register with bad field returns null", () => {
  assert.strictEqual(Science.registerScientist("Bob", "astrology"), null);
});

test("register is idempotent", () => {
  const a = Science.registerScientist("Ada", "medicine");
  const b = Science.registerScientist("Ada", "alchemy");
  assert.strictEqual(a, b);
  assert.strictEqual(b.field, "medicine"); // first field wins
});

test("setSkillLevel updates level", () => {
  Science.setSkillLevel("Ada", 55);
  assert.strictEqual(Science.scientistFor("Ada").skillLevel, 55);
});

// --- experiments ---

test("start experiment requires lab level", () => {
  // alloy_mixing needs lab level 3; fresh lab is level 1
  const exp = Science.startExperiment("Ada", "alloy_mixing", "varrock");
  assert.strictEqual(exp, null);
});

test("start experiment works at sufficient lab level", () => {
  // bump the lab
  Science.labFor("varrock").level = 3;
  const exp = Science.startExperiment("Ada", "antiseptic_trial", "varrock");
  assert.ok(exp);
  assert.strictEqual(exp.status, "running");
  assert.strictEqual(exp.progress, 0);
});

test("experimentFor finds the running experiment", () => {
  const exp = Science.experimentFor("Ada");
  assert.ok(exp);
  assert.strictEqual(exp.templateId, "antiseptic_trial");
});

test("advance experiment accumulates progress", () => {
  const exp = Science.experimentFor("Ada");
  Science.advanceExperiment(exp.id, 5);
  assert.strictEqual(Science.experimentFor("Ada").progress, 5);
});

test("complete experiment marks status", () => {
  const exp = Science.experimentFor("Ada");
  Science.completeExperiment(exp.id, true);
  assert.strictEqual(Science.experimentFor("Ada"), null); // no longer running
  assert.strictEqual(Science.load().experiments[exp.id].status, "succeeded");
});

// --- discoveries ---

test("record discovery creates a persistent record", () => {
  const d = Science.recordDiscovery("antisepsis", "Ada", "varrock", true);
  assert.ok(d);
  assert.strictEqual(d.discoverer, "Ada");
  assert.strictEqual(d.verified, true);
  assert.ok(Science.hasDiscovery("varrock", "antisepsis"));
});

test("record discovery is idempotent per kingdom", () => {
  const a = Science.recordDiscovery("antisepsis", "Ada", "varrock", true);
  const b = Science.recordDiscovery("antisepsis", "Zed", "varrock", false);
  assert.strictEqual(a, b);
});

test("discoveries are kingdom-scoped", () => {
  assert.strictEqual(Science.hasDiscovery("lumbridge", "antisepsis"), false);
  Science.recordDiscovery("antisepsis", "Zed", "lumbridge", false);
  assert.strictEqual(Science.hasDiscovery("lumbridge", "antisepsis"), true);
});

test("discovery bonus sums effects, verified counts double", () => {
  // varrock: antisepsis verified (0.25 * 2 = 0.5)
  assert.strictEqual(Science.surgeryResearchBonusFor("varrock"), 0.5);
  // lumbridge: antisepsis unverified (0.25)
  assert.strictEqual(Science.surgeryResearchBonusFor("lumbridge"), 0.25);
});

test("growth bonus reads farm_growth effects", () => {
  Science.recordDiscovery("crop_rotation_method", "Ada", "varrock", false);
  assert.ok(Science.growthBonusFor("varrock") > 0);
  assert.strictEqual(Science.growthBonusFor("nowhere"), 0);
});

test("unknown discovery id returns null", () => {
  assert.strictEqual(Science.recordDiscovery("phlogiston", "Ada", "varrock", false), null);
});

// --- labs ---

test("lab defaults to level 1", () => {
  const lab = Science.labFor("falador");
  assert.strictEqual(lab.level, 1);
});

// --- grants ---

test("award grant records funding", () => {
  const g = Science.awardGrant("varrock", "Ada", "exp_1", 500);
  assert.ok(g.id);
  assert.strictEqual(g.amount, 500);
  assert.strictEqual(Science.grantsFor("Ada").length, 1);
});

test("grant amount is capped", () => {
  const g = Science.awardGrant("varrock", "Ada", "exp_2", 99999);
  assert.ok(g.amount <= Science.GRANT_MAX_COINS);
});

// --- publications ---

test("publish records a publication and marks grants published", () => {
  Science.publish("Ada", "On Antisepsis", "medicine", true);
  const pubs = Science.recentPublications(5);
  assert.ok(pubs.some((p) => p.title === "On Antisepsis"));
  assert.ok(Science.grantsFor("Ada").every((g) => g.published));
});

// --- persistence ---

test("save and reload round-trips", () => {
  assert.ok(Science.save());
  Science.resetForTests();
  Science._setSavePathForTests(tmpSave);
  // cache was cleared; reload from disk
  const st = Science.load();
  assert.ok(st.scientists["ada"], "scientist survived reload");
  assert.ok(st.discoveries["varrock:antisepsis"], "discovery survived reload");
});

// --- teaching ---

test("teaching bonus requires 3+ discoveries", () => {
  Science.registerScientist("Teacher", "medicine");
  assert.strictEqual(Science.teachingBonusFor("Teacher"), 0);
  const rec = Science.scientistFor("Teacher");
  rec.discoveries = 5;
  assert.ok(Science.teachingBonusFor("Teacher") > 0);
  assert.strictEqual(Science.teachingBonusFor("Nobody"), 0);
});

console.log(`\n${passed} tests passed.`);
