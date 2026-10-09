"use strict";

/**
 * CitizenGalleries.test.js — data-tier tests for REAL gallery operations.
 * Plain node, no jest. Run: node server/plugins/citizens/lib/CitizenGalleries.test.js
 *
 * Uses the REAL CitizenArt (temp save path) for artwork records — this is an
 * integration test of the gallery operations layer against the art data tier.
 */

const assert = require("assert");
const path = require("path");
const os = require("os");
const fs = require("fs");

const Art = require("./CitizenArt");
const Banking = require("./CitizenBanking");
const Galleries = require("./CitizenGalleries");

// Never touch real save files from tests.
const SAVE_PATH = path.join(os.tmpdir(), `citizen-galleries-test-${process.pid}.json`);
const ART_SAVE_PATH = path.join(os.tmpdir(), `citizen-art-test-${process.pid}.json`);
Galleries._setSavePathForTests(SAVE_PATH);
Art._setSavePathForTests(ART_SAVE_PATH);
// Note: CitizenBanking has no save-path seam, but this test never triggers a
// bank write — payee callbacks always succeed, so creditBank is never reached.

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    for (const p of [SAVE_PATH, ART_SAVE_PATH]) {
      try { fs.unlinkSync(p); } catch { /* fresh */ }
    }
    Galleries.resetForTests();
    Art.resetForTests();
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error(`FAIL: ${name}: ${e.message}\n${e.stack}`);
  }
}

// --- Mock player with real inventory semantics ---
function mockPlayer(username, coins) {
  const inv = {
    coins: coins || 0,
    getAmount(id) { return id === 995 ? this.coins : 0; },
    count(id) { return id === 995 ? this.coins : 0; },
    add(id, n) { if (id === 995) this.coins += n; },
    remove(id, n) {
      if (id === 995 && this.coins >= n) { this.coins -= n; return true; }
      return false;
    },
  };
  return {
    username,
    getUsername() { return username; },
    isRealPlayer() { return true; },
    getInventory() { return inv; },
    __inv: inv,
  };
}

function makeArtwork(artist, owner, price) {
  const art = Art.createArtwork(artist, "painting", 50, 0.7, "misthalin");
  assert.ok(art, "artwork created");
  if (price) Art.listForSale(art.id, price);
  // Ensure owner matches (createArtwork sets artist as owner).
  if (owner && owner !== artist) Art.transferOwnership(art.id, owner);
  return Art.artworkById(art.id);
}

// --- curator registry ---

test("registerCurator is idempotent", () => {
  const a = Galleries.registerCurator("CuratorOne", "misthalin");
  const b = Galleries.registerCurator("curatorone", "misthalin");
  assert.ok(a);
  assert.strictEqual(a.username, b.username);
  assert.ok(Galleries.isCurator("CURATORONE"));
  assert.strictEqual(Galleries.curatorsIn("misthalin").length, 1);
});

test("curatorInfo returns null for non-curators", () => {
  assert.strictEqual(Galleries.curatorInfo("Nobody"), null);
  assert.strictEqual(Galleries.isCurator("Nobody"), false);
});

// --- gallery ops / prestige ---

test("galleryOpsFor creates with default prestige", () => {
  const ops = Galleries.galleryOpsFor("misthalin");
  assert.strictEqual(ops.prestige, 10);
  assert.strictEqual(ops.budget, 0);
  assert.strictEqual(Galleries.prestigeFor("misthalin"), 10);
});

test("addPrestige clamps 0-100", () => {
  Galleries.addPrestige("misthalin", 200);
  assert.strictEqual(Galleries.prestigeFor("misthalin"), 100);
  Galleries.addPrestige("misthalin", -500);
  assert.strictEqual(Galleries.prestigeFor("misthalin"), 0);
});

test("prestigeFor degrades gracefully for unknown kingdom", () => {
  assert.strictEqual(Galleries.prestigeFor("nope"), 10);
});

test("accrueStipend pays weekly and throttles", () => {
  const t0 = 1791530000000; // realistic ms timestamp
  const first = Galleries.accrueStipend("misthalin", t0);
  assert.strictEqual(first, 200);
  const second = Galleries.accrueStipend("misthalin", t0 + 1000);
  assert.strictEqual(second, 0);
  const third = Galleries.accrueStipend("misthalin", t0 + 8 * 24 * 3600 * 1000);
  assert.strictEqual(third, 200);
});

// --- auctions ---

