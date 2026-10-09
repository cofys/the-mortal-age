"use strict";

/**
 * CitizenBanking.test.js — data-tier tests for REAL banking.
 * Plain node, no jest. Run: node server/plugins/citizens/lib/CitizenBanking.test.js
 */

const assert = require("assert");
const Banking = require("./CitizenBanking");

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

// --- Mock player with real inventory semantics (canonical engine API:
// getAmount(id), deleteNumber(id, amount), adds(id, amount). There is no
// inv.remove(id, n) and add(id, n) takes an Item instance — stale mocks
// using those shapes mask the vanishing/counterfeiting bugs.) ---
function mockPlayer(coins) {
  const inv = {
    coins,
    getAmount(id) { return id === 995 ? this.coins : 0; },
    adds(id, n) { if (id === 995 && n > 0) this.coins += n; },
    deleteNumber(id, n) { if (id === 995 && n > 0) this.coins = Math.max(0, this.coins - n); },
  };
  return { username: "TestCitizen", getInventory: () => inv, _inv: inv };
}

test("branches exist for all kingdoms", () => {
  for (const kid of ["misthalin", "asgarnia", "kandarin", "keldagrim", "morytania"]) {
    const b = Banking.branchFor(kid);
    assert(b && b.name && b.tile, `missing branch for ${kid}`);
  }
  assert.strictEqual(Banking.branchFor("nowhere"), null);
});

test("deposit moves real coins from inventory to account", () => {
  const p = mockPlayer(1000);
  const r = Banking.deposit(p, "Alice", 400);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.deposited, 400);
  assert.strictEqual(p._inv.coins, 600, "coins leave the inventory");
  assert.strictEqual(Banking.balanceOf("Alice"), 400, "coins land in the account");
});

test("deposit fails honestly when broke", () => {
  const p = mockPlayer(50);
  const r = Banking.deposit(p, "Bob", 400);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(Banking.balanceOf("Bob"), 0, "no phantom balance");
  assert.strictEqual(p._inv.coins, 50, "inventory untouched");
});

test("withdraw moves real coins from account to inventory", () => {
  const p = mockPlayer(0);
  Banking.deposit(p, "Carol", 0); // no-op, creates account
  // Fund directly via a deposit from a funded player
  const p2 = mockPlayer(1000);
  Banking.deposit(p2, "Carol", 800);
  const r = Banking.withdraw(p, "Carol", 300);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.withdrawn, 300);
  assert.strictEqual(p._inv.coins, 300, "coins arrive in inventory");
  assert.strictEqual(Banking.balanceOf("Carol"), 500, "balance reduced");
});

test("withdraw fails honestly on insufficient balance", () => {
  const p = mockPlayer(0);
  const p2 = mockPlayer(500);
  Banking.deposit(p2, "Dave", 200);
  const r = Banking.withdraw(p, "Dave", 500);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(Banking.balanceOf("Dave"), 200, "balance untouched");
});

test("interest accrues on positive balances", () => {
  const p = mockPlayer(10000);
  Banking.deposit(p, "Eve", 10000);
  const acct = Banking.accountFor("Eve");
  acct.lastInterest = Date.now() - 8 * 24 * 3600 * 1000; // 8 days ago
  const changed = Banking.accrueInterest(Date.now());
  assert(changed >= 1, "interest accrued");
  const expected = 10000 + Math.floor((10000 * 200) / 10000);
  assert.strictEqual(Banking.balanceOf("Eve"), expected, "2% weekly interest");
});

test("interest skips empty accounts", () => {
  Banking.accountFor("Frank"); // creates empty account
  const changed = Banking.accrueInterest(Date.now());
  assert.strictEqual(Banking.balanceOf("Frank"), 0);
});

test("borrow disburses real coins and records debt", () => {
  const p = mockPlayer(0);
  const r = Banking.borrow(p, "Grace", 1000);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(p._inv.coins, 1000, "real coins disbursed");
  const loan = Banking.loanFor("Grace");
  assert(loan && loan.owed === 1000, "debt recorded");
});

