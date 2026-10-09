"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const Schools = require("./CitizenSchools");

function tmpSave() {
  const p = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "schools-")),
    "citizen-schools.json"
  );
  Schools._setSavePathForTests(p);
  Schools.resetForTests();
  return p;
}

function fakeChild(over = {}) {
  return {
    id: "child_1",
    display: "Mara Stone",
    surname: "Stone",
    parents: ["tomas stone", "ella stone"],
    familyId: "fam_1",
    kingdomId: "misthalin",
    bornAt: Date.now() - 10 * 24 * 3600 * 1000,
    stage: "child",
    traits: ["curious"],
    bequest: 0,
    joinedRoster: false,
    learnedXp: {},
    leftTown: false,
    ...over,
  };
}

test("schoolTileFor is deterministic and off the market tile", () => {
  const a = Schools.schoolTileFor("misthalin");
  const b = Schools.schoolTileFor("misthalin");
  assert.deepEqual(a, b);
  const c = Schools.schoolTileFor("asgarnia");
  // Different kingdoms (usually) land on different tiles.
  assert.ok(a.x !== c.x || a.y !== c.y || a.x === 3214 + 14);
  assert.ok(Number.isFinite(a.x) && Number.isFinite(a.y));
});

test("foundSchool creates one schoolhouse per kingdom", () => {
  tmpSave();
  const s1 = Schools.foundSchool("misthalin", "Scribe Ana");
  assert.ok(s1);
  assert.equal(s1.name, "Misthalin Schoolhouse");
  assert.equal(s1.teacher, "Scribe Ana");
  assert.equal(Schools.schoolOfKingdom("misthalin").name, s1.name);
  // Second founding is a no-op returning the existing school.
  const s2 = Schools.foundSchool("misthalin", "Someone Else");
  assert.equal(s2.name, s1.name);
  assert.equal(s2.teacher, "Scribe Ana");
  assert.equal(Schools.schoolOfKingdom("asgarnia"), null);
});

test("isSchoolAgeChild gates on stage and town status", () => {
  assert.equal(Schools.isSchoolAgeChild(fakeChild({ stage: "child" })), true);
  assert.equal(Schools.isSchoolAgeChild(fakeChild({ stage: "teen" })), true);
  assert.equal(Schools.isSchoolAgeChild(fakeChild({ stage: "baby" })), false);
  assert.equal(Schools.isSchoolAgeChild(fakeChild({ stage: "adult" })), false);
  assert.equal(Schools.isSchoolAgeChild(fakeChild({ leftTown: true })), false);
  assert.equal(Schools.isSchoolAgeChild(fakeChild({ joinedRoster: true })), false);
  assert.equal(Schools.isSchoolAgeChild(null), false);
});

test("enrollPupil requires a schoolhouse and honors capacity", () => {
  tmpSave();
  const kid = fakeChild();
  // No school → no enrollment.
  assert.equal(Schools.enrollPupil(kid), null);
  Schools.foundSchool("misthalin", null);
  const pupil = Schools.enrollPupil(kid);
  assert.ok(pupil);
  assert.equal(pupil.literacy, 0);
  assert.equal(pupil.numeracy, 0);
  assert.equal(Schools.isEnrolled(kid.id), true);
  // Re-enrollment returns the existing pupil.
  assert.equal(Schools.enrollPupil(kid).childId, kid.id);
  assert.equal(Schools.pupilsOfKingdom("misthalin").length, 1);
  assert.equal(Schools.pupilsOfKingdom("asgarnia").length, 0);
});

test("recordLesson climbs literacy and numeracy toward 100", () => {
  tmpSave();
  Schools.foundSchool("misthalin", null);
  const kid = fakeChild();
  Schools.enrollPupil(kid);
  for (let i = 0; i < 60; i++) Schools.recordLesson(kid.id);
  const p = Schools.pupilOf(kid.id);
  assert.equal(p.lessonsAttended, 60);
  assert.equal(p.literacy, 100);
  assert.equal(p.numeracy, 100);
  // Lessons stop mattering past graduation.
  Schools.graduatePupil(kid.id);
  assert.equal(Schools.recordLesson(kid.id), false);
});

test("tuition debt accrues and clears", () => {
  tmpSave();
  Schools.foundSchool("misthalin", null);
  const kid = fakeChild();
  Schools.enrollPupil(kid);
  assert.equal(Schools.addTuitionDebt(kid.id), 1);
  assert.equal(Schools.addTuitionDebt(kid.id), 2);
  Schools.clearTuitionDebt(kid.id, 12345);
  assert.equal(Schools.pupilOf(kid.id).tuitionDebtDays, 0);
  assert.equal(Schools.pupilOf(kid.id).lastTuitionAt, 12345);
});

