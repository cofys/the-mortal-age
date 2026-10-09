"use strict";

/**
 * CitizenLibraries.test.js — data tier tests (plain node, no jest).
 *
 * Run: node server/plugins/citizens/lib/CitizenLibraries.test.js
 */

const assert = require("assert");
const os = require("os");
const path = require("path");

const Lib = require("./CitizenLibraries");

const SAVE = path.join(os.tmpdir(), `citizen-libraries-test-${process.pid}.json`);
Lib._setSavePathForTests(SAVE);
Lib.resetForTests();

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (e) {
    console.error(`FAIL: ${name}\n  ${e.message}\n${e.stack}`);
    process.exitCode = 1;
  }
}

// --- fake player ---------------------------------------------------------------
function fakePlayer(username, { papyrus = 0, coins = 0 } = {}) {
  const inv = {
    items: [],
    getItems() { return this.items; },
    addItem(id, amount) { this.items.push({ id, amount }); },
    removeItem(id, amount) {
      let need = amount;
      for (const it of this.items) {
        if (it.id === id && need > 0) {
          const take = Math.min(it.amount, need);
          it.amount -= take;
          need -= take;
        }
      }
      this.items = this.items.filter((it) => it.amount > 0);
    },
  };
  if (papyrus > 0) inv.items.push({ id: 970, amount: papyrus });
  if (coins > 0) inv.items.push({ id: 995, amount: coins });
  return {
    getUsername: () => username,
    username,
    getInventory: () => inv,
    isBot: false,
  };
}

// --- libraries -------------------------------------------------------------------
test("ensureLibrary creates one per kingdom", () => {
  const lib = Lib.ensureLibrary("misthalin", 1000);
  assert.ok(lib);
  assert.strictEqual(lib.kingdomId, "misthalin");
  assert.strictEqual(lib.capacity, 200);
});

test("ensureLibrary rejects bad kingdom", () => {
  assert.strictEqual(Lib.ensureLibrary("narnia", 1000), null);
});

test("libraryTile returns a deterministic tile", () => {
  const t1 = Lib.libraryTile("misthalin");
  const t2 = Lib.libraryTile("misthalin");
  assert.ok(t1 && typeof t1.x === "number");
  assert.deepStrictEqual(t1, t2);
});

// --- librarians ---------------------------------------------------------------------
test("registerLibrarian is idempotent", () => {
  assert.strictEqual(Lib.registerLibrarian("Alice", "misthalin", 1000), true);
  assert.strictEqual(Lib.registerLibrarian("alice", "misthalin", 1000), false); // dup (case-insensitive)
  assert.ok(Lib.isLibrarian("Alice"));
  assert.ok(!Lib.isLibrarian("Bob"));
});

test("librariansIn filters by kingdom", () => {
  Lib.registerLibrarian("Bob", "asgarnia", 1000);
  const m = Lib.librariansIn("misthalin");
  assert.ok(m.some((l) => l.username === "alice"));
  assert.ok(!m.some((l) => l.username === "bob"));
});

// --- books ----------------------------------------------------------------------------
test("writeBook consumes real papyrus", () => {
  const p = fakePlayer("Carol", { papyrus: 3 });
  const res = Lib.writeBook(p, "history", "misthalin", 2000);
  assert.ok(res.ok, JSON.stringify(res));
  assert.ok(res.book.title.length > 0);
  assert.ok(res.book.quality >= 1 && res.book.quality <= 10);
  // papyrus consumed
  const items = p.getInventory().getItems();
  const pap = items.find((it) => it.id === 970);
  assert.strictEqual(pap.amount, 2);
});

test("writeBook fails honestly without papyrus", () => {
  const p = fakePlayer("Dave", { papyrus: 0 });
  const res = Lib.writeBook(p, "history", "misthalin", 2000);
  assert.ok(!res.ok);
  assert.strictEqual(res.reason, "no-papyrus");
});

test("writeBook rejects bad subject", () => {
  const p = fakePlayer("Eve", { papyrus: 5 });
  const res = Lib.writeBook(p, "quantum", "misthalin", 2000);
  assert.ok(!res.ok);
  assert.strictEqual(res.reason, "bad-subject");
});

test("book quality grows with author engagement", () => {
  const p = fakePlayer("Frank", { papyrus: 10 });
  const q1 = Lib.writeBook(p, "poetry", "asgarnia", 3000).book.quality;
  const q2 = Lib.writeBook(p, "poetry", "asgarnia", 3001).book.quality;
  assert.ok(q2 >= q1, `quality should not decrease: ${q1} -> ${q2}`);
});

