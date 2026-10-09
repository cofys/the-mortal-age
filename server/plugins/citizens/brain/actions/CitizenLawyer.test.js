"use strict";

/**
 * CitizenLawyer.test.js — brain action tests for lawyer citizens.
 * Plain node asserts with stub dependencies.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const LegalCode = require("../../lib/CitizenLegalCode");
const { createCitizenLawyerAction } = require("./CitizenLawyer");

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lawyeraction-test-"));
  LegalCode._setSavePathForTests(path.join(dir, "citizen-legalcode.json"));
  LegalCode.resetForTests();
}

// Stub player with a coin inventory.
function stubPlayer(username, coins) {
  let balance = coins;
  return {
    username,
    getUsername: () => username,
    getInventory: () => ({
      count: (id) => (id === 995 ? balance : 0),
      remove: (id, n) => {
        if (id === 995) balance = Math.max(0, balance - n);
      },
      add: (id, n) => {
        if (id === 995) balance += n;
      },
    }),
    _balance: () => balance,
  };
}

let passed = 0;
async function test(name, fn) {
  try {
    freshStore();
    await fn();
    passed++;
    console.log(`  ok: ${name}`);
  } catch (e) {
    console.error(`  FAIL: ${name}\n    ${e.message}`);
    process.exitCode = 1;
  }
}

async function main() {
console.log("CitizenLawyer action tests:");

await test("factory creates the action with the right id", () => {
  const action = createCitizenLawyerAction();
  assert.strictEqual(action.id, "citizenLawyer");
  assert.strictEqual(typeof action.run, "function");
});

await test("no clients -> done with no-clients reason", async () => {
  const action = createCitizenLawyerAction({ wantedList: () => [] });
  const lawyer = stubPlayer("Lawyer Larry", 0);
  const res = await action.run(lawyer, {});
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.done, true);
  assert.strictEqual(res.reason, "no-clients");
});

await test("takes the case and collects the fee honestly", async () => {
  const lawyer = stubPlayer("Lawyer Larry", 100);
  const client = stubPlayer("Accused Al", 500);
  const action = createCitizenLawyerAction({
    wantedList: () => ["Accused Al"],
    playerFor: (u) => (u === "Accused Al" ? client : u === "Lawyer Larry" ? lawyer : null),
  });
  const res = await action.run(lawyer, {});
  assert.strictEqual(res.reason, "case-taken");
  assert.strictEqual(res.client, "Accused Al");
  assert.strictEqual(res.feePaid, true, "full fee collected");
  assert.strictEqual(client._balance(), 350, "client paid 150");
  assert.strictEqual(lawyer._balance(), 250, "lawyer received 150");
  const rep = LegalCode.lawyerFor("Accused Al");
  assert.ok(rep, "representation registered");
  assert.strictEqual(rep.lawyer, "Lawyer Larry");
});

await test("pro bono when the client cannot pay", async () => {
  const lawyer = stubPlayer("Lawyer Larry", 0);
  const client = stubPlayer("Broke Bob", 20);
  const action = createCitizenLawyerAction({
    wantedList: () => ["Broke Bob"],
    playerFor: (u) => (u === "Broke Bob" ? client : lawyer),
  });
  const res = await action.run(lawyer, {});
  assert.strictEqual(res.reason, "case-taken");
  assert.strictEqual(res.feePaid, false, "pro bono — not enough coins");
  assert.ok(LegalCode.lawyerFor("Broke Bob"), "still represented");
});

await test("skips clients who already have counsel", async () => {
  LegalCode.hireLawyer("Accused Al", "Other Otto", Date.now(), true);
  const action = createCitizenLawyerAction({ wantedList: () => ["Accused Al"] });
  const lawyer = stubPlayer("Lawyer Larry", 0);
  const res = await action.run(lawyer, {});
  assert.strictEqual(res.reason, "no-clients", "represented client skipped");
});

await test("give-up after the timeout", async () => {
  const action = createCitizenLawyerAction({ wantedList: () => ["Accused Al"] });
  const lawyer = stubPlayer("Lawyer Larry", 0);
  const res = await action.run(lawyer, { startedAt: Date.now() - 11 * 60 * 1000 });
  assert.strictEqual(res.reason, "give-up");
});

await test("never represents itself", async () => {
  const lawyer = stubPlayer("Lawyer Larry", 1000);
  const action = createCitizenLawyerAction({
    wantedList: () => ["Lawyer Larry"],
    playerFor: () => lawyer,
  });
  const res = await action.run(lawyer, {});
  assert.strictEqual(res.reason, "no-clients", "lawyer does not defend itself");
});

await test("takes a civil case when no criminal clients", async () => {
  const CivilLaw = require("../../lib/CitizenCivilLaw");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lawyercivil-test-"));
  CivilLaw._setSavePathForTests(path.join(dir, "civillaw.json"));
  CivilLaw.resetForTests();
  const { dispute } = CivilLaw.fileDispute({ type: "debt", plaintiff: "Alice", defendant: "Bob", claim: 500 });
  assert(dispute, "dispute filed");
  const lawyer = stubPlayer("Lawyer Larry", 0);
  const alice = stubPlayer("Alice", 500);
  const action = createCitizenLawyerAction({
    wantedList: () => [],
    playerFor: (n) => (String(n).toLowerCase() === "alice" ? alice : n.toLowerCase() === "lawyer larry" ? lawyer : null),
  });
  const res = await action.run(lawyer, {});
  assert.strictEqual(res.reason, "civil-case-taken", `got ${res.reason}`);
  assert.strictEqual(res.disputeId, dispute.id);
  const adv = CivilLaw.advocateFor(dispute.id, "alice");
  assert(adv && adv.lawyer === "lawyer larry", "representation registered");
  assert(adv.feePaid, "fee collected honestly");
  assert.strictEqual(alice._balance(), 400, "100-coin advocate fee moved");
  assert.strictEqual(lawyer._balance(), 100);
});

await test("civil case pro bono when the client cannot pay", async () => {
  const CivilLaw = require("../../lib/CitizenCivilLaw");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lawyercivil-test-"));
  CivilLaw._setSavePathForTests(path.join(dir, "civillaw.json"));
  CivilLaw.resetForTests();
  const { dispute } = CivilLaw.fileDispute({ type: "breach", plaintiff: "Carol", defendant: "Dave", claim: 200 });
  const lawyer = stubPlayer("Lawyer Larry", 0);
  const carol = stubPlayer("Carol", 10); // can't afford the 100 fee
  const action = createCitizenLawyerAction({
    wantedList: () => [],
    playerFor: (n) => (String(n).toLowerCase() === "carol" ? carol : null),
  });
  const res = await action.run(lawyer, {});
  assert.strictEqual(res.reason, "civil-case-taken");
  assert.strictEqual(res.feePaid, false, "pro bono");
  assert(CivilLaw.advocateFor(dispute.id, "carol"), "still represented");
});

await test("criminal clients take priority over civil", async () => {
  const CivilLaw = require("../../lib/CitizenCivilLaw");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lawyercivil-test-"));
  CivilLaw._setSavePathForTests(path.join(dir, "civillaw.json"));
  CivilLaw.resetForTests();
  CivilLaw.fileDispute({ type: "debt", plaintiff: "Alice", defendant: "Bob", claim: 500 });
  const lawyer = stubPlayer("Lawyer Larry", 0);
  const accused = stubPlayer("Accused Andy", 500);
  const action = createCitizenLawyerAction({
    wantedList: () => ["Accused Andy"],
    playerFor: (n) => (String(n).toLowerCase() === "accused andy" ? accused : null),
  });
  const res = await action.run(lawyer, {});
  assert.strictEqual(res.reason, "case-taken", "criminal first");
});

} // end main

main().then(() => {
  console.log(`\n${passed} tests passed.`);
});
