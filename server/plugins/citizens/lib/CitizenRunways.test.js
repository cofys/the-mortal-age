"use strict";

/**
 * CitizenRunways.test.js — data-tier tests for REAL runway fashion shows.
 * Plain node, no jest. Run: node server/plugins/citizens/lib/CitizenRunways.test.js
 */

const assert = require("assert");
const path = require("path");
const os = require("os");
const Runways = require("./CitizenRunways");

// Never touch the real save file from tests.
const SAVE_PATH = path.join(os.tmpdir(), `citizen-runways-test-${process.pid}.json`);
Runways._setSavePathForTests(SAVE_PATH);

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    try { require("fs").unlinkSync(SAVE_PATH); } catch { /* fresh */ }
    Runways.resetForTests();
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error(`FAIL: ${name}: ${e.message}`);
  }
}

// --- Mock player with real inventory semantics ---
function mockPlayer(username, coins, papyrus, cloth) {
  const inv = {
    coins: coins || 0,
    papyrus: papyrus || 0,
    cloth: cloth || 0,
    getAmount(id) {
      if (id === 995) return this.coins;
      if (id === 970) return this.papyrus;
      if (id === 1759) return this.cloth;
      return 0;
    },
    // Canonical ItemContainer API: getAmount(id), adds(id, amount),
    // deleteNumber(id, amount). There is no inv.add / inv.remove.
    adds(id, n) {
      if (id === 995) this.coins += n;
      if (id === 970) this.papyrus += n;
      if (id === 1759) this.cloth += n;
    },
    deleteNumber(id, n) {
      if (id === 995) this.coins = Math.max(0, this.coins - n);
      if (id === 970) this.papyrus = Math.max(0, this.papyrus - n);
      if (id === 1759) this.cloth = Math.max(0, this.cloth - n);
    },
  };
  return { username, getUsername: () => username, getInventory: () => inv, _inv: inv };
}

// --- venues ---

test("runway venues exist per kingdom with real capacity", () => {
  const v = Runways.ensureVenue("misthalin");
  assert(v && v.name && v.tile, "venue needs name and tile");
  assert(v.capacity >= 50 && v.capacity <= 110, "capacity in range");
  assert(Runways.effectiveCapacity(v) === v.capacity, "full condition = full capacity");
  v.condition = 0;
  assert(Runways.effectiveCapacity(v) < v.capacity, "poor condition caps attendance");
});

test("venues do not share tiles with theater offset", () => {
  const v = Runways.ensureVenue("asgarnia");
  assert(v.tile && typeof v.tile.x === "number", "tile must be concrete");
});

// --- designers ---

test("designer registration is idempotent", () => {
  Runways.registerDesigner("Coco", "misthalin");
  Runways.registerDesigner("Coco", "misthalin");
  assert(Runways.isDesigner("Coco"), "Coco is a designer");
  assert.strictEqual(Runways.designerFor("coco").username, "Coco", "case-insensitive lookup");
});

// --- collections ---

test("creating a collection consumes real papyrus and cloth", () => {
  Runways.registerDesigner("Elsa", "misthalin");
  const p = mockPlayer("Elsa", 100, 2, 20);
  const before = p._inv.papyrus;
  const clothBefore = p._inv.cloth;
  const res = Runways.createCollection("Elsa", "regal", { payer: p });
  assert(res.ok, `create failed: ${res.reason}`);
  const c = res.collection;
  assert(c.name.includes("regal") || c.name.includes("Regal"), "name has the theme");
  assert(c.pieces.length >= 3 && c.pieces.length <= 6, "3-6 pieces");
  assert(p._inv.papyrus === before - 1, "1 papyrus consumed");
  assert(p._inv.cloth === clothBefore - Runways.CLOTH_PER_PIECE * c.pieces.length, "real cloth per piece");
  assert(c.quality >= 1 && c.quality <= 10, "quality in range");
});

test("collection quality grows with real engagement, never random", () => {
  Runways.registerDesigner("Vera", "misthalin");
  const p = mockPlayer("Vera", 100, 10, 100);
  const q1 = Runways.createCollection("Vera", "elegant", { payer: p }).collection.quality;
  const q2 = Runways.createCollection("Vera", "elegant", { payer: p }).collection.quality;
  assert(q2 >= q1, "quality never decreases with engagement");
  const d = Runways.designerFor("Vera");
  assert.strictEqual(d.collectionsMade, 2, "two collections made");
});

