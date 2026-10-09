"use strict";

/**
 * CitizenTheater.test.js — data-tier tests for REAL theater production.
 * Plain node, no jest. Run: node server/plugins/citizens/lib/CitizenTheater.test.js
 */

const assert = require("assert");
const path = require("path");
const os = require("os");
const Theater = require("./CitizenTheater");

// Never touch the real save file from tests.
const SAVE_PATH = path.join(os.tmpdir(), `citizen-theater-test-${process.pid}.json`);
Theater._setSavePathForTests(SAVE_PATH);

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    try { require("fs").unlinkSync(SAVE_PATH); } catch { /* fresh */ }
    Theater.resetForTests();
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error(`FAIL: ${name}: ${e.message}`);
  }
}

// --- Mock player with real inventory semantics ---
function mockPlayer(username, coins, papyrus) {
  const inv = {
    coins: coins || 0,
    papyrus: papyrus || 0,
    getAmount(id) {
      if (id === 995) return this.coins;
      if (id === 970) return this.papyrus;
      return 0;
    },
    add(id, n) {
      if (id === 995) this.coins += n;
      if (id === 970) this.papyrus += n;
    },
    remove(id, n) {
      if (id === 995 && this.coins >= n) { this.coins -= n; return true; }
      if (id === 970 && this.papyrus >= n) { this.papyrus -= n; return true; }
      return false;
    },
  };
  return { username, getUsername: () => username, getInventory: () => inv, _inv: inv };
}

// --- theaters ---

test("theaters exist per kingdom with real capacity", () => {
  const t = Theater.ensureTheater("misthalin");
  assert(t && t.name && t.tile, "theater needs name and tile");
  assert(t.capacity >= 60 && t.capacity <= 140, "capacity in range");
  assert.strictEqual(t.condition, 100);
  assert.strictEqual(t.owner, "crown");
  // idempotent
  const t2 = Theater.ensureTheater("misthalin");
  assert.strictEqual(t2, t);
});

test("poor condition honestly caps attendance", () => {
  const t = Theater.ensureTheater("misthalin");
  const full = Theater.effectiveCapacity(t);
  t.condition = 20;
  const capped = Theater.effectiveCapacity(t);
  assert(capped < full, "bad condition caps seats");
  assert(capped > 0, "never zero");
});

test("theaterFor returns null for unknown kingdom", () => {
  assert.strictEqual(Theater.theaterFor("nowhere"), null);
});

// --- playwrights & plays ---

test("writePlay needs registration first", () => {
  const p = mockPlayer("Alice", 100, 5);
  const res = Theater.writePlay(p, "tragedy");
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, "not a playwright");
  assert.strictEqual(p._inv.papyrus, 5, "no papyrus consumed");
});

test("writePlay consumes real papyrus and creates a real play", () => {
  const p = mockPlayer("Alice", 100, 5);
  Theater.registerPlaywright("Alice", "misthalin");
  const res = Theater.writePlay(p, "tragedy");
  assert.strictEqual(res.ok, true);
  assert.strictEqual(p._inv.papyrus, 4, "papyrus consumed");
  assert(res.play.id.startsWith("play-"), "play has id");
  assert(res.play.title.length > 0, "play has title");
  assert.strictEqual(res.play.genre, "tragedy");
  assert(res.play.quality >= 1 && res.play.quality <= 10, "quality in range");
  assert.strictEqual(Theater.playwrightFor("Alice").playsWritten, 1);
});

test("writePlay fails honestly without papyrus", () => {
  const p = mockPlayer("Bob", 100, 0);
  Theater.registerPlaywright("Bob", "misthalin");
  const res = Theater.writePlay(p, "comedy");
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, "need papyrus");
  assert.strictEqual(Theater.describe().plays, 0, "no phantom play");
});

test("writePlay rejects unknown genres", () => {
  const p = mockPlayer("Alice", 100, 5);
  Theater.registerPlaywright("Alice", "misthalin");
  const res = Theater.writePlay(p, "musical");
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, "unknown genre");
  assert.deepStrictEqual(res.genres, Theater.GENRE_KEYS);
});

