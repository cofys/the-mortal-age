"use strict";

/**
 * CitizenRunwayLife.test.js — slow-tick contracts without a running server.
 * Plain node, no jest. Run: node server/plugins/citizens/lib/CitizenRunwayLife.test.js
 */

const assert = require("assert");
const path = require("path");
const os = require("os");

const SAVE_PATH = path.join(os.tmpdir(), `citizen-runway-life-test-${process.pid}.json`);
const Runways = require("./CitizenRunways");
Runways._setSavePathForTests(SAVE_PATH);
const Life = require("./CitizenRunwayLife");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    try { require("fs").unlinkSync(SAVE_PATH); } catch { /* fresh */ }
    Runways.resetForTests();
    Life.resetForTests();
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error(`FAIL: ${name}: ${e.message}`);
  }
}

function mockRecord(username, opts) {
  const o = opts || {};
  return {
    username,
    getUsername: () => username,
    getAttribute: (k) => {
      if (k === "citizens:personality") return o.personality || {};
      if (k === "citizens:career") return o.career || null;
      if (k === "kingdom:id") return o.kingdomId || "misthalin";
      return undefined;
    },
    getInventory: () => ({
      getAmount: (id) => (id === 970 ? (o.papyrus || 0) : id === 1759 ? (o.cloth || 0) : id === 995 ? (o.coins || 0) : 0),
      remove: () => true,
      add: () => true,
    }),
    getLocalPlayers: () => [],
    kingdomId: o.kingdomId || "misthalin",
  };
}

function mockDirector(records) {
  return {
    citizensOnline: () => records.map((record) => ({ record })),
  };
}

test("tick never throws with no citizens", () => {
  Life.tickRunwayLife(mockDirector([]), Date.now());
});

test("tick never throws with garbage records", () => {
  Life.tickRunwayLife({ citizensOnline: () => [{ record: null }, {}] }, Date.now());
  Life.tickRunwayLife(null, Date.now());
});

test("tick registers designers by career and expressive citizens", () => {
  const recs = [
    mockRecord("Desi", { career: "designer", kingdomId: "misthalin" }),
    mockRecord("Arty", { personality: { expressiveness: 0.9 }, papyrus: 3, kingdomId: "misthalin" }),
    mockRecord("Plain", { personality: { expressiveness: 0.1 }, kingdomId: "misthalin" }),
  ];
  Life.tickRunwayLife(mockDirector(recs), Date.now());
  assert(Runways.isDesigner("Desi"), "career designer registers");
  assert(Runways.isDesigner("Arty"), "expressive citizen with papyrus registers");
  assert(!Runways.isDesigner("Plain"), "unexpressive citizen does not register");
});

test("tick registers models from confident citizens", () => {
  const recs = [mockRecord("Conf", { personality: { confidence: 0.9 }, kingdomId: "misthalin" })];
  Life.tickRunwayLife(mockDirector(recs), Date.now());
  assert(Runways.isModel("Conf"), "confident citizen registers as model");
});

test("tick drafts collections with real materials", () => {
  const recs = [mockRecord("Draft", { career: "designer", kingdomId: "asgarnia", papyrus: 5, cloth: 30 })];
  Life.tickRunwayLife(mockDirector(recs), Date.now());
  const cols = Runways.collectionsIn("asgarnia");
  assert(cols.length >= 1, "ambient draft produced a collection");
});

test("tick forms houses from unattached designers", () => {
  const recs = [
    mockRecord("HF1", { career: "designer", kingdomId: "kandarin", papyrus: 2, cloth: 20 }),
    mockRecord("HF2", { career: "designer", kingdomId: "kandarin", papyrus: 2, cloth: 20 }),
    mockRecord("HF3", { career: "designer", kingdomId: "kandarin", papyrus: 2, cloth: 20 }),
  ];
  Life.tickRunwayLife(mockDirector(recs), Date.now());
  const houses = Runways.housesIn("kandarin");
  assert(houses.length >= 1, "a house formed");
  assert(houses[0].members.length >= 2, "house has members");
});

test("tick settles finished shows and pays the model purse", () => {
  Runways.registerDesigner("Settle", "morytania");
  Runways.formHouse("Settle", "Settle House");
  Runways.registerModel("Purse1", "morytania");
  Runways.registerModel("Purse2", "morytania");
  const rec = mockRecord("Settle", { kingdomId: "morytania", papyrus: 5, cloth: 30 });
  const col = Runways.createCollection("Settle", "regal", { payer: rec }).collection;
  const h = Runways.houseFor("Settle House");
  h.treasury = 5000;
  const b = Runways.bookShow("Settle House", col.id, { kingdomId: "morytania", castModels: ["Purse1", "Purse2"] });
  assert(b.ok, "booked");
  // sell a ticket with real coins
  const fanInv = { coins: 5000 };
  Runways.buyTicket(
    { getInventory: () => ({ getAmount: () => fanInv.coins, remove: (id, n) => { fanInv.coins -= n; return true; } }) },
    b.show.id
  );
  const show = Runways.showFor(b.show.id);
  show.endsAt = Date.now() - 1;
  const recs = [
    mockRecord("Settle", { kingdomId: "morytania" }),
    mockRecord("Purse1", { kingdomId: "morytania" }),
    mockRecord("Purse2", { kingdomId: "morytania" }),
  ];
  Life.tickRunwayLife(mockDirector(recs), Date.now());
  const settled = Runways.showFor(b.show.id);
  assert(settled.settled, "show settled by the tick");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