test("consignAuction requires ownership and charges listing fee", () => {
  const seller = mockPlayer("Seller", 100);
  const art = makeArtwork("Seller", "Seller", 0);
  const res = Galleries.consignAuction(art.id, seller, 50, 1000);
  assert.ok(res.ok, `consign failed: ${res.reason}`);
  assert.strictEqual(seller.__inv.coins, 90); // 10c listing fee taken
  assert.strictEqual(res.auction.reserve, 50);
  assert.strictEqual(res.auction.status, "open");
});

test("consignAuction fails honestly when seller is broke", () => {
  const seller = mockPlayer("Broke", 5);
  const art = makeArtwork("Broke", "Broke", 0);
  const res = Galleries.consignAuction(art.id, seller, 50, 1000);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, "insufficient-coins");
  assert.strictEqual(seller.__inv.coins, 5); // untouched
});

test("consignAuction rejects art the seller does not own", () => {
  const seller = mockPlayer("Seller", 100);
  const art = makeArtwork("Artist", "Artist", 0);
  const res = Galleries.consignAuction(art.id, seller, 50, 1000);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, "not-owned");
});

test("placeBid escrows coins and refunds the outbid bidder", () => {
  const seller = mockPlayer("Seller", 100);
  const art = makeArtwork("Seller", "Seller", 0);
  const auc = Galleries.consignAuction(art.id, seller, 50, 1000).auction;

  const alice = mockPlayer("Alice", 200);
  const bob = mockPlayer("Bob", 300);
  const paid = [];
  const payee = (u, a) => { paid.push([u, a]); return true; };

  const r1 = Galleries.placeBid(auc.id, alice, 60, payee, 2000);
  assert.ok(r1.ok, `bid1 failed: ${r1.reason}`);
  assert.strictEqual(alice.__inv.coins, 140); // 60 escrowed

  const r2 = Galleries.placeBid(auc.id, bob, 80, payee, 3000);
  assert.ok(r2.ok, `bid2 failed: ${r2.reason}`);
  assert.strictEqual(bob.__inv.coins, 220);
  // Alice refunded via payee.
  assert.deepStrictEqual(paid, [["alice", 60]]);

  // Too-low bid rejected.
  const r3 = Galleries.placeBid(auc.id, alice, 80, payee, 4000);
  assert.strictEqual(r3.ok, false);
  assert.strictEqual(r3.reason, "too-low");
  assert.strictEqual(r3.minBid, 81);
});

test("placeBid rejects own auction and broke bidders", () => {
  const seller = mockPlayer("Seller", 100);
  const art = makeArtwork("Seller", "Seller", 0);
  const auc = Galleries.consignAuction(art.id, seller, 50, 1000).auction;

  const own = Galleries.placeBid(auc.id, seller, 100, () => true, 2000);
  assert.strictEqual(own.ok, false);
  assert.strictEqual(own.reason, "own-auction");

  const broke = mockPlayer("Broke", 10);
  const r = Galleries.placeBid(auc.id, broke, 100, () => true, 2000);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "insufficient-coins");
});

test("closeAuction sells to high bidder, house takes 5%", () => {
  const seller = mockPlayer("Seller", 100);
  const art = makeArtwork("Seller", "Seller", 0);
  const auc = Galleries.consignAuction(art.id, seller, 50, 1000).auction;

  const alice = mockPlayer("Alice", 500);
  const paid = {};
  const payee = (u, a) => { paid[u] = (paid[u] || 0) + a; return true; };

  Galleries.placeBid(auc.id, alice, 200, payee, 2000);
  const res = Galleries.closeAuction(auc.id, payee, 1000 + 4 * 24 * 3600 * 1000);
  assert.ok(res.ok && res.sold);
  assert.strictEqual(res.winner, "alice");
  assert.strictEqual(res.hammerPrice, 200);
  assert.strictEqual(res.houseCut, 10); // 5% of 200
  assert.strictEqual(paid["seller"], 190);
  // Ownership transferred in CitizenArt.
  assert.strictEqual(Art.artworkById(art.id).owner, "alice");
  // Budget grew by the house cut.
  assert.strictEqual(Galleries.galleryOpsFor("misthalin").budget, 10);
});

test("closeAuction with no bids above reserve refunds honestly", () => {
  const seller = mockPlayer("Seller", 100);
  const art = makeArtwork("Seller", "Seller", 0);
  const auc = Galleries.consignAuction(art.id, seller, 500, 1000).auction;

  const alice = mockPlayer("Alice", 500);
  const paid = [];
  const payee = (u, a) => { paid.push([u, a]); return true; };
  // Bid below reserve is rejected at bid time (min = reserve).
  const r = Galleries.placeBid(auc.id, alice, 100, payee, 2000);
  assert.strictEqual(r.ok, false);

  const res = Galleries.closeAuction(auc.id, payee, 1000 + 4 * 24 * 3600 * 1000);
  assert.ok(res.ok && !res.sold);
  assert.strictEqual(Art.artworkById(art.id).owner, "seller"); // unchanged
});

