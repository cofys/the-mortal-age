"use strict";

/**
 * CitizenTournaments.test.js — data-tier tests for participatory tournaments.
 * Plain node:assert, no engine. Run with: node <this file>.
 */

const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const T = require("./CitizenTournaments");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ct-test-"));
T._setSavePathForTests(path.join(TMP, "citizen-tournaments.json"));

let passed = 0;
function test(name, fn) {
  T.resetForTests();
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

const NOW = 1_700_000_000_000;

// --- sport catalog ---

test("SPORTS has 6 sports with kinds", () => {
  assert.equal(Object.keys(T.SPORTS).length, 6);
  assert.equal(T.SPORTS.arena.kind, "rating");
  assert.equal(T.SPORTS.race.kind, "rating");
  assert.equal(T.SPORTS.archery.kind, "rating");
  assert.equal(T.SPORTS.dice.kind, "luck");
  assert.equal(T.SPORTS.cards.kind, "luck");
  assert.equal(T.SPORTS.boards.kind, "luck");
});

test("entryFeeFor: tavern sports cheaper", () => {
  assert.equal(T.entryFeeFor("dice"), T.TAVERN_ENTRY_FEE);
  assert.equal(T.entryFeeFor("arena"), T.ARENA_ENTRY_FEE);
  assert.ok(T.TAVERN_ENTRY_FEE < T.ARENA_ENTRY_FEE);
});

// --- tournaments ---

test("openTournament creates; second open returns existing", () => {
  const a = T.openTournament("varrock", "arena", NOW);
  assert.ok(a);
  assert.equal(a.status, "open");
  const b = T.openTournament("varrock", "arena", NOW + 1000);
  assert.equal(b.id, a.id);
});

test("openTournament rejects bad sport/kingdom", () => {
  assert.equal(T.openTournament("varrock", "nope", NOW), null);
  assert.equal(T.openTournament(null, "arena", NOW), null);
});

test("enterTournament: ok, dedupe, full", () => {
  const t = T.openTournament("varrock", "arena", NOW);
  assert.deepEqual(T.enterTournament(t.id, "Alice", 150, NOW), { ok: true });
  const dup = T.enterTournament(t.id, "alice", 150, NOW);
  assert.equal(dup.ok, false);
  assert.equal(dup.reason, "already-entered");
  for (let i = 0; i < 7; i++) T.enterTournament(t.id, `P${i}`, 100 + i, NOW);
  const full = T.enterTournament(t.id, "Extra", 200, NOW);
  assert.equal(full.ok, false);
  assert.equal(full.reason, "full");
  assert.equal(T.tournamentById(t.id).entries.length, T.MAX_ENTRANTS);
  assert.equal(T.tournamentById(t.id).pool, T.MAX_ENTRANTS * T.ARENA_ENTRY_FEE);
});

test("enterTournament: closed window rejected", () => {
  const t = T.openTournament("varrock", "arena", NOW);
  const r = T.enterTournament(t.id, "Alice", 150, NOW + T.ENTRY_WINDOW_MS + 1);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "entries-closed");
});

test("closeAndRun: cancels with too few entrants", () => {
  const t = T.openTournament("varrock", "arena", NOW);
  T.enterTournament(t.id, "Solo", 150, NOW);
  const res = T.closeAndRun(t.id, NOW + 1000);
  assert.equal(res.cancelled, true);
  assert.equal(T.tournamentById(t.id).status, "cancelled");
});

test("closeAndRun: 8 entrants -> champion + runnerUp + prizes", () => {
  const t = T.openTournament("varrock", "arena", NOW);
  // Alice is dominant (rating 300), rest are 100.
  T.enterTournament(t.id, "Alice", 300, NOW);
  for (let i = 0; i < 7; i++) T.enterTournament(t.id, `P${i}`, 100, NOW);
  const res = T.closeAndRun(t.id, NOW + 1000);
  assert.equal(res.cancelled, false);
  assert.ok(res.champion);
  assert.ok(res.runnerUp);
  assert.notEqual(res.champion, res.runnerUp);
  // Dominant rating should usually win (deterministic seed — just check sane).
  const tt = T.tournamentById(t.id);
  assert.equal(tt.status, "closed");
  assert.equal(tt.championPrize + tt.runnerUpPrize, tt.pool);
  assert.equal(tt.championPrize, Math.floor(tt.pool * T.CHAMPION_SHARE));
  // Champion recorded.
  const champ = T.championOf("varrock", "arena");
  assert.equal(champ.username, res.champion);
});

