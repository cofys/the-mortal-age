"use strict";

/**
 * CitizenTheaterLife.test.js — slow tick contracts without a running server.
 * Plain node, no jest. Run: node server/plugins/citizens/lib/CitizenTheaterLife.test.js
 */

const assert = require("assert");
const path = require("path");
const os = require("os");
const Theater = require("./CitizenTheater");
const Life = require("./CitizenTheaterLife");

Theater._setSavePathForTests(path.join(os.tmpdir(), `citizen-theaterlife-test-${process.pid}.json`));
const SAVE_PATH = path.join(os.tmpdir(), `citizen-theaterlife-test-${process.pid}.json`);

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    try { require("fs").unlinkSync(SAVE_PATH); } catch { /* fresh */ }
    Theater.resetForTests();
    Life.resetForTests();
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error(`FAIL: ${name}: ${e.message}\n${e.stack}`);
  }
}

function stubCitizen(username, opts) {
  const o = opts || {};
  const inv = {
    coins: o.coins ?? 0,
    papyrus: o.papyrus ?? 0,
    getAmount(id) {
      if (id === 995) return this.coins;
      if (id === 970) return this.papyrus;
      return 0;
    },
    remove(id, n) {
      if (id === 995 && this.coins >= n) { this.coins -= n; return true; }
      if (id === 970 && this.papyrus >= n) { this.papyrus -= n; return true; }
      return false;
    },
  };
  return {
    username,
    getUsername: () => username,
    kingdomId: o.kingdomId || "misthalin",
    career: o.career || null,
    personality: o.personality || {},
    getAttribute: (k) => {
      if (k === "citizens:personality") return o.personality || {};
      if (k === "citizens:career") return o.career || null;
      return undefined;
    },
    getInventory: () => inv,
    getLocalPlayers: () => [],
    isOnline: () => true,
    _inv: inv,
  };
}

test("tick never throws on garbage input", () => {
  Life.tickTheaterLife(null, Date.now());
  Life.tickTheaterLife({ roster: [] }, Date.now());
  Life.tickTheaterLife({ roster: [null, {}, { username: null }] }, Date.now());
});

test("tick registers playwright-career citizens", () => {
  const c = stubCitizen("Alice", { career: "playwright", kingdomId: "misthalin" });
  Life.tickTheaterLife({ roster: [c] }, Date.now());
  assert(Theater.isPlaywright("Alice"), "playwright career registered");
});

test("tick registers creative citizens", () => {
  const c = stubCitizen("Bob", {
    kingdomId: "misthalin",
    personality: { creativity: 0.8 },
  });
  Life.tickTheaterLife({ roster: [c] }, Date.now());
  assert(Theater.isPlaywright("Bob"), "creative citizen registered");
});

test("tick does not register dull citizens", () => {
  const c = stubCitizen("Carol", {
    kingdomId: "misthalin",
    personality: { creativity: 0.1 },
  });
  Life.tickTheaterLife({ roster: [c] }, Date.now());
  assert(!Theater.isPlaywright("Carol"), "dull citizen not registered");
});

test("tick drafts plays for playwrights with papyrus", () => {
  const c = stubCitizen("Alice", { career: "playwright", kingdomId: "misthalin", papyrus: 3 });
  Life.tickTheaterLife({ roster: [c] }, Date.now());
  const plays = Theater.playsBy("Alice");
  assert(plays.length >= 1, "ambient draft happened");
  assert(c._inv.papyrus < 3, "papyrus was consumed");
});

test("tick forms troupes when enough performers gather", () => {
  const citizens = [];
  for (let i = 0; i < 5; i++) {
    citizens.push(stubCitizen(`Performer${i}`, {
      kingdomId: "asgarnia",
      personality: { expressiveness: 0.9 },
    }));
  }
  Life.tickTheaterLife({ roster: citizens }, Date.now());
  const troupes = Theater.troupesIn("asgarnia");
  assert(troupes.length >= 1, "a troupe formed");
  assert(troupes[0].members.length >= 3, "troupe has members");
});

test("tick settles finished performances", () => {
  // use the real kingdom derivation so the tick finds our performance
  const { kingdomIdOf } = require("../brain/CitizenSites");
  const realKingdom = kingdomIdOf({ username: "Settler" }) || "misthalin";
  // set up a booked show directly
  const writer = stubCitizen("Alice", { career: "playwright", kingdomId: realKingdom, papyrus: 5, coins: 0 });
  // give the writer a real inventory via the data-tier mock shape
  const inv = writer.getInventory();
  const playerLike = { getUsername: () => "Alice", username: "Alice", getInventory: () => inv };
  Theater.registerPlaywright("Alice", realKingdom);
  const wp = Theater.writePlay(playerLike, "comedy");
  assert(wp.ok, "play written");
  Theater.formTroupe("Bob", realKingdom, "Kingdom Players");
  Theater.addToRepertoire("Kingdom Players", wp.play.id);
  const book = Theater.bookPerformance("Kingdom Players", wp.play.id, realKingdom, 10);
  assert(book.ok, "show booked");
  book.performance.endsAt = Date.now() - 1;
  const before = Theater.describe().reviews;
  Life.tickTheaterLife({ roster: [writer] }, Date.now());
  const after = Theater.describe().reviews;
  assert(after > before, "finished show settled with a review");
  assert(Theater.performanceFor(book.performance.id).settled, "performance marked settled");
});

test("tick degrades gracefully with no roster", () => {
  Life.tickTheaterLife({ roster: [] }, Date.now());
  assert.strictEqual(Theater.describe().theaters, 0, "no theaters without citizens");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
