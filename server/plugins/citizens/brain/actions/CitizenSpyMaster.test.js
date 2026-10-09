"use strict";

/**
 * CitizenSpyMaster.test.js — plain-node tests for the spymaster brain action.
 * Run: node server/plugins/citizens/brain/actions/CitizenSpyMaster.test.js
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const Esp = require("../../lib/CitizenEspionage");
const { createCitizenSpyMasterAction, ACTION_ID } = require("./CitizenSpyMaster");

const SAVE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "spymaster-test-")), "espionage.json");
Esp._setSavePathForTests(SAVE);

function fakePlayer(username, kingdomId, personality = {}) {
  return {
    username,
    getUsername: () => username,
    personality,
    getAttribute: (k) => (k === "kingdom:id" || k === "kingdomId" ? kingdomId : null),
  };
}

// kingdomIdOf reads the player's tile/attribute — stub via ctx is not
// supported, so we monkey-patch CitizenSites for these tests.
const Sites = require("../CitizenSites");
const origKingdomIdOf = Sites.kingdomIdOf;

let passed = 0;
function test(name, fn) {
  Esp.resetForTests();
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

function withKingdom(kingdom, fn) {
  Sites.kingdomIdOf = () => kingdom;
  try {
    return fn();
  } finally {
    Sites.kingdomIdOf = origKingdomIdOf;
  }
}

test("action id is citizenSpyMaster", () => {
  assert.strictEqual(ACTION_ID, "citizenSpyMaster");
  const action = createCitizenSpyMasterAction();
  assert.strictEqual(action.id, "citizenSpyMaster");
});

test("non-sneaky citizen gets no-mission", async () => {
  const action = createCitizenSpyMasterAction();
  await withKingdom("asgarnia", async () => {
    const res = await action.run(fakePlayer("plain-joe", "asgarnia", { sneaky: 0.1 }), { thievingLevel: 30 });
    assert.strictEqual(res.reason, "no-mission");
    assert.strictEqual(res.done, true);
  });
});

test("sneaky but unskilled citizen gets no-mission", async () => {
  const action = createCitizenSpyMasterAction();
  await withKingdom("asgarnia", async () => {
    const res = await action.run(fakePlayer("sneaky-joe", "asgarnia", { sneaky: 0.9 }), { thievingLevel: 10 });
    assert.strictEqual(res.reason, "no-mission");
  });
});

test("spymaster without a network gets no-network", async () => {
  const action = createCitizenSpyMasterAction();
  await withKingdom("asgarnia", async () => {
    const res = await action.run(fakePlayer("lone-shadow", "asgarnia", { sneaky: 0.95 }), { thievingLevel: 40 });
    assert.strictEqual(res.reason, "no-network");
  });
});

test("spymaster with a live operation gets operation-active", async () => {
  Esp.foundNetwork({ kingdom: "kandarin", founder: "f" });
  Esp.planOperation({
    network: "kandarin", type: "sabotage", subtype: "supply",
    targetKingdom: "asgarnia", operative: "busy-shadow", nowMs: 0,
  });
  const action = createCitizenSpyMasterAction();
  await withKingdom("kandarin", async () => {
    const res = await action.run(fakePlayer("busy-shadow", "kandarin", { sneaky: 0.95 }), { thievingLevel: 40 });
    assert.strictEqual(res.reason, "operation-active");
  });
});

test("counter-agent runs counter-patrol", async () => {
  Esp.assignCounterAgent({ kingdom: "misthalin", agent: "eagle-eye-2" });
  const action = createCitizenSpyMasterAction();
  await withKingdom("misthalin", async () => {
    const res = await action.run(fakePlayer("eagle-eye-2", "misthalin", { sneaky: 0.1 }), { thievingLevel: 1 });
    assert.strictEqual(res.reason, "counter-patrol");
  });
});

test("give-up after the timeout", async () => {
  const action = createCitizenSpyMasterAction();
  const res = await action.run(fakePlayer("x", "asgarnia"), { startedAt: Date.now() - 11 * 60 * 1000 });
  assert.strictEqual(res.reason, "give-up");
});

console.log(`\n${passed} tests passed.`);