test("booksIn and availableBooks filter correctly", () => {
  const books = Lib.booksIn("misthalin");
  assert.ok(books.length >= 1);
  const avail = Lib.availableBooks("misthalin");
  assert.ok(avail.every((b) => b.available));
});

// --- lending ------------------------------------------------------------------------------
test("borrowBook takes real deposit", () => {
  const author = fakePlayer("Gail", { papyrus: 2 });
  const book = Lib.writeBook(author, "law", "kandarin", 4000).book;
  const borrower = fakePlayer("Hank", { coins: 100 });
  const res = Lib.borrowBook(borrower, book.id, 4001);
  assert.ok(res.ok, JSON.stringify(res));
  assert.strictEqual(res.loan.deposit, Lib.LOAN_DEPOSIT);
  // deposit taken from real inventory
  const coins = borrower.getInventory().getItems().find((it) => it.id === 995);
  assert.strictEqual(coins.amount, 100 - Lib.LOAN_DEPOSIT);
  // book no longer available
  assert.strictEqual(Lib.bookById(book.id).available, false);
});

test("borrowBook fails honestly when broke", () => {
  const author = fakePlayer("Ivy", { papyrus: 2 });
  const book = Lib.writeBook(author, "medicine", "kandarin", 5000).book;
  const borrower = fakePlayer("Jack", { coins: 10 });
  const res = Lib.borrowBook(borrower, book.id, 5001);
  assert.ok(!res.ok);
  assert.strictEqual(res.reason, "no-deposit");
});

test("borrowBook fails when book unavailable", () => {
  const borrower = fakePlayer("Kim", { coins: 200 });
  const res = Lib.borrowBook(borrower, "book_nonexistent", 5001);
  assert.ok(!res.ok);
  assert.strictEqual(res.reason, "unavailable");
});

test("returnBook refunds deposit on time", () => {
  const author = fakePlayer("Liam", { papyrus: 2 });
  const book = Lib.writeBook(author, "theology", "keldagrim", 6000).book;
  const borrower = fakePlayer("Mia", { coins: 100 });
  const loan = Lib.borrowBook(borrower, book.id, 6001).loan;
  const res = Lib.returnBook(borrower, loan.id, 6002); // same day — on time
  assert.ok(res.ok);
  assert.strictEqual(res.lateFee, 0);
  const total = borrower.getInventory().getItems()
    .filter((it) => it.id === 995).reduce((s, it) => s + it.amount, 0);
  assert.strictEqual(total, 100); // deposit back
  assert.strictEqual(Lib.bookById(book.id).available, true);
});

test("returnBook charges late fee when overdue", () => {
  const author = fakePlayer("Nora", { papyrus: 2 });
  const book = Lib.writeBook(author, "astronomy", "morytania", 7000).book;
  const borrower = fakePlayer("Owen", { coins: 500 });
  const loan = Lib.borrowBook(borrower, book.id, 7001).loan;
  const tenDaysLater = 7001 + 10 * 24 * 3600 * 1000;
  const res = Lib.returnBook(borrower, loan.id, tenDaysLater);
  assert.ok(res.ok);
  assert.ok(res.lateFee > 0);
  // 500 - 50 deposit - lateFee + 50 deposit back = 500 - lateFee
  const total = borrower.getInventory().getItems()
    .filter((it) => it.id === 995).reduce((s, it) => s + it.amount, 0);
  assert.strictEqual(total, 500 - res.lateFee);
});

test("overdueLoans finds overdue", () => {
  const author = fakePlayer("Pete", { papyrus: 2 });
  const book = Lib.writeBook(author, "craft", "misthalin", 8000).book;
  const borrower = fakePlayer("Quinn", { coins: 100 });
  Lib.borrowBook(borrower, book.id, 8001);
  const future = 8001 + 10 * 24 * 3600 * 1000;
  const overdue = Lib.overdueLoans(future);
  assert.ok(overdue.length >= 1);
});

test("loansFor filters by borrower", () => {
  const loans = Lib.loansFor("Quinn");
  assert.ok(loans.length >= 1);
  assert.ok(loans.every((l) => l.borrower === "quinn"));
});