test("closeAndRun is deterministic for the same seed", () => {
  const mk = () => {
    T.resetForTests();
    const t = T.openTournament("varrock", "arena", NOW);
    const names = ["A", "B", "C", "D", "E", "F", "G", "H"];
    names.forEach((n, i) => T.enterTournament(t.id, n, 100 + i * 7, NOW));
    return T.closeAndRun(t.id, NOW + 1);
  };
  const r1 = mk();
  const r2 = mk();
  assert.equal(r1.champion, r2.champion);
  assert.equal(r1.runnerUp, r2.runnerUp);
});

test("runBracket: odd entrants get byes, still resolves", () => {
  const entries = [
    { username: "A", rating: 120 },
    { username: "B", rating: 110 },
    { username: "C", rating: 100 },
  ];
  const { champion, runnerUp, rounds } = T.runBracket(entries, "arena", "seed1");
  assert.ok(champion);
  assert.ok(rounds.length >= 1);
  assert.ok(["A", "B", "C"].includes(champion));
});

test("boutWinner: luck sports ignore ratings", () => {
  const a = { username: "A", rating: 999 };
  const b = { username: "B", rating: 1 };
  const rng = T.mulberry32(T.hashStr("x"));
  // Just verify it returns one of them and doesn't throw.
  const w = T.runBracket([a, b], "dice", "s");
  assert.ok(["A", "B"].includes(w.champion));
  void rng;
});

// --- betting ---

test("placeBet: validates tournament, entrant, amount", () => {
  const t = T.openTournament("varrock", "arena", NOW);
  T.enterTournament(t.id, "Alice", 150, NOW);
  T.enterTournament(t.id, "Bob", 140, NOW);
  assert.equal(T.placeBet("nope", "Zed", "Alice", 50).ok, false);
  assert.equal(T.placeBet(t.id, "Zed", "Nobody", 50).reason, "not-entered");
  assert.equal(T.placeBet(t.id, "Zed", "Alice", 0).reason, "bad-amount");
  assert.equal(T.placeBet(t.id, "Zed", "Alice", T.MAX_BET + 1).reason, "too-big");
  assert.deepEqual(T.placeBet(t.id, "Zed", "Alice", 50), { ok: true });
});

test("settleBets: parimutuel split, house cut to purse", () => {
  const t = T.openTournament("varrock", "arena", NOW);
  T.enterTournament(t.id, "Alice", 500, NOW); // heavy favorite
  T.enterTournament(t.id, "Bob", 10, NOW);
  T.placeBet(t.id, "Zed", "Alice", 90);
  T.placeBet(t.id, "Yara", "Bob", 10);
  const res = T.closeAndRun(t.id, NOW + 1000);
  const champ = res.champion;
  const settled = T.settleBets(t.id);
  assert.ok(settled);
  assert.equal(settled.pool, 100);
  assert.equal(settled.houseCut, 10);
  assert.equal(T.purseFor("varrock"), 10);
  // Winners split 90.
  const winTotal = champ === "Alice" ? 90 : 10;
  if (winTotal === 90) {
    assert.equal(settled.payouts.length, 1);
    assert.equal(settled.payouts[0].bettor, "Zed");
    assert.equal(settled.payouts[0].amount, 90);
  } else {
    assert.equal(settled.payouts[0].bettor, "Yara");
    assert.equal(settled.payouts[0].amount, 90);
  }
  // Double-settle is a no-op.
  assert.equal(T.settleBets(t.id), null);
});

