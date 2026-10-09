"use strict";

/**
 * CitizenCivilLife.test.js — slow-tick tests: contract deadlines,
 * mediation, hearings, enforcement, will execution. Plain node.
 *
 * Run: node server/plugins/citizens/lib/CitizenCivilLife.test.js
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SAVE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "civillife-")), "civillaw.json");
const CivilLaw = require("./CitizenCivilLaw");
CivilLaw._setSavePathForTests(SAVE);
const CivilLife = require("./CitizenCivilLife");

function fakeBot(username, coins, kingdomId) {
  let balance = coins;
  return {
    username,
    kingdomId,
    getUsername: () => username,
    getInventory() {
      return {
        count: () => balance,
        getAmount: () => balance,
        remove: (id, n) => { balance = Math.max(0, balance - n); },
        add: (id, n) => { balance += n; },
      };
    },
    __balance: () => balance,
  };
}

function fakeDirector(bots) {
  const roster = bots.map((b) => ({ username: b.username, kingdomId: b.kingdomId, __bot: b }));
  return {
    roster,
    isOnline: () => true,
    getBot: (record) => record.__bot,
    getPlayer: () => null,
    players: new Map(),
    log: () => {},
  };
}

let passed = 0;
function test(name, fn) {
  CivilLaw.resetForTests();
  CivilLife.resetForTests();
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

test("tick: expired contract breaches and auto-disputes", () => {
  const alice = fakeBot("Alice", 1000, "misthalin");
  const bob = fakeBot("Bob", 1000, "misthalin");
  const director = fakeDirector([alice, bob]);
  const { contract } = CivilLaw.createContract({
    type: "service", partyA: "Alice", partyB: "Bob", amount: 500,
    deadlineMs: Date.now() - 1000, // already expired
  });
  CivilLife.tickCivilLife(director, Date.now());
  const c = CivilLaw.contractById(contract.id);
  assert.strictEqual(c.status, "breached", "expired contract breached");
  assert.strictEqual(c.breachedBy, "bob");
});

test("tick: never throws with empty director", () => {
  CivilLife.tickCivilLife({}, Date.now());
  CivilLife.tickCivilLife(null, Date.now());
});

test("tick: will executes on fresh death", () => {
  // Stub the funerals death feed via require cache.
  const funeralsPath = require.resolve("./CitizenFunerals");
  const orig = require.cache[funeralsPath];
  const bob = fakeBot("Bob", 0, "misthalin");
  const alice = fakeBot("Alice", 1000, "misthalin");
  require.cache[funeralsPath] = {
    id: funeralsPath, filename: funeralsPath, loaded: true,
    exports: { getDeceased: () => [{ username: "alice", display: "Alice", diedAt: Date.now() }] },
  };
  try {
    CivilLaw.registerWill("Alice", [{ username: "Bob", share: 1 }]);
    const director = fakeDirector([alice, bob]);
    CivilLife.tickCivilLife(director, Date.now());
    assert.strictEqual(bob.__balance(), 1000, "heir receives the estate");
    assert(CivilLaw.willWatermarkMs > 0, "watermark advances");
    // Second tick: no double-execution.
    CivilLife.tickCivilLife(director, Date.now());
    assert.strictEqual(bob.__balance(), 1000, "no double payout");
  } finally {
    if (orig) require.cache[funeralsPath] = orig;
    else delete require.cache[funeralsPath];
  }
});

test("tick: mediation settles or advances to hearing", () => {
  const alice = fakeBot("Alice", 1000, "misthalin");
  const bob = fakeBot("Bob", 1000, "misthalin");
  const director = fakeDirector([alice, bob]);
  const { dispute } = CivilLaw.fileDispute({
    type: "debt", plaintiff: "Alice", defendant: "Bob", claim: 400,
  });
  // Force the mediation pass by running many ticks (chance-gated).
  for (let i = 0; i < 20; i++) CivilLife.tickCivilLife(director, Date.now() + i * 70000);
  const d = CivilLaw.disputeById(dispute.id);
  assert(
    d.status === "settled" || d.status === "hearing" || d.status === "decided",
    `dispute progressed, got ${d.status}`
  );
});

test("tick: hearings need a seated judge", () => {
  // No judge stubbed → hearing stays pending, never invents a verdict.
  const { dispute } = CivilLaw.fileDispute({ type: "debt", plaintiff: "A", defendant: "B", claim: 100, kingdomId: "misthalin" });
  CivilLaw.setDisputeStatus(dispute.id, CivilLaw.DISPUTE_STATUS.hearing);
  const director = fakeDirector([]);
  for (let i = 0; i < 20; i++) CivilLife.tickCivilLife(director, Date.now() + i * 70000);
  const d = CivilLaw.disputeById(dispute.id);
  assert.strictEqual(d.status, "hearing", "no judge → docket waits honestly");
});

test("tick: enforcement collects unpaid judgments", () => {
  const alice = fakeBot("Alice", 0, "misthalin");
  const bob = fakeBot("Bob", 500, "misthalin");
  const director = fakeDirector([alice, bob]);
  const { dispute } = CivilLaw.fileDispute({ type: "debt", plaintiff: "Alice", defendant: "Bob", claim: 300 });
  CivilLaw.recordJudgment(dispute.id, "Alice", 300);
  for (let i = 0; i < 20; i++) CivilLife.tickCivilLife(director, Date.now() + i * 70000);
  assert.strictEqual(alice.__balance(), 300, "winner collected");
  assert.strictEqual(bob.__balance(), 200, "loser paid");
});

console.log(`\n${passed} tests passed`);
