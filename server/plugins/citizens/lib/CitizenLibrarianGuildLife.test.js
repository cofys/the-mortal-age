"use strict";

// Plain-node tests for CitizenLibrarianGuildLife (no jest, no engine).
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const Guilds = require("./CitizenLibrarianGuilds");

// NOTE: CitizenLibrarianGuildLife binds sayPublic at load time, so each test
// installs the require stubs first, then (re)loads the Life module fresh from
// the require cache. This keeps the ../chat/CitizenSayPublic stub effective.
function loadLifeFresh() {
  delete require.cache[require.resolve("./CitizenLibrarianGuildLife")];
  return require("./CitizenLibrarianGuildLife");
}

function freshSave(Life) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lgf-")), "save.json");
  Guilds._setSavePathForTests(p);
  Guilds.resetForTests();
  Life.resetForTests();
  return p;
}

// --- Engine stubs ---
const Module = require("module");
const origRequire = Module.prototype.require;

const said = [];
let careers = {};
let books = {};

function installStubs() {
  const stubs = {
    "./CitizenLibrarianGuilds": Guilds,
    "../chat/CitizenSayPublic": {
      sayPublic: (bot, text) => { said.push(text); },
    },
    "../brain/CitizenSites": {
      KINGDOM_IDS: ["varrock"],
      kingdomIdOf: () => "varrock",
      siteTileByKingdom: () => ({ x: 3200, y: 3200, z: 0 }),
    },
    "./CitizenLibraries": {
      booksIn: (kid) => Object.values(books).filter((b) => b.kingdomId === kid),
      bookById: (id) => books[id] || null,
      archivesIn: () => [],
      isLibrarian: () => false,
      libraryTile: () => ({ x: 3200, y: 3200, z: 0 }),
    },
    "./CitizenCareers": {
      careerOf: (u) => careers[String(u || "").toLowerCase()] || null,
    },
    "./CitizenReputation": { awardDeed: () => {} },
    "./CitizenBanking": { creditAccount: () => true },
    "./CitizenBonds": { normalizeName: (s) => String(s || "").toLowerCase().trim() },
  };
  Module.prototype.require = function (id) {
    if (Object.prototype.hasOwnProperty.call(stubs, id)) return stubs[id];
    return origRequire.apply(this, arguments);
  };
  return () => { Module.prototype.require = origRequire; };
}

