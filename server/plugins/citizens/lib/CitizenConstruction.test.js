"use strict";

/**
 * CitizenConstruction.test.js — plain-node tests for the real construction layer.
 *
 * Run: node server/plugins/citizens/lib/CitizenConstruction.test.js
 */

const assert = require("node:assert/strict");

const Construction = require("./CitizenConstruction");

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

// --- catalog ---------------------------------------------------------------

test("catalog has 10 regular buildings and 3 landmarks", () => {
  assert.equal(Object.keys(Construction.BUILDINGS).length, 10);
  assert.equal(Object.keys(Construction.LANDMARKS).length, 3);
});

test("isLandmark distinguishes landmarks from buildings", () => {
  assert.ok(Construction.isLandmark("grand_temple"));
  assert.ok(Construction.isLandmark("great_wall"));
  assert.ok(Construction.isLandmark("royal_palace"));
  assert.ok(!Construction.isLandmark("granary"));
  assert.ok(!Construction.isLandmark("nope"));
});

test("specFor returns the building spec", () => {
  const spec = Construction.specFor("granary");
  assert.ok(spec);
  assert.equal(spec.label, "granary");
  assert.ok(spec.materials);
  assert.ok(spec.effect);
});

// --- blueprints ------------------------------------------------------------

test("createBlueprint stores a persistent blueprint", () => {
  const res = Construction.createBlueprint("bob", "granary", "large", "stone");
  assert.ok(res.ok);
  const bp = Construction.blueprint(res.id);
  assert.ok(bp);
  assert.equal(bp.designer, "bob");
  assert.equal(bp.type, "granary");
  assert.equal(bp.size, "large");
  assert.equal(bp.style, "stone");
});

test("createBlueprint rejects unknown types", () => {
  const res = Construction.createBlueprint("bob", "death-star");
  assert.ok(!res.ok);
  assert.equal(res.reason, "unknown-type");
});

test("blueprintsFor lists a designer's blueprints", () => {
  Construction.createBlueprint("bob", "granary");
  Construction.createBlueprint("bob", "walls");
  Construction.createBlueprint("alice", "temple");
  assert.equal(Construction.blueprintsFor("bob").length, 2);
  assert.equal(Construction.blueprintsFor("alice").length, 1);
});

// --- projects --------------------------------------------------------------

test("commissionProject creates a private project", () => {
  const bp = Construction.createBlueprint("bob", "granary");
  const res = Construction.commissionProject("varrock", bp.id, "bob");
  assert.ok(res.ok);
  const proj = Construction.project(res.id);
  assert.ok(proj);
  assert.equal(proj.kingdomId, "varrock");
  assert.equal(proj.status, "gathering");
  assert.ok(!proj.royal);
});

test("commissionProject rejects missing blueprint", () => {
  const res = Construction.commissionProject("varrock", "bp_nope", "bob");
  assert.ok(!res.ok);
  assert.equal(res.reason, "no-blueprint");
});

test("royal commission fails honestly without treasury funds", () => {
  const bp = Construction.createBlueprint("crown-architect", "grand_temple");
  // No KingdomStore treasury in plain-node — degrades to treasury-unavailable.
  const res = Construction.commissionProject("varrock", bp.id, "crown", { royal: true });
  assert.ok(!res.ok);
  assert.ok(["insufficient-treasury", "treasury-unavailable"].includes(res.reason));
});

test("projectsFor lists active projects for a kingdom", () => {
  const bp1 = Construction.createBlueprint("bob", "granary");
  const bp2 = Construction.createBlueprint("bob", "walls");
  Construction.commissionProject("varrock", bp1.id, "bob");
  Construction.commissionProject("varrock", bp2.id, "bob");
  Construction.commissionProject("falador", bp1.id, "bob");
  assert.equal(Construction.projectsFor("varrock").length, 2);
  assert.equal(Construction.projectsFor("falador").length, 1);
});

test("activeProjectFor returns the first active project", () => {
  const bp = Construction.createBlueprint("bob", "granary");
  const res = Construction.commissionProject("varrock", bp.id, "bob");
  const active = Construction.activeProjectFor("varrock");
  assert.ok(active);
  assert.equal(active.id, res.id);
  assert.equal(Construction.activeProjectFor("nowhere"), null);
});