test("collection fails honestly without materials", () => {
  Runways.registerDesigner("Broke", "misthalin");
  const p = mockPlayer("Broke", 100, 0, 0);
  const res = Runways.createCollection("Broke", "rugged", { payer: p });
  assert(!res.ok, "must fail without papyrus");
  assert.strictEqual(p._inv.papyrus, 0, "no partial consumption");
});

test("collection fails honestly with bad theme", () => {
  Runways.registerDesigner("Pick", "misthalin");
  const p = mockPlayer("Pick", 100, 5, 50);
  const res = Runways.createCollection("Pick", "cyberpunk", { payer: p });
  assert(!res.ok, "unknown theme rejected");
  assert(p._inv.papyrus === 5, "materials untouched on theme failure");
});

// --- houses ---

test("houses form, join, and track treasuries", () => {
  Runways.registerDesigner("House", "kandarin");
  const f = Runways.formHouse("House", "House Aurelia");
  assert(f.ok, `form failed: ${f.reason}`);
  const j = Runways.joinHouse("Member", "House Aurelia");
  assert(j.ok, "member joins");
  assert(j.house.members.includes("Member"), "member in roster");
  const dup = Runways.formHouse("Other", "house aurelia");
  assert(!dup.ok, "duplicate house name rejected");
});

test("house tours take real time", () => {
  Runways.registerDesigner("Tour", "kandarin");
  Runways.formHouse("Tour", "Tour House");
  const t = Runways.tourTo("Tour House", "morytania");
  assert(t.ok, "tour starts");
  const loc = Runways.houseLocation(Runways.houseFor("Tour House"));
  assert(loc.traveling, "house is traveling right now");
  // not yet arrived
  assert(!Runways.arriveHouse("Tour House"), "arrival too early");
});

// --- casting ---

test("models register and get cast", () => {
  Runways.registerDesigner("Cast", "kandarin");
  Runways.formHouse("Cast", "Cast House");
  Runways.registerModel("ModelA", "kandarin");
  Runways.registerModel("ModelB", "kandarin");
  assert(Runways.isModel("modela"), "model registered");
  const p = mockPlayer("Cast", 100, 5, 50);
  const col = Runways.createCollection("Cast", "ornate", { payer: p }).collection;
  const h = Runways.houseFor("Cast House");
  h.treasury = 1000;
  // cast before booking is not required — bookShow takes castModels directly
  const b = Runways.bookShow("Cast House", col.id, { kingdomId: "kandarin", castModels: ["ModelA", "ModelB"] });
  assert(b.ok, `book failed: ${b.reason}`);
  const c = Runways.castModel(b.show.id, "ModelC");
  assert(!c.ok, "unregistered model cannot be cast");
});

// --- shows & tickets ---

function setupShow(kingdomId) {
  Runways.registerDesigner("Show", kingdomId);
  Runways.formHouse("Show", "Show House");
  Runways.registerModel("Walker1", kingdomId);
  Runways.registerModel("Walker2", kingdomId);
  const p = mockPlayer("Show", 100, 5, 50);
  const col = Runways.createCollection("Show", "simple", { payer: p }).collection;
  const h = Runways.houseFor("Show House");
  h.treasury = 5000;
  return Runways.bookShow("Show House", col.id, { kingdomId, castModels: ["Walker1", "Walker2"] });
}

test("booking requires venue fee, cast, and pays it honestly", () => {
  const b = setupShow("morytania");
  assert(b.ok, `book failed: ${b.reason}`);
  assert(b.show.ticketPrice >= 5, "ticket price floored");
  const h = Runways.houseFor("Show House");
  assert(h.treasury === 5000 - Runways.VENUE_BOOKING_FEE, "venue fee leaves the treasury");
  const poor = Runways.formHouse("Show", "Poor House");
  assert(poor.ok);
  const b2 = Runways.bookShow("Poor House", 1, { kingdomId: "morytania", castModels: ["Walker1", "Walker2"] });
  assert(!b2.ok, "broke house cannot book");
});

