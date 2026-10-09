"use strict";

const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");

const Philosophy = require("./CitizenPhilosophy");

function freshSave() {
  const p = path.join(os.tmpdir(), `citizen-philosophy-test-${Date.now()}-${Math.random()}.json`);
  Philosophy.resetForTests();
  Philosophy._setSavePathForTests(p);
  return p;
}

// --- school catalog ---

{
  freshSave();
  assert(Philosophy.SCHOOL_IDS.length === 5, "5 schools");
  assert(Philosophy.schoolFor("stoics").name === "Stoics", "stoics exist");
  assert(Philosophy.schoolFor("bogus") === null, "unknown school null");
  console.log("ok: school catalog");
}

// --- bestSchoolForTraits ---

{
  freshSave();
  const school = Philosophy.bestSchoolForTraits(["dutiful", "patient", "calm"]);
  assert(school === "stoics", `dutiful+patient -> stoics, got ${school}`);
  const school2 = Philosophy.bestSchoolForTraits(["ambitious", "bold"]);
  assert(school2 === "ambitionists", `ambitious+bold -> ambitionists, got ${school2}`);
  const none = Philosophy.bestSchoolForTraits(["xyznonexistent"]);
  assert(none === null, "no matching traits -> null");
  const empty = Philosophy.bestSchoolForTraits([]);
  assert(empty === null, "empty traits -> null");
  console.log("ok: bestSchoolForTraits");
}

// --- join/leave ---

{
  freshSave();
  assert(!Philosophy.isPhilosopher("Alice"), "not philosopher initially");
  const r = Philosophy.joinSchool("Alice", "stoics");
  assert(r.ok, "join succeeds");
  assert(Philosophy.isPhilosopher("Alice"), "is philosopher after join");
  const phil = Philosophy.philosopherFor("Alice");
  assert(phil.school === "stoics", "school recorded");
  assert(phil.wisdom === 10, "starting wisdom 10");

  const dup = Philosophy.joinSchool("Alice", "skeptics");
  assert(!dup.ok && dup.reason === "already-philosopher", "no double-join");

  const bad = Philosophy.joinSchool("Bob", "nonsense");
  assert(!bad.ok && bad.reason === "unknown-school", "bad school rejected");

  assert(Philosophy.leaveSchool("Alice"), "leave succeeds");
  assert(!Philosophy.isPhilosopher("Alice"), "not philosopher after leave");
  assert(!Philosophy.leaveSchool("Alice"), "leave non-philosopher false");
  console.log("ok: join/leave");
}

// --- wisdom ---

{
  freshSave();
  Philosophy.joinSchool("Alice", "skeptics");
  assert(Philosophy.wisdomFor("Alice") === 10, "initial wisdom");
  assert(Philosophy.wisdomFor("Nobody") === 0, "non-philosopher wisdom 0");

  const w1 = Philosophy.addWisdom("Alice", 25);
  assert(w1 === 35, "wisdom added");
  const w2 = Philosophy.addWisdom("Alice", 100);
  assert(w2 === 100, "wisdom capped at 100");
  const w3 = Philosophy.addWisdom("Alice", -200);
  assert(w3 === 0, "wisdom floored at 0");

  assert(!Philosophy.isSage("Alice"), "not sage at 0");
  Philosophy.addWisdom("Alice", 85);
  assert(Philosophy.isSage("Alice"), "sage at 85");
  assert(Philosophy.canTeach("Alice"), "can teach at 85");
  assert(Philosophy.canDebate("Alice"), "can debate at 85");

  Philosophy.addWisdom("Alice", -60); // back to 25
  assert(!Philosophy.canTeach("Alice"), "cannot teach at 25");
  assert(!Philosophy.canDebate("Alice"), "cannot debate at 25");
  console.log("ok: wisdom thresholds");
}

// --- contemplation ---

{
  freshSave();
  Philosophy.joinSchool("Alice", "naturalists");
  const now = Date.now();
  assert(Philosophy.canContemplate("Alice", now), "can contemplate initially");
  const r = Philosophy.contemplate("Alice", now);
  assert(r.ok, "contemplate succeeds");
  assert(r.wisdom === 13, "wisdom +3 from contemplation");
  assert(!Philosophy.canContemplate("Alice", now + 1000), "cooldown active");
  assert(Philosophy.canContemplate("Alice", now + 5 * 60 * 60 * 1000), "cooldown expires");

  const r2 = Philosophy.contemplate("Alice", now + 1000);
  assert(!r2.ok && r2.reason === "too-soon", "too soon rejected");

  const r3 = Philosophy.contemplate("Nobody", now);
  assert(!r3.ok && r3.reason === "not-philosopher", "non-philosopher rejected");
  console.log("ok: contemplation");
}

// --- debates ---

