"use strict";

/**
 * CitizenDiplomacyLife.test.js — slow-tick tests for the covert and
 * dynastic layer. Plain node:assert, no engine. Run with: node <this file>.
 */

const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const D = require("./CitizenDiplomacy");
const { tickCovertDiplomacy } = require("./CitizenDiplomacyLife");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cdl-test-"));
D._setSavePathForTests(path.join(TMP, "citizen-diplomacy.json"));

let passed = 0;
function test(name, fn) {
  D.resetForTests();
  try {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}: ${e.message}`);
    console.error(e.stack?.split("\n").slice(0, 4).join("\n"));
    process.exitCode = 1;
  }
}

const NOW = 1_700_000_000_000;

function fakeDirector(roster = []) {
  const map = new Map();
  for (const r of roster) map.set(r.username.toLowerCase(), r);
  return {
    roster: { get: (k) => map.get(String(k).toLowerCase()), values: () => map.values() },
    isOnline: () => false,
    getBot: () => null,
    journal: () => {},
    log: () => {},
  };
}

test("tickCovertDiplomacy never throws with no director", () => {
  tickCovertDiplomacy(null, NOW);
  tickCovertDiplomacy(undefined, NOW);
});

test("tickCovertDiplomacy never throws with an empty director", () => {
  tickCovertDiplomacy(fakeDirector(), NOW);
});

test("marriage negotiation advances pending proposals", () => {
  D.proposeMarriage({ from: "asgarnia", to: "misthalin", broker: "Al", nowMs: NOW });
  const director = fakeDirector();
  // Run enough ticks (with time jumps past the round throttle) to resolve.
  let resolved = false;
  for (let i = 0; i < 10; i++) {
    tickCovertDiplomacy(director, NOW + i * 7 * 60 * 60 * 1000);
    const pend = D.pendingMarriagesFor("asgarnia");
    if (!pend.length) {
      resolved = true;
      break;
    }
  }
  assert.ok(resolved, "proposal should resolve within 10 rounds");
});

test("espionage gathers intel for roster spies", () => {
  D.startSpyMission({ spy: "Sneak", homeKingdom: "asgarnia", targetKingdom: "misthalin", nowMs: NOW });
  const director = fakeDirector([{ username: "Sneak" }]);
  tickCovertDiplomacy(director, NOW + 1000);
  const intel = D.latestIntelOn("misthalin");
  assert.ok(intel, "intel should be gathered");
  assert.equal(intel.targetKingdom, "misthalin");
});

console.log(`\n${passed} tests passed`);