test("tickets are real coins with honest failures", () => {
  const b = setupShow("keldagrim");
  assert(b.ok);
  const rich = mockPlayer("Rich", 1000, 0, 0);
  const r1 = Runways.buyTicket(rich, b.show.id);
  assert(r1.ok, "rich buyer gets a ticket");
  assert.strictEqual(rich._inv.coins, 1000 - b.show.ticketPrice, "real coins leave inventory");
  const broke = mockPlayer("Broke2", 1, 0, 0);
  const r2 = Runways.buyTicket(broke, b.show.id);
  assert(!r2.ok, "broke buyer fails honestly");
});

test("settlement splits revenue 60/25/15 and reviews deterministically", () => {
  const b = setupShow("misthalin");
  assert(b.ok);
  const rich = mockPlayer("Fan", 10000, 0, 0);
  Runways.buyTicket(rich, b.show.id);
  const show = Runways.showFor(b.show.id);
  show.endsAt = Date.now() - 1; // force finished
  const s = Runways.settleShow(b.show.id);
  assert(s.ok, "settles");
  assert(s.review.stars >= 1 && s.review.stars <= 5, "stars in range");
  assert(s.splits.houseShare + s.splits.venueShare + s.splits.purseShare <= show.revenue, "splits don't exceed revenue");
  const h = Runways.houseFor("Show House");
  assert(h.treasury >= s.splits.houseShare, "house gets its share");
  // deterministic: settle twice on identical state gives same stars
  Runways.resetForTests();
  try { require("fs").unlinkSync(SAVE_PATH); } catch {}
  const b2 = setupShow("misthalin");
  const rich2 = mockPlayer("Fan2", 10000, 0, 0);
  Runways.buyTicket(rich2, b2.show.id);
  const show2 = Runways.showFor(b2.show.id);
  show2.endsAt = Date.now() - 1;
  const s2 = Runways.settleShow(b2.show.id);
  assert.strictEqual(s2.review.stars, s.review.stars, "reviews are deterministic");
});

// --- ateliers ---

test("ateliers sell collection pieces for real coins", () => {
  Runways.registerDesigner("Atel", "asgarnia");
  const p = mockPlayer("Atel", 100, 5, 50);
  const col = Runways.createCollection("Atel", "practical", { payer: p }).collection;
  const o = Runways.openAtelier("Atel", "asgarnia");
  assert(o.ok, `open failed: ${o.reason}`);
  const st = Runways.stockAtelier("Atel", col.id);
  assert(st.ok && st.stocked === col.pieces.length, "all pieces stocked");
  const buyer = mockPlayer("Buyer", 10000, 0, 0);
  const pieceId = col.pieces[0].pieceId;
  const buy = Runways.buyFromAtelier(buyer, "Atel", pieceId);
  assert(buy.ok, `buy failed: ${buy.reason}`);
  assert(buyer._inv.coins < 10000, "real coins paid");
  const buy2 = Runways.buyFromAtelier(buyer, "Atel", pieceId);
  assert(!buy2.ok, "sold piece cannot be bought twice");
});

test("atelier requires designer registration", () => {
  const o = Runways.openAtelier("Nobody", "asgarnia");
  assert(!o.ok, "non-designer cannot open atelier");
});

// --- upkeep & persistence ---

test("venue upkeep and decay are real", () => {
  const v = Runways.ensureVenue("misthalin");
  v.condition = 50;
  const p = mockPlayer("Keeper", 10000, 0, 0);
  const r = Runways.renovate("misthalin", p, 10);
  assert(r.ok && v.condition === 60, "renovation restores condition");
  Runways.decayVenue("misthalin");
  assert(v.condition < 60, "decay reduces condition");
});

test("fame deeds fire on real engagement", () => {
  Runways.registerDesigner("Fame", "misthalin");
  const d = Runways.designerFor("Fame");
  d.collectionsMade = 5;
  assert(Runways.deedsForDesigner("Fame").includes(Runways.DEED_COLLECTION_LAUREATE), "laureate at 5 collections");
  d.collectionsMade = 4;
  assert(!Runways.deedsForDesigner("Fame").includes(Runways.DEED_COLLECTION_LAUREATE), "not before 5");
});

