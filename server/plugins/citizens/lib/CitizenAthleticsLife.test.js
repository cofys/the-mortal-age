"use strict";

/**
 * CitizenAthleticsLife.test.js — slow tick tests (plain node, no jest).
 */

const assert = require("assert");
const Athletics = require("./CitizenAthletics");
const { tickAthleticsLife } = require("./CitizenAthleticsLife");

function run() {
  let passed = 0;
  const test = (name, fn) => {
    Athletics.resetForTests();
    try { fn(); passed++; }
    catch (e) { console.error(`FAIL: ${name}: ${e.message}`); process.exitCode = 1; }
  };

  test("tick never throws with empty director", () => {
    const s = tickAthleticsLife(null, Date.now());
    assert(s, "should return stats");
    assert.strictEqual(typeof s.registered, "number");
  });

  test("tick never throws with minimal director", () => {
    const s = tickAthleticsLife({}, Date.now());
    assert(s, "should return stats");
  });

  test("tick registers athletic citizens", () => {
    const director = {
      citizensOnline: () => [
        { username: "StrongBob", career: "athlete", traits: { strength: 0.8 } },
        { username: "WeakWill", career: "banker", traits: {} },
      ],
    };
    const s = tickAthleticsLife(director, Date.now());
    assert(Athletics.isAthlete("StrongBob"), "athlete career should register");
    assert(!Athletics.isAthlete("WeakWill"), "banker should not register");
    assert(s.registered >= 1, "should count registrations");
  });

  test("tick registers by traits", () => {
    const director = {
      citizensOnline: () => [
        { username: "AgileAmy", traits: { agility: 0.85 } },
      ],
    };
    tickAthleticsLife(director, Date.now());
    assert(Athletics.isAthlete("AgileAmy"), "high agility should register");
  });

  test("tick is idempotent for registration", () => {
    const director = {
      citizensOnline: () => [{ username: "StrongBob", career: "athlete" }],
    };
    tickAthleticsLife(director, Date.now());
    const s2 = tickAthleticsLife(director, Date.now());
    assert.strictEqual(s2.registered, 0, "should not re-register");
  });

  console.log(`CitizenAthleticsLife: ${passed} passed`);
}

run();