test("ripeAuctions finds only ended open auctions", () => {
  const seller = mockPlayer("Seller", 100);
  const a1 = makeArtwork("Seller", "Seller", 0);
  const a2 = makeArtwork("Seller", "Seller", 0);
  Galleries.consignAuction(a1.id, seller, 10, 1000);
  Galleries.consignAuction(a2.id, seller, 10, 1000 + 10 * 24 * 3600 * 1000);
  const ripe = Galleries.ripeAuctions(1000 + 4 * 24 * 3600 * 1000);
  assert.strictEqual(ripe.length, 1);
  assert.strictEqual(ripe[0].artworkId, a1.id);
});

// --- commissions ---

test("postCommission escrows real coins", () => {
  const patron = mockPlayer("Patron", 1000);
  const res = Galleries.postCommission(patron, "painting", "sunset", 300, "misthalin", 1000);
  assert.ok(res.ok, `post failed: ${res.reason}`);
  assert.strictEqual(patron.__inv.coins, 700);
  assert.strictEqual(res.commission.status, "open");
  assert.strictEqual(res.commission.escrow, 300);
});

test("postCommission validates medium and escrow", () => {
  const patron = mockPlayer("Patron", 1000);
  assert.strictEqual(Galleries.postCommission(patron, "dance", "x", 100, "misthalin", 1000).ok, false);
  assert.strictEqual(Galleries.postCommission(patron, "painting", "x", 0, "misthalin", 1000).ok, false);
  const broke = mockPlayer("Broke", 10);
  const r = Galleries.postCommission(broke, "painting", "x", 100, "misthalin", 1000);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "insufficient-coins");
});

test("accept + deliver releases escrow to the artist", () => {
  const patron = mockPlayer("Patron", 1000);
  const com = Galleries.postCommission(patron, "painting", "sunset", 300, "misthalin", 1000).commission;

  const acc = Galleries.acceptCommission(com.id, "Artist");
  assert.ok(acc.ok);
  assert.strictEqual(acc.commission.status, "accepted");

  const art = makeArtwork("Artist", "Artist", 0);
  const paid = {};
  const payee = (u, a) => { paid[u] = (paid[u] || 0) + a; return true; };
  const del = Galleries.deliverCommission(com.id, art.id, payee, 2000);
  assert.ok(del.ok, `deliver failed: ${del.reason}`);
  assert.strictEqual(paid["artist"], 300);
  assert.strictEqual(Art.artworkById(art.id).owner, "patron");
});

test("deliverCommission rejects wrong medium", () => {
  const patron = mockPlayer("Patron", 1000);
  const com = Galleries.postCommission(patron, "sculpture", "bust", 300, "misthalin", 1000).commission;
  Galleries.acceptCommission(com.id, "Artist");
  const art = makeArtwork("Artist", "Artist", 0); // painting, not sculpture
  const del = Galleries.deliverCommission(com.id, art.id, () => true, 2000);
  assert.strictEqual(del.ok, false);
  assert.strictEqual(del.reason, "wrong-medium");
});

test("cancelCommission refunds the patron", () => {
  const patron = mockPlayer("Patron", 1000);
  const com = Galleries.postCommission(patron, "painting", "x", 300, "misthalin", 1000).commission;
  const paid = {};
  const res = Galleries.cancelCommission(com.id, (u, a) => { paid[u] = a; return true; });
  assert.ok(res.ok);
  assert.strictEqual(paid["patron"], 300);
});

// --- appraisals ---

test("appraise charges fee and reads CitizenArt valuation", () => {
  Galleries.registerCurator("Curator", "misthalin", 1000);
  const client = mockPlayer("Client", 100);
  const art = makeArtwork("Client", "Client", 0);
  const res = Galleries.appraise(art.id, "Curator", client, 2000);
  assert.ok(res.ok, `appraise failed: ${res.reason}`);
  assert.strictEqual(client.__inv.coins, 75); // 25c fee
  assert.strictEqual(typeof res.appraisal.value, "number");
  assert.strictEqual(res.appraisal.value, Art.valueFor(Art.artworkById(art.id)));
  assert.strictEqual(Galleries.curatorInfo("curator").appraisals, 1);
  // Fee went to the gallery budget.
  assert.strictEqual(Galleries.galleryOpsFor("misthalin").budget, 25);
});