// --- materials -------------------------------------------------------------

test("donateMaterials accepts up to what's needed", () => {
  const bp = Construction.createBlueprint("bob", "granary");
  const res = Construction.commissionProject("varrock", bp.id, "bob");
  const proj = Construction.project(res.id);
  const need = proj.materialsNeeded;
  const itemId = Object.keys(need)[0];
  const over = need[itemId] + 100;
  const d = Construction.donateMaterials(res.id, { [itemId]: over });
  assert.ok(d.ok);
  assert.equal(d.donated[itemId], need[itemId]); // capped at need
});

test("donateMaterials moves project to building phase when complete", () => {
  const bp = Construction.createBlueprint("bob", "granary");
  const res = Construction.commissionProject("varrock", bp.id, "bob");
  const proj = Construction.project(res.id);
  assert.equal(proj.status, "gathering");
  Construction.donateMaterials(res.id, Object.assign({}, proj.materialsNeeded));
  assert.equal(Construction.project(res.id).status, "building");
});

test("materialsComplete is false until fully stocked", () => {
  const bp = Construction.createBlueprint("bob", "granary");
  const res = Construction.commissionProject("varrock", bp.id, "bob");
  const proj = Construction.project(res.id);
  assert.ok(!Construction.materialsComplete(proj));
});

// --- progress & completion -------------------------------------------------

test("progressProject completes and creates a built record with effects", () => {
  const bp = Construction.createBlueprint("bob", "granary");
  const res = Construction.commissionProject("varrock", bp.id, "bob");
  const proj = Construction.project(res.id);
  Construction.donateMaterials(res.id, Object.assign({}, proj.materialsNeeded));
  assert.equal(Construction.project(res.id).status, "building");
  const done = Construction.progressProject(res.id, 10000); // way over
  assert.ok(done);
  assert.equal(done.status, "complete");
  const built = Construction.builtFor("varrock");
  assert.equal(built.length, 1);
  assert.equal(built[0].type, "granary");
  assert.equal(built[0].effect.kind, "food_storage");
});

test("effectBonus sums the effect kind across buildings", () => {
  const bp1 = Construction.createBlueprint("bob", "granary");
  const bp2 = Construction.createBlueprint("bob", "granary");
  const r1 = Construction.commissionProject("varrock", bp1.id, "bob");
  const r2 = Construction.commissionProject("varrock", bp2.id, "bob");
  for (const rid of [r1.id, r2.id]) {
    const p = Construction.project(rid);
    Construction.donateMaterials(rid, Object.assign({}, p.materialsNeeded));
    Construction.progressProject(rid, 10000);
  }
  assert.equal(Construction.effectBonus("varrock", "food_storage"), 100);
  assert.equal(Construction.effectBonus("varrock", "siege_defense"), 0);
  assert.equal(Construction.effectBonus("falador", "food_storage"), 0);
});

test("completed buildings are assigned to districts", () => {
  const bp = Construction.createBlueprint("bob", "granary");
  const r = Construction.commissionProject("varrock", bp.id, "bob");
  const p = Construction.project(r.id);
  Construction.donateMaterials(r.id, Object.assign({}, p.materialsNeeded));
  Construction.progressProject(r.id, 10000);
  const districts = Construction.districtsFor("varrock");
  assert.ok(districts.length > 0);
  const market = districts.find((d) => d.name === "market");
  assert.ok(market);
  assert.equal(market.buildings.length, 1);
});

test("ensureDistrict creates a district idempotently", () => {
  const d1 = Construction.ensureDistrict("varrock", "harbor");
  const d2 = Construction.ensureDistrict("varrock", "harbor");
  assert.equal(d1.name, "harbor");
  assert.equal(Construction.districtsFor("varrock").filter((d) => d.name === "harbor").length, 1);
});

test("landmarksFor filters landmark builds", () => {
  assert.equal(Construction.landmarksFor("varrock").length, 0);
});

// --- site tile -------------------------------------------------------------

test("siteTile returns null without engine (defensive)", () => {
  // No CitizenSites engine in plain-node — must not throw.
  const tile = Construction.siteTile("varrock");
  assert.ok(tile === null || typeof tile.x === "number");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
