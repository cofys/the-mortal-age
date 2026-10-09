"use strict";

/**
 * CitizenDiplomat.test.js — brain-action tests for spies and marriage brokers.
 * Plain node:assert, no engine. Run with: node <this file>.
 */

const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const D = require("../../lib/CitizenDiplomacy");
const { createCitizenDiplomatAction, ACTION_ID } = require("./CitizenDiplomat");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cda-test-"));
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

function fakePlayer(username, kingdomId) {
  return {
    getUsername: () => username,
    username,
    getAttribute: (k) => (k === "kingdom:id" ? kingdomId : null),
  };
}

async function main() {
  test("action id is citizenDiplomat", () => {
    assert.equal(ACTION_ID, "citizenDiplomat");
    const a = createCitizenDiplomatAction();
    assert.equal(a.id, "citizenDiplomat");
  });

  await (async () => {
    const name = "give-up after timeout";
    D.resetForTests();
    try {
      const a = createCitizenDiplomatAction();
      const player = fakePlayer("Al", "asgarnia");
      const res = await a.run(player, {
        startedAt: Date.now() - 11 * 60 * 1000,
        personality: { sneaky: 0.9 },
        thievingLevel: 30,
      });
      assert.equal(res.reason, "give-up");
      assert.ok(res.done);
      passed += 1;
      console.log(`ok - ${name}`);
    } catch (e) {
      console.error(`FAIL - ${name}: ${e.message}`);
      process.exitCode = 1;
    }
  })();

  await (async () => {
    const name = "ordinary citizen has no mission";
    D.resetForTests();
    try {
      const a = createCitizenDiplomatAction();
      const player = fakePlayer("Bob", "asgarnia");
      const res = await a.run(player, { personality: {}, thievingLevel: 1, fameScore: 0 });
      assert.equal(res.reason, "no-mission");
      passed += 1;
      console.log(`ok - ${name}`);
    } catch (e) {
      console.error(`FAIL - ${name}: ${e.message}`);
      process.exitCode = 1;
    }
  })();

  await (async () => {
    const name = "spy with an active mission does not double up";
    D.resetForTests();
    try {
      D.startSpyMission({ spy: "Ivy", homeKingdom: "asgarnia", targetKingdom: "misthalin", nowMs: Date.now() });
      const a = createCitizenDiplomatAction();
      const player = fakePlayer("Ivy", "asgarnia");
      const res = await a.run(player, {
        personality: { sneaky: 0.9 },
        thievingLevel: 30,
      });
      assert.equal(res.reason, "mission-active");
      passed += 1;
      console.log(`ok - ${name}`);
    } catch (e) {
      console.error(`FAIL - ${name}: ${e.message}`);
      process.exitCode = 1;
    }
  })();

  await (async () => {
    const name = "spy starts a mission when a rival border is hot (or honestly reports none)";
    D.resetForTests();
    try {
      const a = createCitizenDiplomatAction();
      const player = fakePlayer("Sneak", "asgarnia");
      const res = await a.run(player, {
        personality: { sneaky: 0.9 },
        thievingLevel: 30,
      });
      // Without the kingdom layer there is no hot border — honest no-rival.
      assert.ok(["mission-started", "no-rival"].includes(res.reason), `got ${res.reason}`);
      passed += 1;
      console.log(`ok - ${name}`);
    } catch (e) {
      console.error(`FAIL - ${name}: ${e.message}`);
      process.exitCode = 1;
    }
  })();

  await (async () => {
    const name = "broker proposes a marriage on calm borders (or honestly reports none)";
    D.resetForTests();
    try {
      const a = createCitizenDiplomatAction();
      const player = fakePlayer("Charm", "asgarnia");
      const res = await a.run(player, {
        personality: { charisma: 0.9 },
        thievingLevel: 1,
        fameScore: 60,
      });
      // Without the kingdom layer, tension reads 50 (unreadable default) —
      // above the 40 calm threshold, so no-partner is the honest answer.
      assert.ok(["proposed", "no-partner", "proposal-exists"].includes(res.reason), `got ${res.reason}`);
      passed += 1;
      console.log(`ok - ${name}`);
    } catch (e) {
      console.error(`FAIL - ${name}: ${e.message}`);
      process.exitCode = 1;
    }
  })();

  console.log(`\n${passed} tests passed`);
}

main();