test("appraise requires a real curator", () => {
  const client = mockPlayer("Client", 100);
  const art = makeArtwork("Client", "Client", 0);
  const res = Galleries.appraise(art.id, "Nobody", client, 2000);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, "not-curator");
});

// --- acquisitions ---

test("acquireForCollection spends budget and transfers ownership", () => {
  Galleries.registerCurator("Curator", "misthalin", 1000);
  const ops = Galleries.galleryOpsFor("misthalin");
  ops.budget = 500;
  Galleries.markDirty();

  const art = makeArtwork("Artist", "Artist", 100);
  const paid = {};
  const res = Galleries.acquireForCollection(art.id, "Curator", 100, (u, a) => { paid[u] = a; return true; }, 2000);
  assert.ok(res.ok, `acquire failed: ${res.reason}`);
  assert.strictEqual(paid["artist"], 100);
  assert.strictEqual(Galleries.galleryOpsFor("misthalin").budget, 400);
  assert.ok(Galleries.galleryOpsFor("misthalin").collection.includes(art.id));
  assert.strictEqual(Art.artworkById(art.id).owner, "gallery:misthalin");
});

test("acquireForCollection fails honestly when budget is short", () => {
  Galleries.registerCurator("Curator", "misthalin", 1000);
  const art = makeArtwork("Artist", "Artist", 100);
  const res = Galleries.acquireForCollection(art.id, "Curator", 100, () => true, 2000);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, "insufficient-budget");
});

// --- tours ---

test("sendTour requires a collection and real destinations", () => {
  Galleries.registerCurator("Curator", "misthalin", 1000);
  const empty = Galleries.sendTour("Curator", ["asgarnia"], 1000);
  assert.strictEqual(empty.ok, false);
  assert.strictEqual(empty.reason, "empty-collection");

  const ops = Galleries.galleryOpsFor("misthalin");
  const art = makeArtwork("Artist", "Artist", 0);
  ops.collection.push(art.id);
  Galleries.markDirty();

  const noDest = Galleries.sendTour("Curator", ["misthalin"], 1000);
  assert.strictEqual(noDest.ok, false);

  const res = Galleries.sendTour("Curator", ["asgarnia", "kandarin"], 1000);
  assert.ok(res.ok, `tour failed: ${res.reason}`);
  assert.strictEqual(res.tour.pieces.length, 1);
  assert.strictEqual(res.tour.status, "traveling");

  // Second tour while one is active is rejected.
  const dup = Galleries.sendTour("Curator", ["keldagrim"], 2000);
  assert.strictEqual(dup.ok, false);
  assert.strictEqual(dup.reason, "already-touring");
});

test("advanceTours moves shows along and boosts prestige", () => {
  Galleries.registerCurator("Curator", "misthalin", 1000);
  const ops = Galleries.galleryOpsFor("misthalin");
  const art = makeArtwork("Artist", "Artist", 0);
  ops.collection.push(art.id);
  Galleries.markDirty();
  const t0 = 1000000;
  Galleries.sendTour("Curator", ["asgarnia"], t0);

  const before = Galleries.prestigeFor("asgarnia");
  const arrived = Galleries.advanceTours(t0 + 3 * 24 * 3600 * 1000);
  assert.strictEqual(arrived.length, 1);
  assert.strictEqual(arrived[0].status, "showing");
  assert.ok(Galleries.prestigeFor("asgarnia") > before);

  // After the 3-day show, it heads home and completes.
  Galleries.advanceTours(t0 + 7 * 24 * 3600 * 1000); // showing -> traveling
  const done = Galleries.advanceTours(t0 + 12 * 24 * 3600 * 1000);
  assert.strictEqual(done[0].status, "done");
});

// --- persistence ---

test("state survives a save/load round-trip", () => {
  Galleries.registerCurator("Curator", "misthalin", 1000);
  Galleries.galleryOpsFor("misthalin").budget = 123;
  Galleries.markDirty();
  assert.ok(Galleries.save());
  // Force reload from disk.
  Galleries._setSavePathForTests(SAVE_PATH);
  assert.ok(Galleries.isCurator("curator"));
  assert.strictEqual(Galleries.galleryOpsFor("misthalin").budget, 123);
});

// --- stats ---

test("stats reports the honest shape", () => {
  const s = Galleries.stats("misthalin");
  assert.strictEqual(typeof s.prestige, "number");
  assert.strictEqual(typeof s.budget, "number");
  assert.strictEqual(s.curators, 0);
  assert.strictEqual(s.openAuctions, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
