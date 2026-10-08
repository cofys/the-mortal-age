"use strict";
// CitizenTeachers unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const T = require("./CitizenTeachers");

// Deterministic LCG — coverage is exact, not luck-based.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

// Point the store at a temp file so tests never touch real saves.
const tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "citizen-teachers-")), "save.json");
T._setSaveFileForTests(tmpFile);

// --- constants ---
check("four teacher types with subject lists", () => {
  assert.equal(T.TEACHER_TYPES.length, 4);
  assert.deepEqual(T.TEACHER_SUBJECTS[T.SCHOOLMASTER], ["reading", "writing", "arithmetic"]);
  assert.deepEqual(T.TEACHER_SUBJECTS[T.TRADE_INSTRUCTOR], ["trade"]);
  assert.deepEqual(T.TEACHER_SUBJECTS[T.SAGE], ["history"]);
  assert.ok(T.TEACHER_SUBJECTS[T.TUTOR].length >= 5);
});

check("five curriculum subjects, level cap 5", () => {
  assert.equal(T.SUBJECTS.length, 5);
  assert.equal(T.MAX_SUBJECT_LEVEL, 5);
  assert.equal(T.GRADUATION_TOTAL, 15);
});

check("lesson and student line pools non-empty for every subject", () => {
  for (const s of T.SUBJECTS) {
    assert.ok(T.LESSON_LINES[s].length >= 3, `lines for ${s}`);
  }
  assert.ok(T.STUDENT_LINES.length >= 3);
  assert.ok(T.WELCOME_LINES.length >= 3);
});

// --- school hours ---
check("school hours are 08:00-14:00 server local", () => {
  const d = (h) => new Date(2026, 0, 5, h, 30, 0).getTime();
  assert.equal(T.isSchoolHours(d(7)), false);
  assert.equal(T.isSchoolHours(d(8)), true);
  assert.equal(T.isSchoolHours(d(13)), true);
  assert.equal(T.isSchoolHours(d(14)), false);
  assert.equal(T.isSchoolHours(d(23)), false);
});

// --- deterministic assignment ---
check("assignTeachers is deterministic and covers types", () => {
  const names = ["Aldric", "Bryn", "Cora", "Dain", "Elowen", "Fenwick"];
  const a = T.assignTeachers("asgarnia", names);
  const b = T.assignTeachers("asgarnia", names);
  assert.deepEqual(a, b);
  const types = a.map((t) => t.type);
  assert.ok(types.includes(T.SCHOOLMASTER));
  assert.ok(types.includes(T.TRADE_INSTRUCTOR));
  assert.ok(types.includes(T.SAGE));
  // No duplicate teachers.
  const seen = new Set(a.map((t) => t.username.toLowerCase()));
  assert.equal(seen.size, a.length);
});

check("assignTeachers differs per kingdom and degrades with few citizens", () => {
  const names = ["Aldric", "Bryn", "Cora", "Dain", "Elowen", "Fenwick"];
  const asg = JSON.stringify(T.assignTeachers("asgarnia", names));
  const mis = JSON.stringify(T.assignTeachers("misthalin", names));
  assert.notEqual(asg, mis);
  const solo = T.assignTeachers("keldagrim", ["Solo"]);
  assert.equal(solo.length, 1);
  assert.equal(solo[0].type, T.SCHOOLMASTER);
  assert.deepEqual(T.assignTeachers("nowhere", []), []);
});

check("isSchoolAge is deterministic and roughly 1 in 4", () => {
  let count = 0;
  for (let i = 0; i < 200; i++) {
    const name = `citizen${i}`;
    assert.equal(T.isSchoolAge(name), T.isSchoolAge(name));
    if (T.isSchoolAge(name)) count++;
  }
  assert.ok(count >= 30 && count <= 70, `school-age count ${count} in range`);
});

check("pickStudents is deterministic, capped, kingdom-scoped", () => {
  const records = [];
  for (let i = 0; i < 60; i++) {
    records.push({ username: `pupil${i}`, kingdomId: "asgarnia", role: "commoner" });
    records.push({ username: `other${i}`, kingdomId: "misthalin", role: "commoner" });
  }
  const a = T.pickStudents("asgarnia", records);
  const b = T.pickStudents("asgarnia", records);
  assert.deepEqual(a, b);
  assert.ok(a.length <= 6);
  for (const n of a) assert.ok(T.isSchoolAge(n));
  const m = T.pickStudents("misthalin", records);
  for (const n of m) assert.ok(!a.includes(n), "kingdoms do not share students");
});

