// CitizenAging unit checks — aging, stages, wisdom, retirement, immigration.
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

// Stub sayPublic (announceArrivals path) to capture speech.
const sayPath = require.resolve("../chat/CitizenSayPublic");
const said = [];
require.cache[sayPath] = {
  exports: { sayPublic: (bot, text) => { said.push(String(text)); return true; } },
};

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "citizen-aging-test-"));
const savePath = path.join(tmpDir, "citizen-aging.json");
const careersPath = path.join(tmpDir, "citizen-careers.json");

const Aging = require("./CitizenAging");
const Careers = require("./CitizenCareers");

const DAY = 24 * 3600 * 1000;

function resetAll() {
  Aging.resetForTests();
  Aging._setSavePathForTests(savePath);
  Careers.resetForTests();
  Careers._setSavePathForTests(careersPath);
  said.length = 0;
}

function rec(username, role, kingdomId) {
  return {
    username,
    display: username,
    role: role ?? "commoner",
    kingdomId: kingdomId ?? "asgarnia",
    personality: {},
  };
}

// --- pure helpers ------------------------------------------------------------

{
  resetAll();
  assert.equal(Aging.ageStage(30), "adult");
  assert.equal(Aging.ageStage(44), "adult");
  assert.equal(Aging.ageStage(45), "middle-aged");
  assert.equal(Aging.ageStage(59), "middle-aged");
  assert.equal(Aging.ageStage(60), "elder");
  assert.equal(Aging.ageStage(85), "elder");
  assert.equal(Aging.ageStage(undefined), "adult"); // default 35
  console.log("ok 1 - ageStage boundaries");
}

{
  resetAll();
  assert.equal(Aging.isElderAge(60), true);
  assert.equal(Aging.isElderAge(59), false);
  assert.equal(Aging.isRetirableRole("guard"), true);
  assert.equal(Aging.isRetirableRole("merchant"), true);
  assert.equal(Aging.isRetirableRole("commoner"), true);
  assert.equal(Aging.isRetirableRole("courtier"), false);
  assert.equal(Aging.isRetirableRole("refugee"), false);
  console.log("ok 2 - isElderAge / isRetirableRole");
}

{
  resetAll();
  assert.equal(Aging.xpBonusForAge(30), 0);
  assert.equal(Aging.xpBonusForAge(50), 0.05);
  assert.equal(Aging.xpBonusForAge(65), 0.1);
  assert.equal(Aging.xpBonusForRecord(rec("Wiz", "commoner")), 0); // default age 35
  console.log("ok 3 - xpBonusForAge wisdom curve");
}

// --- aging advancement -------------------------------------------------------

{
  resetAll();
  const r = rec("Ager");
  const now = Date.now();
  const age0 = Aging.ageCitizen(r, now, () => 0.5);
  assert.ok(age0 >= 20 && age0 <= 54, `seeded age in range, got ${age0}`);
  assert.equal(r.personality.age, age0, "live record written back");
  // Two years pass.
  const age1 = Aging.ageCitizen(r, now + 2 * DAY + 1000, () => 0.5);
  assert.equal(age1, age0 + 2, "two game-years advanced");
  console.log("ok 4 - ageCitizen seeds and advances");
}

{
  resetAll();
  const r = rec("Stager");
  const now = Date.now();
  // Seed at 59, then cross into elderhood.
  Aging._data().citizens["stager"] = { age: 59, lastAgedAt: now, stage: "middle-aged" };
  const age = Aging.ageCitizen(r, now + DAY + 1000, () => 0.1);
  assert.equal(age, 60);
  assert.equal(Aging._data().citizens["stager"].stage, "elder");
  assert.equal(Aging.ageOf(r), 60);
  console.log("ok 5 - stage transition to elder journaled + tracked");
}

{
  resetAll();
  // Persistence round-trip: ages survive a restart.
  const r = rec("Saver");
  const now = Date.now();
  Aging.ageCitizen(r, now, () => 0.5);
  const before = Aging.ageOf(r);
  assert.ok(Aging.save(), "save returns true when dirty");
  Aging.resetForTests();
  Aging._setSavePathForTests(savePath);
  const r2 = rec("Saver");
  assert.equal(Aging.ageOf(r2), before, "age reloaded from disk");
  console.log("ok 6 - save/reload persistence");
}

// --- retirement ---------------------------------------------------------------

{
  resetAll();
  const director = { roster: new Map(), log() {} };
  const elder = rec("OldGuard", "guard");
  const courtier = rec("OldCourt", "courtier");
  const young = rec("YoungMerch", "merchant");
  director.roster.set("oldguard", elder);
  director.roster.set("oldcourt", courtier);
  director.roster.set("youngmerch", young);
  const now = Date.now();
  Aging._data().citizens["oldguard"] = { age: 65, lastAgedAt: now, stage: "elder" };
  Aging._data().citizens["oldcourt"] = { age: 70, lastAgedAt: now, stage: "elder" };
  Aging._data().citizens["youngmerch"] = { age: 30, lastAgedAt: now, stage: "adult" };

  const retired = Aging.processRetirements(director, now);
  assert.deepEqual(retired, ["OldGuard"], "only the elder guard retires");
  assert.equal(Careers.isCareerRetired("OldGuard"), true);
  // careerFor auto-created a laborer stub; set the real career then re-check title
  Careers.setCareer("OldGuard", "guard", now);
  assert.equal(Careers.titleFor("OldGuard"), "Retired guard");
  assert.equal(Careers.isCareerRetired("OldCourt"), false, "courtiers advise for life");
  assert.equal(Careers.isCareerRetired("YoungMerch"), false);
  assert.equal(Careers.titleFor("OldGuard"), "Retired guard");
  // Idempotent: second pass retires nobody new.
  assert.deepEqual(Aging.processRetirements(director, now + 1000), []);
  console.log("ok 7 - processRetirements retires elder workers only");
}

