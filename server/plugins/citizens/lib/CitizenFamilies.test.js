// CitizenFamilies unit checks — pure data logic, no running server.
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const Families = require("./CitizenFamilies");

const DAY_MS = 24 * 3600 * 1000;

let passed = 0;
function check(name, fn) {
  Families.resetForTests();
  fn();
  passed++;
  console.log("ok - " + name);
}

// --- growth stages ------------------------------------------------------------

check("stageForAge: baby -> child -> teen -> adult on compressed clock", () => {
  assert.equal(Families.stageForAge(0), Families.STAGE_BABY);
  assert.equal(Families.stageForAge(6 * DAY_MS), Families.STAGE_BABY);
  assert.equal(Families.stageForAge(7 * DAY_MS), Families.STAGE_CHILD);
  assert.equal(Families.stageForAge(20 * DAY_MS), Families.STAGE_CHILD);
  assert.equal(Families.stageForAge(21 * DAY_MS), Families.STAGE_TEEN);
  assert.equal(Families.stageForAge(34 * DAY_MS), Families.STAGE_TEEN);
  assert.equal(Families.stageForAge(35 * DAY_MS), Families.STAGE_ADULT);
  assert.equal(Families.stageForAge(400 * DAY_MS), Families.STAGE_ADULT);
});

check("isMinorStage: only adult is not minor", () => {
  assert.equal(Families.isMinorStage(Families.STAGE_BABY), true);
  assert.equal(Families.isMinorStage(Families.STAGE_CHILD), true);
  assert.equal(Families.isMinorStage(Families.STAGE_TEEN), true);
  assert.equal(Families.isMinorStage(Families.STAGE_ADULT), false);
});

// --- family creation ----------------------------------------------------------

check("createFamily: forms with shared surname, idempotent", () => {
  const f = Families.createFamily("Alice Stone", "Alice Stone", "Bob Stone", "Bob Stone", "varrock");
  assert.ok(f);
  assert.equal(f.surname, "Stone");
  assert.deepEqual(f.spouses, ["alice stone", "bob stone"]);
  assert.equal(f.kingdomId, "varrock");
  // Idempotent — same couple returns the same family.
  const f2 = Families.createFamily("Bob Stone", "Bob Stone", "Alice Stone", "Alice Stone", "varrock");
  assert.equal(f2.id, f.id);
  assert.equal(Families.familyOf("alice stone").id, f.id);
  assert.equal(Families.familyOf("ALICE STONE").id, f.id); // normalized
});

check("createFamily: rejects self-marriage and empty names", () => {
  assert.equal(Families.createFamily("Alice", "Alice", "Alice", "Alice", "varrock"), null);
  assert.equal(Families.createFamily("", "", "Bob", "Bob", "varrock"), null);
});

check("createFamily: different surnames take spouse A's", () => {
  const f = Families.createFamily("Alice Stone", "Alice Stone", "Bob River", "Bob River", "varrock");
  assert.equal(f.surname, "Stone");
});

// --- births -------------------------------------------------------------------

check("recordBirth: child takes family surname, birth order kept", () => {
  const f = Families.createFamily("Alice Stone", "Alice Stone", "Bob Stone", "Bob Stone", "varrock");
  const c1 = Families.recordBirth(f.id, "Mara", ["kind"], Date.now() - 10 * DAY_MS);
  const c2 = Families.recordBirth(f.id, "Tom", ["brave"], Date.now());
  assert.ok(c1 && c2);
  assert.equal(c1.display, "Mara Stone");
  assert.equal(c1.surname, "Stone");
  assert.deepEqual(c1.parents, ["alice stone", "bob stone"]);
  assert.equal(c1.stage, Families.STAGE_BABY);
  const kids = Families.childrenOf("alice stone");
  assert.deepEqual(kids.map((k) => k.id), [c1.id, c2.id]); // birth order
});

check("recordBirth: enforces max children per family", () => {
  const f = Families.createFamily("Alice Stone", "Alice Stone", "Bob Stone", "Bob Stone", "varrock");
  for (let i = 0; i < Families.MAX_CHILDREN_PER_FAMILY; i++) {
    assert.ok(Families.recordBirth(f.id, `Kid${i}`, [], Date.now()));
  }
  assert.equal(Families.recordBirth(f.id, "Extra", [], Date.now()), null);
});

check("minorChildrenOf / adultChildrenOf split by stage", () => {
  const f = Families.createFamily("Alice Stone", "Alice Stone", "Bob Stone", "Bob Stone", "varrock");
  const baby = Families.recordBirth(f.id, "Mara", [], Date.now());
  const grown = Families.recordBirth(f.id, "Tom", [], Date.now() - 40 * DAY_MS);
  Families.refreshStage(baby, Date.now());
  Families.refreshStage(grown, Date.now());
  assert.equal(Families.minorChildrenOf("alice stone").length, 1);
  assert.equal(Families.minorChildrenOf("alice stone")[0].id, baby.id);
  assert.equal(Families.adultChildrenOf("alice stone").length, 1);
  assert.equal(Families.adultChildrenOf("alice stone")[0].id, grown.id);
});

