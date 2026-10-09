"use strict";

/**
 * CitizenGalleriesLife.test.js — slow-tick tests for gallery operations.
 * Plain node, no jest. Run: node server/plugins/citizens/lib/CitizenGalleriesLife.test.js
 *
 * The Life tick's engine reads (roster, CitizenSites, CitizenSayPublic) are
 * stubbed in the require cache. The global citizen journal is stubbed with a
 * fresh in-memory instance (never touches data/saves). CitizenArt is real
 * (temp save path).
 */

const assert = require("assert");
const path = require("path");
const os = require("os");
const fs = require("fs");

// --- stubs (must be installed before requiring the Life module) ---

const sitesPath = path.resolve(__dirname, "../brain/CitizenSites.js");
require.cache[sitesPath] = {
  id: sitesPath, filename: sitesPath, loaded: true,
  exports: {
    KINGDOM_IDS: ["misthalin", "asgarnia"],
    kingdomIdOf: (record) => record?.kingdomId ?? null,
    siteTile: () => ({ x: 3200, y: 3200, z: 0 }),
  },
};

const sayPublicPath = path.resolve(__dirname, "../chat/CitizenSayPublic.js");
const saidPublic = [];
require.cache[sayPublicPath] = {
  id: sayPublicPath, filename: sayPublicPath, loaded: true,
  exports: {
    sayPublic: (player, text) => { saidPublic.push(text); },
  },
};

const perceptionPath = path.resolve(__dirname, "../brain/CitizenPerception.js");
require.cache[perceptionPath] = {
  id: perceptionPath, filename: perceptionPath, loaded: true,
  exports: { getLocalPlayers: () => [] },
};

// The gallery tick journals to the GLOBAL citizen journal (canonical path:
// getJournal().log(name, "galleries", text, { data })), not to the director.
// Stub it with a fresh in-memory instance — never touches data/saves.
const journalPath = path.resolve(__dirname, "./CitizenJournal.js");
const RealJournalModule = require(journalPath); // real class, loaded pre-stub
const stubJournal = new RealJournalModule.CitizenJournal();
stubJournal.resetForTests(); // in-memory only, _savePath = null
const journalStubExports = {
  CitizenJournal: RealJournalModule.CitizenJournal,
  getJournal: () => stubJournal,
  initCitizenJournal: () => stubJournal,
  MAX_EVENTS_PER_CITIZEN: RealJournalModule.MAX_EVENTS_PER_CITIZEN,
};
require.cache[journalPath] = {
  id: journalPath, filename: journalPath, loaded: true,
  exports: journalStubExports,
};

const Art = require("./CitizenArt");
const Galleries = require("./CitizenGalleries");
const Life = require("./CitizenGalleriesLife");

const SAVE_PATH = path.join(os.tmpdir(), `citizen-galleries-life-test-${process.pid}.json`);
const ART_SAVE_PATH = path.join(os.tmpdir(), `citizen-art-life-test-${process.pid}.json`);
Galleries._setSavePathForTests(SAVE_PATH);
Art._setSavePathForTests(ART_SAVE_PATH);

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    for (const p of [SAVE_PATH, ART_SAVE_PATH]) {
      try { fs.unlinkSync(p); } catch { /* fresh */ }
    }
    Galleries.resetForTests();
    Art.resetForTests();
    Life.resetForTests();
    stubJournal.resetForTests();
    saidPublic.length = 0;
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error(`FAIL: ${name}: ${e.message}\n${e.stack}`);
  }
}

function mockRecord(username, kingdomId, career, personality) {
  return {
    username,
    kingdomId,
    getUsername() { return username; },
    getAttribute(key) {
      if (key === "citizens:personality") return personality ?? {};
      if (key === "citizens:career") return career ?? null;
      return null;
    },
    isOnline() { return true; },
  };
}

function mockDirector(records) {
  const roster = new Map();
  for (const r of records) roster.set(r.username.toLowerCase(), r);
  return {
    roster,
    isOnline: (r) => true,
    getBot: (r) => null,
    journalCalls: [],
    journal(topic, text, data) { this.journalCalls.push([topic, text, data]); },
  };
}

