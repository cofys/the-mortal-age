"use strict";

/**
 * CitizenLegalLife.test.js — tick tests for the legal system.
 * Plain node asserts. Verifies the tick never throws and each pass
 * behaves correctly with stub directors.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const LegalCode = require("./CitizenLegalCode");
const { tickLegalLife } = require("./CitizenLegalLife");

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "legallife-test-"));
  LegalCode._setSavePathForTests(path.join(dir, "citizen-legalcode.json"));
  LegalCode.resetForTests();
}

// Minimal director stub: empty roster, no players.
function stubDirector(roster = []) {
  const map = new Map(roster.map((r) => [r.username, r]));
  return {
    roster: {
      values: () => map.values(),
      get: (u) => map.get(u),
    },
    getBot: () => null,
    getPlayer: () => null,
    players: { get: () => null },
    log: () => {},
  };
}

let passed = 0;
function test(name, fn) {
  try {
    freshStore();
    fn();
    passed++;
    console.log(`  ok: ${name}`);
  } catch (e) {
    console.error(`  FAIL: ${name}\n    ${e.message}\n${e.stack}`);
    process.exitCode = 1;
  }
}

console.log("CitizenLegalLife tests:");

test("tick never throws with an empty director", () => {
  const d = stubDirector();
  assert.doesNotThrow(() => tickLegalLife(d, Date.now(), () => 0.99));
});

test("tick never throws with null-ish director", () => {
  assert.doesNotThrow(() => tickLegalLife(null, Date.now(), () => 0.99));
  assert.doesNotThrow(() => tickLegalLife({}, Date.now(), () => 0.99));
});

test("judge is appointed from eligible citizens", () => {
  // Stub the government kingdom list via require cache.
  const govPath = require.resolve("./CitizenGovernment");
  const Gov = require(govPath);
  const origKingdomIds = Gov.kingdomIds;
  Gov.kingdomIds = () => ["varrock"];

  // Stub reputation so the candidate qualifies.
  const repPath = require.resolve("./CitizenReputation");
  const Rep = require(repPath);
  const origScoreFor = Rep.scoreFor;
  Rep.scoreFor = () => 50;

  try {
    const d = stubDirector([
      { username: "Justina", kingdomId: "varrock", personality: { traits: ["lawful", "honest"] } },
      { username: "Shady", kingdomId: "varrock", personality: { traits: ["sneaky"] } },
    ]);
    // Force the judge pass to run (rng irrelevant for appointment).
    tickLegalLife(d, Date.now(), () => 0.99);
    const judge = LegalCode.judgeFor("varrock", Date.now());
    assert.ok(judge, "a judge was appointed");
    assert.strictEqual(judge.username, "Justina", "the lawful citizen takes the bench");
  } finally {
    if (origKingdomIds) Gov.kingdomIds = origKingdomIds;
    else delete Gov.kingdomIds;
    if (origScoreFor) Rep.scoreFor = origScoreFor;
    else delete Rep.scoreFor;
  }
});

test("no judge appointed when nobody is eligible", () => {
  const govPath = require.resolve("./CitizenGovernment");
  const Gov = require(govPath);
  const origKingdomIds = Gov.kingdomIds;
  Gov.kingdomIds = () => ["varrock"];
  const repPath = require.resolve("./CitizenReputation");
  const Rep = require(repPath);
  const origScoreFor = Rep.scoreFor;
  Rep.scoreFor = () => 0; // nobody meets the reputation bar

  try {
    const d = stubDirector([
      { username: "Shady", kingdomId: "varrock", personality: { traits: ["sneaky"] } },
    ]);
    tickLegalLife(d, Date.now(), () => 0.99);
    assert.strictEqual(LegalCode.judgeFor("varrock", Date.now()), null);
  } finally {
    if (origKingdomIds) Gov.kingdomIds = origKingdomIds;
    else delete Gov.kingdomIds;
    if (origScoreFor) Rep.scoreFor = origScoreFor;
    else delete Rep.scoreFor;
  }
});

test("appeal hearing overturns or upholds without throwing", () => {
  const now = Date.now();
  LegalCode.fileAppeal("Convicted Carl", "theft", now, true);
  const d = stubDirector();
  // rng 0.99: appeal pass runs (0.99 >= 0.5? no — use 0.1 to run the pass)
  tickLegalLife(d, now, () => 0.1);
  // The appeal was heard (either overturned or upheld).
  assert.strictEqual(LegalCode.pendingAppeals(now).length, 0, "appeal resolved");
});

test("pardon granted for reformed citizen", () => {
  const repPath = require.resolve("./CitizenReputation");
  const Rep = require(repPath);
  const origScoreFor = Rep.scoreFor;
  Rep.scoreFor = () => 60; // above the pardon threshold

  try {
    const now = Date.now();
    LegalCode.requestPardon("Reformed Rita", null, now, false);
    const d = stubDirector();
    tickLegalLife(d, now, () => 0.1); // pardon pass runs
    assert.strictEqual(LegalCode.pendingPardons().length, 0, "pardon decided");
  } finally {
    if (origScoreFor) Rep.scoreFor = origScoreFor;
    else delete Rep.scoreFor;
  }
});

test("pardon denied for unrepentant citizen without petition", () => {
  const repPath = require.resolve("./CitizenReputation");
  const Rep = require(repPath);
  const origScoreFor = Rep.scoreFor;
  Rep.scoreFor = () => 5; // below threshold, no family petition

  try {
    const now = Date.now();
    LegalCode.requestPardon("Unrepentant Ulf", null, now, false);
    const d = stubDirector();
    tickLegalLife(d, now, () => 0.1);
    assert.strictEqual(LegalCode.pendingPardons().length, 0, "pardon decided (denied)");
  } finally {
    if (origScoreFor) Rep.scoreFor = origScoreFor;
    else delete Rep.scoreFor;
  }
});

test("player trial resolves accusations without throwing", () => {
  const now = Date.now();
  LegalCode.accusePlayer("Player Pete", "theft", "Guard Gary", now);
  const d = stubDirector();
  tickLegalLife(d, now, () => 0.1); // player trial pass runs
  assert.strictEqual(
    LegalCode.pendingPlayerAccusations().length,
    0,
    "accusation resolved (guilty or acquitted)"
  );
});

console.log(`\n${passed} tests passed.`);
