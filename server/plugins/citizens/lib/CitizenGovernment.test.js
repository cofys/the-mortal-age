"use strict";

// Tests for CitizenGovernment (data tier). Run with: node --test <this file>

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const Gov = require("./CitizenGovernment");

function fresh() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gov-test-"));
  Gov.resetForTests();
  Gov._setSavePathForTests(path.join(tmp, "government.json"));
}

test("ensureCouncil creates a blank council", () => {
  fresh();
  const c = Gov.ensureCouncil("falador", "Falador", 1000);
  assert.equal(c.kingdomId, "falador");
  assert.equal(c.kingdomName, "Falador");
  assert.deepEqual(c.seats, []);
  assert.equal(c.unrest, 10);
});

test("getCouncil returns null for unknown kingdom", () => {
  fresh();
  assert.equal(Gov.getCouncil("nowhere"), null);
});

test("passLaw applies unrest delta and blocks duplicates", () => {
  fresh();
  Gov.ensureCouncil("falador", "Falador", 1000);
  const law = Gov.passLaw("falador", "festival", "alice", 2000);
  assert.ok(law);
  assert.equal(law.name, "Harvest Festival");
  const c = Gov.getCouncil("falador");
  // festival unrestDelta is -12; 10 - 12 clamps to 0
  assert.equal(c.unrest, 0);
  // duplicate is rejected
  assert.equal(Gov.passLaw("falador", "festival", "bob", 3000), null);
  assert.equal(c.laws.length, 1);
});

test("passLaw rejects unknown law ids", () => {
  fresh();
  Gov.ensureCouncil("falador", "Falador", 1000);
  assert.equal(Gov.passLaw("falador", "nope", "alice", 2000), null);
});

test("raise-taxes increases unrest", () => {
  fresh();
  Gov.ensureCouncil("falador", "Falador", 1000);
  Gov.passLaw("falador", "raise-taxes", "alice", 2000);
  assert.equal(Gov.getCouncil("falador").unrest, 20); // 10 + 10
});

test("repealLaw removes the law", () => {
  fresh();
  Gov.ensureCouncil("falador", "Falador", 1000);
  Gov.passLaw("falador", "festival", "alice", 2000);
  assert.ok(Gov.repealLaw("falador", "festival"));
  assert.equal(Gov.activeLaws("falador").length, 0);
  assert.equal(Gov.repealLaw("falador", "festival"), false);
});

test("expired laws drop out of activeLaws", () => {
  fresh();
  Gov.ensureCouncil("falador", "Falador", 1000);
  Gov.passLaw("falador", "festival", "alice", 1000, 5000); // 5s duration
  assert.equal(Gov.activeLaws("falador", 2000).length, 1);
  assert.equal(Gov.activeLaws("falador", 7000).length, 0);
});

test("nominateCandidate dedupes and blocks office holders", () => {
  fresh();
  Gov.ensureCouncil("falador", "Falador", 1000);
  assert.ok(Gov.nominateCandidate("falador", "Alice", "Alice", false, 1000));
  assert.equal(Gov.nominateCandidate("falador", "alice", "Alice", false, 1000), false);
  // simulate her winning a seat, then she can't be nominated again
  const c = Gov.getCouncil("falador");
  c.seats.push({ office: "mayor", citizenName: "Alice", displayName: "Alice" });
  assert.equal(Gov.nominateCandidate("falador", "Alice", "Alice", false, 1000), false);
});

test("endorseCandidate records player endorsements once", () => {
  fresh();
  Gov.ensureCouncil("falador", "Falador", 1000);
  Gov.nominateCandidate("falador", "Alice", "Alice", false, 1000);
  assert.ok(Gov.endorseCandidate("falador", "Alice", "Jon"));
  assert.ok(Gov.endorseCandidate("falador", "Alice", "Jon")); // idempotent
  const c = Gov.getCouncil("falador");
  assert.deepEqual(c.endorsements["alice"], ["Jon"]);
  assert.equal(Gov.endorseCandidate("falador", "Nobody", "Jon"), false);
});

