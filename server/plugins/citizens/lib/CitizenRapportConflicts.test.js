// Citizen rapport-conflicts unit checks — real event sites feed the brain graph.
// These tests FAIL before the noteInteraction hooks and PASS after:
//   - guard VIP escort        -> "helped"
//   - apprentice pairing       -> "workedAlongside"
//   - apprentice graduation    -> "helped"
//   - activity party formation -> "workedAlongside"
// Run: cd server/plugins/citizens && node lib/CitizenRapportConflicts.test.js

// Isolate filesystem writes: point process.cwd() at a temp dir BEFORE requires.
const os = require("os");
const path = require("path");
const fs = require("fs");
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "rapport-conflicts-test-"));
process.chdir(testDir);

const assert = require("node:assert/strict");
const {
  noteInteraction,
  rapportOf,
  resetForTests,
} = require("../brain/CitizenRelationships");
const { pairUp, graduatePair } = require("./CitizenApprentices");
const { tickVipEscort } = require("./CitizenGuardPatrols");
const { notePartyRapport } = require("./CitizenActivityParties");

let n = 0;
function mockDirector(names, extra = {}) {
  return {
    roster: new Map(names.map((x) => [x, { username: x }])),
    isOnline: () => true,
    getBot: () => null,
    ...extra,
  };
}

// Baseline units: what one fresh interaction of each kind is worth
// (first-impression math, personality null on both sides).
resetForTests();
noteInteraction("basea", "baseb", "workedAlongside", null, null);
const ALONGSIDE_UNIT = rapportOf("basea", "baseb");
resetForTests();
noteInteraction("basec", "based", "helped", null, null);
const HELPED_UNIT = rapportOf("basec", "based");
assert.ok(ALONGSIDE_UNIT > 0 && HELPED_UNIT > 0, "baseline units must be positive");
assert.ok(HELPED_UNIT > ALONGSIDE_UNIT, "helped must outweigh workedAlongside");
n += 2;

// --- apprentice pairing -> workedAlongside ---
resetForTests();
assert.equal(rapportOf("mastera", "apprenticeb"), 0, "graph starts empty");
pairUp("mastera", "apprenticeb", "woodcutting", Date.now(), mockDirector(["mastera", "apprenticeb"]));
assert.equal(rapportOf("mastera", "apprenticeb"), ALONGSIDE_UNIT,
  "pairing must accrue workedAlongside between master and apprentice");
n++;

// roster gate: strangers earn nothing
resetForTests();
pairUp("mastera", "strangerx", "woodcutting", Date.now(), mockDirector(["mastera"]));
assert.equal(rapportOf("mastera", "strangerx"), 0, "non-roster apprentice must not accrue");
n++;

// --- apprentice graduation -> helped ---
resetForTests();
assert.equal(rapportOf("mastera", "apprenticeb"), 0, "graph starts empty");
graduatePair(mockDirector(["mastera", "apprenticeb"]), "apprenticeb",
  { master: "mastera", skill: "woodcutting" }, Date.now());
assert.equal(rapportOf("mastera", "apprenticeb"), HELPED_UNIT,
  "graduation must accrue helped between master and apprentice");
n++;

// roster gate: strangers earn nothing
resetForTests();
graduatePair(mockDirector(["mastera"]), "strangery",
  { master: "mastera", skill: "woodcutting" }, Date.now());
assert.equal(rapportOf("mastera", "strangery"), 0, "non-roster apprentice must not accrue");
n++;

// --- guard VIP escort -> helped ---
resetForTests();
const merchantBot = {
  getLocation: () => ({ getX: () => 10, getY: () => 20, getZ: () => 0 }),
  getAttribute: () => null,
};
const guardBot = { getAttribute: () => null, moveTo: () => {} };
const escortDirector = mockDirector(["guardx", "merchanty"], {
  isOnline: () => true,
  getBot: (rec) => (rec.username === "merchanty" ? merchantBot : guardBot),
});
escortDirector.roster.set("merchanty", { username: "merchanty", role: "merchant" });
assert.equal(rapportOf("guardx", "merchanty"), 0, "graph starts empty");
tickVipEscort(escortDirector, { username: "guardx" }, guardBot,
  { x: 10, y: 20, z: 0 }, Date.now(), () => 0.05, true);
assert.equal(rapportOf("guardx", "merchanty"), HELPED_UNIT,
  "VIP escort must accrue helped between guard and escorted citizen");
n++;

// no merchant nearby -> no accrual, no crash
resetForTests();
tickVipEscort(mockDirector(["guardy"]), { username: "guardy" }, guardBot,
  { x: 10, y: 20, z: 0 }, Date.now(), () => 0.05, true);
assert.equal(rapportOf("guardy", "merchanty"), 0, "no escort target, no accrual");
n++;

// --- activity party formation -> workedAlongside ---
resetForTests();
assert.equal(rapportOf("leaderp", "companionq"), 0, "graph starts empty");
notePartyRapport(mockDirector(["leaderp", "companionq"]), "leaderp", ["companionq"]);
assert.equal(rapportOf("leaderp", "companionq"), ALONGSIDE_UNIT,
  "party formation must accrue workedAlongside between leader and companion");
n++;

// roster gates: leader out -> nothing; companion out -> skipped
resetForTests();
notePartyRapport(mockDirector(["companionq"]), "outsiderl", ["companionq"]);
assert.equal(rapportOf("outsiderl", "companionq"), 0, "non-roster leader must not accrue");
notePartyRapport(mockDirector(["leaderp"]), "leaderp", ["outsiderc"]);
assert.equal(rapportOf("leaderp", "outsiderc"), 0, "non-roster companion must be skipped");
n += 2;

console.log(`CitizenRapportConflicts: all ${n} assertions passed`);
