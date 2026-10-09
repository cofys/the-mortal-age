"use strict";

/**
 * CitizenSpyEvents.test.js — plain-node tests for the ::spy command.
 * Run: node server/plugins/citizens/CitizenSpyEvents.test.js
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const Esp = require("./lib/CitizenEspionage");
const { onSpyCommand, USAGE } = require("./CitizenSpyEvents");

const SAVE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "spyevents-test-")), "espionage.json");
Esp._setSavePathForTests(SAVE);

const COINS = 995;

function fakePlayer(username, kingdomId, coins = 5000, isBot = false) {
  const messages = [];
  const inv = new Map([[COINS, coins]]);
  return {
    username,
    messages,
    isBot,
    getUsername: () => username,
    getAttribute: (k) => (k === "kingdom:id" || k === "kingdomId" ? kingdomId : null),
    getInventory: () => ({
      // Real ItemContainer API: getAmount(id), deleteNumber(id, amount).
      getAmount: (id) => inv.get(id) ?? 0,
      deleteNumber: (id, n) => inv.set(id, Math.max(0, (inv.get(id) ?? 0) - n)),
    }),
    sendMessage: (t) => messages.push(t),
    _coins: () => inv.get(COINS) ?? 0,
  };
}

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

test("usage mentions the subcommands", () => {
  assert.ok(USAGE.includes("infiltrate"), "usage mentions infiltrate");
  assert.ok(USAGE.includes("sabotage"), "usage mentions sabotage");
});

test("bots are rejected", () => {
  const p = fakePlayer("bot-spy", "asgarnia", 5000, true);
  onSpyCommand(p, ["infiltrate", "kandarin"]);
  assert.ok(p.messages.some((m) => /citizens spy/i.test(m)), "bot rejection message");
  assert.strictEqual(Esp.cellFor("bot-spy"), null, "no cell for bots");
});

test("infiltrate creates a cell and takes coins", () => {
  const p = fakePlayer("player-spy", "asgarnia", 5000);
  onSpyCommand(p, ["infiltrate", "kandarin"]);
  const cell = Esp.cellFor("player-spy");
  assert.ok(cell, "cell created");
  assert.strictEqual(cell.targetKingdom, "kandarin");
  assert.strictEqual(p._coins(), 4500, "infiltration cost taken");
});

test("infiltrate rejects unknown kingdoms and self-infiltration", () => {
  const p = fakePlayer("player-spy-2", "asgarnia", 5000);
  onSpyCommand(p, ["infiltrate", "atlantis"]);
  assert.strictEqual(Esp.cellFor("player-spy-2"), null);
  onSpyCommand(p, ["infiltrate", "asgarnia"]);
  assert.strictEqual(Esp.cellFor("player-spy-2"), null, "no self-infiltration");
});

test("infiltrate rejects the broke", () => {
  const p = fakePlayer("broke-spy", "asgarnia", 10);
  onSpyCommand(p, ["infiltrate", "kandarin"]);
  assert.strictEqual(Esp.cellFor("broke-spy"), null, "no cell without coins");
  assert.ok(p.messages.some((m) => /500/.test(m)), "cost mentioned");
});

test("sabotage plans a player operation and takes coins", () => {
  const p = fakePlayer("player-saboteur", "kandarin", 5000);
  onSpyCommand(p, ["sabotage", "asgarnia"]);
  const ops = Esp.pendingOperationsFor("kandarin");
  assert.strictEqual(ops.length, 1, "operation planned");
  assert.strictEqual(ops[0].type, "sabotage");
  assert.strictEqual(ops[0].operative, "player-saboteur");
  assert.strictEqual(p._coins(), 4000, "sabotage cost taken");
});

test("sabotage rejects treason", () => {
  const p = fakePlayer("traitor", "kandarin", 5000);
  onSpyCommand(p, ["sabotage", "kandarin"]);
  assert.strictEqual(Esp.pendingOperationsFor("kandarin").length, 0, "no self-sabotage");
});

test("report with no intel says so honestly", () => {
  const p = fakePlayer("curious", "asgarnia", 0);
  onSpyCommand(p, ["report", "morytania"]);
  assert.ok(p.messages.some((m) => /no word/i.test(m)), "honest empty report");
});

test("networks lists founded networks", () => {
  Esp.foundNetwork({ kingdom: "asgarnia", founder: "f" });
  Esp.recruitSpy({ kingdom: "asgarnia", spy: "s1" });
  const p = fakePlayer("curious-2", "kandarin", 0);
  onSpyCommand(p, ["networks"]);
  assert.ok(p.messages.some((m) => /Asgarnia/i.test(m) && /1 spies/.test(m)), "network listed");
});

test("advantage with no intel says so honestly", () => {
  const p = fakePlayer("curious-3", "asgarnia", 0);
  onSpyCommand(p, ["advantage", "kandarin"]);
  assert.ok(p.messages.some((m) => /no fresh intelligence/i.test(m)), "honest empty advantage");
});

test("advantage reflects fresh intel", () => {
  Esp.recordIntel("asgarnia", "kandarin", 0.7, "test", Date.now());
  const p = fakePlayer("curious-4", "asgarnia", 0);
  onSpyCommand(p, ["advantage", "kandarin"]);
  assert.ok(p.messages.some((m) => /intel advantage/i.test(m)), "advantage reported");
});

test("unknown subcommand shows usage", () => {
  const p = fakePlayer("curious-5", "asgarnia", 0);
  onSpyCommand(p, ["frobnicate"]);
  assert.ok(p.messages.some((m) => m.includes("::spy")), "usage shown");
});

console.log(`\n${passed} tests passed.`);