// --- immigration --------------------------------------------------------------

function mockDirector(size, perKingdom) {
  const roster = new Map();
  for (let i = 0; i < size; i++) {
    const k = perKingdom[i % perKingdom.length];
    const name = `Cit${i}`;
    roster.set(name.toLowerCase(), rec(name, "commoner", k));
  }
  const added = [];
  return {
    roster,
    added,
    log() {},
    addCitizen(kingdomId, role) {
      const name = `Newbie${added.length}`;
      const r = rec(name, role, kingdomId);
      roster.set(name.toLowerCase(), r);
      added.push({ kingdomId, role, record: r });
      return r;
    },
  };
}

{
  resetAll();
  // Full roster: no immigration.
  const d = mockDirector(110, ["asgarnia"]);
  const arrivals = Aging.processImmigration(d, Date.now(), () => 0.5);
  assert.equal(arrivals.length, 0, "no arrivals at target");
  assert.equal(d.added.length, 0);
  console.log("ok 8 - no immigration at target population");
}

{
  resetAll();
  // Thinned roster: immigrants arrive, capped per tick, filling deficits.
  const d = mockDirector(60, ["asgarnia", "misthalin"]);
  const before = d.roster.size;
  const arrivals = Aging.processImmigration(d, Date.now(), () => 0.5);
  assert.ok(arrivals.length > 0 && arrivals.length <= 2, `1-2 arrivals, got ${arrivals.length}`);
  assert.equal(d.roster.size, before + arrivals.length);
  for (const a of arrivals) {
    const age = Aging.ageOf(a.record);
    assert.ok(age >= 20 && age <= 40, `working-age adult, got ${age}`);
    assert.ok(a.origin, "caravan origin recorded");
  }
  console.log("ok 9 - immigration replenishes a thinned roster");
}

{
  resetAll();
  // Deficit targeting: the emptiest kingdom gets the newcomer.
  const d = mockDirector(0, []);
  // asgarnia full to plan (4/3/10/3), misthalin nearly empty.
  const roles = ["guard", "guard", "guard", "guard", "merchant", "merchant", "merchant",
    "courtier", "courtier", "courtier",
    "commoner", "commoner", "commoner", "commoner", "commoner",
    "commoner", "commoner", "commoner", "commoner", "commoner"];
  roles.forEach((role, i) => d.roster.set(`a${i}`, rec(`A${i}`, role, "asgarnia")));
  const m = rec("M0", "commoner", "misthalin");
  d.roster.set("m0", m);
  const arrivals = Aging.processImmigration(d, Date.now(), () => 0.9);
  assert.ok(arrivals.length > 0);
  assert.equal(arrivals[0].kingdomId, "misthalin", "newcomer goes where the deficit is");
  console.log("ok 10 - biggestDeficit targets the emptiest kingdom");
}

{
  resetAll();
  // biggestDeficit pure helper.
  const counts = { asgarnia: { commoner: 10, guard: 4, merchant: 3, courtier: 3 }, misthalin: { commoner: 2 } };
  const plan = { asgarnia: { guard: 4, merchant: 3, commoner: 10, courtier: 3 }, misthalin: { guard: 4, merchant: 3, commoner: 10, courtier: 3 } };
  const need = Aging.biggestDeficit(counts, plan);
  assert.equal(need.kingdomId, "misthalin");
  assert.equal(need.role, "commoner");
  assert.equal(need.deficit, 8);
  assert.equal(Aging.biggestDeficit({ asgarnia: { guard: 4, merchant: 3, commoner: 10, courtier: 3 } }, { asgarnia: plan.asgarnia }), null);
  console.log("ok 11 - biggestDeficit pure logic");
}

// --- tick integration ---------------------------------------------------------

{
  resetAll();
  const d = mockDirector(50, ["asgarnia"]);
  // One elder worker in the roster.
  const elder = rec("TickOld", "merchant", "asgarnia");
  d.roster.set("tickold", elder);
  Aging._data().citizens["tickold"] = { age: 61, lastAgedAt: Date.now() - 3 * DAY, stage: "middle-aged" };
  Aging.tickAging(d, Date.now(), () => 0.5);
  assert.equal(Careers.isCareerRetired("TickOld"), true, "tick retires elders");
  assert.equal(Aging.ageOf(elder), 64, "tick advances age by elapsed years");
  assert.ok(d.added.length > 0, "tick triggers immigration below target");
  assert.ok(Array.isArray(d._pendingArrivals), "arrivals stashed for proximity tick");
  console.log("ok 12 - tickAging integrates retirement + aging + immigration");
}

{
  resetAll();
  // forgetCitizen cleans up after death/removal.
  const r = rec("Gone");
  Aging.ageCitizen(r, Date.now(), () => 0.5);
  assert.ok(Aging._data().citizens["gone"]);
  Aging.forgetCitizen("Gone");
  assert.ok(!Aging._data().citizens["gone"]);
  console.log("ok 13 - forgetCitizen cleans up");
}

console.log("aging status:", Aging.agingStatus());
console.log("All CitizenAging checks passed.");