// --- curriculum ---
check("blankCurriculum starts at zero, totals zero", () => {
  const c = T.blankCurriculum();
  assert.equal(T.curriculumTotal(c), 0);
});

check("advanceCurriculum raises the weakest subject first", () => {
  let subjects = T.blankCurriculum();
  const seen = [];
  for (let i = 0; i < 5; i++) {
    const { subjects: next, advanced } = T.advanceCurriculum(subjects, Date.now());
    subjects = next;
    seen.push(advanced);
    assert.ok(T.SUBJECTS.includes(advanced));
  }
  // All five subjects raised exactly once before any repeats.
  assert.deepEqual([...seen].sort(), [...T.SUBJECTS].sort());
  assert.equal(T.curriculumTotal(subjects), 5);
});

check("advanceCurriculum stops at the level cap", () => {
  const subjects = T.blankCurriculum();
  for (const s of T.SUBJECTS) subjects[s] = T.MAX_SUBJECT_LEVEL;
  const { advanced } = T.advanceCurriculum(subjects, Date.now());
  assert.equal(advanced, null);
});

check("hasGraduated at total 15", () => {
  const subjects = T.blankCurriculum();
  for (const s of T.SUBJECTS) subjects[s] = 3;
  assert.equal(T.hasGraduated(subjects), true);
  subjects.reading = 2;
  assert.equal(T.hasGraduated(subjects), false);
});

// --- gating ---
check("shouldHoldClass respects hours, cooldown, chance", () => {
  const schoolTime = new Date(2026, 0, 5, 10, 0, 0).getTime();
  const night = new Date(2026, 0, 5, 22, 0, 0).getTime();
  const always = () => 0.0;
  const never = () => 0.999;
  assert.equal(T.shouldHoldClass(always, 0, night), false, "no class at night");
  assert.equal(T.shouldHoldClass(always, schoolTime, schoolTime), false, "cooldown blocks");
  assert.equal(T.shouldHoldClass(always, 0, schoolTime), true, "fresh teacher may teach");
  assert.equal(T.shouldHoldClass(never, 0, schoolTime), false, "chance gate works");
});

// --- shared helpers ---
check("isRealPlayer rejects bots and accepts players", () => {
  assert.equal(T.isRealPlayer(null), false);
  assert.equal(T.isRealPlayer({ isPlayerBot: () => true }), false);
  assert.equal(T.isRealPlayer({ getHostAddress: () => "bot", getUsername: () => "x" }), false);
  assert.equal(T.isRealPlayer({ getUsername: () => "Jon" }), true);
});

check("withinTiles chebyshev on same plane", () => {
  const loc = (x, y, z) => ({ getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => z }) });
  assert.equal(T.withinTiles(loc(0, 0, 0), loc(10, 5, 0), 14), true);
  assert.equal(T.withinTiles(loc(0, 0, 0), loc(15, 0, 0), 14), false);
  assert.equal(T.withinTiles(loc(0, 0, 0), loc(1, 1, 1), 14), false);
});

check("fillLessonLine fills tokens", () => {
  const out = T.fillLessonLine("A {title} on {subject}.", T.SAGE, "history");
  assert.equal(out, "A Sage on history.");
});

// --- persistence round-trip ---
check("store save/load round-trips students and schools", () => {
  const st = T._store;
  st.schools.set("asgarnia", { foundedAt: 123, teachers: [{ username: "Aldric", type: T.SCHOOLMASTER }] });
  const subjects = T.blankCurriculum();
  subjects.reading = 2;
  st.students.set("pupil1", {
    kingdomId: "asgarnia",
    subjects,
    enrolledAt: 100,
    lastAdvancedAt: 200,
    graduated: false,
  });
  st.playerTeachers.set("jon", { subject: "history", since: 300 });
  st.save();
  st.resetForTests();
  st.load();
  assert.equal(st.schools.get("asgarnia").teachers[0].username, "Aldric");
  assert.equal(st.students.get("pupil1").subjects.reading, 2);
  assert.equal(st.students.get("pupil1").graduated, false);
  assert.equal(st.playerTeachers.get("jon").subject, "history");
  st.resetForTests();
});

// --- volunteerTeach ---
check("volunteerTeach registers a player teacher", () => {
  const res = T.volunteerTeach(null, "JonCofy", "trade");
  assert.equal(res.subject, "trade");
  assert.equal(T._store.playerTeachers.get("joncofy").subject, "trade");
  // Bad subject falls back to reading.
  const res2 = T.volunteerTeach(null, "JonCofy", "alchemy");
  assert.equal(res2.subject, "reading");
  T._resetStoreForTests();
});

console.log(`\n${passed} assertions passed.`);
