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

test("tick: journal entries carry kind 'civillaw' (not the text)", () => {
  // Regression: journalEvent once called log(name, text, kind) — the real
  // signature is log(name, kind, text). The LLM prompt reads .text.
  const { getJournal } = require("./CitizenJournal");
  getJournal().resetForTests();
  const alice = fakeBot("Alice", 1000, "misthalin");
  const bob = fakeBot("Bob", 1000, "misthalin");
  const director = fakeDirector([alice, bob]);
  CivilLaw.createContract({
    type: "service", partyA: "Alice", partyB: "Bob", amount: 500,
    deadlineMs: Date.now() - 1000, // already expired
  });
  CivilLife.tickCivilLife(director, Date.now());
  const recent = getJournal().recent("Alice", 10);
  assert(recent.length > 0, "breach journaled");
  const breach = recent.find((e) => e.text.includes("expired"));
  assert(breach, `breach entry present, got ${JSON.stringify(recent.map((e) => e.text))}`);
  assert.strictEqual(breach.kind, "civillaw", `kind is the kind, got ${JSON.stringify(breach.kind)}`);
});

test("tick: citizens speak via the canonical bot path when a real player is near", () => {
  // Regression: sayPublicTo used director.getPlayer/players (do not exist)
  // and heardByPlayer imported a getLocalPlayers the chat module never
  // exported — civil-law speech never fired. Now: roster -> isOnline ->
  // getBot(record) -> sayPublic(bot, text), gated on bot.getLocalPlayers().
  const { resetForTests: resetSpeech } = require("../chat/CitizenSayPublic");
  resetSpeech();
  const spoken = [];
  const realPlayer = {
    isPlayerBot: () => false,
    getUsername: () => "RealRon",
    getIndex: () => 7,
    getRelations: () => ({ canReceivePublicChatFrom: () => true }),
    getPacketSender: () => ({ sendPublicChat: () => { spoken.push("[box]"); } }),
  };
  const bot = {
    username: "Alice",
    getUsername: () => "Alice",
    getIndex: () => 3,
    forceChat: (t) => spoken.push(t),
    getLocalPlayers: () => [realPlayer],
    getInventory() {
      return { count: () => 1000, remove: () => {}, add: () => {} };
    },
  };
  const record = { username: "Alice", __bot: bot };
  const director = {
    roster: new Map([["alice", record]]), // canonical key: normalized username
    isOnline: () => true,
    getBot: (r) => r.__bot, // canonical: takes the RECORD
    log: () => {},
  };
  CivilLaw.createContract({
    type: "service", partyA: "Alice", partyB: "Bob", amount: 500,
    deadlineMs: Date.now() - 1000,
  });
  CivilLife.tickCivilLife(director, Date.now());
  assert(
    spoken.some((t) => String(t).includes("court")),
    `citizen spoke about the breach, got ${JSON.stringify(spoken)}`
  );
});

test("tick: silent when no real player is near", () => {
  const { resetForTests: resetSpeech } = require("../chat/CitizenSayPublic");
  resetSpeech();
  const spoken = [];
  const bot = {
    username: "Alice",
    getUsername: () => "Alice",
    getIndex: () => 3,
    forceChat: (t) => spoken.push(t),
    getLocalPlayers: () => [], // nobody around
    getInventory() {
      return { count: () => 1000, remove: () => {}, add: () => {} };
    },
  };
  const director = {
    roster: new Map([["alice", { username: "Alice", __bot: bot }]]),
    isOnline: () => true,
    getBot: (r) => r.__bot,
    log: () => {},
  };
  CivilLaw.createContract({
    type: "service", partyA: "Alice", partyB: "Bob", amount: 500,
    deadlineMs: Date.now() - 1000,
  });
  CivilLife.tickCivilLife(director, Date.now());
  assert.strictEqual(spoken.length, 0, "no speech with no audience");
  // The journal still records it — the event happened, just unheard.
  const { getJournal } = require("./CitizenJournal");
  assert(getJournal().recent("Alice").length > 0, "breach still journaled");
});

test("tick: offline citizen's bank balance is swept into the estate", () => {
  // Regression: estateOf called Banking.accountOf (does not exist) and
  // Banking.withdraw with the wrong arg order — bank balances were
  // silently excluded from every will.
  const bankingPath = require.resolve("./CitizenBanking");
  const origBanking = require.cache[bankingPath];
  const accounts = Object.create(null);
  require.cache[bankingPath] = {
    id: bankingPath, filename: bankingPath, loaded: true,
    exports: {
      accountFor: (username) => {
        const k = String(username || "").toLowerCase();
        if (!accounts[k]) accounts[k] = { balance: 0 };
        return accounts[k];
      },
      markDirty: () => {},
    },
  };
  const funeralsPath = require.resolve("./CitizenFunerals");
  const origFunerals = require.cache[funeralsPath];
  require.cache[funeralsPath] = {
    id: funeralsPath, filename: funeralsPath, loaded: true,
    exports: { getDeceased: () => [{ username: "zed", display: "Zed", diedAt: Date.now() }] },
  };
  try {
    accounts["zed"] = { balance: 800 }; // bank only, no inventory (offline)
    CivilLaw.registerWill("Zed", [{ username: "Bob", share: 1 }]);
    const bob = fakeBot("Bob", 0, "misthalin");
    const director = fakeDirector([bob]); // Zed has no bot — offline death
    CivilLife.tickCivilLife(director, Date.now());
    assert.strictEqual(bob.__balance(), 800, "heir receives the bank estate");
    assert.strictEqual(accounts["zed"].balance, 0, "account swept");
  } finally {
    if (origBanking) require.cache[bankingPath] = origBanking;
    else delete require.cache[bankingPath];
    if (origFunerals) require.cache[funeralsPath] = origFunerals;
    else delete require.cache[funeralsPath];
  }
});

console.log(`\n${passed} tests passed`);
