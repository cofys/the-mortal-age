"use strict";

/**
 * CitizenGalleryEvents.test.js — ::gallery command contracts.
 * Plain node, no jest. Run: node server/plugins/citizens/CitizenGalleryEvents.test.js
 *
 * The data tier is stubbed in the require cache; CitizenArt is real
 * (temp save path) for artwork records.
 */

const assert = require("assert");
const path = require("path");
const os = require("os");
const fs = require("fs");

// --- stub the galleries data tier ---
const galleriesPath = path.resolve(__dirname, "./lib/CitizenGalleries.js");
const calls = [];
const galleriesStub = {
  stats: (kid) => ({ prestige: 42, budget: 500, collectionSize: 3, openAuctions: 1, curators: 1, openCommissions: 0, activeTours: 0 }),
  openAuctions: () => [{ id: "auc-1", title: "Sunset", medium: "painting", bids: [{ bidder: "alice", amount: 100 }] }],
  openCommissions: () => [{ id: "com-1", medium: "painting", theme: "dawn", escrow: 200, patron: "patron" }],
  consignAuction: (artworkId, player, reserve) => { calls.push(["consign", artworkId, reserve]); return { ok: true, auction: { id: "auc-9", title: "T", reserve } }; },
  placeBid: (id, player, amount) => { calls.push(["bid", id, amount]); return amount >= 50 ? { ok: true, outbid: null } : { ok: false, reason: "too-low", minBid: 50 }; },
  postCommission: (player, medium, theme, escrow, kid) => { calls.push(["post", medium, escrow]); return { ok: true, commission: { id: "com-9" } }; },
  acceptCommission: (id, user) => { calls.push(["accept", id]); return { ok: true, commission: { id, medium: "painting" } }; },
  deliverCommission: (cid, aid) => { calls.push(["deliver", cid, aid]); return { ok: true, escrow: 200 }; },
  cancelCommission: (id) => { calls.push(["cancel", id]); return { ok: true, refunded: 200 }; },
  curatorsIn: () => [{ username: "curator" }],
  appraise: (aid, curator, player) => { calls.push(["appraise", aid]); return { ok: true, appraisal: { curator: "curator", value: 150, fee: 25 } }; },
  sendTour: (user, dests) => { calls.push(["tour", dests]); return { ok: true, tour: { name: "X on Tour", pieces: [1, 2] } }; },
};
require.cache[galleriesPath] = {
  id: galleriesPath, filename: galleriesPath, loaded: true,
  exports: galleriesStub,
};

// --- stub CitizenSites for kingdomOf ---
const sitesPath = path.resolve(__dirname, "./lib/../brain/CitizenSites.js");
require.cache[sitesPath] = {
  id: sitesPath, filename: sitesPath, loaded: true,
  exports: { kingdomIdOf: () => "misthalin" },
};

const { onGalleryCommand, GALLERY_USAGE } = require("./CitizenGalleryEvents.js");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    calls.length = 0;
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error(`FAIL: ${name}: ${e.message}\n${e.stack}`);
  }
}

function mockPlayer(username, isBot) {
  const said = [];
  return {
    username,
    isPlayerBot: () => !!isBot,
    getUsername() { return username; },
    sendMessage(t) { said.push(t); },
    said,
    getInventory() { return { getAmount: () => 1000, count: () => 1000, remove: () => true, add: () => {} }; },
  };
}

test("bots are rejected", () => {
  const bot = mockPlayer("Bot", true);
  onGalleryCommand(bot, "status");
  assert.ok(bot.said[0].includes("not this command"));
  assert.strictEqual(calls.length, 0);
});

test("status lists all kingdoms", () => {
  const p = mockPlayer("Player", false);
  onGalleryCommand(p, "status");
  assert.ok(p.said[0].includes("misthalin"));
  assert.ok(p.said[0].includes("prestige 42"));
});

test("auctions lists open auctions", () => {
  const p = mockPlayer("Player", false);
  onGalleryCommand(p, "auctions");
  assert.ok(p.said[0].includes("auc-1"));
  assert.ok(p.said[0].includes("100c"));
});

test("consign requires an artwork id", () => {
  const p = mockPlayer("Player", false);
  onGalleryCommand(p, "consign");
  assert.ok(p.said[0].includes("Usage"));
});

test("consign passes through to the data tier", () => {
  const p = mockPlayer("Player", false);
  onGalleryCommand(p, "consign art-123 75");
  assert.deepStrictEqual(calls[0], ["consign", "art-123", 75]);
  assert.ok(p.said[0].includes("auc-9"));
});

test("bid reports honest failures", () => {
  const p = mockPlayer("Player", false);
  onGalleryCommand(p, "bid auc-1 10");
  assert.ok(p.said[0].includes("too-low"));
  assert.ok(p.said[0].includes("min 50"));
});

test("bid success confirms escrow", () => {
  const p = mockPlayer("Player", false);
  onGalleryCommand(p, "bid auc-1 100");
  assert.ok(p.said[0].includes("escrow"));
});

test("commissions lists open commissions", () => {
  const p = mockPlayer("Player", false);
  onGalleryCommand(p, "commissions");
  assert.ok(p.said[0].includes("com-1"));
});

test("post validates args", () => {
  const p = mockPlayer("Player", false);
  onGalleryCommand(p, "post painting");
  assert.ok(p.said[0].includes("Usage"));
  onGalleryCommand(p, "post painting 300 A red dawn");
  assert.deepStrictEqual(calls[0], ["post", "painting", 300]);
  assert.ok(p.said[1].includes("com-9"));
});

test("accept/deliver/cancel flow", () => {
  const p = mockPlayer("Player", false);
  onGalleryCommand(p, "accept com-1");
  assert.deepStrictEqual(calls[0], ["accept", "com-1"]);
  onGalleryCommand(p, "deliver com-1 art-5");
  assert.deepStrictEqual(calls[1], ["deliver", "com-1", "art-5"]);
  assert.ok(p.said[1].includes("200 coins"));
  onGalleryCommand(p, "cancel com-1");
  assert.deepStrictEqual(calls[2], ["cancel", "com-1"]);
});

test("appraise uses the kingdom curator", () => {
  const p = mockPlayer("Player", false);
  onGalleryCommand(p, "appraise art-7");
  assert.deepStrictEqual(calls[0], ["appraise", "art-7"]);
  assert.ok(p.said[0].includes("150 coins"));
});

test("tour sends exhibitions", () => {
  const p = mockPlayer("Player", false);
  onGalleryCommand(p, "tour asgarnia kandarin");
  assert.deepStrictEqual(calls[0], ["tour", ["asgarnia", "kandarin"]]);
  assert.ok(p.said[0].includes("departs"));
});

test("unknown subcommand shows usage", () => {
  const p = mockPlayer("Player", false);
  onGalleryCommand(p, "frobnicate");
  assert.strictEqual(p.said[0], GALLERY_USAGE);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