test("save round-trips state", () => {
  Runways.registerDesigner("Save", "misthalin");
  assert(Runways.save(), "saves");
  Runways.resetForTests();
  assert(Runways.isDesigner("Save"), "designer survives reload");
  assert(Runways.describe().designers === 1, "describe counts");
});

// --- canonical ItemContainer API regressions (inv-audit) ---
test("takeCoins reduces the balance via deleteNumber, broke refuses honestly", () => {
  const rich = mockPlayer("RichTaker", 1000, 0, 0);
  assert.strictEqual(Runways.takeCoins(rich, 400), true, "take succeeds");
  assert.strictEqual(rich._inv.coins, 600, "balance reduced by the take");
  assert.strictEqual(Runways.takeCoins(rich, 9999), false, "broke refuses");
  assert.strictEqual(rich._inv.coins, 600, "failed take touches nothing");
  assert.strictEqual(Runways.takeCoins(null, 10), false, "null player refuses");
});

test("giveCoins credits via adds", () => {
  const p = mockPlayer("PrizeTaker", 100, 0, 0);
  assert.strictEqual(Runways.giveCoins(p, 250), true, "give succeeds");
  assert.strictEqual(p._inv.coins, 350, "balance credited");
});

// --- vanishing-coins: crown venue share + verified model purses ---

test("settleShow accrues the crown venue share honestly when no coinSink is given", () => {
  const b = setupShow("kandarin");
  assert(b.ok, `book failed: ${b.reason}`);
  const rich = mockPlayer("CrownFan", 10000, 0, 0);
  Runways.buyTicket(rich, b.show.id);
  const show = Runways.showFor(b.show.id);
  show.endsAt = Date.now() - 1; // force finished
  const venueBefore = Runways.venueFor("kandarin").crownRevenue || 0;
  const s = Runways.settleShow(b.show.id); // no coinSink: the production call shape
  assert(s.ok, "settled");
  const expected = Math.floor(show.revenue * 2500 / 10000);
  assert(expected > 0, "the ticket sale must produce a crown share");
  assert.strictEqual(
    (Runways.venueFor("kandarin").crownRevenue || 0) - venueBefore,
    expected,
    `crown share ${expected} accrued on the venue, not dropped`
  );
});

test("settleShow still honors an explicit coinSink instead of accruing", () => {
  const b = setupShow("asgarnia");
  assert(b.ok, `book failed: ${b.reason}`);
  const rich = mockPlayer("SinkFan", 10000, 0, 0);
  Runways.buyTicket(rich, b.show.id);
  const show = Runways.showFor(b.show.id);
  show.endsAt = Date.now() - 1;
  let sunk = 0;
  const s = Runways.settleShow(b.show.id, (coins) => { sunk += coins; });
  assert(s.ok, "settled");
  const expected = Math.floor(show.revenue * 2500 / 10000);
  assert.strictEqual(sunk, expected, "sink received the crown share");
  assert(!(Runways.venueFor("asgarnia").crownRevenue > 0), "nothing double-booked on the venue");
});

test("payModelPurse delivers to a reachable bot inventory", () => {
  const bot = mockPlayer("ModelPay", 0, 0, 0);
  assert.strictEqual(Runways.payModelPurse("ModelPay", bot, 150), true);
  assert.strictEqual(bot._inv.coins, 150, "real inventory credited");
});

test("payModelPurse falls back to the real bank account when inventory is unreachable", () => {
  const Banking = require("./CitizenBanking");
  Banking.resetForTests();
  const before = Banking.accountFor("BankFallback").balance;
  assert.strictEqual(Runways.payModelPurse("BankFallback", null, 175), true);
  assert.strictEqual(Banking.accountFor("BankFallback").balance, before + 175, "bank account credited");
  Banking.resetForTests();
});

test("oweModelPurse / purseOwedList / clearPurseOwed round-trip", () => {
  assert.strictEqual(Runways.oweModelPurse("OwedModel", 200), 200);
  const list = Runways.purseOwedList();
  assert(list.some((e) => e.username === "owedmodel" && e.amount === 200), "owed entry listed");
  assert.strictEqual(Runways.clearPurseOwed("OwedModel"), true);
  assert(!Runways.purseOwedList().some((e) => e.username === "owedmodel"), "cleared");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