{
  freshSave();
  Philosophy.joinSchool("Alice", "stoics");
  Philosophy.joinSchool("Bob", "skeptics");
  Philosophy.addWisdom("Alice", 40); // 50
  Philosophy.addWisdom("Bob", 30); // 40

  assert(Philosophy.shouldHoldDebate("k1", Date.now()), "debate due initially");
  const debate = Philosophy.scheduleDebate("k1", ["Alice", "Bob"], "justice", Date.now());
  assert(debate.participants.length === 2, "2 participants");
  assert(debate.winner === null, "no winner yet");
  assert(!Philosophy.shouldHoldDebate("k1", Date.now()), "cooldown after scheduling");

  Philosophy.recordDebate("Alice", ["Bob"]);
  const alice = Philosophy.philosopherFor("Alice");
  const bob = Philosophy.philosopherFor("Bob");
  assert(alice.debatesWon === 1, "winner recorded");
  assert(bob.debatesLost === 1, "loser recorded");
  assert(alice.wisdom === 55, "winner +5 wisdom");
  assert(bob.wisdom === 42, "loser +2 wisdom");
  console.log("ok: debates");
}

// --- resolveDebate ---

{
  freshSave();
  Philosophy.joinSchool("Alice", "stoics");
  Philosophy.joinSchool("Bob", "skeptics");
  Philosophy.addWisdom("Alice", 30);
  Philosophy.addWisdom("Bob", 30);
  Philosophy.scheduleDebate("k1", ["Alice", "Bob"], "courage", Date.now());
  const r = Philosophy.resolveDebate(0, "Bob");
  assert(r.ok, "resolve succeeds");
  assert(r.winner === "Bob", "winner recorded");
  const r2 = Philosophy.resolveDebate(0, "Alice");
  assert(!r2.ok, "cannot re-resolve");
  const r3 = Philosophy.resolveDebate(99, "Alice");
  assert(!r3.ok, "invalid index rejected");
  console.log("ok: resolveDebate");
}

// --- academies ---

{
  freshSave();
  const a1 = Philosophy.academyFor("varrock");
  assert(a1.kingdomId === "varrock", "academy kingdom");
  assert(a1.debateCount === 0, "no debates yet");
  const a2 = Philosophy.academyFor("varrock");
  assert(a1 === a2, "same academy returned");
  console.log("ok: academies");
}

// --- topSages ---

{
  freshSave();
  Philosophy.joinSchool("Alice", "stoics");
  Philosophy.joinSchool("Bob", "skeptics");
  Philosophy.joinSchool("Carol", "epicureans");
  Philosophy.addWisdom("Alice", 70); // 80
  Philosophy.addWisdom("Bob", 40); // 50
  Philosophy.addWisdom("Carol", 20); // 30
  const top = Philosophy.topSages(2);
  assert(top.length === 2, "limit respected");
  assert(top[0].username === "Alice", "highest wisdom first");
  assert(top[1].username === "Bob", "second highest second");
  console.log("ok: topSages");
}

// --- philosophersInKingdom ---

{
  freshSave();
  Philosophy.joinSchool("Alice", "stoics");
  Philosophy.joinSchool("Bob", "skeptics");
  const roster = [
    { username: "Alice", kingdomId: "k1" },
    { username: "Bob", kingdomId: "k2" },
    { username: "Carol", kingdomId: "k1" }, // not a philosopher
  ];
  const inK1 = Philosophy.philosophersInKingdom("k1", roster);
  assert(inK1.length === 1 && inK1[0].username === "Alice", "k1 has Alice");
  const inK2 = Philosophy.philosophersInKingdom("k2", roster);
  assert(inK2.length === 1 && inK2[0].username === "Bob", "k2 has Bob");
  console.log("ok: philosophersInKingdom");
}

// --- teachingBonusFor ---

{
  freshSave();
  Philosophy.joinSchool("Alice", "stoics");
  assert(Philosophy.teachingBonusFor("Alice") === 0, "no bonus at wisdom 10");
  assert(Philosophy.teachingBonusFor("Nobody") === 0, "no bonus for non-philosopher");
  Philosophy.addWisdom("Alice", 45); // 55
  const bonus = Philosophy.teachingBonusFor("Alice");
  assert(bonus >= 1 && bonus <= 5, `bonus in range, got ${bonus}`);
  Philosophy.addWisdom("Alice", 45); // 100
  assert(Philosophy.teachingBonusFor("Alice") === 5, "max bonus at 100");
  console.log("ok: teachingBonusFor");
}

// --- persistence ---

{
  const savePath = freshSave();
  Philosophy.joinSchool("Alice", "stoics");
  Philosophy.addWisdom("Alice", 30);
  assert(Philosophy.save(), "save succeeds");
  assert(fs.existsSync(savePath), "save file exists");

  // Reload from disk
  Philosophy.resetForTests();
  Philosophy._setSavePathForTests(savePath);
  assert(Philosophy.isPhilosopher("Alice"), "philosopher persisted");
  assert(Philosophy.wisdomFor("Alice") === 40, "wisdom persisted");
  console.log("ok: persistence");
}

console.log("\nAll CitizenPhilosophy tests passed!");