test("runElection picks mayor and councilors by votes", () => {
  fresh();
  Gov.ensureCouncil("falador", "Falador", 1000);
  const voters = [
    { username: "v1", personality: { traits: [] } },
    { username: "v2", personality: { traits: [] } },
    { username: "v3", personality: { traits: [] } },
  ];
  const candidates = [
    { name: "Alice", displayName: "Alice" },
    { name: "Bob", displayName: "Bob" },
  ];
  const ctx = {
    isFriend: (a, b) => a === "v1" && b === "Alice",
    clanOf: () => null,
    careerOf: () => null,
    recordOf: () => null,
  };
  const seats = Gov.runElection("falador", voters, candidates, ctx, 5000);
  assert.equal(seats.length, 2);
  assert.equal(seats[0].office, "mayor");
  // v1 is Alice's friend (+3) so Alice should win the mayoral seat
  assert.equal(seats[0].citizenName, "Alice");
  assert.ok(seats[0].votes >= (seats[1]?.votes ?? 0));
  // election vents unrest
  assert.equal(Gov.getCouncil("falador").unrest, 0); // 10 - 15 clamps to 0
  // candidates cleared, next election scheduled
  assert.deepEqual(Gov.getCouncil("falador").candidates, []);
  assert.equal(Gov.getCouncil("falador").nextElectionAtMs, 5000 + Gov.TERM_MS);
});

test("voteScore: self gets 2, stranger gets base 1", () => {
  fresh();
  const voter = { username: "v1", personality: { traits: [] } };
  const self = { name: "v1", displayName: "v1" };
  const stranger = { name: "s9", displayName: "s9" };
  assert.equal(Gov.voteScore(voter, self, {}), 2);
  assert.equal(Gov.voteScore(voter, stranger, {}), 1);
});

test("voteScore rewards shared clan and career", () => {
  fresh();
  const voter = { username: "v1", personality: { traits: [] } };
  const cand = { name: "c1", displayName: "c1" };
  const ctx = {
    clanOf: () => ({ id: "clan-a" }),
    careerOf: () => "smith",
  };
  // base 1 + clan 2 + career 1 = 4
  assert.equal(Gov.voteScore(voter, cand, ctx), 4);
});

test("voteScore counts endorsements with a cap", () => {
  fresh();
  const voter = { username: "v1", personality: { traits: [] } };
  const cand = { name: "c1", displayName: "c1" };
  const council = { endorsements: { c1: ["p1", "p2", "p3", "p4", "p5"] }, unrest: 10, seats: [] };
  // base 1 + min(6, 5*2)=6 -> 7
  assert.equal(Gov.voteScore(voter, cand, { council }), 7);
});

test("dissolveCouncil clears seats and schedules snap election", () => {
  fresh();
  Gov.ensureCouncil("falador", "Falador", 1000);
  const c = Gov.getCouncil("falador");
  c.seats.push({ office: "mayor", citizenName: "Alice", displayName: "Alice" });
  c.unrest = 95;
  assert.ok(Gov.dissolveCouncil("falador", 9000, "unrest"));
  assert.deepEqual(c.seats, []);
  assert.equal(c.nextElectionAtMs, 9000 + 24 * 60 * 60 * 1000);
  assert.equal(c.unrest, 45);
});

test("wantsOffice respects ambition traits and retirement", () => {
  fresh();
  assert.ok(Gov.wantsOffice({ username: "a", personality: { traits: ["ambitious"] } }));
  assert.ok(!Gov.wantsOffice({ username: "b", personality: { traits: ["shy"] } }));
  assert.ok(!Gov.wantsOffice({ username: "c" }));
  assert.ok(!Gov.wantsOffice(null));
});

test("describeCouncil summarizes for chat", () => {
  fresh();
  Gov.ensureCouncil("falador", "Falador", 1000);
  Gov.passLaw("falador", "festival", "alice", 2000);
  const c = Gov.getCouncil("falador");
  c.seats.push(
    { office: "mayor", citizenName: "Alice", displayName: "Alice" },
    { office: "councilor", citizenName: "Bob", displayName: "Bob" }
  );
  const d = Gov.describeCouncil("falador");
  assert.equal(d.mayor, "Alice");
  assert.deepEqual(d.councilors, ["Bob"]);
  assert.deepEqual(d.laws, ["Harvest Festival"]);
  assert.equal(Gov.describeCouncil("nowhere"), null);
});

test("save persists and reloads", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gov-save-"));
  const file = path.join(tmp, "government.json");
  Gov.resetForTests();
  Gov._setSavePathForTests(file);
  Gov.ensureCouncil("falador", "Falador", 1000);
  Gov.passLaw("falador", "festival", "alice", 2000);
  assert.ok(Gov.save());
  // wipe in-memory, reload from disk
  Gov.resetForTests();
  Gov._setSavePathForTests(file);
  const c = Gov.getCouncil("falador");
  assert.ok(c);
  assert.equal(c.laws[0].id, "festival");
});
