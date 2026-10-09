// CitizenCareers unit checks — pure data logic, no running server.
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const Careers = require("./CitizenCareers");

let passed = 0;
function check(name, fn) {
  Careers.resetForTests();
  Careers._setSavePathForTests(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "careers-")), "careers.json"));
  fn();
  passed++;
  console.log("ok - " + name);
}

// --- catalog ------------------------------------------------------------------

check("careerDef resolves known careers, null for junk", () => {
  assert.ok(Careers.careerDef("smith"));
  assert.equal(Careers.careerDef("smith").label, "blacksmith");
  assert.equal(Careers.careerDef("GUARD").wage, 300);
  assert.equal(Careers.careerDef("nope"), null);
  assert.equal(Careers.careerDef(null), null);
});

check("service careers have wages, trade careers do not", () => {
  assert.ok(Careers.careerDef("guard").service);
  assert.ok(Careers.careerDef("laborer").service);
  assert.ok(!Careers.careerDef("smith").service);
  assert.ok(!Careers.careerDef("fisher").service);
});

// --- records --------------------------------------------------------------------

check("careerFor creates a laborer stub for new names", () => {
  const rec = Careers.careerFor("Alice Smith");
  assert.ok(rec);
  assert.equal(rec.career, "laborer");
  assert.equal(rec.rank, Careers.RANK_APPRENTICE);
  assert.equal(Careers.careerFor("alice smith"), rec); // normalized, same record
});

check("careerFor returns null for bad names", () => {
  assert.equal(Careers.careerFor(""), null);
  assert.equal(Careers.careerFor(null), null);
});

check("setCareer archives history and resets rank", () => {
  const now = Date.now();
  Careers.setCareer("Bob Jones", "smith", now);
  let rec = Careers.careerFor("Bob Jones");
  assert.equal(rec.career, "smith");
  assert.equal(rec.rank, Careers.RANK_APPRENTICE);
  assert.equal(rec.history.length, 1); // laborer stub archived
  assert.equal(rec.history[0].career, "laborer");
  // Same career is a no-op.
  Careers.setCareer("Bob Jones", "smith", now + 1000);
  rec = Careers.careerFor("Bob Jones");
  assert.equal(rec.history.length, 1);
  // Bad career key is a no-op.
  assert.equal(Careers.setCareer("Bob Jones", "astronaut", now), null);
});

check("setRank promotes and rejects junk ranks", () => {
  Careers.setCareer("Cara Doe", "cook", Date.now());
  const rec = Careers.setRank("Cara Doe", Careers.RANK_MASTER, Date.now());
  assert.equal(rec.rank, Careers.RANK_MASTER);
  assert.equal(Careers.setRank("Cara Doe", "grandmaster", Date.now()), null);
});

// --- rank computation --------------------------------------------------------------

check("earnedRank uses real skill levels for skill careers", () => {
  const rec = { username: "Dan Hill", since: Date.now() };
  const lvl = (n, skill) => ({ woodcutting: 45, fishing: 62 }[skill] ?? 0);
  assert.equal(Careers.earnedRank("woodcutter", rec, lvl), Careers.RANK_JOURNEYMAN);
  assert.equal(Careers.earnedRank("fisher", rec, lvl), Careers.RANK_MASTER);
  assert.equal(Careers.earnedRank("miner", rec, lvl), Careers.RANK_APPRENTICE); // level 0
});

check("earnedRank uses tenure for non-skill careers", () => {
  const now = Date.now();
  const fresh = { username: "Eve", since: now };
  const week = { username: "Eve", since: now - 8 * 24 * 3600 * 1000 };
  const month = { username: "Eve", since: now - 31 * 24 * 3600 * 1000 };
  assert.equal(Careers.earnedRank("guard", fresh), Careers.RANK_APPRENTICE);
  assert.equal(Careers.earnedRank("guard", week), Careers.RANK_JOURNEYMAN);
  assert.equal(Careers.earnedRank("guard", month), Careers.RANK_MASTER);
  assert.equal(Careers.earnedRank("trader", month), Careers.RANK_MASTER);
});

// --- wages --------------------------------------------------------------------------

check("dailyWage scales by rank, zero for trade careers", () => {
  assert.equal(Careers.dailyWage("smith", Careers.RANK_MASTER), 0);
  assert.equal(Careers.dailyWage("fisher", Careers.RANK_JOURNEYMAN), 0);
  const ap = Careers.dailyWage("guard", Careers.RANK_APPRENTICE);
  const jo = Careers.dailyWage("guard", Careers.RANK_JOURNEYMAN);
  const ma = Careers.dailyWage("guard", Careers.RANK_MASTER);
  assert.ok(ap < jo && jo < ma, "wages rise with rank");
  assert.equal(jo, 300);
  assert.equal(Careers.dailyWage("laborer", Careers.RANK_JOURNEYMAN), 120);
});

// --- titles ----------------------------------------------------------------------------

check("titleFor and describeCareer read real state", () => {
  Careers.setCareer("Finn", "smith", Date.now());
  Careers.setRank("Finn", Careers.RANK_MASTER, Date.now());
  assert.equal(Careers.titleFor("Finn"), "Master blacksmith");
  assert.ok(Careers.describeCareer("Finn").includes("master blacksmith"));
  assert.ok(Careers.describeCareer("Finn").includes("laborer")); // history shown
  assert.equal(Careers.describeCareer("Nobody"), "between jobs at the moment");
});

// --- persistence --------------------------------------------------------------------------

check("save and reload round-trips career state", () => {
  const savePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "careers-")), "c.json");
  Careers._setSavePathForTests(savePath);
  Careers.setCareer("Gus", "cook", Date.now());
  Careers.setRank("Gus", Careers.RANK_JOURNEYMAN, Date.now());
  assert.ok(Careers.save());
  Careers.resetForTests();
  Careers._setSavePathForTests(savePath);
  const rec = Careers.careerFor("Gus");
  assert.equal(rec.career, "cook");
  assert.equal(rec.rank, Careers.RANK_JOURNEYMAN);
});

console.log(`\n${passed} checks passed.`);