// --- research --------------------------------------------------------------------------------
test("researchBook grants real XP", () => {
  // Stub the skill store.
  const SkillPath = require.resolve("./CitizenSkilling");
  const orig = require.cache[SkillPath];
  let granted = null;
  require.cache[SkillPath] = {
    id: SkillPath, filename: SkillPath, loaded: true,
    exports: { skillStore: { addXp: (u, s, xp) => { granted = { u, s, xp }; } } },
  };
  try {
    const author = fakePlayer("Rita", { papyrus: 2 });
    const book = Lib.writeBook(author, "naturalism", "asgarnia", 9000).book;
    const researcher = fakePlayer("Sam");
    const res = Lib.researchBook(researcher, book.id, "herblore", 9001);
    assert.ok(res.ok, JSON.stringify(res));
    assert.ok(granted);
    assert.strictEqual(granted.u, "Sam"); // real username, not normalized
    assert.strictEqual(granted.s, "herblore");
    assert.ok(granted.xp > 0);
  } finally {
    if (orig) require.cache[SkillPath] = orig;
    else delete require.cache[SkillPath];
  }
});

test("researchBook throttles sessions", () => {
  const SkillPath = require.resolve("./CitizenSkilling");
  const orig = require.cache[SkillPath];
  require.cache[SkillPath] = {
    id: SkillPath, filename: SkillPath, loaded: true,
    exports: { skillStore: { addXp: () => {} } },
  };
  try {
    const researcher = fakePlayer("Tina");
    const books = Lib.availableBooks("asgarnia");
    assert.ok(books.length > 0);
    const r1 = Lib.researchBook(researcher, books[0].id, "farming", 9100);
    assert.ok(r1.ok);
    const r2 = Lib.researchBook(researcher, books[0].id, "farming", 9101);
    assert.ok(!r2.ok);
    assert.strictEqual(r2.reason, "too-soon");
  } finally {
    if (orig) require.cache[SkillPath] = orig;
    else delete require.cache[SkillPath];
  }
});

// --- archives -----------------------------------------------------------------------------------
test("writeArchive records real events", () => {
  const rec = Lib.writeArchive("misthalin", "War: test war", "war", 10000);
  assert.ok(rec);
  assert.strictEqual(rec.event, "War: test war");
  const archives = Lib.archivesIn("misthalin");
  assert.ok(archives.some((a) => a.id === rec.id));
});

test("writeArchive dedupes within 24h", () => {
  const r1 = Lib.writeArchive("asgarnia", "Election held", "election", 11000);
  const r2 = Lib.writeArchive("asgarnia", "Election held", "election", 11001);
  assert.strictEqual(r1.id, r2.id);
});

test("writeArchive rejects bad subject", () => {
  assert.strictEqual(Lib.writeArchive("misthalin", "Something", "gossip", 12000), null);
});

test("gatherArchiveEvents never throws", () => {
  const events = Lib.gatherArchiveEvents("misthalin");
  assert.ok(Array.isArray(events));
});

// --- knowledge --------------------------------------------------------------------------------------
test("knowledgeFor starts at 0 and grows", () => {
  Lib.resetForTests();
  assert.strictEqual(Lib.knowledgeFor("kandarin"), 0);
  Lib.addKnowledge("kandarin", 5);
  assert.strictEqual(Lib.knowledgeFor("kandarin"), 5);
  Lib.addKnowledge("kandarin", 200);
  assert.strictEqual(Lib.knowledgeFor("kandarin"), 100); // capped
});

// --- persistence ---------------------------------------------------------------------------------------
test("save and load round-trip", () => {
  Lib.resetForTests();
  Lib.ensureLibrary("morytania", 13000);
  Lib.registerLibrarian("Uma", "morytania", 13000);
  assert.ok(Lib.save());
  // Simulate fresh load.
  Lib.resetForTests();
  Lib._setSavePathForTests(SAVE);
  const loaded = Lib.load();
  assert.ok(loaded.libraries["morytania"]);
  assert.ok(loaded.librarians["uma"]);
});

// --- donate -----------------------------------------------------------------------------------------------
test("donateBook moves book to library", () => {
  Lib.resetForTests();
  const author = fakePlayer("Vera", { papyrus: 2 });
  const book = Lib.writeBook(author, "history", "misthalin", 14000).book;
  const donor = fakePlayer("Walt");
  const res = Lib.donateBook(donor, book.id, "asgarnia", 14001);
  assert.ok(res.ok);
  assert.strictEqual(res.book.kingdomId, "asgarnia");
});

console.log(`\nCitizenLibraries: ${passed} passed`);
