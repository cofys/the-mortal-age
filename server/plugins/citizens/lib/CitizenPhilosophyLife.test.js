"use strict";

const assert = require("assert");
const path = require("path");
const os = require("os");

const Philosophy = require("./CitizenPhilosophy");
const { tickPhilosophy } = require("./CitizenPhilosophyLife");

function freshSave() {
  const p = path.join(os.tmpdir(), `citizen-phil-life-test-${Date.now()}-${Math.random()}.json`);
  Philosophy.resetForTests();
  Philosophy._setSavePathForTests(p);
  return p;
}

function mockDirector(rosterRecords) {
  const roster = new Map();
  for (const r of rosterRecords || []) {
    roster.set(r.username, r);
  }
  return {
    roster,
    said: [],
    sayPublic(text) {
      this.said.push(text);
    },
    logged: [],
    log(msg, data) {
      this.logged.push({ msg, data });
    },
  };
}

// --- tick never throws with empty director ---

{
  freshSave();
  const director = mockDirector([]);
  tickPhilosophy(director, Date.now()); // should not throw
  tickPhilosophy(null, Date.now()); // null director should not throw
  tickPhilosophy({}, Date.now()); // empty director should not throw
  console.log("ok: never throws");
}

// --- debate happens with 2+ eligible philosophers ---

{
  freshSave();
  Philosophy.joinSchool("Alice", "stoics");
  Philosophy.joinSchool("Bob", "skeptics");
  Philosophy.addWisdom("Alice", 50); // 60
  Philosophy.addWisdom("Bob", 40); // 50

  const director = mockDirector([
    { username: "Alice", kingdomId: "k1" },
    { username: "Bob", kingdomId: "k1" },
  ]);
  const now = Date.now();
  tickPhilosophy(director, now);

  // Debate should have been scheduled and resolved
  const alice = Philosophy.philosopherFor("Alice");
  assert(alice.debatesWon === 1, "Alice won (higher wisdom)");
  const bob = Philosophy.philosopherFor("Bob");
  assert(bob.debatesLost === 1, "Bob lost");

  // Announcement should have been made
  assert(director.said.length > 0, "debate announced");
  assert(director.said[0].includes("Alice"), "winner named in announcement");

  // No second debate immediately (cooldown)
  const saidCount = director.said.length;
  tickPhilosophy(director, now + 1000);
  assert(director.said.length === saidCount, "no duplicate debate");
  console.log("ok: debate scheduling and resolution");
}

// --- no debate with fewer than 2 philosophers ---

{
  freshSave();
  Philosophy.joinSchool("Alice", "stoics");
  Philosophy.addWisdom("Alice", 50);

  const director = mockDirector([{ username: "Alice", kingdomId: "k1" }]);
  tickPhilosophy(director, Date.now());
  assert(director.said.length === 0, "no debate with 1 philosopher");
  console.log("ok: no debate when insufficient philosophers");
}

// --- no debate when philosophers lack wisdom ---

{
  freshSave();
  Philosophy.joinSchool("Alice", "stoics"); // wisdom 10, below debater threshold
  Philosophy.joinSchool("Bob", "skeptics");

  const director = mockDirector([
    { username: "Alice", kingdomId: "k1" },
    { username: "Bob", kingdomId: "k1" },
  ]);
  tickPhilosophy(director, Date.now());
  assert(director.said.length === 0, "no debate when wisdom too low");
  console.log("ok: no debate when wisdom too low");
}

// --- sage announcement ---

{
  freshSave();
  Philosophy.joinSchool("Alice", "stoics");
  Philosophy.addWisdom("Alice", 75); // 85, sage level

  const director = mockDirector([{ username: "Alice", kingdomId: "k1" }]);
  tickPhilosophy(director, Date.now());

  const sageAnnouncements = director.said.filter((s) => s.includes("sage"));
  assert(sageAnnouncements.length === 1, "sage announced once");

  // Second tick should not re-announce
  tickPhilosophy(director, Date.now() + 1000);
  const sageAnnouncements2 = director.said.filter((s) => s.includes("sage"));
  assert(sageAnnouncements2.length === 1, "sage not re-announced");
  console.log("ok: sage announcement (once)");
}

// --- multiple kingdoms ---

{
  freshSave();
  Philosophy.joinSchool("Alice", "stoics");
  Philosophy.joinSchool("Bob", "skeptics");
  Philosophy.joinSchool("Carol", "epicureans");
  Philosophy.joinSchool("Dave", "naturalists");
  for (const name of ["Alice", "Bob", "Carol", "Dave"]) {
    Philosophy.addWisdom(name, 50);
  }

  const director = mockDirector([
    { username: "Alice", kingdomId: "k1" },
    { username: "Bob", kingdomId: "k1" },
    { username: "Carol", kingdomId: "k2" },
    { username: "Dave", kingdomId: "k2" },
  ]);
  tickPhilosophy(director, Date.now());

  // Two debates (one per kingdom)
  const debateAnnouncements = director.said.filter((s) => s.includes("wins the debate"));
  assert(debateAnnouncements.length === 2, `two debates, got ${debateAnnouncements.length}`);
  console.log("ok: multiple kingdoms");
}

console.log("\nAll CitizenPhilosophyLife tests passed!");
