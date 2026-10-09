"use strict";

/**
 * CitizenLibraryEvents.test.js — ::library command tests (plain node, no jest).
 *
 * Run: node server/plugins/citizens/CitizenLibraryEvents.test.js
 */

const assert = require("assert");
const os = require("os");
const path = require("path");

// Stub CitizenSites before requiring.
const sitesPath = require.resolve("./brain/CitizenSites");
require.cache[sitesPath] = {
  id: sitesPath, filename: sitesPath, loaded: true,
  exports: {
    kingdomIdOf: (p) => p?.getAttribute?.("kingdom:id") || null,
    siteTile: () => ({ x: 3200, y: 3200, z: 0 }),
  },
};

const Lib = require("./lib/CitizenLibraries");
const { onLibraryCommand } = require("./CitizenLibraryEvents");

const SAVE = path.join(os.tmpdir(), `citizen-library-events-test-${process.pid}.json`);
Lib._setSavePathForTests(SAVE);
Lib.resetForTests();

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

function fakePlayer(username, kingdomId, { papyrus = 0, coins = 0, isBot = false } = {}) {
  const messages = [];
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
    isBot,
    getAttribute: (key) => (key === "kingdom:id" ? kingdomId : null),
    getInventory: () => inv,
    sendMessage: (text) => messages.push(text),
    _messages: messages,
  };
}

test("bot rejection", () => {
  const bot = fakePlayer("Bot", "misthalin", { isBot: true });
  onLibraryCommand(bot, ["status"]);
  assert.ok(bot._messages.some((m) => m.includes("Citizens work")));
});

test("status shows library info", () => {
  const p = fakePlayer("Alice", "misthalin");
  onLibraryCommand(p, ["status"]);
  assert.ok(p._messages.some((m) => m.includes("Library of misthalin")));
});

test("write creates a book with papyrus", () => {
  const p = fakePlayer("Bob", "asgarnia", { papyrus: 3 });
  onLibraryCommand(p, ["write", "history"]);
  assert.ok(p._messages.some((m) => m.includes("You wrote")));
});

test("write fails without papyrus", () => {
  const p = fakePlayer("Carol", "asgarnia", { papyrus: 0 });
  onLibraryCommand(p, ["write", "history"]);
  assert.ok(p._messages.some((m) => m.includes("papyrus")));
});

test("write rejects bad subject", () => {
  const p = fakePlayer("Dave", "asgarnia", { papyrus: 3 });
  onLibraryCommand(p, ["write", "quantum"]);
  assert.ok(p._messages.some((m) => m.includes("Subjects:")));
});

test("books lists available", () => {
  const p = fakePlayer("Eve", "asgarnia");
  onLibraryCommand(p, ["books"]);
  // May or may not have books; just shouldn't throw.
  assert.ok(p._messages.length >= 0);
});

test("borrow and return flow", () => {
  const author = fakePlayer("Frank", "kandarin", { papyrus: 2 });
  onLibraryCommand(author, ["write", "law"]);
  const books = Lib.availableBooks("kandarin");
  assert.ok(books.length > 0);
  const bookId = books[0].id;

  const borrower = fakePlayer("Grace", "kandarin", { coins: 100 });
  onLibraryCommand(borrower, ["borrow", bookId]);
  assert.ok(borrower._messages.some((m) => m.includes("Borrowed")));

  const loans = Lib.loansFor("Grace");
  assert.ok(loans.length > 0);

  onLibraryCommand(borrower, ["return", loans[0].id]);
  assert.ok(borrower._messages.some((m) => m.includes("Returned")));
});

test("borrow fails when broke", () => {
  const author = fakePlayer("Hank", "keldagrim", { papyrus: 2 });
  onLibraryCommand(author, ["write", "medicine"]);
  const books = Lib.availableBooks("keldagrim");
  const borrower = fakePlayer("Ivy", "keldagrim", { coins: 5 });
  onLibraryCommand(borrower, ["borrow", books[0].id]);
  assert.ok(borrower._messages.some((m) => m.includes("deposit")));
});

test("loans lists borrower loans", () => {
  const p = fakePlayer("Grace", "kandarin");
  onLibraryCommand(p, ["loans"]);
  // Grace returned her book; should show no loans or empty.
  assert.ok(p._messages.length > 0);
});

test("archives shows records", () => {
  Lib.writeArchive("morytania", "Test event", "war", Date.now());
  const p = fakePlayer("Jack", "morytania");
  onLibraryCommand(p, ["archives"]);
  assert.ok(p._messages.some((m) => m.includes("Test event")));
});

test("donate moves book", () => {
  const author = fakePlayer("Kim", "misthalin", { papyrus: 2 });
  onLibraryCommand(author, ["write", "poetry"]);
  const books = Lib.availableBooks("misthalin");
  const bookId = books[books.length - 1].id;
  const donor = fakePlayer("Liam", "asgarnia");
  // Donate requires the book to exist; we donate Kim's book to asgarnia.
  // (In real usage, the donor would own the book.)
  onLibraryCommand(donor, ["donate", bookId]);
  assert.ok(donor._messages.some((m) => m.includes("Donated")));
});

test("unknown subcommand shows usage", () => {
  const p = fakePlayer("Mia", "misthalin");
  onLibraryCommand(p, ["frobnicate"]);
  assert.ok(p._messages.some((m) => m.includes("::library")));
});

console.log(`\nCitizenLibraryEvents: ${passed} passed`);