test("unenrollPupil keeps the record for honest re-enrollment", () => {
  tmpSave();
  Schools.foundSchool("misthalin", null);
  const kid = fakeChild();
  Schools.enrollPupil(kid);
  Schools.recordLesson(kid.id);
  assert.equal(Schools.unenrollPupil(kid.id, "unpaid tuition"), true);
  assert.equal(Schools.isEnrolled(kid.id), false);
  const p = Schools.pupilOf(kid.id);
  assert.equal(p.lessonsAttended, 1);
  assert.equal(p.unenrollReason, "unpaid tuition");
});

test("graduatePupil is idempotent", () => {
  tmpSave();
  Schools.foundSchool("misthalin", null);
  const kid = fakeChild();
  Schools.enrollPupil(kid);
  assert.equal(Schools.graduatePupil(kid.id), true);
  assert.equal(Schools.graduatePupil(kid.id), false);
  assert.ok(Schools.pupilOf(kid.id).graduatedAt);
  assert.equal(Schools.isEnrolled(kid.id), false);
});

test("xpBonusFor rewards graduates, ignores everyone else", () => {
  tmpSave();
  Schools.foundSchool("misthalin", null);
  // No record → no bonus.
  assert.equal(Schools.xpBonusFor("Mara Stone"), 0);
  const kid = fakeChild();
  Schools.enrollPupil(kid);
  // Enrolled but not graduated → no bonus.
  assert.equal(Schools.xpBonusFor("Mara Stone"), 0);
  // Perfect graduate → max bonus.
  for (let i = 0; i < 60; i++) Schools.recordLesson(kid.id);
  Schools.graduatePupil(kid.id);
  assert.equal(Schools.xpBonusFor("Mara Stone"), Schools.MAX_XP_BONUS);
  assert.equal(Schools.xpBonusFor("mara stone"), Schools.MAX_XP_BONUS); // normalized
  // Half-schooled graduate → half bonus.
  const kid2 = fakeChild({ id: "child_2", display: "Pip Stone" });
  Schools.enrollPupil(kid2);
  for (let i = 0; i < 15; i++) Schools.recordLesson(kid2.id);
  Schools.graduatePupil(kid2.id);
  const half = Schools.xpBonusFor("Pip Stone");
  assert.ok(half > 0 && half < Schools.MAX_XP_BONUS);
  // A stranger shares no name → no bonus.
  assert.equal(Schools.xpBonusFor("Stranger Danger"), 0);
});

test("schoolingSummary returns the pupil's real state", () => {
  tmpSave();
  assert.equal(Schools.schoolingSummary("child_9"), null);
  Schools.foundSchool("misthalin", "Scribe Ana");
  const kid = fakeChild();
  Schools.enrollPupil(kid);
  Schools.recordLesson(kid.id);
  const s = Schools.schoolingSummary(kid.id);
  assert.equal(s.display, "Mara Stone");
  assert.equal(s.school, "Misthalin Schoolhouse");
  assert.equal(s.literacy, 2);
  assert.equal(s.graduated, false);
});

test("save and reload round-trip preserves schools and pupils", () => {
  const p = tmpSave();
  Schools.foundSchool("misthalin", "Scribe Ana");
  const kid = fakeChild();
  Schools.enrollPupil(kid);
  Schools.recordLesson(kid.id);
  assert.equal(Schools.save(), true);
  // Wipe memory and reload from disk.
  Schools.resetForTests();
  assert.equal(Schools.schoolOfKingdom("misthalin").teacher, "Scribe Ana");
  assert.equal(Schools.pupilOf(kid.id).lessonsAttended, 1);
  assert.ok(fs.existsSync(p));
});

test("setTeacher appoints and clears the schoolmaster", () => {
  tmpSave();
  assert.equal(Schools.setTeacher("misthalin", "Scribe Ana"), false);
  Schools.foundSchool("misthalin", null);
  assert.equal(Schools.setTeacher("misthalin", "Scribe Ana"), true);
  assert.equal(Schools.schoolOfKingdom("misthalin").teacher, "Scribe Ana");
  assert.equal(Schools.setTeacher("misthalin", null), true);
  assert.equal(Schools.schoolOfKingdom("misthalin").teacher, null);
});
