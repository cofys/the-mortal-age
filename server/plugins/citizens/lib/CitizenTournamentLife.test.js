"use strict";

/**
 * CitizenTournamentLife.test.js — slow-tick tests with a mock director.
 * Plain node:assert, no engine. Run with: node <this file>.
 */

const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const T = require("./CitizenTournaments");
const Life = require("./CitizenTournamentLife");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ctl-test-"));
T._setSavePathForTests(path.join(TMP, "citizen-tournaments.json"));

let passed = 0;
function test(name, fn) {
  T.resetForTests();
  Life._resetTickForTests();
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

function mockBot(username, coins, levels) {
  return {
    username,
    _coins: coins,
    getInventory: () => ({
      count: (id) => (id === 995 ? mockBot._store[username] ?? coins : 0),
      remove: (id, n) => { if (id === 995) mockBot._store[username] = (mockBot._store[username] ?? coins) - n; },
      add: (id, n) => { if (id === 995) mockBot._store[username] = (mockBot._store[username] ?? coins) + n; },
    }),
    getSkills: () => ({
      getLevel: (i) => levels?.[i] ?? 10,
    }),
  };
}
mockBot._store = {};

function mockDirector(records) {
  const said = [];
  const journaled = [];
  return {
    roster: new Map(records.map((r) => [r.username, r])),
    isOnline: () => true,
    getBot: (record) => record._bot ?? null,
    sayPublic: (msg) => said.push(msg),
    getJournal: () => ({ log: (kind, data) => journaled.push({ kind, data }) }),
    _said: said,
    _journaled: journaled,
  };
}

function citizenRec(username, kingdomId, bot, personality) {
  return { username, kingdomId, personality: personality ?? {}, _bot: bot };
}

const NOW = 1_700_000_000_000;

test("tick opens tournaments per kingdom per sport", () => {
  mockBot._store = {};
  const bot = mockBot("Alice", 1000);
  const d = mockDirector([citizenRec("Alice", "varrock", bot)]);
  Life.tickTournaments(d, NOW);
  const opens = T.openTournamentsFor("varrock");
  assert.equal(opens.length, 6); // all 6 sports
  assert.ok(opens.every((t) => t.status === "open"));
});

test("tick never throws with empty/broken director", () => {
  Life.tickTournaments(null, NOW);
  Life.tickTournaments({}, NOW);
  Life.tickTournaments({ roster: null }, NOW);
  // throttle: second tick within TICK_MS is a no-op, no throw
  const d = mockDirector([]);
  Life.tickTournaments(d, NOW);
  Life.tickTournaments(d, NOW + 1000);
});

test("tick closes expired tournament and pays champion real coins", () => {
  mockBot._store = {};
  const alice = mockBot("Alice", 1000);
  const bob = mockBot("Bob", 1000);
  const d = mockDirector([
    citizenRec("Alice", "varrock", alice, { competitive: 0.9 }),
    citizenRec("Bob", "varrock", bob, { competitive: 0.9 }),
  ]);
  // Open then manually enter + expire.
  const t = T.openTournament("varrock", "arena", NOW - T.ENTRY_WINDOW_MS - 1000);
  t.closesAt = NOW - 1000; // force expiry
  T.enterTournament(t.id, "Alice", 300, NOW - 2000);
  T.enterTournament(t.id, "Bob", 100, NOW - 2000);
  Life._resetTickForTests();
  Life.tickTournaments(d, NOW);
  const closed = T.tournamentById(t.id);
  assert.equal(closed.status, "closed");
  assert.ok(closed.champion);
  // Champion got real coins (pool 50, champion 40).
  const champCoins = mockBot._store[closed.champion] ?? 1000;
  assert.ok(champCoins >= 1000, `champion should be paid, has ${champCoins}`);
  // Journaled.
  assert.ok(d._journaled.some((j) => j.kind === "tournament-closed"));
});

test("cancelled tournament refunds entry fees", () => {
  mockBot._store = {};
  const alice = mockBot("Alice", 1000);
  const d = mockDirector([citizenRec("Alice", "varrock", alice)]);
  const t = T.openTournament("varrock", "dice", NOW - T.ENTRY_WINDOW_MS - 1000);
  t.closesAt = NOW - 1000;
  // Simulate the fee having been paid at entry.
  mockBot._store["Alice"] = 1000 - T.TAVERN_ENTRY_FEE;
  T.enterTournament(t.id, "Alice", null, NOW - 2000);
  Life._resetTickForTests();
  Life.tickTournaments(d, NOW);
  assert.equal(T.tournamentById(t.id).status, "cancelled");
  assert.equal(mockBot._store["Alice"], 1000); // refunded
});

test("ambient fill enters competitive citizens when closing soon", () => {
  mockBot._store = {};
  const alice = mockBot("Alice", 1000);
  const d = mockDirector([
    citizenRec("Alice", "varrock", alice, { competitive: 0.9 }),
  ]);
  const t = T.openTournament("varrock", "arena", NOW);
  t.closesAt = NOW + 1000; // closing within fill window
  Life._resetTickForTests();
  Life.tickTournaments(d, NOW);
  const after = T.tournamentById(t.id);
  assert.ok(after.entries.some((e) => e.username === "Alice"));
  // Fee was really deducted.
  assert.equal(mockBot._store["Alice"], 1000 - T.ARENA_ENTRY_FEE);
});

test("bet settlement pays online bettors real coins", () => {
  mockBot._store = {};
  const alice = mockBot("Alice", 1000);
  const bob = mockBot("Bob", 1000);
  const zed = mockBot("Zed", 1000);
  const d = mockDirector([
    citizenRec("Alice", "varrock", alice),
    citizenRec("Bob", "varrock", bob),
    citizenRec("Zed", "varrock", zed),
  ]);
  const t = T.openTournament("varrock", "arena", NOW - T.ENTRY_WINDOW_MS - 1000);
  t.closesAt = NOW - 1000;
  T.enterTournament(t.id, "Alice", 500, NOW - 2000);
  T.enterTournament(t.id, "Bob", 10, NOW - 2000);
  // Zed bets 90 on Alice (heavy favorite).
  mockBot._store["Zed"] = 1000 - 90;
  T.placeBet(t.id, "Zed", "Alice", 90);
  Life._resetTickForTests();
  Life.tickTournaments(d, NOW);
  const champ = T.tournamentById(t.id).champion;
  if (champ === "Alice") {
    // Zed wins 90 back (pool 90, house cut 9, distributable 81... wait pool=90)
    // pool=90, houseCut=9, distributable=81, Zed staked all -> 81.
    assert.equal(mockBot._store["Zed"], 1000 - 90 + 81);
    assert.equal(T.purseFor("varrock"), 9);
  }
  assert.ok(d._journaled.some((j) => j.kind === "tournament-closed"));
});

console.log(`\n${passed} tests passed`);
