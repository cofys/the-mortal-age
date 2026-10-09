"use strict";

/**
 * CitizenLibrariesLife.test.js — slow tick tests (plain node, no jest).
 *
 * Run: node server/plugins/citizens/lib/CitizenLibrariesLife.test.js
 */

const assert = require("assert");
const os = require("os");
const path = require("path");

const Lib = require("./CitizenLibraries");
const Life = require("./CitizenLibrariesLife");

const SAVE = path.join(os.tmpdir(), `citizen-libraries-life-test-${process.pid}.json`);
Lib._setSavePathForTests(SAVE);
Lib.resetForTests();
Life.resetForTests();

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (e) {
    console.error(`FAIL: ${name}\n  ${e.message}`);
    process.exitCode = 1;
  }
}

function fakeCitizen(username, kingdomId, career = "") {
  return {
    getUsername: () => username,
    username,
    isBot: true,
    getAttribute: (key) => {
      if (key === "citizen:career") return career;
      if (key === "kingdom:id") return kingdomId;
      return null;
    },
  };
}

function fakeDirector(citizens) {
  return {
    citizensOnline: () => citizens,
    log: () => {},
  };
}

// Mock CitizenSites.kingdomIdOf
const sitesPath = require.resolve("../brain/CitizenSites");
const origSites = require.cache[sitesPath];
require.cache[sitesPath] = {
  id: sitesPath, filename: sitesPath, loaded: true,
  exports: {
    kingdomIdOf: (p) => p?.getAttribute?.("kingdom:id") || null,
    siteTile: () => ({ x: 3200, y: 3200, z: 0 }),
  },
};

test("tickLibrariesLife never throws with empty director", () => {
  Life.tickLibrariesLife(null, 1000);
  Life.tickLibrariesLife({}, 1000);
  Life.tickLibrariesLife(fakeDirector([]), 1000);
});

test("registers librarian-career citizens", () => {
  Lib.resetForTests();
  Life.resetForTests();
  const c = fakeCitizen("Libby", "misthalin", "librarian");
  const director = fakeDirector([c]);
  Life.tickLibrariesLife(director, 2000);
  assert.ok(Lib.isLibrarian("Libby"));
});

test("does not register non-librarians", () => {
  Lib.resetForTests();
  Life.resetForTests();
  const c = fakeCitizen("Nora", "misthalin", "farmer");
  const director = fakeDirector([c]);
  Life.tickLibrariesLife(director, 3000);
  assert.ok(!Lib.isLibrarian("Nora"));
});

test("enforceLoans marks long-overdue as lost", () => {
  Lib.resetForTests();
  Life.resetForTests();
  // Create a loan via direct state manipulation (faster than full flow).
  const nowMs = 10000;
  Lib.ensureLibrary("asgarnia", nowMs);
  // Write a book with a fake author.
  const fakeAuthor = {
    getUsername: () => "Author",
    getInventory: () => ({
      getItems: () => [{ id: 970, amount: 5 }],
      removeItem: () => {},
    }),
  };
  const book = Lib.writeBook(fakeAuthor, "history", "asgarnia", nowMs).book;
  assert.ok(book);
  // Manually create an ancient overdue loan.
  const loanId = "loan_test_1";
  const state = Lib.load();
  // Use the public API instead — borrow then manipulate.
  const borrower = {
    getUsername: () => "Borrower",
    getInventory: () => ({
      getItems: () => [{ id: 995, amount: 100 }],
      removeItem: () => {},
      addItem: () => {},
    }),
  };
  const bres = Lib.borrowBook(borrower, book.id, nowMs);
  assert.ok(bres.ok);
  // Fast-forward 40 days (7-day term + 30-day lost threshold + buffer).
  const future = nowMs + 40 * 24 * 3600 * 1000;
  Life.tickLibrariesLife(fakeDirector([]), future);
  // Loan should be marked lost.
  const loans = Lib.loansFor("Borrower");
  // The loan is either returned (lost) or still active.
  // Check via overdueLoans — should not include it anymore if marked lost.
  const overdue = Lib.overdueLoans(future + 1000);
  const stillOverdue = overdue.filter((l) => l.id === bres.loan.id);
  assert.strictEqual(stillOverdue.length, 0);
});

test("writeArchives records events without throwing", () => {
  Lib.resetForTests();
  Life.resetForTests();
  // Should not throw even with no events.
  Life.tickLibrariesLife(fakeDirector([]), 50000);
});

test("payUpkeeps runs without throwing", () => {
  Lib.resetForTests();
  Life.resetForTests();
  Lib.ensureLibrary("kandarin", 60000);
  Life.tickLibrariesLife(fakeDirector([]), 60001);
});

// Restore
if (origSites) require.cache[sitesPath] = origSites;
else delete require.cache[sitesPath];

console.log(`\nCitizenLibrariesLife: ${passed} passed`);
