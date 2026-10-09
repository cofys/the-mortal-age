"use strict";

/**
 * CitizenSurgery.test.js — data-tier tests for advanced citizen medicine.
 *
 * Plain node:assert, no engine, no jest. Run with: node <this file>.
 */

const assert = require("node:assert");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const Surgery = require("./CitizenSurgery");

// Redirect saves to a temp file so tests never touch the real one.
const tmpSave = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "surgery-test-")), "surgery.json");
Surgery._setSavePathForTests(tmpSave);
Surgery.resetForTests();
// Inject fake material ids (no engine in tests).
Surgery._setMaterialIdsForTests({
  thread: 1001, bandage: 1002, splint: 1003, paper: 1004,
  clean_herb: 2001, super_restore: 2002,
});

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

console.log("CitizenSurgery data-tier tests:");

// --- catalog ---

test("procedure catalog has 4 procedures", () => {
  assert.strictEqual(Surgery.PROCEDURE_KEYS.length, 4);
  assert.ok(Surgery.procedureDef("stitch_wound"));
  assert.ok(Surgery.procedureDef("purge_plague"));
  assert.strictEqual(Surgery.procedureDef("nope"), null);
});

test("research catalog has 3 projects", () => {
  assert.strictEqual(Surgery.RESEARCH_KEYS.length, 3);
  assert.ok(Surgery.researchDef("plague_antidote"));
  assert.strictEqual(Surgery.researchDef("nope"), null);
});

test("stitch_wound cures infection, purge_plague needs research", () => {
  const stitch = Surgery.procedureDef("stitch_wound");
  assert.ok(stitch.cures.includes("infection"));
  assert.strictEqual(stitch.researchReq, null);
  const purge = Surgery.procedureDef("purge_plague");
  assert.strictEqual(purge.researchReq, "plague_antidote");
});

// --- surgeons ---

test("surgeon registry: register and check", () => {
  assert.strictEqual(Surgery.isSurgeon("Alice"), false);
  Surgery.registerSurgeon("Alice", Date.now());
  assert.strictEqual(Surgery.isSurgeon("Alice"), true);
  assert.strictEqual(Surgery.isSurgeon("alice"), true); // normalized
});

test("surgeonsOfKingdom filters by kingdom", () => {
  Surgery.registerSurgeon("Bob", Date.now());
  const roster = [
    { username: "Alice", kingdomId: "varrock" },
    { username: "Bob", kingdomId: "falador" },
    { username: "Cara", kingdomId: "varrock" },
  ];
  const v = Surgery.surgeonsOfKingdom("varrock", roster);
  assert.strictEqual(v.length, 1);
  assert.strictEqual(v[0].username, "Alice");
});

// --- wings ---

test("surgery wing: build once", () => {
  assert.strictEqual(Surgery.wingOf("varrock"), null);
  assert.strictEqual(Surgery.buildWing("varrock", Date.now()), true);
  assert.strictEqual(Surgery.buildWing("varrock", Date.now()), false); // already built
  const wing = Surgery.wingOf("varrock");
  assert.strictEqual(wing.beds, Surgery.SURGERY_WING_BEDS);
});

// --- procedures ---

test("schedule and complete a procedure", () => {
  const now = Date.now();
  assert.strictEqual(Surgery.scheduleProcedure("Dave", "stitch_wound", "Alice", "varrock", now), true);
  const p = Surgery.procedureOf("Dave");
  assert.strictEqual(p.status, "in_progress");
  assert.strictEqual(p.surgeon, "alice"); // normalized
  // Cannot double-schedule.
  assert.strictEqual(Surgery.scheduleProcedure("Dave", "stitch_wound", "Alice", "varrock", now), false);
  // Complete it.
  assert.strictEqual(Surgery.completeProcedure("Dave", true, now + 1000), true);
  assert.strictEqual(Surgery.procedureOf("Dave").status, "completed");
});

test("successChanceFor: base + skill bonus, capped", () => {
  const base = Surgery.successChanceFor("stitch_wound", 50, "varrock");
  assert.ok(base >= 0.84 && base <= 0.86, `base=${base}`);
  const skilled = Surgery.successChanceFor("stitch_wound", 80, "varrock");
  assert.ok(skilled > base, `skilled=${skilled} should exceed base=${base}`);
  assert.ok(skilled <= 0.95, "capped at 0.95");
  assert.strictEqual(Surgery.successChanceFor("nope", 99, "varrock"), 0);
});

