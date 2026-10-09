"use strict";

/**
 * CitizenPressLife.test.js — plain-node tests for the journalism slow tick.
 *
 * Run: node server/plugins/citizens/lib/CitizenPressLife.test.js
 */

const assert = require("assert");

const Press = require("./CitizenPress");
const { tickPress, resetForTests } = require("./CitizenPressLife");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    Press.resetForTests();
    resetForTests();
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL - ${name}: ${err.message}`);
  }
}

console.log("CitizenPressLife tests:");

function fakeDirector(records, opts = {}) {
  return {
    roster: records,
    isOnline: (r) => records.includes(r),
    getBot: (r) => ({ getUsername: () => r.username, fakeBot: true }),
    ...opts,
  };
}

function citizen(username, kingdomId, career = null, personality = {}) {
  return { username, kingdomId, career, personality };
}

test("never throws on empty or null director", () => {
  tickPress(null, Date.now());
  tickPress({}, Date.now());
  tickPress({ roster: null }, Date.now());
});

test("registers journalist-career citizens", () => {
  const d = fakeDirector([citizen("Alice", "misthalin", "journalist")]);
  tickPress(d, Date.now());
  assert.strictEqual(Press.isJournalist("Alice"), true);
});

test("registers curious citizens when no reporter exists", () => {
  const d = fakeDirector([citizen("Bob", "asgarnia", "farmer", { curiosity: 0.8 })]);
  tickPress(d, Date.now());
  assert.strictEqual(Press.isJournalist("Bob"), true);
});

test("does not register uninterested citizens", () => {
  const d = fakeDirector([citizen("Carol", "misthalin", "farmer", { curiosity: 0.1 })]);
  tickPress(d, Date.now());
  assert.strictEqual(Press.isJournalist("Carol"), false);
});

test("journalists file stories on unclaimed events", () => {
  Press.registerJournalist("Alice", "misthalin");
  Press.recordEvent("crime", "misthalin", "trial-1", "Bob convicted of theft");
  const d = fakeDirector([citizen("Alice", "misthalin", "journalist")]);
  tickPress(d, Date.now());
  assert.strictEqual(Press.storyCountFor("Alice"), 1);
});

test("story filing is throttled per reporter", () => {
  Press.registerJournalist("Alice", "misthalin");
  Press.recordEvent("crime", "misthalin", "trial-1", "one");
  Press.recordEvent("war", "misthalin", "war-1", "two");
  const d = fakeDirector([citizen("Alice", "misthalin", "journalist")]);
  const now = Date.now();
  tickPress(d, now);
  tickPress(d, now + 1000); // within 30m throttle
  assert.strictEqual(Press.storyCountFor("Alice"), 1);
});

test("major events trigger a special edition when paper is stocked", () => {
  Press.registerJournalist("Alice", "misthalin");
  Press.recordEvent("war", "misthalin", "war-1", "Asgarnia marches", Press.KIND_MAJOR);
  Press.recordEvent("war", "misthalin", "war-2", "Troops mass", Press.KIND_ROUTINE);
  const d = fakeDirector([citizen("Alice", "misthalin", "journalist")]);
  // First tick: files stories. Second tick: compiles edition (stories now published).
  tickPress(d, Date.now());
  Press.stockPress("misthalin", 10);
  tickPress(d, Date.now() + 31 * 60 * 1000); // past the 30m story throttle
  const ed = Press.latestEdition("misthalin");
  assert.ok(ed, "edition should compile after a major event");
  assert.strictEqual(ed.beat, "war");
});

test("edition distributes to subscribers", () => {
  Press.registerJournalist("Alice", "misthalin");
  Press.subscribe("Bob", "misthalin");
  for (let i = 0; i < 3; i++) {
    Press.recordEvent("culture", "misthalin", `c${i}`, `culture ${i}`);
  }
  const d = fakeDirector([citizen("Alice", "misthalin", "journalist")]);
  tickPress(d, Date.now()); // files 1 story
  tickPress(d, Date.now() + 31 * 60 * 1000); // files 2nd
  tickPress(d, Date.now() + 62 * 60 * 1000); // files 3rd -> accumulation trigger
  Press.stockPress("misthalin", 10);
  tickPress(d, Date.now() + 93 * 60 * 1000); // compiles + distributes
  const ed = Press.latestEdition("misthalin");
  assert.ok(ed, "edition should compile after 3 stories accumulate");
  assert.strictEqual(Press.subscribersIn("misthalin")[0].editionsReceived, 1);
});

test("tick survives missing modules gracefully", () => {
  // No KingdomStore/CitizenDiscovery/etc. in this env — gatherers must degrade.
  const d = fakeDirector([citizen("Alice", "misthalin", "journalist")]);
  tickPress(d, Date.now());
  assert.ok(true); // reaching here means no throw
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