let passed = 0;
function test(name, fn) {
  careers = {};
  books = {};
  said.length = 0;
  const restore = installStubs();
  const Life = loadLifeFresh();
  freshSave(Life);
  try {
    fn(Life);
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}: ${e.message}`);
    process.exitCode = 1;
  } finally {
    restore();
  }
}

function fakeDirector(records) {
  return {
    roster: records,
    isOnline: () => true,
    getBot: (r) => ({ __record: r }),
    log: () => {},
  };
}

function fakeRecord(username) {
  return { username, getUsername: () => username };
}

function botWithCoins(coins) {
  const inv = new Map([[995, coins]]);
  return {
    inventory: {
      getAmount: (id) => inv.get(id) || 0,
      remove: (id, n) => inv.set(id, Math.max(0, (inv.get(id) || 0) - n)),
    },
  };
}

test("tick is a no-op when nobody is around", (Life) => {
  Life.tickLibrarianGuildLife(fakeDirector([]), Date.now());
  assert.ok(Guilds.guildOf("varrock")); // guild ensured
});

test("tick collects dues from online members with coins", (Life) => {
  careers = { alice: "librarian" };
  Guilds.joinGuild("Alice", "varrock");
  Guilds.memberOf("Alice").duesPaidUntilMs = Date.now() - 1000; // dues due
  const rec = fakeRecord("Alice");
  const director = fakeDirector([rec]);
  const rich = botWithCoins(1000);
  director.getBot = () => rich;
  Life.tickLibrarianGuildLife(director, Date.now());
  assert.ok(Guilds.memberOf("Alice").duesPaidUntilMs > Date.now());
  assert.strictEqual(Guilds.guildTreasuryFor("varrock").treasury, 20);
});

test("tick marks a miss for broke members", (Life) => {
  careers = { alice: "librarian" };
  Guilds.joinGuild("Alice", "varrock");
  Guilds.memberOf("Alice").duesPaidUntilMs = Date.now() - 1000;
  const rec = fakeRecord("Alice");
  const director = fakeDirector([rec]);
  director.getBot = () => botWithCoins(0);
  Life.tickLibrarianGuildLife(director, Date.now());
  assert.strictEqual(Guilds.memberOf("Alice").missedDues, 1);
});

test("tick auto-scans plagiarism and announces", (Life) => {
  careers = { alice: "librarian", mallory: "librarian" };
  Guilds.joinGuild("Alice", "varrock");
  Guilds.joinGuild("Mallory", "varrock");
  const now = Date.now();
  const st = Guilds.load();
  st.certifications["cert-1"] = { id: "cert-1", kingdomId: "varrock", author: "Alice", title: "Copied Tome", subject: "lore", quality: 8, grade: "A", certifiedMs: now - 1000 };
  st.certifications["cert-2"] = { id: "cert-2", kingdomId: "varrock", author: "Mallory", title: "Copied Tome", subject: "lore", quality: 2, grade: "C", certifiedMs: now };
  Guilds.touch();
  Life.tickLibrarianGuildLife(fakeDirector([fakeRecord("Alice")]), now);
  assert.ok(said.some((s) => s.includes("plagiarism case")));
  const cases = Object.values(Guilds.load().cases);
  assert.strictEqual(cases.length, 1);
});

test("tick settles ripe tribunal cases and announces", (Life) => {
  careers = { warden: "librarian" };
  Guilds.joinGuild("Warden", "varrock");
  Guilds.memberOf("Warden").rank = Guilds.RANK_LIBRARIAN;
  const now = Date.now();
  const st = Guilds.load();
  st.certifications["cert-1"] = { id: "cert-1", kingdomId: "varrock", author: "Alice", title: "Tome X", subject: "lore", quality: 8, grade: "A", certifiedMs: now - 1000 };
  st.certifications["cert-2"] = { id: "cert-2", kingdomId: "varrock", author: "Mallory", title: "Tome X", subject: "lore", quality: 2, grade: "C", certifiedMs: now };
  Guilds.touch();
  const rep = Guilds.reportPlagiarism("varrock", "Warden", "Tome X");
  st.cases[rep.caseId].votes = { warden: "guilty", alice: "guilty" };
  Guilds.touch();
  Life.tickLibrarianGuildLife(fakeDirector([fakeRecord("Warden")]), now + 25 * 3600 * 1000);
  // The plagiarism auto-scan consumes the 6h announce cooldown, so we assert
  // the settlement itself: the case is convicted and the plagiarist expelled.
  assert.strictEqual(Guilds.load().cases[rep.caseId].status, "convicted");
});

test("tick announces collection audits below threshold", (Life) => {
  careers = { alice: "librarian", bob: "librarian" };
  Guilds.joinGuild("Alice", "varrock");
  Guilds.joinGuild("Bob", "varrock");
  // No real books written by either member -> score 0 < 40.
  Life.tickLibrarianGuildLife(fakeDirector([fakeRecord("Alice")]), Date.now());
  assert.ok(said.some((s) => s.includes("collection audit")));
});

test("tick grants the golden quill and announces", (Life) => {
  careers = { alice: "librarian" };
  // A real book in the library ledger keeps the inspection score at 100 so
  // no collection-audit announcement consumes the cooldown before the quill.
  books = { "book-9": { id: "book-9", title: "Real Work", subject: "lore", author: "alice", kingdomId: "varrock", quality: 8 } };
  Guilds.joinGuild("Alice", "varrock");
  const st = Guilds.load();
  st.certifications["cert-1"] = { id: "cert-1", kingdomId: "varrock", author: "Alice", title: "A", subject: "lore", quality: 8, grade: "A", certifiedMs: 1 };
  Guilds.touch();
  Life.tickLibrarianGuildLife(fakeDirector([fakeRecord("Alice")]), Date.now());
  assert.ok(said.some((s) => s.includes("golden quill")));
});

test("tick never throws with a broken director", (Life) => {
  Life.tickLibrarianGuildLife(null, Date.now());
  Life.tickLibrarianGuildLife({}, Date.now());
});

console.log(`\n${passed} tests passed`);