test("quality grows with real engagement, never random", () => {
  const p = mockPlayer("Alice", 100, 20);
  Theater.registerPlaywright("Alice", "misthalin");
  const q1 = Theater.qualityForPlaywright(Theater.playwrightFor("Alice"));
  for (let i = 0; i < 4; i++) Theater.writePlay(p, "history");
  const q2 = Theater.qualityForPlaywright(Theater.playwrightFor("Alice"));
  assert(q2 > q1, "more plays = higher quality");
  assert.strictEqual(Theater.qualityForPlaywright(Theater.playwrightFor("Alice")), q2, "deterministic");
});

test("play titles come from real data only", () => {
  const p = mockPlayer("Alice", 100, 5);
  Theater.registerPlaywright("Alice", "misthalin");
  const res = Theater.writePlay(p, "epic");
  assert(res.play.title.includes("Alice") || res.play.title.includes("Misthalin"),
    `title references real data: ${res.play.title}`);
});

// --- troupes ---

test("formTroupe creates a named troupe with the founder as member", () => {
  const res = Theater.formTroupe("Alice", "misthalin");
  assert.strictEqual(res.ok, true);
  assert(res.troupe.name.length > 0);
  assert(res.troupe.members.includes("Alice"));
  assert.strictEqual(res.troupe.homeKingdom, "misthalin");
});

test("formTroupe rejects duplicate names", () => {
  Theater.formTroupe("Alice", "misthalin", "The Stars");
  const res = Theater.formTroupe("Bob", "misthalin", "The Stars");
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, "name taken");
});

test("joinTroupe adds members idempotently", () => {
  Theater.formTroupe("Alice", "misthalin", "The Stars");
  Theater.joinTroupe("Bob", "The Stars");
  Theater.joinTroupe("Bob", "The Stars");
  const t = Theater.troupeFor("The Stars");
  assert.strictEqual(t.members.filter((m) => m === "Bob").length, 1);
});

test("addToRepertoire needs a real play", () => {
  Theater.formTroupe("Alice", "misthalin", "The Stars");
  const res = Theater.addToRepertoire("The Stars", "play-999");
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, "no such play");
});

test("tourTo sets real travel with arrival time", () => {
  Theater.formTroupe("Alice", "misthalin", "The Stars");
  const res = Theater.tourTo("The Stars", "asgarnia");
  assert.strictEqual(res.ok, true);
  assert(res.arrivesAt > Date.now(), "travel takes real time");
  const t = Theater.troupeFor("The Stars");
  const loc = Theater.troupeLocation(t);
  assert.strictEqual(loc.traveling, true);
});

// --- performances ---

function setupShow() {
  const writer = mockPlayer("Alice", 100, 5);
  Theater.registerPlaywright("Alice", "misthalin");
  const wp = Theater.writePlay(writer, "tragedy");
  Theater.formTroupe("Bob", "misthalin", "The Stars");
  Theater.joinTroupe("Alice", "The Stars");
  Theater.addToRepertoire("The Stars", wp.play.id);
  return wp.play;
}

test("bookPerformance needs the troupe present with the play in repertoire", () => {
  setupShow();
  const play = Theater.playsBy("Alice")[0];
  const res = Theater.bookPerformance("The Stars", play.id, "misthalin", 30);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.performance.ticketPrice, 30);
  assert(res.performance.startsAt > Date.now(), "booking has lead time");
});

test("bookPerformance fails when the play is not in repertoire", () => {
  const writer = mockPlayer("Alice", 100, 5);
  Theater.registerPlaywright("Alice", "misthalin");
  const wp = Theater.writePlay(writer, "comedy");
  Theater.formTroupe("Bob", "misthalin", "The Stars");
  // note: NOT added to repertoire
  const res = Theater.bookPerformance("The Stars", wp.play.id, "misthalin");
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, "not in repertoire");
});

test("bookPerformance fails when the troupe is away", () => {
  setupShow();
  const play = Theater.playsBy("Alice")[0];
  Theater.tourTo("The Stars", "asgarnia");
  const res = Theater.bookPerformance("The Stars", play.id, "misthalin");
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, "troupe not here");
});