test("procedureUnlocked: research-gated procedures need research", () => {
  assert.strictEqual(Surgery.procedureUnlocked("varrock", "stitch_wound"), true);
  assert.strictEqual(Surgery.procedureUnlocked("varrock", "purge_plague"), false);
  const now = Date.now();
  Surgery.startResearch("varrock", "plague_antidote", "Alice", now);
  Surgery.completeResearch("varrock", "plague_antidote", now + 1000);
  assert.strictEqual(Surgery.procedureUnlocked("varrock", "purge_plague"), true);
});

// --- research ---

test("research lifecycle: start, progress, complete", () => {
  const now = Date.now();
  assert.strictEqual(Surgery.researchStatus("falador", "field_medicine"), "not_started");
  assert.strictEqual(Surgery.startResearch("falador", "field_medicine", "Bob", now), true);
  assert.strictEqual(Surgery.startResearch("falador", "field_medicine", "Bob", now), false); // already started
  assert.strictEqual(Surgery.researchStatus("falador", "field_medicine"), "in_progress");
  const progress = Surgery.researchProgress("falador", "field_medicine", now);
  assert.strictEqual(progress, 0);
  // 36 hours later it should be done.
  const done = Surgery.researchProgress("falador", "field_medicine", now + 37 * 3600 * 1000);
  assert.strictEqual(done, 1);
  assert.strictEqual(Surgery.completeResearch("falador", "field_medicine", now + 37 * 3600 * 1000), true);
  assert.strictEqual(Surgery.researchDone("falador", "field_medicine"), true);
});

test("field_medicine research boosts success chance", () => {
  // falador completed field_medicine above; varrock did not.
  const withBonus = Surgery.successChanceFor("stitch_wound", 50, "falador");
  const without = Surgery.successChanceFor("stitch_wound", 50, "varrock");
  assert.ok(withBonus > without, `with=${withBonus} without=${without}`);
});

// --- quarantine ---

test("quarantine: add, check, release, capacity", () => {
  const now = Date.now();
  assert.strictEqual(Surgery.isQuarantined("Eve"), false);
  assert.strictEqual(Surgery.quarantinePatient("Eve", "varrock", now), true);
  assert.strictEqual(Surgery.isQuarantined("Eve"), true);
  assert.strictEqual(Surgery.isQuarantined("eve"), true); // normalized
  assert.deepStrictEqual(Surgery.quarantineOf("varrock"), ["eve"]);
  // Cannot double-quarantine.
  assert.strictEqual(Surgery.quarantinePatient("Eve", "varrock", now), false);
  // Release.
  assert.strictEqual(Surgery.releaseFromQuarantine("Eve", "varrock"), true);
  assert.strictEqual(Surgery.isQuarantined("Eve"), false);
});

test("quarantine capacity is enforced", () => {
  const now = Date.now();
  for (let i = 0; i < Surgery.QUARANTINE_BEDS; i++) {
    assert.strictEqual(Surgery.quarantinePatient(`Patient${i}`, "falador", now), true);
  }
  // One more should fail — full.
  assert.strictEqual(Surgery.quarantinePatient("Extra", "falador", now), false);
});

// --- player surgery ---

test("player surgery requests queue correctly", () => {
  const now = Date.now();
  assert.strictEqual(Surgery.requestSurgeryForPlayer("RealPlayer1", "stitch_wound", "varrock", now), true);
  const p = Surgery.procedureOf("RealPlayer1");
  assert.strictEqual(p.status, "queued");
  assert.strictEqual(p.isPlayer, true);
  // Cannot double-queue... (queued is not in_progress, so this would re-queue;
  // the guard is on in_progress. Re-queue overwrites — acceptable.)
});

// --- persistence ---

test("save and reload round-trip", () => {
  assert.strictEqual(Surgery.save(), true); // dirty from above
  Surgery.resetForTests();
  Surgery._setSavePathForTests(tmpSave);
  Surgery._setMaterialIdsForTests({ thread: 1001 });
  // After reset, the surgeon registry should reload from disk.
  assert.strictEqual(Surgery.isSurgeon("Alice"), true);
});

console.log(`\n${passed} tests passed.`);
