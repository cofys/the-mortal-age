"use strict";

/**
 * CitizenCivilEvents.test.js — player command tests: ::contract, ::will,
 * ::dispute, ::represent. Plain node.
 *
 * Run: node server/plugins/citizens/CitizenCivilEvents.test.js
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SAVE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "civilevents-")), "civillaw.json");
const CivilLaw = require("./lib/CitizenCivilLaw");
CivilLaw._setSavePathForTests(SAVE);
const { onContractCommand, onWillCommand, onDisputeCommand, onRepresentCommand } = require("./CitizenCivilEvents");

function stubPlayer(username, coins) {
  let balance = coins;
  const messages = [];
  return {
    username,
    getUsername: () => username,
    getAttribute: () => null,
    isPlayerBot: () => false,
    getInventory: () => ({
      getAmount: (id) => (id === 995 ? balance : 0),
      deleteNumber: (id, n) => { if (id === 995) balance = Math.max(0, balance - n); },
      adds: (id, n) => { if (id === 995) balance += n; },
    }),
    sendMessage: (m) => messages.push(m),
    _balance: () => balance,
    _messages: () => messages,
  };
}

let passed = 0;
function test(name, fn) {
  CivilLaw.resetForTests();
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

test("::contract make creates a witnessed contract", () => {
  const p = stubPlayer("Player1", 1000);
  onContractCommand({ player: p, parts: ["contract", "make", "service", "Bob", "500", "7", "build a fence"] });
  assert.strictEqual(p._balance(), 990, "witness fee taken");
  const mine = CivilLaw.contractsOf("player1");
  assert.strictEqual(mine.length, 1);
  assert.strictEqual(mine[0].amount, 500);
  assert(p._messages().some((m) => m.includes("witnessed")));
});

test("::contract make fails honestly without fee", () => {
  const p = stubPlayer("Player1", 5);
  onContractCommand({ player: p, parts: ["contract", "make", "service", "Bob", "500", "7", "work"] });
  assert.strictEqual(CivilLaw.contractsOf("player1").length, 0);
  assert(p._messages().some((m) => m.includes("no-fee")));
});

test("::contract list shows contracts", () => {
  const p = stubPlayer("Player1", 1000);
  onContractCommand({ player: p, parts: ["contract", "make", "trade", "Bob", "100", "7", "goods"] });
  onContractCommand({ player: p, parts: ["contract", "list"] });
  assert(p._messages().some((m) => m.includes("trade")));
});

test("::will make registers a will", () => {
  const p = stubPlayer("Player1", 100);
  onWillCommand({ player: p, parts: ["will", "make", "Bob:0.6", "Carol:0.4"] });
  const w = CivilLaw.willFor("player1");
  assert(w && w.heirs.length === 2);
  assert(p._messages().some((m) => m.includes("registered")));
});

test("::will make rejects bad shares", () => {
  const p = stubPlayer("Player1", 100);
  onWillCommand({ player: p, parts: ["will", "make", "Bob:0.5"] });
  assert(!CivilLaw.willFor("player1"));
});

test("::will show reads the will", () => {
  const p = stubPlayer("Player1", 100);
  onWillCommand({ player: p, parts: ["will", "make", "Bob:1"] });
  onWillCommand({ player: p, parts: ["will", "show"] });
  assert(p._messages().some((m) => m.includes("Bob")));
});

test("::dispute file opens a dispute", () => {
  const p = stubPlayer("Player1", 1000);
  onDisputeCommand({ player: p, parts: ["dispute", "file", "debt", "Bob", "300"] });
  assert.strictEqual(p._balance(), 950, "filing fee taken");
  const mine = CivilLaw.disputesOf("player1");
  assert.strictEqual(mine.length, 1);
  assert.strictEqual(mine[0].type, "debt");
});

test("::dispute file fails honestly without fee", () => {
  const p = stubPlayer("Player1", 10);
  onDisputeCommand({ player: p, parts: ["dispute", "file", "debt", "Bob", "300"] });
  assert.strictEqual(CivilLaw.disputesOf("player1").length, 0);
});

test("::represent takes a civil case", () => {
  const { dispute } = CivilLaw.fileDispute({ type: "debt", plaintiff: "Alice", defendant: "Bob", claim: 200 });
  const p = stubPlayer("Player1", 100);
  onRepresentCommand({ player: p, parts: ["represent", dispute.id] });
  const adv = CivilLaw.advocateFor(dispute.id, "alice");
  assert(adv && adv.lawyer === "player1", "player registered as advocate");
  assert(p._messages().some((m) => m.includes("represent")));
});

test("::represent rejects self-representation", () => {
  const { dispute } = CivilLaw.fileDispute({ type: "debt", plaintiff: "Player1", defendant: "Bob", claim: 200 });
  const p = stubPlayer("Player1", 100);
  onRepresentCommand({ player: p, parts: ["represent", dispute.id] });
  assert(!CivilLaw.advocateFor(dispute.id, "player1"));
  assert(p._messages().some((m) => m.includes("yourself")));
});

test("citizens cannot run player commands", () => {
  const bot = stubPlayer("Bot1", 100);
  bot.isPlayerBot = () => true;
  const r1 = onContractCommand({ player: bot, parts: ["contract", "list"] });
  const r2 = onWillCommand({ player: bot, parts: ["will", "show"] });
  const r3 = onDisputeCommand({ player: bot, parts: ["dispute", "list"] });
  assert(r1 && r2 && r3, "all return true (handled, no-op)");
  assert.strictEqual(bot._messages().length, 0, "no messages to bots");
});

console.log(`\n${passed} tests passed`);