test("buyTicket moves real coins and fails honestly when broke", () => {
  setupShow();
  const play = Theater.playsBy("Alice")[0];
  const book = Theater.bookPerformance("The Stars", play.id, "misthalin", 30);
  const rich = mockPlayer("Rich", 100, 0);
  const broke = mockPlayer("Broke", 10, 0);
  const ok = Theater.buyTicket(rich, book.performance.id);
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(rich._inv.coins, 70, "coins leave the buyer");
  assert.strictEqual(book.performance.ticketsSold, 1);
  const no = Theater.buyTicket(broke, book.performance.id);
  assert.strictEqual(no.ok, false);
  assert.strictEqual(no.reason, "can't afford it");
  assert.strictEqual(broke._inv.coins, 10, "broke buyer untouched");
});

test("buyTicket respects the sold-out cap", () => {
  setupShow();
  const play = Theater.playsBy("Alice")[0];
  const book = Theater.bookPerformance("The Stars", play.id, "misthalin", 5);
  const theater = Theater.theaterFor("misthalin");
  theater.condition = 20; // shrink capacity
  const seats = Theater.effectiveCapacity(theater);
  for (let i = 0; i < seats; i++) {
    const p = mockPlayer(`Fan${i}`, 100, 0);
    const r = Theater.buyTicket(p, book.performance.id);
    assert.strictEqual(r.ok, true);
  }
  const extra = mockPlayer("Late", 100, 0);
  const r = Theater.buyTicket(extra, book.performance.id);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "sold out");
  assert.strictEqual(extra._inv.coins, 100, "no coins taken when sold out");
});

test("settlePerformance splits revenue 60/25/15 with real coin effects", () => {
  setupShow();
  const play = Theater.playsBy("Alice")[0];
  const book = Theater.bookPerformance("The Stars", play.id, "misthalin", 100);
  const buyer = mockPlayer("Fan", 500, 0);
  Theater.buyTicket(buyer, book.performance.id);
  Theater.buyTicket(buyer, book.performance.id);
  // force the show to be over
  book.performance.endsAt = Date.now() - 1;
  const res = Theater.settlePerformance(book.performance.id);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.split.troupeShare + res.split.venueShare + res.split.royaltyShare, 200);
  assert.strictEqual(res.split.troupeShare, 120, "60% troupe");
  assert.strictEqual(res.split.venueShare, 50, "25% venue");
  assert.strictEqual(res.split.royaltyShare, 30, "15% royalty");
  const troupe = Theater.troupeFor("The Stars");
  // Alice is playwright AND troupe member: troupe gets 120 + 30 royalty
  assert.strictEqual(troupe.treasury, 150, `treasury got troupe share + royalty (got ${troupe.treasury})`);
  assert(res.review.stars >= 1 && res.review.stars <= 5, "review has stars");
  assert(res.review.verdict.length > 0, "review has verdict");
});

test("settlePerformance is idempotent", () => {
  setupShow();
  const play = Theater.playsBy("Alice")[0];
  const book = Theater.bookPerformance("The Stars", play.id, "misthalin", 100);
  book.performance.endsAt = Date.now() - 1;
  Theater.settlePerformance(book.performance.id);
  const again = Theater.settlePerformance(book.performance.id);
  assert.strictEqual(again.ok, false);
  assert.strictEqual(again.reason, "already settled");
});

test("reviews are deterministic", () => {
  setupShow();
  const play = Theater.playsBy("Alice")[0];
  const book = Theater.bookPerformance("The Stars", play.id, "misthalin", 100);
  book.performance.endsAt = Date.now() - 1;
  const a = Theater.settlePerformance(book.performance.id);
  assert.strictEqual(a.review.stars, a.review.stars); // sanity
  // same inputs re-settled in a fresh state give the same stars
  const starsA = a.review.stars;
  Theater.resetForTests();
  setupShow();
  const play2 = Theater.playsBy("Alice")[0];
  const book2 = Theater.bookPerformance("The Stars", play2.id, "misthalin", 100);
  book2.performance.endsAt = Date.now() - 1;
  const b = Theater.settlePerformance(book2.performance.id);
  assert.strictEqual(b.review.stars, starsA, "deterministic reviews");
});

// --- culture seam ---

