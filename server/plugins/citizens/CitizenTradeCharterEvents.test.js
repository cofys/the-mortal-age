"use strict";

/**
 * CitizenTradeCharterEvents.test.js — ::charter command tests: list,
 * petition, toll, treasury, bot rejection, and usage.
 * Plain node:assert, no engine. Run with: node <this file>.
 */

const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const C = require("./lib/CitizenTradeCharters");
const { onCharterCommand } = require("./CitizenTradeCharterEvents");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ctce-test-"));
C._setSavePathForTests(path.join(TMP, "citizen-trade-charters.json"));

let passed = 0;
function test(name, fn) {
  C.resetForTests();
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

function fakePlayer(username, coins, isBot = false) {
  let bal = coins;
  const messages = [];
  return {
    username,
    isPlayerBot: () => !!isBot,
    getUsername() {
      return username;
    },
    sendMessage(t) {
      messages.push(String(t));
    },
    _messages: messages,
    getInventory() {
      return {
        getAmount: (id) => (id === 995 ? bal : 0),
        deleteNumber: (id, n) => {
          if (id === 995 && bal >= n) {
            bal -= n;
            return true;
          }
          return false;
        },
        adds: (id, n) => { if (id === 995) bal += n; },
      };
    },
    _bal: () => bal,
  };
}

function said(p) {
  return p._messages.join("\n");
}

test("bot rejection", () => {
  const p = fakePlayer("Bot1", 99999, true);
  onCharterCommand(p, ["list"]);
  assert.match(said(p), /through their guilds/);
});

test("list: empty state", () => {
  const p = fakePlayer("Alice", 100);
  onCharterCommand(p, ["list"]);
  assert.match(said(p), /No trade charters/);
});

test("petition: usage when args missing", () => {
  const p = fakePlayer("Alice", 99999);
  onCharterCommand(p, ["petition"]);
  assert.match(said(p), /Usage/);
});

test("petition: fails honestly without standing", () => {
  const p = fakePlayer("Alice", 99999);
  onCharterCommand(p, ["petition", "merchants", "asgarnia", "weapons"]);
  assert.match(said(p), /failed/);
});

test("petition: succeeds with fame and real coins", () => {
  const Rep = require("./lib/CitizenReputation");
  const repTmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctce-rep-"));
  Rep._setSavePathForTests?.(path.join(repTmp, "rep.json"));
  Rep.resetForTests?.();
  for (let i = 0; i < 10; i++) Rep.addReputation("FamousPete", 10, "test", Date.now());
  const p = fakePlayer("FamousPete", 99999);
  onCharterCommand(p, ["petition", "merchants", "asgarnia", "weapons"]);
  assert.match(said(p), /Granted!/);
  assert.equal(p._bal(), 99999 - C.CHARTER_FEE);
  assert.equal(C.isChartered("asgarnia", "weapons"), true);
});

test("toll: reports charter and exemption honestly", () => {
  const p = fakePlayer("Bob", 100);
  onCharterCommand(p, ["toll", "asgarnia", "weapons"]);
  assert.match(said(p), /No charter covers/);
});

test("treasury: usage and balances", () => {
  const p = fakePlayer("Bob", 100);
  onCharterCommand(p, ["treasury"]);
  assert.match(said(p), /Usage/);
  onCharterCommand(p, ["treasury", "merchants"]);
  assert.match(said(p), /treasury holds 0 coins/);
  C.collectToll("merchants", 2500);
  const p2 = fakePlayer("Bob", 100);
  onCharterCommand(p2, ["treasury", "merchants"]);
  assert.match(said(p2), /2,500 coins/);
});

test("unknown subcommand shows usage", () => {
  const p = fakePlayer("Bob", 100);
  onCharterCommand(p, ["frobnicate"]);
  assert.match(said(p), /::charter/);
});

console.log(`\n${passed} tests passed`);