test("borrow rejects out-of-range amounts", () => {
  const p = mockPlayer(0);
  assert.strictEqual(Banking.borrow(p, "Heidi", 50).ok, false, "below minimum");
  assert.strictEqual(Banking.borrow(p, "Heidi", 999999).ok, false, "above maximum");
});

test("borrow rejects when existing loan outstanding", () => {
  const p = mockPlayer(0);
  Banking.borrow(p, "Ivan", 500);
  assert.strictEqual(Banking.borrow(p, "Ivan", 500).ok, false, "no double-dip");
});

test("repay reduces debt with real coins", () => {
  const p = mockPlayer(0);
  Banking.borrow(p, "Judy", 1000);
  assert.strictEqual(p._inv.coins, 1000);
  const r = Banking.repay(p, "Judy", 400);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.paid, 400);
  assert.strictEqual(p._inv.coins, 600, "coins leave inventory");
  assert.strictEqual(Banking.loanFor("Judy").owed, 600, "debt reduced");
});

test("repay clears loan when fully paid", () => {
  const p = mockPlayer(0);
  Banking.borrow(p, "Karl", 500);
  Banking.repay(p, "Karl", 500);
  assert.strictEqual(Banking.loanFor("Karl"), null, "loan record cleared");
});

test("repay fails honestly when broke", () => {
  const p = mockPlayer(0);
  Banking.borrow(p, "Liam", 1000);
  p._inv.coins = 0; // spent it all
  const r = Banking.repay(p, "Liam", 500);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(Banking.loanFor("Liam").owed, 1000, "debt unchanged");
});

test("loan interest accrues", () => {
  const p = mockPlayer(0);
  Banking.borrow(p, "Mia", 1000);
  const loan = Banking.loanFor("Mia");
  loan.lastInterest = Date.now() - 8 * 24 * 3600 * 1000;
  Banking.accrueLoanInterest(Date.now());
  const expected = 1000 + Math.floor((1000 * 1000) / 10000);
  assert.strictEqual(Banking.loanFor("Mia").owed, expected, "10% weekly loan interest");
});

test("overdue and default detection", () => {
  const p = mockPlayer(0);
  Banking.borrow(p, "Nina", 500);
  const loan = Banking.loanFor("Nina");
  assert.strictEqual(Banking.isOverdue("Nina", Date.now()), false, "not overdue yet");
  loan.dueAt = Date.now() - 1000;
  assert.strictEqual(Banking.isOverdue("Nina", Date.now()), true, "overdue now");
  assert.strictEqual(Banking.isDefaulted("Nina", Date.now()), false, "not defaulted yet");
  loan.borrowedAt = Date.now() - 61 * 24 * 3600 * 1000;
  assert.strictEqual(Banking.isDefaulted("Nina", Date.now()), true, "defaulted now");
});

test("banker registration", () => {
  Banking.registerBanker("Oscar", "misthalin");
  assert(Banking.bankerFor("Oscar"), "banker registered");
  assert.deepStrictEqual(Banking.bankersIn("misthalin"), ["oscar"]);
  assert.deepStrictEqual(Banking.bankersIn("asgarnia"), []);
});

test("treasury deposits", () => {
  const r = Banking.treasuryDeposit("misthalin", 5000);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(Banking.treasuryBalance("misthalin"), 5000);
  assert.strictEqual(Banking.treasuryDeposit("misthalin", 100).ok, false, "below minimum");
});

test("money supply and outstanding loans", () => {
  const p = mockPlayer(10000);
  Banking.deposit(p, "Pam", 3000);
  Banking.treasuryDeposit("asgarnia", 2000);
  const p2 = mockPlayer(0);
  Banking.borrow(p2, "Quinn", 1500);
  assert.strictEqual(Banking.moneySupply(), 5000, "deposits + treasury");
  assert.strictEqual(Banking.outstandingLoans(), 1500);
});

test("persistence round-trip", () => {
  const p = mockPlayer(2000);
  Banking.deposit(p, "Rita", 1500);
  assert.strictEqual(Banking.save(), true, "saved");
  Banking.clearCacheForTests();
  // reload from disk
  const bal = Banking.balanceOf("Rita");
  assert.strictEqual(bal, 1500, "balance survived reload");
});

console.log(`\nCitizenBanking: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
