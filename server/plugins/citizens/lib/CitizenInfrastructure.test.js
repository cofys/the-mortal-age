"use strict";

/**
 * CitizenInfrastructure.test.js — plain-node tests for the real
 * public-works infrastructure data tier.
 *
 * Run: node server/plugins/citizens/lib/CitizenInfrastructure.test.js
 */

const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");

const Infra = require("./CitizenInfrastructure");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    // Isolate state per test.
    Infra.resetForTests();
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL - ${name}: ${err.message}`);
  }
}

console.log("CitizenInfrastructure tests:");

test("catalog has all 6 project types", () => {
  const c = Infra.catalog();
  for (const t of ["bridge", "stone_bridge", "road", "watchtower", "fort", "reservoir"]) {
    assert.ok(c[t], `missing ${t}`);
  }
});

test("specFor returns null for unknown type", () => {
  assert.strictEqual(Infra.specFor("teleporter"), null);
});

test("commissionProject requires a kingdom", () => {
  const r = Infra.commissionProject("bridge", null, "crown", { from: "a", to: "b" });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "no-kingdom");
});

test("commissionProject requires route for route projects", () => {
  const r = Infra.commissionProject("bridge", "varrock", "crown", {});
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "no-route");
});

test("commissionProject rejects unknown type", () => {
  const r = Infra.commissionProject("death_star", "varrock", "crown", {});
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "unknown-type");
});

test("private commission creates a project with zero funding", () => {
  const r = Infra.commissionProject("watchtower", "varrock", "bob", {});
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.project.funded, 0);
  assert.strictEqual(r.project.royal, false);
  assert.strictEqual(r.project.progress, 0);
});

test("royal commission fails honestly when treasury unavailable", () => {
  // No KingdomStore in this environment — must fail with treasury-unavailable.
  const r = Infra.commissionProject("watchtower", "varrock", "crown", { royal: true });
  assert.strictEqual(r.ok, false);
  assert.ok(["insufficient-treasury", "treasury-unavailable"].includes(r.reason));
});

test("donateMaterials only stockpiles needed items up to need", () => {
  const r = Infra.commissionProject("watchtower", "varrock", "bob", {});
  const spec = Infra.specFor("watchtower");
  const plankNeed = spec.materials[Infra.MATERIALS.plank];
  const res = Infra.donateMaterials(r.project.id, {
    [Infra.MATERIALS.plank]: plankNeed + 100, // over-donate
    99999: 50, // not needed at all
  });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.stockpiled[Infra.MATERIALS.plank], plankNeed);
  assert.strictEqual(res.stockpiled[99999], undefined);
});

test("donateCoins refuses royal projects", () => {
  const r = Infra.commissionProject("watchtower", "varrock", "bob", {});
  // force royal for the test
  const proj = Infra.project(r.project.id);
  proj.royal = true;
  const res = Infra.donateCoins(r.project.id, 500);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, "royal-funded");
});

test("donateCoins funds private projects", () => {
  const r = Infra.commissionProject("watchtower", "varrock", "bob", {});
  const res = Infra.donateCoins(r.project.id, 500);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.funded, 500);
});

test("materialsComplete is false until fully stocked", () => {
  const r = Infra.commissionProject("watchtower", "varrock", "bob", {});
  assert.strictEqual(Infra.materialsComplete(r.project), false);
  const spec = Infra.specFor("watchtower");
  const mats = {};
  for (const [id, need] of Object.entries(spec.materials)) mats[id] = need;
  Infra.donateMaterials(r.project.id, mats);
  assert.strictEqual(Infra.materialsComplete(Infra.project(r.project.id)), true);
});

test("progressProject refuses to advance without materials", () => {
  const r = Infra.commissionProject("watchtower", "varrock", "bob", {});
  const res = Infra.progressProject(r.project.id, 1);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, "awaiting-materials");
});

test("progressProject completes and records built infrastructure", () => {
  const r = Infra.commissionProject("watchtower", "varrock", "bob", {});
  const spec = Infra.specFor("watchtower");
  const mats = {};
  for (const [id, need] of Object.entries(spec.materials)) mats[id] = need;
  Infra.donateMaterials(r.project.id, mats);
  const res = Infra.progressProject(r.project.id, spec.workTicks);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.done, true);
  assert.strictEqual(res.built.type, "watchtower");
  assert.strictEqual(res.built.kingdomId, "varrock");
  // Project removed from active list.
  assert.strictEqual(Infra.project(r.project.id), null);
  // Built list has it.
  const built = Infra.builtFor("varrock");
  assert.strictEqual(built.length, 1);
});

test("effectBonus sums built effects per kingdom and kind", () => {
  for (const type of ["watchtower", "watchtower"]) {
    const r = Infra.commissionProject(type, "varrock", "bob", {});
    const spec = Infra.specFor(type);
    const mats = {};
    for (const [id, need] of Object.entries(spec.materials)) mats[id] = need;
    Infra.donateMaterials(r.project.id, mats);
    Infra.progressProject(r.project.id, spec.workTicks);
  }
  assert.strictEqual(Infra.effectBonus("varrock", "patrol_range"), 12);
  assert.strictEqual(Infra.effectBonus("varrock", "siege_defense"), 0);
  assert.strictEqual(Infra.effectBonus("falador", "patrol_range"), 0);
});

test("travelBonusFor sums route_speed on matching routes both directions", () => {
  const r1 = Infra.commissionProject("bridge", "varrock", "bob", { from: "varrock", to: "falador" });
  const spec = Infra.specFor("bridge");
  const mats = {};
  for (const [id, need] of Object.entries(spec.materials)) mats[id] = need;
  Infra.donateMaterials(r1.project.id, mats);
  Infra.progressProject(r1.project.id, spec.workTicks);
  assert.strictEqual(Infra.travelBonusFor("varrock", "falador"), 15);
  assert.strictEqual(Infra.travelBonusFor("falador", "varrock"), 15);
  assert.strictEqual(Infra.travelBonusFor("varrock", "lumbridge"), 0);
});

test("routeSafer is true only for built roads", () => {
  const r = Infra.commissionProject("road", "varrock", "bob", { from: "varrock", to: "falador" });
  const spec = Infra.specFor("road");
  const mats = {};
  for (const [id, need] of Object.entries(spec.materials)) mats[id] = need;
  Infra.donateMaterials(r.project.id, mats);
  Infra.progressProject(r.project.id, spec.workTicks);
  assert.strictEqual(Infra.routeSafer("varrock", "falador"), true);
  assert.strictEqual(Infra.routeSafer("varrock", "lumbridge"), false);
});

test("registerEngineer records engineers per kingdom", () => {
  Infra.registerEngineer("Alice", "varrock", 45);
  const e = Infra.engineerFor("alice");
  assert.ok(e);
  assert.strictEqual(e.constructionLevel, 45);
  const list = Infra.engineersFor("varrock");
  assert.strictEqual(list.length, 1);
  assert.strictEqual(Infra.engineersFor("falador").length, 0);
});

test("inventionUnlocked gates advanced projects on science discoveries", () => {
  // fort needs the tempered_steel science discovery — absent here, so locked.
  assert.strictEqual(Infra.inventionUnlocked("fort", "varrock"), false);
  // bridge has no invention requirement — always unlocked.
  assert.strictEqual(Infra.inventionUnlocked("bridge", "varrock"), true);
  // unknown type without a requirement is unlocked (permissive default).
  assert.strictEqual(Infra.inventionUnlocked("watchtower", "varrock"), true);
});

test("siteTile returns a deterministic tile", () => {
  const t1 = Infra.siteTile("varrock");
  const t2 = Infra.siteTile("varrock");
  assert.deepStrictEqual(t1, t2);
});

test("describe summarizes state", () => {
  Infra.commissionProject("watchtower", "varrock", "bob", {});
  const d = Infra.describe();
  assert.ok(d.includes("1 active project"));
});

test("save/load round-trips state", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "infra-test-"));
  const saveFile = path.join(tmpDir, "data", "saves", "citizen-infrastructure.json");
  const origCwd = process.cwd();
  try {
    process.chdir(tmpDir);
    // Re-require fresh to pick up cwd-relative save path.
    delete require.cache[require.resolve("./CitizenInfrastructure")];
    const I2 = require("./CitizenInfrastructure");
    I2.resetForTests();
    I2.registerEngineer("Zed", "varrock", 50);
    const r = I2.commissionProject("reservoir", "varrock", "zed", {});
    assert.strictEqual(r.ok, true);
    assert.strictEqual(I2.save(), true);
    assert.ok(fs.existsSync(saveFile));
    I2.resetForTests();
    assert.strictEqual(I2.engineerFor("zed").username, "Zed");
    assert.strictEqual(I2.projectsFor("varrock").length, 1);
  } finally {
    process.chdir(origCwd);
    delete require.cache[require.resolve("./CitizenInfrastructure")];
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
