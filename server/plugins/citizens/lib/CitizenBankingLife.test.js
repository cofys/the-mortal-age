"use strict";

/**
 * CitizenBankingLife.test.js — slow-tick tests for REAL banking.
 * Plain node, no jest. Run: node server/plugins/citizens/lib/CitizenBankingLife.test.js
 */

const assert = require("assert");
const Banking = require("./CitizenBanking");
const { tickBankingLife } = require("./CitizenBankingLife");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    Banking.resetForTests();
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error(`FAIL: ${name}: ${e.message}`);
  }
}

function mockDirector() {
  // Real director shape: isOnline/getBot take the roster RECORD;
  // near-player scans live on the bot (getLocalPlayers), not the director.
  return {
    roster: new Map(),
    log: () => {},
    isOnline: () => false,
    getBot: () => null,
  };
}

function mockPlayer(coins) {
  const inv = {
    coins,
    getAmount(id) { return id === 995 ? this.coins : 0; },
    add(id, n) { if (id === 995) this.coins += n; },
    remove(id, n) { if (id === 995 && this.coins >= n) { this.coins -= n; return true; } return false; },
  };
  return { username: "TestCitizen", getInventory: () => inv, _inv: inv };
}

test("tick never throws on empty director", () => {
  tickBankingLife(mockDirector(), Date.now());
  tickBankingLife(null, Date.now());
  tickBankingLife({}, Date.now());
});

test("tick accrues interest", () => {
  const p = mockPlayer(10000);
  Banking.deposit(p, "Alice", 10000);
  const acct = Banking.accountFor("Alice");
  acct.lastInterest = Date.now() - 8 * 24 * 3600 * 1000;
  tickBankingLife(mockDirector(), Date.now());
  const expected = 10000 + Math.floor((10000 * 200) / 10000);
  assert.strictEqual(Banking.balanceOf("Alice"), expected);
});

test("tick accrues loan interest", () => {
  const p = mockPlayer(0);
  Banking.borrow(p, "Bob", 1000);
  const loan = Banking.loanFor("Bob");
  loan.lastInterest = Date.now() - 8 * 24 * 3600 * 1000;
  tickBankingLife(mockDirector(), Date.now());
  const expected = 1000 + Math.floor((1000 * 1000) / 10000);
  assert.strictEqual(Banking.loanFor("Bob").owed, expected);
});

test("tick processes defaults", () => {
  const p = mockPlayer(0);
  Banking.borrow(p, "Carol", 500);
  const loan = Banking.loanFor("Carol");
  loan.borrowedAt = Date.now() - 61 * 24 * 3600 * 1000;
  tickBankingLife(mockDirector(), Date.now());
  assert.strictEqual(Banking.loanFor("Carol").defaulted, true, "default flagged");
});

test("tick does not re-process defaults", () => {
  const p = mockPlayer(0);
  Banking.borrow(p, "Dave", 500);
  const loan = Banking.loanFor("Dave");
  loan.borrowedAt = Date.now() - 61 * 24 * 3600 * 1000;
  loan.defaulted = true; // already processed
  tickBankingLife(mockDirector(), Date.now());
  // Should not throw or double-process
  assert.strictEqual(Banking.loanFor("Dave").defaulted, true);
});

test("tick reminds overdue borrowers", () => {
  const p = mockPlayer(0);
  Banking.borrow(p, "Eve", 500);
  const loan = Banking.loanFor("Eve");
  loan.dueAt = Date.now() - 1000;
  tickBankingLife(mockDirector(), Date.now());
  assert(loan.lastReminder, "reminder timestamp set");
});

test("tick skips recent reminders", () => {
  const p = mockPlayer(0);
  Banking.borrow(p, "Frank", 500);
  const loan = Banking.loanFor("Frank");
  loan.dueAt = Date.now() - 1000;
  loan.lastReminder = Date.now() - 1000; // just reminded
  const before = loan.lastReminder;
  tickBankingLife(mockDirector(), Date.now());
  assert.strictEqual(loan.lastReminder, before, "no duplicate reminder");
});

console.log(`\nCitizenBankingLife: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
