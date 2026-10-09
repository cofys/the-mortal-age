"use strict";

/**
 * CitizenTreatyEvents.test.js — player command tests: ::treaty.
 * Plain node.
 *
 * Run: node server/plugins/citizens/CitizenTreatyEvents.test.js
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const SAVE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "treatyevents-")), "treaties.json");
const T = require("./lib/CitizenTreaties");
T._setSavePathForTests(SAVE);
const { onTreatyCommand } = require("./CitizenTreatyEvents");

function stubPlayer(username, coins, kingdomId) {
  let balance = coins;
  const messages = [];
  return {
    username,
    getUsername: () => username,
    getAttribute: (k) => (k === "kingdom:id" || k === "kingdomId" ? kingdomId : null),
    isPlayerBot: () => false,
    getInventory: () => ({
      // Real ItemContainer API: getAmount(id), adds(id, amount), deleteNumber(id, amount).
      getAmount: (id) => (id === 995 ? balance : 0),
      adds: (id, n) => { if (id === 995 && n > 0) balance += n; },
      deleteNumber: (id, n) => { if (id === 995) balance = Math.max(0, balance - n); },
    }),
    sendMessage: (m) => messages.push(m),
    _balance: () => balance,
    _messages: () => messages,
  };
}

let passed = 0;
function test(name, fn) {
  T.resetForTests();
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

test("::treaty help", () => {
  const p = stubPlayer("Alice", 10000, "asgarnia");
  onTreatyCommand({ player: p, parts: ["treaty"] });
  assert.ok(p._messages().some((m) => /::treaty propose/.test(m)));
});

test("::treaty relations: empty realm", () => {
  const p = stubPlayer("Alice", 10000, "asgarnia");
  onTreatyCommand({ player: p, parts: ["treaty", "relations"] });
  assert.ok(p._messages().some((m) => /no treaties/.test(m)));
});

test("::treaty propose peace: player bypasses fame gate", () => {
  const p = stubPlayer("Alice", 10000, "asgarnia");
  onTreatyCommand({ player: p, parts: ["treaty", "propose", "peace", "misthalin"] });
  assert.ok(p._messages().some((m) => /goes to their court/.test(m)));
  assert.equal(T.pendingProposalsFor("asgarnia").length, 1);
});

test("::treaty propose trade: refused without embassies", () => {
  const p = stubPlayer("Alice", 10000, "asgarnia");
  onTreatyCommand({ player: p, parts: ["treaty", "propose", "trade", "misthalin"] });
  assert.ok(p._messages().some((m) => /embassies/.test(m)));
});

test("::treaty embassy: real coins, honest failure when broke", () => {
  const poor = stubPlayer("Bob", 100, "asgarnia");
  onTreatyCommand({ player: poor, parts: ["treaty", "embassy", "misthalin"] });
  assert.ok(poor._messages().some((m) => /costs 5000/.test(m)));
  const rich = stubPlayer("Alice", 10000, "asgarnia");
  onTreatyCommand({ player: rich, parts: ["treaty", "embassy", "misthalin"] });
  assert.ok(rich._messages().some((m) => /embassy rises/.test(m)));
  assert.equal(rich._balance(), 5000); // real coins moved
  assert.ok(T.embassyFor("asgarnia", "misthalin"));
});

test("::treaty embassy: full pair unlocks trade talks", () => {
  const a = stubPlayer("Alice", 10000, "asgarnia");
  const m = stubPlayer("Mallory", 10000, "misthalin");
  onTreatyCommand({ player: a, parts: ["treaty", "embassy", "misthalin"] });
  onTreatyCommand({ player: m, parts: ["treaty", "embassy", "asgarnia"] });
  assert.equal(T.embassyPair("asgarnia", "misthalin"), true);
  onTreatyCommand({ player: a, parts: ["treaty", "propose", "trade", "misthalin"] });
  assert.ok(a._messages().some((mm) => /goes to their court/.test(mm)));
});

test("::treaty summit: needs embassies", () => {
  const p = stubPlayer("Alice", 10000, "asgarnia");
  onTreatyCommand({ player: p, parts: ["treaty", "summit", "misthalin"] });
  assert.ok(p._messages().some((m) => /embassies/.test(m)));
});

test("::treaty: citizens (bots) cannot run it", () => {
  const bot = stubPlayer("Bot1", 10000, "asgarnia");
  bot.isPlayerBot = () => true;
  const r = onTreatyCommand({ player: bot, parts: ["treaty", "relations"] });
  assert.equal(r, true);
  assert.equal(bot._messages().length, 0);
});

test("::treaty: unknown kingdom rejected honestly", () => {
  const p = stubPlayer("Alice", 10000, "asgarnia");
  onTreatyCommand({ player: p, parts: ["treaty", "propose", "peace", "narnia"] });
  assert.ok(p._messages().some((m) => /unknown kingdom/.test(m)));
});

console.log(`\n${passed} tests passed.`);
