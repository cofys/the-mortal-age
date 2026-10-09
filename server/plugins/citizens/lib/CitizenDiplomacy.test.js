"use strict";

/**
 * CitizenDiplomacy.test.js — data-tier tests for the covert and dynastic
 * layer: espionage and royal marriage alliances.
 * Plain node:assert, no engine. Run with: node <this file>.
 */

const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const D = require("./CitizenDiplomacy");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cd-test-"));
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

// --- kingdoms ---

test("kingdoms: five great powers", () => {
  assert.deepEqual(D.kingdoms(), ["asgarnia", "kandarin", "keldagrim", "misthalin", "morytania"]);
});

test("pairKey is order-independent", () => {
  assert.equal(D.pairKey("misthalin", "asgarnia"), D.pairKey("asgarnia", "misthalin"));
});

test("isKnownKingdom rejects fiction", () => {
  assert.ok(D.isKnownKingdom("asgarnia"));
  assert.ok(!D.isKnownKingdom("narnia"));
  assert.ok(!D.isKnownKingdom(""));
});

// --- marriage alliances ---

test("proposeMarriage records a proposal", () => {
  const m = D.proposeMarriage({ from: "asgarnia", to: "misthalin", broker: "Alice", nowMs: NOW });
  assert.ok(m);
  assert.equal(m.status, "proposed");
  assert.equal(m.rounds, 0);
  assert.equal(m.broker, "Alice");
  assert.ok(m.expiresAt > NOW);
});

test("proposeMarriage rejects duplicates, same kingdom, unknown", () => {
  D.proposeMarriage({ from: "asgarnia", to: "misthalin", broker: "Alice", nowMs: NOW });
  assert.equal(D.proposeMarriage({ from: "asgarnia", to: "misthalin", broker: "Bob", nowMs: NOW }), null);
  assert.equal(D.proposeMarriage({ from: "misthalin", to: "asgarnia", broker: "Bob", nowMs: NOW }), null);
  assert.equal(D.proposeMarriage({ from: "asgarnia", to: "asgarnia", broker: "Bob", nowMs: NOW }), null);
  assert.equal(D.proposeMarriage({ from: "asgarnia", to: "narnia", broker: "Bob", nowMs: NOW }), null);
  assert.equal(D.proposeMarriage({ from: "asgarnia", to: "misthalin", broker: "", nowMs: NOW }), null);
});

test("pendingMarriagesFor finds pending proposals", () => {
  D.proposeMarriage({ from: "asgarnia", to: "misthalin", broker: "Alice", nowMs: NOW });
  assert.equal(D.pendingMarriagesFor("asgarnia").length, 1);
  assert.equal(D.pendingMarriagesFor("misthalin").length, 1);
  assert.equal(D.pendingMarriagesFor("kandarin").length, 0);
});

test("negotiateRound respects the round throttle", () => {
  const m = D.proposeMarriage({ from: "asgarnia", to: "misthalin", broker: "Alice", nowMs: NOW });
  const first = D.negotiateRound(m.id, NOW + 1000);
  assert.ok(["accepted", "countered", "refused"].includes(first));
  if (first === "countered") {
    assert.equal(D.negotiateRound(m.id, NOW + 2000), "waiting");
  }
});

test("negotiateRound expires stale proposals", () => {
  const m = D.proposeMarriage({ from: "asgarnia", to: "misthalin", broker: "Alice", nowMs: NOW });
  const outcome = D.negotiateRound(m.id, NOW + 8 * 24 * 60 * 60 * 1000);
  assert.equal(outcome, "expired");
  assert.equal(D.marriageById(m.id).status, "expired");
});

test("negotiateRound on unknown id returns null", () => {
  assert.equal(D.negotiateRound("nope", NOW), null);
});

test("courtDisposition stays in range without the kingdom layer", () => {
  const m = D.proposeMarriage({ from: "asgarnia", to: "misthalin", broker: "Alice", nowMs: NOW });
  const w = D.courtDisposition(m);
  assert.ok(w >= 0.05 && w <= 0.95, `weight ${w} out of range`);
});

test("marriageById returns null for unknown", () => {
  assert.equal(D.marriageById("nope"), null);
});

// --- espionage ---

test("startSpyMission records a mission", () => {
  const m = D.startSpyMission({ spy: "Sneaky", homeKingdom: "asgarnia", targetKingdom: "misthalin", nowMs: NOW });
  assert.ok(m);
  assert.equal(m.status, "active");
  const back = D.spyMissionFor("Sneaky");
  assert.equal(back.targetKingdom, "misthalin");
});

test("startSpyMission rejects same-kingdom and duplicate missions", () => {
  assert.equal(D.startSpyMission({ spy: "S", homeKingdom: "asgarnia", targetKingdom: "asgarnia", nowMs: NOW }), null);
  D.startSpyMission({ spy: "S2", homeKingdom: "asgarnia", targetKingdom: "misthalin", nowMs: NOW });
  assert.equal(D.startSpyMission({ spy: "S2", homeKingdom: "asgarnia", targetKingdom: "kandarin", nowMs: NOW }), null);
});

test("gatherIntel returns a record without the kingdom layer", () => {
  const m = D.startSpyMission({ spy: "Ivy", homeKingdom: "asgarnia", targetKingdom: "misthalin", nowMs: NOW });
  const intel = D.gatherIntel(m.id, NOW + 1000);
  assert.ok(intel);
  assert.equal(intel.targetKingdom, "misthalin");
  assert.ok(intel.gatheredAt >= NOW);
  // Mission is now reported; no longer active.
  assert.equal(D.spyMissionFor("Ivy"), null);
});

test("gatherIntel persists for chat answers", () => {
  const m = D.startSpyMission({ spy: "Jon", homeKingdom: "asgarnia", targetKingdom: "misthalin", nowMs: NOW });
  D.gatherIntel(m.id, NOW + 1000);
  const latest = D.latestIntelOn("misthalin");
  assert.ok(latest);
  assert.equal(latest.spy, "Jon");
});

test("discoveryRoll on inactive mission is false", () => {
  assert.equal(D.discoveryRoll("nope", NOW), false);
});

test("describeIntel returns null with no intel", () => {
  assert.equal(D.describeIntel("kandarin"), null);
});

test("summaryFor lists marriages and pending", () => {
  D.proposeMarriage({ from: "asgarnia", to: "misthalin", broker: "Alice", nowMs: NOW });
  const s = D.summaryFor("asgarnia", NOW);
  assert.equal(s.pending.length, 1);
  assert.ok(s.pending[0].includes("marriage proposal"));
  assert.equal(s.marriages.length, 0);
});

test("save writes and reloads", () => {
  D.startSpyMission({ spy: "Zed", homeKingdom: "asgarnia", targetKingdom: "misthalin", nowMs: NOW });
  assert.ok(D.save());
  // Fresh load from disk keeps the mission (resetForTests clears the
  // in-memory cache but keeps the test save path).
  D.resetForTests();
  const back = D.spyMissionFor("Zed");
  assert.ok(back);
  assert.equal(back.targetKingdom, "misthalin");
});

console.log(`\n${passed} tests passed`);