test("prideDeltaFor rewards home history/epic triumphs", () => {
  const writer = mockPlayer("Alice", 100, 20);
  Theater.registerPlaywright("Alice", "misthalin");
  // a master playwright: 8 plays written...
  for (let i = 0; i < 8; i++) Theater.writePlay(writer, "history");
  Theater.formTroupe("Bob", "misthalin", "The Stars");
  Theater.joinTroupe("Alice", "The Stars");
  const plays = Theater.playsBy("Alice");
  const best = plays[plays.length - 1];
  Theater.addToRepertoire("The Stars", best.id);
  // ...with 9 acclaimed performances behind her (quality hits 10)
  for (let i = 0; i < 9; i++) {
    const b = Theater.bookPerformance("The Stars", best.id, "misthalin", 5);
    assert(b.ok, `booking ${i} should succeed`);
    b.performance.endsAt = Date.now() - 1;
    Theater.settlePerformance(b.performance.id);
  }
  assert.strictEqual(Theater.qualityForPlaywright(Theater.playwrightFor("Alice")), 10);
  // now the triumph: full house for the masterpiece
  const book = Theater.bookPerformance("The Stars", best.id, "misthalin", 5);
  const theater = Theater.theaterFor("misthalin");
  const seats = Theater.effectiveCapacity(theater);
  for (let i = 0; i < seats; i++) {
    Theater.buyTicket(mockPlayer(`F${i}`, 100, 0), book.performance.id);
  }
  book.performance.endsAt = Date.now() - 1;
  const res = Theater.settlePerformance(book.performance.id);
  assert(res.review.stars >= 4, `expected a triumph, got ${res.review.stars}`);
  const delta = Theater.prideDeltaFor("misthalin");
  assert(delta.pride >= 1, "home epic/history triumph raises pride");
});

// --- fame ---

test("fameDeedsFor awards laureate at 5 plays", () => {
  const p = mockPlayer("Alice", 100, 10);
  Theater.registerPlaywright("Alice", "misthalin");
  assert.deepStrictEqual(Theater.fameDeedsFor("Alice"), []);
  for (let i = 0; i < 5; i++) Theater.writePlay(p, "comedy");
  assert(Theater.fameDeedsFor("Alice").includes(Theater.DEED_PLAYWRIGHT_LAUREATE));
});

// --- upkeep ---

test("payUpkeep takes real coins and restores condition", () => {
  const t = Theater.ensureTheater("misthalin");
  t.condition = 50;
  const payer = mockPlayer("Owner", 500, 0);
  const res = Theater.payUpkeep("misthalin", payer);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(payer._inv.coins, 500 - Theater.THEATER_UPKEEP_WEEKLY);
  assert(res.theater.condition > 50);
});

test("payUpkeep fails honestly when broke", () => {
  Theater.ensureTheater("misthalin");
  const payer = mockPlayer("Owner", 10, 0);
  const res = Theater.payUpkeep("misthalin", payer);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(payer._inv.coins, 10);
});

test("decayTheater drops condition without coin movement", () => {
  const t = Theater.ensureTheater("misthalin");
  const before = t.condition;
  Theater.decayTheater("misthalin");
  assert(Theater.theaterFor("misthalin").condition < before);
});

test("renovate costs real coins per point", () => {
  const t = Theater.ensureTheater("misthalin");
  t.condition = 40;
  const payer = mockPlayer("Owner", 1000, 0);
  const res = Theater.renovate("misthalin", payer, 10);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.cost, 150);
  assert.strictEqual(payer._inv.coins, 850);
  assert.strictEqual(Theater.theaterFor("misthalin").condition, 50);
});

// --- persistence ---

test("save round-trips state", () => {
  const p = mockPlayer("Alice", 100, 5);
  Theater.registerPlaywright("Alice", "misthalin");
  Theater.writePlay(p, "tragedy");
  Theater.formTroupe("Bob", "misthalin", "The Stars");
  assert.strictEqual(Theater.save(), true);
  const before = Theater.describe();
  // simulate a fresh load by clearing the module cache entry state
  Theater.resetForTests();
  // NOTE: resetForTests clears memory; save file persists. Re-require not
  // needed — load() re-reads from disk on next access after cache=null.
  const after = Theater.describe();
  assert.strictEqual(after.plays, before.plays, "plays persist");
  assert.strictEqual(after.troupes, before.troupes, "troupes persist");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
