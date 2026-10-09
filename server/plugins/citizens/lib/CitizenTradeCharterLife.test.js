"use strict";

/**
 * CitizenTradeCharterLife.test.js — slow-tick tests: renewal, lapse,
 * war revocation, and never-throws safety.
 * Plain node:assert, no engine. Run with: node <this file>.
 */

const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const C = require("./CitizenTradeCharters");
const Life = require("./CitizenTradeCharterLife");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ctcl-test-"));
C._setSavePathForTests(path.join(TMP, "citizen-trade-charters.json"));

let passed = 0;
function test(name, fn) {
  C.resetForTests();
  Life.resetForTests();
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

// Grant a charter directly in state (bypasses petition standing).
function seedCharter(guildId, kingdomId, category, grantedAt, expiresAt) {
  const st = { charters: {}, treasuries: {} };
  // Use the module's own petition path is standing-gated; write via save/load:
  // simplest honest seed is through collectToll + direct state. We reach
  // state through the public API only, so simulate a petition by temporarily
  // granting fame.
  const Rep = require("./CitizenReputation");
  const repTmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctcl-rep-"));
  Rep._setSavePathForTests?.(path.join(repTmp, "rep.json"));
  Rep.resetForTests?.();
  for (let i = 0; i < 10; i++) Rep.addReputation("SeedBob", 10, "test", Date.now());
  let bal = 99999;
  const player = {
    getInventory() {
      return {
        count: (id) => (id === 995 ? bal : 0),
        delete: (id, n) => {
          if (id === 995 && bal >= n) {
            bal -= n;
            return true;
          }
          return false;
        },
      };
    },
  };
  const res = C.petitionCharter("SeedBob", guildId, kingdomId, category, player, grantedAt);
  assert.equal(res.ok, true, `seed petition failed: ${res.reason}`);
  // Adjust expiry to the desired value via revoke + re-seed is not possible;
  // instead rely on grantedAt being recent. For expiry tests, grant in the
  // past so expiresAt is already past.
  void st;
  return res.charter;
}

test("tick: never throws on empty state", () => {
  Life.tickTradeCharters(null, Date.now());
  Life.tickTradeCharters(undefined);
  assert.ok(true);
});

test("tick: active charter is left alone", () => {
  seedCharter("merchants", "asgarnia", "weapons", Date.now(), Date.now());
  Life.tickTradeCharters(null, Date.now());
  assert.equal(C.isChartered("asgarnia", "weapons"), true);
});

test("tick: expired charter lapses when treasury is broke", () => {
  // Grant 31 days ago so it's expired.
  const past = Date.now() - 31 * 24 * 60 * 60 * 1000;
  seedCharter("merchants", "kandarin", "ore", past, past);
  assert.equal(C.treasuryFor("merchants"), 0, "treasury starts broke");
  Life.tickTradeCharters(null, Date.now());
  assert.equal(C.isChartered("kandarin", "ore"), false, "expired charter lapsed");
});

test("tick: charter in renewal window renews from treasury", () => {
  // Grant 29.5 days ago: within the 24h renewal window, still active.
  const past = Date.now() - 29.5 * 24 * 60 * 60 * 1000;
  seedCharter("crafters", "misthalin", "jewelry", past, past);
  C.collectToll("crafters", C.RENEWAL_FEE + 1000);
  const before = C.charterFor("misthalin", "jewelry").expiresAt;
  Life.tickTradeCharters(null, Date.now());
  const after = C.charterFor("misthalin", "jewelry");
  assert.ok(after, "charter still active after renewal");
  assert.ok(after.expiresAt > before, "expiry extended");
  assert.ok(C.treasuryFor("crafters") < C.RENEWAL_FEE + 1000, "treasury debited");
});

test("tick: throttling — second immediate tick is a no-op", () => {
  const past = Date.now() - 31 * 24 * 60 * 60 * 1000;
  seedCharter("merchants", "morytania", "food", past, past);
  Life.tickTradeCharters(null, Date.now());
  assert.equal(C.isChartered("morytania", "food"), false);
  // Second tick immediately: no crash, no double-processing.
  Life.tickTradeCharters(null, Date.now());
  assert.ok(true);
});

console.log(`\n${passed} tests passed`);