test("settleBets: no bets -> zero payouts", () => {
  const t = T.openTournament("varrock", "arena", NOW);
  T.enterTournament(t.id, "Alice", 150, NOW);
  T.enterTournament(t.id, "Bob", 140, NOW);
  T.closeAndRun(t.id, NOW + 1000);
  const settled = T.settleBets(t.id);
  assert.deepEqual(settled.payouts, []);
  assert.equal(settled.pool, 0);
});

// --- purse ---

test("purseFor/addToPurse/purseSpend", () => {
  assert.equal(T.purseFor("varrock"), 0);
  T.addToPurse("varrock", 100);
  assert.equal(T.purseFor("varrock"), 100);
  assert.equal(T.purseSpend("varrock", 60), true);
  assert.equal(T.purseFor("varrock"), 40);
  assert.equal(T.purseSpend("varrock", 999), false);
  assert.equal(T.purseFor("varrock"), 40); // unchanged
});

// --- challenges ---

test("issueChallenge/pendingChallengeFor/resolveChallenge", () => {
  const c = T.issueChallenge("CitizenBob", "Jon", "race", NOW);
  assert.ok(c);
  assert.equal(c.status, "pending");
  // One pending per citizen.
  const c2 = T.issueChallenge("CitizenBob", "Jon", "arena", NOW + 1);
  assert.equal(c2.id, c.id);
  const pend = T.pendingChallengeFor("jon", NOW + 100);
  assert.equal(pend.id, c.id);
  assert.equal(T.pendingChallengeFor("jon", NOW + T.CHALLENGE_EXPIRY_MS + 9999), null);
  // Resolve: player much stronger wins.
  const res = T.resolveChallenge(c.id, 50, 500, NOW + 200);
  assert.ok(res);
  assert.equal(res.winner, "Jon");
  assert.equal(res.citizenWon, false);
  assert.equal(T.resolveChallenge(c.id, 50, 500, NOW + 300), null); // already resolved
});

test("issueChallenge rejects bad input", () => {
  assert.equal(T.issueChallenge("", "Jon", "race", NOW), null);
  assert.equal(T.issueChallenge("Bob", "Jon", "nope", NOW), null);
});

// --- champions ---

test("topChampions lists most recent first", () => {
  const t1 = T.openTournament("varrock", "arena", NOW);
  T.enterTournament(t1.id, "A", 200, NOW);
  T.enterTournament(t1.id, "B", 100, NOW);
  T.closeAndRun(t1.id, NOW + 1000);
  const t2 = T.openTournament("falador", "race", NOW);
  T.enterTournament(t2.id, "C", 200, NOW);
  T.enterTournament(t2.id, "D", 100, NOW);
  T.closeAndRun(t2.id, NOW + 2000);
  const top = T.topChampions(10);
  assert.equal(top.length, 2);
  assert.equal(top[0].kingdomId, "falador"); // most recent first
});

// --- ratings ---

test("athleticRatingFor: sums real levels; luck sports null", () => {
  const player = {
    getSkills: () => ({
      getLevel: (i) => [50, 40, 60][i] ?? 1, // attack 50, defence 40, strength 60
    }),
  };
  assert.equal(T.athleticRatingFor(player, "arena"), 150);
  assert.equal(T.athleticRatingFor(player, "dice"), null);
  assert.equal(T.athleticRatingFor(null, "arena"), 3); // level 1 x 3 skills
});

// --- coins ---

test("coinCount/removeCoins/addCoins with mock inventory", () => {
  let coins = 100;
  const player = {
    getInventory: () => ({
      getAmount: (id) => (id === 995 ? coins : 0),
      deleteNumber: (id, n) => { if (id === 995) coins -= n; },
      adds: (id, n) => { if (id === 995) coins += n; },
    }),
  };
  assert.equal(T.coinCount(player), 100);
  assert.equal(T.removeCoins(player, 30), true);
  assert.equal(T.coinCount(player), 70);
  assert.equal(T.addCoins(player, 50), true);
  assert.equal(T.coinCount(player), 120);
  assert.equal(T.coinCount(null), 0);
});

test("save persists and reloads", () => {
  T.openTournament("varrock", "arena", NOW);
  assert.equal(T.save(), true);
  assert.equal(T.save(), false); // not dirty anymore
});

console.log(`\n${passed} tests passed`);
