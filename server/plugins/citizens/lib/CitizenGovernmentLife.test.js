"use strict";

// Tests for CitizenGovernmentLife (tick dynamics). Run with: node --test <this file>

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const Gov = require("./CitizenGovernment");
const Life = require("./CitizenGovernmentLife");

function fresh() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "govlife-test-"));
  Gov.resetForTests();
  Gov._setSavePathForTests(path.join(tmp, "government.json"));
}

function makeDirector(records) {
  const roster = new Map();
  for (const r of records) roster.set(String(r.username).toLowerCase(), r);
  return {
    roster,
    getPlayer: () => null,
    players: new Map(),
    log: () => {},
  };
}

function rec(username, opts = {}) {
  return {
    username,
    displayName: username[0].toUpperCase() + username.slice(1),
    role: opts.role || "commoner",
    kingdomId: opts.kingdomId !== undefined ? opts.kingdomId : "falador",
    kingdomName: opts.kingdomName || "Falador",
    personality: { traits: opts.traits || [] },
    goal: opts.goal || null,
  };
}

// Deterministic rng: always returns 0.5 (so 0.6-gated nominations fire).
const rngHalf = () => 0.5;

test("tickGovernments creates councils for kingdoms with citizens", () => {
  fresh();
  const director = makeDirector([rec("alice"), rec("bob", { kingdomId: "varrock", kingdomName: "Varrock" })]);
  Life.tickGovernments(director, 1000, rngHalf);
  assert.ok(Gov.getCouncil("falador"));
  assert.ok(Gov.getCouncil("varrock"));
  assert.equal(Gov.getCouncil("falador").kingdomName, "Falador");
});

test("tickGovernments ignores records without kingdomId", () => {
  fresh();
  const director = makeDirector([rec("alice", { kingdomId: "" })]);
  Life.tickGovernments(director, 1000, rngHalf);
  assert.deepEqual(Gov.allCouncils(), []);
});

test("ambitious citizens nominate themselves before elections", () => {
  fresh();
  const now = 1000;
  const director = makeDirector([
    rec("alice", { traits: ["ambitious"] }),
    rec("bob", { traits: ["charismatic"] }),
    rec("cara", { traits: ["shy"] }),
  ]);
  const council = Gov.ensureCouncil("falador", "Falador", now);
  // Election in 2 days (inside the 3-day nomination window).
  council.nextElectionAtMs = now + 2 * 24 * 60 * 60 * 1000;
  Life.tickGovernments(director, now, rngHalf);
  const names = council.candidates.map((c) => c.name);
  assert.ok(names.includes("alice"), "ambitious alice nominates");
  assert.ok(names.includes("bob"), "charismatic bob nominates");
  assert.ok(!names.includes("cara"), "shy cara does not");
});

test("election runs when due and seats a mayor", () => {
  fresh();
  const now = 1000;
  const director = makeDirector([
    rec("alice", { traits: ["ambitious", "honest"] }),
    rec("bob", { traits: ["ambitious"] }),
    rec("cara", {}),
    rec("dan", {}),
  ]);
  const council = Gov.ensureCouncil("falador", "Falador", now);
  council.nextElectionAtMs = now - 1; // overdue
  // rng 0.5 < 0.6 so both ambitious citizens nominate
  Life.tickGovernments(director, now, rngHalf);
  assert.ok(council.seats.length > 0, "seats filled");
  assert.equal(council.seats[0].office, "mayor");
  assert.ok(council.nextElectionAtMs > now, "next election scheduled");
});

test("council passes a law at session time", () => {
  fresh();
  const now = 1000;
  const director = makeDirector([
    rec("alice", { role: "guard", traits: ["ambitious"] }),
    rec("bob", { role: "guard" }),
  ]);
  const council = Gov.ensureCouncil("falador", "Falador", now);
  council.seats.push(
    { office: "mayor", citizenName: "alice", displayName: "Alice", electedAtMs: now, termEndsMs: now + 1e9 }
  );
  council.nextElectionAtMs = now + 30 * 24 * 60 * 60 * 1000; // far off
  council.lastSessionAtMs = now - Gov.LAW_SESSION_MS - 1; // session due
  // rng that picks first weighted option deterministically
  Life.tickGovernments(director, now, () => 0.01);
  assert.ok(council.laws.length > 0, "a law was passed");
  assert.ok(council.lastSessionAtMs === now, "session timestamp updated");
});

test("unrest at 90 dissolves the council", () => {
  fresh();
  const now = 1000;
  const director = makeDirector([rec("alice"), rec("bob")]);
  const council = Gov.ensureCouncil("falador", "Falador", now);
  council.seats.push(
    { office: "mayor", citizenName: "alice", displayName: "Alice", electedAtMs: now, termEndsMs: now + 1e9 }
  );
  council.unrest = 95;
  council.nextElectionAtMs = now + 30 * 24 * 60 * 60 * 1000;
  council.lastSessionAtMs = now; // no session this tick
  Life.tickGovernments(director, now, () => 0.9); // high roll: no scandal, no protest
  assert.deepEqual(council.seats, [], "seats cleared");
  assert.ok(council.nextElectionAtMs <= now + 24 * 60 * 60 * 1000 + 1, "snap election soon");
});

test("unrest drifts down toward calm", () => {
  fresh();
  const now = 1000;
  const director = makeDirector([rec("alice")]);
  const council = Gov.ensureCouncil("falador", "Falador", now);
  council.unrest = 50;
  council.nextElectionAtMs = now + 30 * 24 * 60 * 60 * 1000;
  council.lastSessionAtMs = now;
  Life.tickGovernments(director, now, () => 0.9); // no random events
  assert.ok(council.unrest < 50, "unrest decayed");
});

test("tickGovernments never throws on a broken director", () => {
  fresh();
  assert.doesNotThrow(() => Life.tickGovernments(null, 1000, rngHalf));
  assert.doesNotThrow(() => Life.tickGovernments({}, 1000, rngHalf));
});

test("_chooseLaw prefers festival at high unrest", () => {
  fresh();
  const council = Gov.ensureCouncil("falador", "Falador", 1000);
  council.unrest = 80;
  council.seats.push(
    { office: "mayor", citizenName: "alice", displayName: "Alice" }
  );
  const director = makeDirector([rec("alice", { role: "commoner" })]);
  // With only a commoner mayor, options = [festival(5)]. Any roll picks it.
  const lawId = Life._chooseLaw(council, director, () => 0.99);
  assert.equal(lawId, "festival");
});

test("_recordsByKingdom groups correctly", () => {
  const director = makeDirector([
    rec("a1", { kingdomId: "k1" }),
    rec("a2", { kingdomId: "k1" }),
    rec("b1", { kingdomId: "k2" }),
  ]);
  const map = Life._recordsByKingdom(director);
  assert.equal(map.get("k1").length, 2);
  assert.equal(map.get("k2").length, 1);
});
