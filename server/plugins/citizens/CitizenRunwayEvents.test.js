"use strict";

/**
 * CitizenRunwayEvents.test.js — ::runway command contracts.
 * Plain node, no jest. Run: node server/plugins/citizens/CitizenRunwayEvents.test.js
 */

const assert = require("assert");
const path = require("path");
const os = require("os");

const SAVE_PATH = path.join(os.tmpdir(), `citizen-runway-events-test-${process.pid}.json`);
const Runways = require("./lib/CitizenRunways");
Runways._setSavePathForTests(SAVE_PATH);
const { onRunwayCommand, RUNWAY_USAGE } = require("./CitizenRunwayEvents");

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

function mockPlayer(username, opts) {
  const o = opts || {};
  const inv = {
    coins: o.coins ?? 10000,
    papyrus: o.papyrus ?? 5,
    cloth: o.cloth ?? 50,
    getAmount(id) {
      if (id === 995) return this.coins;
      if (id === 970) return this.papyrus;
      if (id === 1759) return this.cloth;
      return 0;
    },
    // Real ItemContainer API: getAmount(id), adds(id, amount), deleteNumber(id, amount).
    adds(id, n) {
      if (id === 995) this.coins += n;
      if (id === 970) this.papyrus += n;
      if (id === 1759) this.cloth += n;
    },
    deleteNumber(id, n) {
      if (id === 995 && this.coins >= n) this.coins -= n;
      if (id === 970 && this.papyrus >= n) this.papyrus -= n;
      if (id === 1759 && this.cloth >= n) this.cloth -= n;
    },
  };
  return {
    username,
    getUsername: () => username,
    isPlayerBot: () => false,
    getAttribute: (k) => (k === "kingdom:id" ? "misthalin" : undefined),
    getInventory: () => inv,
    messages: [],
    sendMessage(t) { this.messages.push(String(t)); },
    _inv: inv,
  };
}

function run(player, args) {
  player.messages = [];
  onRunwayCommand(player, args);
  return player.messages.join(" ");
}

test("bots are rejected", () => {
  const bot = { isPlayerBot: () => true, messages: [], sendMessage(t) { this.messages.push(t); } };
  onRunwayCommand(bot, "venues");
  assert(bot.messages.join(" ").toLowerCase().includes("citizens"), "bot rejection message");
});

test("usage is exported", () => {
  assert(RUNWAY_USAGE.includes("::runway"), "usage has command name");
});

test("venues lists runway venues", () => {
  const p = mockPlayer("P1");
  const out = run(p, "venues");
  assert(out.includes("Runway"), "lists runway venues");
});

test("register then create a collection", () => {
  const p = mockPlayer("Couture");
  let out = run(p, "register");
  assert(out.toLowerCase().includes("registered"), "registers as designer");
  out = run(p, "create regal");
  assert(out.includes("Created"), `creates collection: ${out}`);
  out = run(p, "collections");
  assert(out.includes("Collection"), "collection listed");
});

test("create with bad theme fails honestly", () => {
  const p = mockPlayer("ThemeFail");
  run(p, "register");
  const out = run(p, "create cyberpunk");
  assert(out.toLowerCase().includes("theme"), "theme guidance given");
});

test("form, join, and list houses", () => {
  const p = mockPlayer("Founder");
  run(p, "register");
  let out = run(p, "form Golden Atelier");
  assert(out.includes("Formed"), `formed: ${out}`);
  const q = mockPlayer("Joiner");
  out = run(q, "join Golden Atelier");
  assert(out.includes("Joined"), "joins house");
  out = run(p, "houses");
  assert(out.includes("Golden Atelier"), "house listed");
});

test("full flow: model, book, ticket, review", () => {
  const d = mockPlayer("DesiFlow");
  run(d, "register");
  run(d, "create elegant");
  run(d, "form Flow House");
  const m1 = mockPlayer("ModelOne");
  const m2 = mockPlayer("ModelTwo");
  run(m1, "model");
  run(m2, "model");
  // models must be in the house for defaultCast — join them
  run(m1, "join Flow House");
  run(m2, "join Flow House");
  const colId = Object.keys(Runways.load().collections)[0];
  Runways.houseFor("Flow House").treasury = 5000; // houses earn this from shows
  let out = run(d, `book Flow House ${colId}`);
  assert(out.toLowerCase().includes("booked"), `booked: ${out}`);
  const showId = Object.keys(Runways.load().shows)[0];
  const fan = mockPlayer("FanFlow");
  out = run(fan, `ticket ${showId}`);
  assert(out.toLowerCase().includes("ticket bought"), `ticket: ${out}`);
  out = run(fan, "shows");
  assert(out.includes(showId), "show listed");
});

test("book fails honestly without cast models", () => {
  const d = mockPlayer("Lonely");
  run(d, "register");
  run(d, "create simple");
  run(d, "form Lonely House");
  const colId = Object.keys(Runways.load().collections)[0];
  const out = run(d, `book Lonely House ${colId}`);
  assert(out.toLowerCase().includes("cast model"), `honest cast failure: ${out}`);
});

test("ateliers: open, stock, buy", () => {
  const d = mockPlayer("AtelCmd");
  run(d, "register");
  run(d, "create practical");
  let out = run(d, "open");
  assert(out.toLowerCase().includes("opened"), "atelier opened");
  const colId = Object.keys(Runways.load().collections)[0];
  out = run(d, `stock ${colId}`);
  assert(out.toLowerCase().includes("stocked"), "stocked");
  const buyer = mockPlayer("BuyerCmd");
  const pieceId = Runways.load().collections[colId].pieces[0].pieceId;
  out = run(buyer, `buy AtelCmd ${pieceId}`);
  assert(out.toLowerCase().includes("bought"), `bought: ${out}`);
});

test("tour and renovate subcommands work", () => {
  const d = mockPlayer("TourCmd");
  run(d, "register");
  let out = run(d, "form Tour House");
  out = run(d, "tour Tour House morytania");
  assert(out.toLowerCase().includes("departs"), `tour: ${out}`);
  out = run(d, "renovate 5");
  assert(out.toLowerCase().includes("renovated"), `renovate: ${out}`);
});

test("unknown subcommand shows usage", () => {
  const p = mockPlayer("Lost");
  const out = run(p, "frobnicate");
  assert(out.includes("::runway"), "usage shown");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
