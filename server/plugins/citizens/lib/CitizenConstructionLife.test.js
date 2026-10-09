"use strict";

/**
 * CitizenConstructionLife.test.js — plain-node tests for construction tick dynamics.
 *
 * Run: node server/plugins/citizens/lib/CitizenConstructionLife.test.js
 */

const assert = require("node:assert/strict");

const Construction = require("./CitizenConstruction");
const { tickConstruction } = require("./CitizenConstructionLife");

let passed = 0;
let failed = 0;

function test(name, fn) {
  Construction.resetForTests();
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error(`FAIL: ${name}\n  ${e.message}`);
  }
}

function emptyDirector() {
  return {
    roster: new Map(),
    isOnline: () => false,
    getBot: () => null,
    log: () => {},
  };
}

function directorWith(kingdomId, usernames) {
  const roster = new Map();
  for (const u of usernames) {
    roster.set(u, { username: u, kingdomId, role: "commoner" });
  }
  return {
    roster,
    isOnline: () => false,
    getBot: () => null,
    log: () => {},
  };
}

test("tick never throws on an empty director", () => {
  tickConstruction(emptyDirector(), Date.now());
});

test("tick advances a building-phase project", () => {
  const bp = Construction.createBlueprint("bob", "granary");
  const r = Construction.commissionProject("varrock", bp.id, "bob");
  const p = Construction.project(r.id);
  Construction.donateMaterials(r.id, Object.assign({}, p.materialsNeeded));
  assert.equal(Construction.project(r.id).progress, 0);
  tickConstruction(directorWith("varrock", ["bob"]), Date.now());
  assert.equal(Construction.project(r.id).progress, 1);
});

test("tick completes a project at full progress", () => {
  const bp = Construction.createBlueprint("bob", "granary");
  const r = Construction.commissionProject("varrock", bp.id, "bob");
  const p = Construction.project(r.id);
  Construction.donateMaterials(r.id, Object.assign({}, p.materialsNeeded));
  Construction.progressProject(r.id, 10000);
  assert.equal(Construction.project(r.id).status, "complete");
  // Tick after completion: no throw, built record exists.
  tickConstruction(directorWith("varrock", ["bob"]), Date.now());
  assert.equal(Construction.builtFor("varrock").length, 1);
});

test("tick does not advance gathering-phase projects", () => {
  const bp = Construction.createBlueprint("bob", "granary");
  const r = Construction.commissionProject("varrock", bp.id, "bob");
  assert.equal(Construction.project(r.id).status, "gathering");
  tickConstruction(directorWith("varrock", ["bob"]), Date.now());
  assert.equal(Construction.project(r.id).progress, 0);
});

test("tick never throws with a null roster", () => {
  tickConstruction({ roster: null, log: () => {} }, Date.now());
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
