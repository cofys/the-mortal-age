"use strict";

/**
 * CitizenCivilLaw.test.js — data-tier tests for contracts, wills,
 * disputes, advocates, and judgments. Plain node, zero LLM.
 *
 * Run: node server/plugins/citizens/lib/CitizenCivilLaw.test.js
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const CivilLaw = require("./CitizenCivilLaw");

const SAVE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "civillaw-")), "civillaw.json");
CivilLaw._setSavePathForTests(SAVE);

// --- stub banking: hermetic in-memory accounts ---------------------------------
// CitizenBanking is required lazily by CitizenCivilLaw, so injecting a stub
// into the require cache keeps these tests off the real save file.
const bankingPath = require.resolve("./CitizenBanking");
const _origBanking = require.cache[bankingPath];
const stubAccounts = Object.create(null);
require.cache[bankingPath] = {
  id: bankingPath, filename: bankingPath, loaded: true,
  exports: {
    accountFor: (username) => {
      const k = String(username || "").toLowerCase();
      if (!stubAccounts[k]) stubAccounts[k] = { balance: 0 };
      return stubAccounts[k];
    },
    balanceOf: (username) => stubAccounts[String(username || "").toLowerCase()]?.balance || 0,
    markDirty: () => {},
  },
};
function resetStubBanking() {
  for (const k of Object.keys(stubAccounts)) delete stubAccounts[k];
}
function bankBalanceOf(username) {
  return stubAccounts[String(username || "").toLowerCase()]?.balance || 0;
}

// --- fake players ----------------------------------------------------------------

function fakePlayer(coins) {
  let balance = coins;
  return {
    _coins: 0,
    getUsername: () => "fake",
    getInventory() {
      return {
        getAmount: () => balance,
        deleteNumber: (id, n) => { balance = Math.max(0, balance - n); },
        adds: (id, n) => { balance += n; },
      };
    },
    __balance: () => balance,
  };
}

let passed = 0;
function test(name, fn) {
  CivilLaw.resetForTests();
  resetStubBanking();
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

// --- contracts -------------------------------------------------------------------

test("createContract: honest witness fee", () => {
  const proposer = fakePlayer(100);
  const res = CivilLaw.createContract({
    type: "service", partyA: "Alice", partyB: "Bob", amount: 500,
    deadlineMs: Date.now() + 86400000, description: "build a fence",
    kingdomId: "misthalin", proposerPlayer: proposer,
  });
  assert(res.ok, "contract should be created");
  assert.strictEqual(res.contract.type, "service");
  assert.strictEqual(res.contract.status, "active");
  assert.strictEqual(proposer.__balance(), 90, "witness fee taken honestly");
});

test("createContract: fails without fee coins", () => {
  const proposer = fakePlayer(5);
  const res = CivilLaw.createContract({
    type: "service", partyA: "Alice", partyB: "Bob", amount: 500,
    proposerPlayer: proposer,
  });
  assert(!res.ok && res.reason === "no-fee", "should fail honestly");
});

test("createContract: rejects bad type and self-deal", () => {
  assert(!CivilLaw.createContract({ type: "nope", partyA: "A", partyB: "B", amount: 10 }).ok);
  assert(!CivilLaw.createContract({ type: "service", partyA: "Alice", partyB: "alice", amount: 10 }).ok);
  assert(!CivilLaw.createContract({ type: "service", partyA: "Alice", partyB: "Bob", amount: 0 }).ok);
});

test("fulfillContract: service moves coins A->B", () => {
  const alice = fakePlayer(1000);
  const bob = fakePlayer(0);
  const players = { alice, bob };
  const { contract } = CivilLaw.createContract({
    type: "service", partyA: "Alice", partyB: "Bob", amount: 500,
  });
  const res = CivilLaw.fulfillContract(contract.id, (n) => players[n.toLowerCase()] || null);
  assert(res.ok);
  assert.strictEqual(res.paid, 500);
  assert.strictEqual(alice.__balance(), 500);
  assert.strictEqual(bob.__balance(), 500);
  assert.strictEqual(CivilLaw.contractById(contract.id).status, "fulfilled");
});

test("fulfillContract: trade moves coins B->A", () => {
  const alice = fakePlayer(0);
  const bob = fakePlayer(1000);
  const players = { alice, bob };
  const { contract } = CivilLaw.createContract({
    type: "trade", partyA: "Alice", partyB: "Bob", amount: 300,
  });
  const res = CivilLaw.fulfillContract(contract.id, (n) => players[n.toLowerCase()] || null);
  assert(res.ok && res.paid === 300);
  assert.strictEqual(bob.__balance(), 700);
  assert.strictEqual(alice.__balance(), 300);
});

test("fulfillContract: partial payment when short", () => {
  const alice = fakePlayer(100);
  const bob = fakePlayer(0);
  const players = { alice, bob };
  const { contract } = CivilLaw.createContract({
    type: "service", partyA: "Alice", partyB: "Bob", amount: 500,
  });
  const res = CivilLaw.fulfillContract(contract.id, (n) => players[n.toLowerCase()] || null);
  assert(res.ok && res.paid === 100, "honest partial payment");
});

test("breachContract: records breach and auto-opens dispute", () => {
  const { contract } = CivilLaw.createContract({
    type: "service", partyA: "Alice", partyB: "Bob", amount: 500,
  });
  const res = CivilLaw.breachContract(contract.id, "Bob");
  assert(res.ok);
  assert.strictEqual(CivilLaw.contractById(contract.id).status, "breached");
  assert(res.disputeId, "dispute auto-opened");
  const d = CivilLaw.disputeById(res.disputeId);
  assert.strictEqual(d.type, "breach");
  assert.strictEqual(d.claim, 500);
});

test("contractsOf / activeContracts", () => {
  CivilLaw.createContract({ type: "service", partyA: "Alice", partyB: "Bob", amount: 10 });
  CivilLaw.createContract({ type: "trade", partyA: "Carol", partyB: "Dave", amount: 10 });
  assert.strictEqual(CivilLaw.contractsOf("alice").length, 1);
  assert.strictEqual(CivilLaw.activeContracts().length, 2);
  assert.strictEqual(CivilLaw.allContracts().length, 2);
});

// --- wills -----------------------------------------------------------------------

test("registerWill: validates shares", () => {
  assert(CivilLaw.registerWill("Alice", [{ username: "Bob", share: 0.6 }, { username: "Carol", share: 0.4 }], "Dave").ok);
  assert(!CivilLaw.registerWill("Alice", [{ username: "Bob", share: 0.5 }]).ok, "shares must sum to 1");
  assert(!CivilLaw.registerWill("Alice", []).ok);
  const w = CivilLaw.willFor("Alice");
  assert.strictEqual(w.heirs.length, 2);
  assert.strictEqual(w.executor, "dave");
});

test("executeWill: distributes per shares to live players", () => {
  CivilLaw.registerWill("Alice", [{ username: "Bob", share: 0.7 }, { username: "Carol", share: 0.3 }]);
  const bob = fakePlayer(0);
  const carol = fakePlayer(0);
  const players = { bob, carol };
  const res = CivilLaw.executeWill("Alice", 1000, (n) => players[n.toLowerCase()] || null, []);
  assert(res.ok && !res.intestate);
  assert.strictEqual(res.distributed, 1000);
  assert.strictEqual(bob.__balance(), 700);
  assert.strictEqual(carol.__balance(), 300);
  // Idempotent — can't execute twice.
  assert(!CivilLaw.executeWill("Alice", 1000, () => null, []).ok);
});

test("executeWill: intestate splits among bonds, crown takes 20%", () => {
  const bob = fakePlayer(0);
  const players = { bob };
  const res = CivilLaw.executeWill("Zed", 1000, (n) => players[n.toLowerCase()] || null, ["Bob"]);
  assert(res.ok && res.intestate);
  const crown = res.heirs.find((h) => h.username === "__crown__");
  assert(crown && crown.amount === 200, "crown takes 20%");
  assert.strictEqual(bob.__balance(), 800);
});

test("executeWill: zero estate marks executed", () => {
  const res = CivilLaw.executeWill("Nobody", 0, () => null, []);
  assert(res.ok && res.distributed === 0);
});

// --- disputes --------------------------------------------------------------------

test("fileDispute: honest filing fee", () => {
  const plaintiff = fakePlayer(100);
  const res = CivilLaw.fileDispute({
    type: "debt", plaintiff: "Alice", defendant: "Bob", claim: 250,
    kingdomId: "misthalin", plaintiffPlayer: plaintiff,
  });
  assert(res.ok);
  assert.strictEqual(res.dispute.status, "filed");
  assert.strictEqual(plaintiff.__balance(), 50, "filing fee taken");
});

test("fileDispute: fails without fee, rejects self-suit", () => {
  const poor = fakePlayer(10);
  assert(!CivilLaw.fileDispute({ type: "debt", plaintiff: "A", defendant: "B", claim: 10, plaintiffPlayer: poor }).ok);
  assert(!CivilLaw.fileDispute({ type: "debt", plaintiff: "Alice", defendant: "alice", claim: 10 }).ok);
  assert(!CivilLaw.fileDispute({ type: "nope", plaintiff: "A", defendant: "B", claim: 10 }).ok);
});

test("hireAdvocate / advocateFor / advocateBonusFor", () => {
  const { dispute } = CivilLaw.fileDispute({ type: "debt", plaintiff: "Alice", defendant: "Bob", claim: 100 });
  assert(CivilLaw.hireAdvocate(dispute.id, "Alice", "Portia", true).ok);
  assert(!CivilLaw.hireAdvocate(dispute.id, "Carol", "Portia", true).ok, "non-party rejected");
  const adv = CivilLaw.advocateFor(dispute.id, "alice");
  assert(adv && adv.lawyer === "portia");
  assert.strictEqual(CivilLaw.advocateBonusFor(dispute.id, "alice"), CivilLaw.ADVOCATE_BONUS);
  assert.strictEqual(CivilLaw.advocateBonusFor(dispute.id, "bob"), 0);
  assert.strictEqual(CivilLaw.disputesNeedingAdvocates().length, 1, "defendant still needs counsel");
});

test("setDisputeStatus transitions", () => {
  const { dispute } = CivilLaw.fileDispute({ type: "defamation", plaintiff: "A", defendant: "B", claim: 50 });
  assert(CivilLaw.setDisputeStatus(dispute.id, CivilLaw.DISPUTE_STATUS.mediation));
  assert.strictEqual(CivilLaw.disputeById(dispute.id).status, "mediation");
  assert(CivilLaw.disputeById(dispute.id).mediationAtMs > 0);
});

// --- judgments -------------------------------------------------------------------

test("recordJudgment + enforceJudgment: real coins", () => {
  const { dispute } = CivilLaw.fileDispute({ type: "debt", plaintiff: "Alice", defendant: "Bob", claim: 400 });
  const bob = fakePlayer(1000);
  const alice = fakePlayer(0);
  const players = { alice, bob };
  const rec = CivilLaw.recordJudgment(dispute.id, "Alice", 400);
  assert(rec.ok);
  assert.strictEqual(rec.judgment.winner, "alice");
  assert.strictEqual(CivilLaw.disputeById(dispute.id).status, "decided");
  const enf = CivilLaw.enforceJudgment(dispute.id, (n) => players[n.toLowerCase()] || null);
  assert(enf.ok && enf.paid === 400);
  assert.strictEqual(bob.__balance(), 600);
  assert.strictEqual(alice.__balance(), 400);
  assert.strictEqual(CivilLaw.judgmentFor(dispute.id).status, "paid");
  assert.strictEqual(CivilLaw.unpaidJudgments().length, 0);
});

test("enforceJudgment: partial when loser is short", () => {
  const { dispute } = CivilLaw.fileDispute({ type: "debt", plaintiff: "Alice", defendant: "Bob", claim: 400 });
  const bob = fakePlayer(150);
  const alice = fakePlayer(0);
  const players = { alice, bob };
  CivilLaw.recordJudgment(dispute.id, "Alice", 400);
  const enf = CivilLaw.enforceJudgment(dispute.id, (n) => players[n.toLowerCase()] || null);
  assert(enf.ok && enf.paid === 150 && enf.remaining === 250);
  assert.strictEqual(CivilLaw.unpaidJudgments().length, 1, "remainder stays as honest debt");
});

test("enforceJudgment: zero award needs no enforcement", () => {
  const { dispute } = CivilLaw.fileDispute({ type: "defamation", plaintiff: "A", defendant: "B", claim: 50 });
  const rec = CivilLaw.recordJudgment(dispute.id, "B", 0);
  assert(rec.ok && rec.judgment.status === "none");
});

// --- misc ------------------------------------------------------------------------

test("courthouseFor returns null without kingdom", () => {
  assert.strictEqual(CivilLaw.courthouseFor(null), null);
});

test("describe: counts", () => {
  CivilLaw.createContract({ type: "service", partyA: "A", partyB: "B", amount: 10, kingdomId: "misthalin" });
  CivilLaw.fileDispute({ type: "debt", plaintiff: "C", defendant: "D", claim: 10, kingdomId: "misthalin" });
  CivilLaw.registerWill("E", [{ username: "F", share: 1 }]);
  const d = CivilLaw.describe("misthalin");
  assert.strictEqual(d.openDisputes, 1);
  assert.strictEqual(d.activeContracts, 1);
  assert.strictEqual(d.willsRegistered, 1);
  assert.strictEqual(d.filingFee, CivilLaw.DISPUTE_FILING_FEE);
});

test("save: dirty-flag persistence round-trip", () => {
  CivilLaw.createContract({ type: "service", partyA: "A", partyB: "B", amount: 10 });
  assert(CivilLaw.save(), "save returns true when dirty");
  assert(!CivilLaw.save(), "save returns false when clean");
  const raw = JSON.parse(fs.readFileSync(SAVE, "utf8"));
  assert.strictEqual(Object.keys(raw.contracts).length, 1);
});

test("will watermark get/set", () => {
  CivilLaw.setWillWatermarkMs(12345);
  assert.strictEqual(CivilLaw.willWatermarkMs, 12345);
});

test("fulfillContract: offline payee is credited to their bank account", () => {
  const alice = fakePlayer(500);
  const { contract } = CivilLaw.createContract({
    type: "service", partyA: "Alice", partyB: "Bob", amount: 500,
  });
  // Bob is offline — playerFor only resolves Alice.
  const res = CivilLaw.fulfillContract(contract.id, (n) => (n.toLowerCase() === "alice" ? alice : null));
  assert(res.ok && res.paid === 500);
  assert.strictEqual(alice.__balance(), 0, "payer's coins taken");
  assert.strictEqual(bankBalanceOf("bob"), 500, "offline payee credited to bank — coins not destroyed");
});

test("enforceJudgment: offline loser is debited from their bank account", () => {
  const { dispute } = CivilLaw.fileDispute({ type: "debt", plaintiff: "Alice", defendant: "Bob", claim: 300 });
  CivilLaw.recordJudgment(dispute.id, "Alice", 300);
  const alice = fakePlayer(0);
  const bankingPath2 = require.resolve("./CitizenBanking");
  require.cache[bankingPath2].exports.accountFor("bob").balance = 400;
  // Bob offline: only Alice resolves.
  const enf = CivilLaw.enforceJudgment(dispute.id, (n) => (n.toLowerCase() === "alice" ? alice : null));
  assert(enf.ok && enf.paid === 300, `paid ${enf.paid}`);
  assert.strictEqual(bankBalanceOf("bob"), 100, "loser's bank debited");
  assert.strictEqual(alice.__balance(), 300, "winner collected");
  assert.strictEqual(CivilLaw.judgmentFor(dispute.id).status, "paid");
});

test("executeWill: offline heir is credited to their bank account", () => {
  CivilLaw.registerWill("Alice", [{ username: "Bob", share: 1 }]);
  const res = CivilLaw.executeWill("Alice", 1000, () => null, []);
  assert(res.ok && !res.intestate);
  assert.strictEqual(bankBalanceOf("bob"), 1000, "offline heir credited — coins not destroyed");
});

test("courthouseFor: returns the kingdom's own market tile", () => {
  const tile = CivilLaw.courthouseFor("kandarin");
  assert(tile, "courthouse resolved");
  assert.strictEqual(tile.kingdomId, "kandarin");
  // Kandarin's market (not the default kingdom's tile).
  assert.strictEqual(tile.x, 2657 + 2);
  assert.strictEqual(tile.y, 3288);
  assert.strictEqual(CivilLaw.courthouseFor(null), null);
});

console.log(`\n${passed} tests passed`);