// --- stage refresh --------------------------------------------------------------

check("refreshStage: advances on age, returns whether it changed", () => {
  const f = Families.createFamily("Alice Stone", "Alice Stone", "Bob Stone", "Bob Stone", "varrock");
  const c = Families.recordBirth(f.id, "Mara", [], Date.now() - 30 * DAY_MS);
  assert.equal(Families.refreshStage(c, Date.now()), true);
  assert.equal(c.stage, Families.STAGE_TEEN);
  assert.equal(Families.refreshStage(c, Date.now()), false); // no change
});

// --- bequests & teaching --------------------------------------------------------

check("addBequest accumulates coins owed", () => {
  const f = Families.createFamily("Alice Stone", "Alice Stone", "Bob Stone", "Bob Stone", "varrock");
  const c = Families.recordBirth(f.id, "Mara", [], Date.now());
  assert.equal(Families.addBequest(c.id, 500), 500);
  assert.equal(Families.addBequest(c.id, 250), 750);
  assert.equal(Families.addBequest(c.id, -100), 0); // negatives rejected
  assert.equal(Families.getChild(c.id).bequest, 750); // unchanged
});

check("addLearnedXp banks taught xp per skill", () => {
  const f = Families.createFamily("Alice Stone", "Alice Stone", "Bob Stone", "Bob Stone", "varrock");
  const c = Families.recordBirth(f.id, "Mara", [], Date.now());
  assert.equal(Families.addLearnedXp(c.id, "woodcutting", 25), 25);
  assert.equal(Families.addLearnedXp(c.id, "woodcutting", 25), 50);
  assert.equal(Families.addLearnedXp(c.id, "fishing", 10), 10);
});

check("markJoinedRoster / markLeftTown flip flags", () => {
  const f = Families.createFamily("Alice Stone", "Alice Stone", "Bob Stone", "Bob Stone", "varrock");
  const c = Families.recordBirth(f.id, "Mara", [], Date.now());
  assert.equal(Families.markJoinedRoster(c.id), true);
  assert.equal(Families.getChild(c.id).joinedRoster, true);
  assert.equal(Families.markLeftTown(c.id), true);
  assert.equal(Families.getChild(c.id).leftTown, true);
  assert.equal(Families.markJoinedRoster("nope"), false);
});

// --- widow/orphan ---------------------------------------------------------------

check("recordSpouseGone: drops deceased from spouses, logs it", () => {
  const f = Families.createFamily("Alice Stone", "Alice Stone", "Bob Stone", "Bob Stone", "varrock");
  Families.recordBirth(f.id, "Mara", [], Date.now());
  const out = Families.recordSpouseGone(f.id, "Bob Stone", "Bob Stone");
  assert.deepEqual(out.spouses, ["alice stone"]);
  assert.ok(out.activityLog.some((e) => e.text.includes("Bob Stone")));
  // Children still linked to both parents.
  assert.equal(Families.childrenOf("bob stone").length, 1);
});

// --- summary --------------------------------------------------------------------

check("familySummary: token-lean line for chat context", () => {
  const f = Families.createFamily("Alice Stone", "Alice Stone", "Bob Stone", "Bob Stone", "varrock");
  assert.equal(Families.familySummary("alice stone"), null); // no kids yet
  const c = Families.recordBirth(f.id, "Mara", [], Date.now());
  Families.refreshStage(c, Date.now());
  const s = Families.familySummary("alice stone");
  assert.ok(s.includes("Mara"));
  assert.ok(s.includes("baby"));
});

// --- persistence ------------------------------------------------------------------

check("save writes and reloads families", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fam-persist-"));
  const file = path.join(dir, "families.json");
  Families._setSavePathForTests(file);
  const f = Families.createFamily("Alice Stone", "Alice Stone", "Bob Stone", "Bob Stone", "varrock");
  const c = Families.recordBirth(f.id, "Mara", ["kind"], Date.now());
  Families.addBequest(c.id, 123);
  assert.ok(Families.save(), "dirty save returns true");
  assert.ok(!Families.save(), "clean save returns false");
  Families.resetForTests();
  Families._setSavePathForTests(file);
  const reloaded = Families.familyOf("Alice Stone");
  assert.ok(reloaded, "family survives reload");
  assert.equal(reloaded.surname, "Stone");
  const kids = Families.childrenOf("alice stone");
  assert.equal(kids.length, 1);
  assert.equal(kids[0].display, "Mara Stone");
  assert.equal(kids[0].bequest, 123);
  assert.deepEqual(kids[0].traits, ["kind"]);
});

console.log(`\n${passed} checks passed`);
