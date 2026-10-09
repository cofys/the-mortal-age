"use strict";

/**
 * CitizenInfrastructureLife.test.js — plain-node tests for the
 * public-works infrastructure slow tick.
 *
 * Run: node server/plugins/citizens/lib/CitizenInfrastructureLife.test.js
 */

const assert = require("assert");

const Infra = require("./CitizenInfrastructure");
const Life = require("./CitizenInfrastructureLife");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    Infra.resetForTests();
    Life.resetForTests();
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL - ${name}: ${err.message}`);
  }
}

function emptyDirector() {
  return {
    roster: { values: () => [] },
    log: () => {},
  };
}

console.log("CitizenInfrastructureLife tests:");

test("tick never throws on an empty director", () => {
  Life.tickInfrastructure(emptyDirector(), Date.now());
});

test("tick never throws when the data tier is missing", () => {
  // Simulate a broken require by ticking with a director whose roster throws.
  const d = { get roster() { throw new Error("boom"); }, log: () => {} };
  Life.tickInfrastructure(d, Date.now());
});

test("tick advances material-stocked projects", () => {
  const r = Infra.commissionProject("watchtower", "varrock", "bob", {});
  assert.strictEqual(r.ok, true);
  const spec = Infra.specFor("watchtower");
  const mats = {};
  for (const [id, need] of Object.entries(spec.materials)) mats[id] = need;
  Infra.donateMaterials(r.project.id, mats);
  const before = Infra.project(r.project.id).progress;
  Life.tickInfrastructure(emptyDirector(), Date.now());
  const after = Infra.project(r.project.id);
  // Either advanced by 1 or completed (both are honest progress).
  assert.ok(after === null || after.progress === before + 1, "project did not advance");
});

test("tick does not advance projects awaiting materials", () => {
  const r = Infra.commissionProject("watchtower", "varrock", "bob", {});
  const before = Infra.project(r.project.id).progress;
  Life.tickInfrastructure(emptyDirector(), Date.now());
  assert.strictEqual(Infra.project(r.project.id).progress, before);
});

test("tick completes finished projects into built records", () => {
  const r = Infra.commissionProject("watchtower", "varrock", "bob", {});
  const spec = Infra.specFor("watchtower");
  const mats = {};
  for (const [id, need] of Object.entries(spec.materials)) mats[id] = need;
  Infra.donateMaterials(r.project.id, mats);
  // Push progress to one tick from completion.
  Infra.progressProject(r.project.id, spec.workTicks - 1);
  Life.tickInfrastructure(emptyDirector(), Date.now());
  assert.strictEqual(Infra.builtFor("varrock").length, 1);
  assert.strictEqual(Infra.project(r.project.id), null);
});

test("tick promotes engineer-career citizens with Construction 40+", () => {
  const director = {
    roster: {
      values: () => [
        { username: "Enga", kingdomId: "varrock", career: "engineer", skills: { construction: 45 } },
        { username: "Novice", kingdomId: "varrock", career: "engineer", skills: { construction: 12 } },
        { username: "Smith", kingdomId: "varrock", career: "blacksmith", skills: { construction: 99 } },
      ],
    },
    log: () => {},
  };
  Life.tickInfrastructure(director, Date.now());
  assert.ok(Infra.engineerFor("enga"), "qualified engineer not registered");
  assert.strictEqual(Infra.engineerFor("novice"), null, "under-leveled citizen registered");
  assert.strictEqual(Infra.engineerFor("smith"), null, "wrong career registered");
});

test("tick does not re-register existing engineers", () => {
  Infra.registerEngineer("Enga", "varrock", 45);
  const before = Infra.engineersFor("varrock").length;
  const director = {
    roster: {
      values: () => [
        { username: "Enga", kingdomId: "varrock", career: "engineer", skills: { construction: 45 } },
      ],
    },
    log: () => {},
  };
  Life.tickInfrastructure(director, Date.now());
  assert.strictEqual(Infra.engineersFor("varrock").length, before);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