function mockPlayer(username, coins) {
  const inv = {
    coins: coins || 0,
    getAmount(id) { return id === 995 ? this.coins : 0; },
    // Canonical ItemContainer API: adds(id, amount), deleteNumber(id, amount).
    // There is no inv.add / inv.remove.
    adds(id, n) { if (id === 995) this.coins += n; },
    deleteNumber(id, n) {
      if (id === 995) this.coins = Math.max(0, this.coins - n);
    },
    // Legacy path: CitizenGalleries.js (a different module, separate worker's
    // dead-API scope) still reads inv.count / inv.delete. Kept so auction
    // consignment tests keep working until that module is canonicalized.
    count(id) { return id === 995 ? this.coins : 0; },
    delete(id, n) { if (id === 995) this.coins = Math.max(0, this.coins - n); },
  };
  return {
    username,
    getUsername() { return username; },
    getInventory() { return inv; },
    __inv: inv,
  };
}

test("tick never throws with an empty director", () => {
  Life.tickGalleriesLife({}, Date.now());
  Life.tickGalleriesLife(null, Date.now());
  Life.tickGalleriesLife({ roster: new Map() }, Date.now());
});

test("registers curators by career", () => {
  const director = mockDirector([
    mockRecord("CuratorBob", "misthalin", "curator", {}),
    mockRecord("RandomJoe", "misthalin", "miner", {}),
  ]);
  Life.tickGalleriesLife(director, Date.now());
  assert.ok(Galleries.isCurator("curatorbob"));
  assert.ok(!Galleries.isCurator("randomjoe"));
});

test("registers cultured+organized citizens as curators", () => {
  const director = mockDirector([
    mockRecord("Cultured", "misthalin", null, { culture: 0.8, organization: 0.7 }),
  ]);
  Life.tickGalleriesLife(director, Date.now());
  assert.ok(Galleries.isCurator("cultured"));
});

test("closes ripe auctions and journals the result", () => {
  const t0 = 1791530000000;
  const seller = mockPlayer("Seller", 100);
  const art = Art.createArtwork("Seller", "painting", 50, 0.7, "misthalin");
  const auc = Galleries.consignAuction(art.id, seller, 10, t0).auction;
  const alice = mockPlayer("Alice", 500);
  Galleries.placeBid(auc.id, alice, 100, () => true, t0 + 1000);

  const director = mockDirector([]);
  // Fast-forward past the 3-day auction.
  Life.tickGalleriesLife(director, t0 + 4 * 24 * 3600 * 1000);
  const closed = Galleries.openAuctions("misthalin");
  assert.strictEqual(closed.length, 0);
  // The tick journals to the global citizen journal (canonical path), not the
  // director — the director mock's journalCalls can never see it.
  const sellerEvents = journalStubExports.getJournal().recent("Seller");
  assert.ok(sellerEvents.some((e) => e.kind === "galleries"));
});

test("accrues stipends into gallery budgets", () => {
  const director = mockDirector([]);
  const t0 = 1791530000000;
  Life.tickGalleriesLife(director, t0);
  assert.strictEqual(Galleries.galleryOpsFor("misthalin").budget, 200);
});

test("advances tours along their route", () => {
  const t0 = 1791530000000;
  Galleries.registerCurator("Curator", "misthalin", t0);
  const art = Art.createArtwork("Artist", "painting", 50, 0.7, "misthalin");
  const ops = Galleries.galleryOpsFor("misthalin", t0);
  ops.collection.push(art.id);
  Galleries.markDirty();
  Galleries.sendTour("Curator", ["asgarnia"], t0);

  const director = mockDirector([]);
  // Tours advance every 30 min of tick time; jump past arrival.
  Life.tickGalleriesLife(director, t0 + 3 * 24 * 3600 * 1000);
  const s = Galleries.stats("misthalin");
  assert.strictEqual(s.activeTours, 1); // showing at asgarnia
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
