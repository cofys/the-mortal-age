"use strict";

/**
 * CitizenAthletics.test.js — data tier tests (plain node, no jest).
 */

const assert = require("assert");
const Athletics = require("./CitizenAthletics");

function run() {
  let passed = 0;
  const test = (name, fn) => {
    Athletics.resetForTests();
    try { fn(); passed++; }
    catch (e) { console.error(`FAIL: ${name}: ${e.message}`); process.exitCode = 1; }
  };

  test("registerAthlete creates an athlete", () => {
    const a = Athletics.registerAthlete("Alice", "running");
    assert(a, "should return athlete");
    assert.strictEqual(a.sport, "running");
    assert.strictEqual(a.fitness, 20);
    assert(Athletics.isAthlete("Alice"), "should be athlete");
  });

  test("registerAthlete rejects invalid sport", () => {
    const a = Athletics.registerAthlete("Bob", "chess");
    assert.strictEqual(a, null);
    assert(!Athletics.isAthlete("Bob"));
  });

  test("registerAthlete is idempotent", () => {
    Athletics.registerAthlete("Alice", "running");
    const a2 = Athletics.registerAthlete("Alice", "wrestling");
    assert.strictEqual(a2.sport, "running", "sport should not change");
  });

  test("trainAthlete raises fitness and skill", () => {
    Athletics.registerAthlete("Alice", "running");
    const beforeFitness = Athletics.athleteInfo("Alice").fitness;
    const beforeSkill = Athletics.athleteInfo("Alice").skill;
    Athletics.trainAthlete("Alice", Date.now());
    const after = Athletics.athleteInfo("Alice");
    assert(after.fitness > beforeFitness, "fitness should rise");
    assert(after.skill > beforeSkill, "skill should rise");
  });

  test("trainAthlete caps fitness at max", () => {
    Athletics.registerAthlete("Alice", "running");
    for (let i = 0; i < 50; i++) Athletics.trainAthlete("Alice", Date.now());
    const a = Athletics.athleteInfo("Alice");
    assert(a.fitness <= Athletics.FITNESS_MAX, "fitness capped");
  });

  test("trainAthlete on unknown returns null", () => {
    assert.strictEqual(Athletics.trainAthlete("Nobody", Date.now()), null);
  });

  test("fitnessFor returns 0-1", () => {
    Athletics.registerAthlete("Alice", "running");
    const f = Athletics.fitnessFor("Alice");
    assert(f >= 0 && f <= 1, "fitness in range");
    assert.strictEqual(Athletics.fitnessFor("Nobody"), 0);
  });

  test("decayFitness reduces idle fitness", () => {
    Athletics.registerAthlete("Alice", "running");
    Athletics.trainAthlete("Alice", Date.now());
    const before = Athletics.athleteInfo("Alice").fitness;
    // Simulate 2 days idle
    const twoDaysAgo = Date.now() - 2 * 24 * 3600 * 1000;
    Athletics.athleteInfo("Alice").trainedAt = twoDaysAgo;
    Athletics.decayFitness(Date.now());
    const after = Athletics.athleteInfo("Alice").fitness;
    assert(after < before, "fitness should decay");
  });

  test("foundStadium creates a stadium", () => {
    const s = Athletics.foundStadium("misthalin", 300);
    assert(s, "should return stadium");
    assert.strictEqual(s.capacity, 300);
    assert(Athletics.stadiumFor("misthalin"), "should be retrievable");
  });

  test("foundStadium is idempotent", () => {
    Athletics.foundStadium("misthalin", 300);
    const s2 = Athletics.foundStadium("misthalin", 500);
    assert.strictEqual(s2.capacity, 300, "capacity should not change");
  });

  test("stadiumFor returns null when none", () => {
    assert.strictEqual(Athletics.stadiumFor("nowhere"), null);
  });

  test("attemptRecord sets first record", () => {
    Athletics.registerAthlete("Alice", "running");
    for (let i = 0; i < 15; i++) Athletics.trainAthlete("Alice", Date.now());
    const rec = Athletics.attemptRecord("Alice", "misthalin", "running", Date.now());
    assert(rec, "should set record");
    assert.strictEqual(rec.holder, "Alice");
  });

  test("attemptRecord requires better mark", () => {
    Athletics.registerAthlete("Alice", "running");
    Athletics.registerAthlete("Bob", "running");
    for (let i = 0; i < 15; i++) Athletics.trainAthlete("Alice", Date.now());
    for (let i = 0; i < 5; i++) Athletics.trainAthlete("Bob", Date.now());
    Athletics.attemptRecord("Alice", "misthalin", "running", Date.now());
    const rec2 = Athletics.attemptRecord("Bob", "misthalin", "running", Date.now());
    assert.strictEqual(rec2, null, "worse mark should not set record");
  });

  test("attemptRecord rejects wrong sport", () => {
    Athletics.registerAthlete("Alice", "running");
    const rec = Athletics.attemptRecord("Alice", "misthalin", "wrestling", Date.now());
    assert.strictEqual(rec, null);
  });

  test("recordFor returns null when none", () => {
    assert.strictEqual(Athletics.recordFor("misthalin", "running"), null);
  });

  test("ambient throttle works", () => {
    const now = Date.now();
    assert(Athletics.ambientDue("misthalin", now), "should be due initially");
    Athletics.markAmbient("misthalin", now);
    assert(!Athletics.ambientDue("misthalin", now + 1000), "should not be due immediately");
  });

  test("serialize/deserialize round-trip", () => {
    Athletics.registerAthlete("Alice", "running");
    Athletics.foundStadium("misthalin");
    const json = Athletics.serialize();
    Athletics.resetForTests();
    assert(!Athletics.isAthlete("Alice"), "should be cleared");
    Athletics.deserialize(json);
    assert(Athletics.isAthlete("Alice"), "should be restored");
    assert(Athletics.stadiumFor("misthalin"), "stadium restored");
  });

  test("athletesIn returns list", () => {
    Athletics.registerAthlete("Alice", "running");
    Athletics.registerAthlete("Bob", "wrestling");
    const list = Athletics.athletesIn("misthalin", 10);
    assert.strictEqual(list.length, 2);
  });

  console.log(`CitizenAthletics: ${passed} passed`);
}

run();
