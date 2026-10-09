"use strict";

/**
 * CitizenCharterToll.test.js — toll collector tests: category mapping,
 * charter gating, exemption, and real coin movement.
 * Plain node:assert, no engine. Run with: node <this file>.
 */

const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const C = require("./CitizenTradeCharters");
const { onOfferConfirmed, categoryForItemName, _setItemNameForTests } = require("./CitizenCharterToll");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ctct-test-"));
C._setSavePathForTests(path.join(TMP, "citizen-trade-charters.json"));

let passed = 0;
function test(name, fn) {
  C.resetForTests();
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

function fakePlayer(username, coins, kingdomId) {
  let bal = coins;
  const messages = [];
  return {
    username,
    getUsername() {
      return username;
    },
    getAttribute(k) {
      if (k === "kingdom:id" || k === "kingdomId") return kingdomId;
      return null;
    },
    sendMessage(t) {
      messages.push(String(t));
    },
    _messages: messages,
    getInventory() {
      return {
        // Canonical ItemContainer API: getAmount(id), deleteNumber(id, amount).
        getAmount: (id) => (id === 995 ? bal : 0),
        deleteNumber: (id, n) => {
          if (id === 995) bal = Math.max(0, bal - n);
        },
      };
    },
    _bal: () => bal,
  };
}

// Seed a charter via the petition path (fame-granted standing).
function seedCharter(guildId, kingdomId, category) {
  const Rep = require("./CitizenReputation");
  const repTmp = fs.mkdtempSync(path.join(os.tmpdir(), "ctct-rep-"));
  Rep._setSavePathForTests?.(path.join(repTmp, "rep.json"));
  Rep.resetForTests?.();
  for (let i = 0; i < 10; i++) Rep.addReputation("TollBob", 10, "test", Date.now());
  let bal = 99999;
  const seeder = {
    getInventory() {
      return {
        // Canonical ItemContainer API: getAmount(id), deleteNumber(id, amount).
        getAmount: (id) => (id === 995 ? bal : 0),
        deleteNumber: (id, n) => {
          if (id === 995) bal = Math.max(0, bal - n);
        },
        // Legacy path: petitionCharter (CitizenTradeCharters.js — a different
        // file's dead-API scope) still reads inv.count / inv.delete. Kept so
        // the charter seed keeps working until that file is canonicalized.
        count: (id) => (id === 995 ? bal : 0),
        delete: (id, n) => {
          if (id === 995) bal = Math.max(0, bal - n);
        },
      };
    },
  };
  const res = C.petitionCharter("TollBob", guildId, kingdomId, category, seeder, Date.now());
  assert.equal(res.ok, true, `seed failed: ${res.reason}`);
}

test("categoryForItemName: maps product names", () => {
  assert.equal(categoryForItemName("Rune scimitar"), "weapons");
  assert.equal(categoryForItemName("Adamant platebody"), "armor");
  assert.equal(categoryForItemName("Shark"), "food");
  assert.equal(categoryForItemName("Super attack potion"), "potions");
  assert.equal(categoryForItemName("Nature rune"), "runes");
  assert.equal(categoryForItemName("Yew logs"), "lumber");
  assert.equal(categoryForItemName("Runite ore"), "ore");
  assert.equal(categoryForItemName("Diamond ring"), "jewelry");
});

test("categoryForItemName: unknown returns null (honest skip)", () => {
  assert.equal(categoryForItemName("Mysterious widget"), null);
  assert.equal(categoryForItemName(""), null);
  assert.equal(categoryForItemName(null), null);
  assert.equal(categoryForItemName("null"), null);
});

test("onOfferConfirmed: ignores buy offers and vetoed offers", () => {
  seedCharter("merchants", "asgarnia", "weapons");
  const p = fakePlayer("Seller", 1000, "asgarnia");
  onOfferConfirmed({ player: p, itemId: 1333, sell: false, accepted: true });
  onOfferConfirmed({ player: p, itemId: 1333, sell: true, accepted: false });
  assert.equal(p._bal(), 1000, "no coins taken");
  assert.equal(C.treasuryFor("merchants"), 0, "no toll accrued");
});

test("onOfferConfirmed: skips when no charter covers the goods", () => {
  const p = fakePlayer("Seller", 1000, "asgarnia");
  // No charter seeded — kandarin ore is not chartered.
  onOfferConfirmed({ player: p, itemId: 451, sell: true, accepted: true }); // runite ore
  assert.equal(p._bal(), 1000);
});

test("onOfferConfirmed: skips when seller has no kingdom", () => {
  seedCharter("merchants", "asgarnia", "weapons");
  const p = fakePlayer("Seller", 1000, null);
  onOfferConfirmed({ player: p, itemId: 1333, sell: true, accepted: true });
  assert.equal(p._bal(), 1000);
});

test("onOfferConfirmed: never throws on garbage", () => {
  onOfferConfirmed(null);
  onOfferConfirmed({});
  onOfferConfirmed({ player: null });
  assert.ok(true);
});

test("onOfferConfirmed: collects toll on chartered sale (real coins)", () => {
  seedCharter("merchants", "asgarnia", "weapons");
  _setItemNameForTests((id) => (id === 1333 ? "Rune scimitar" : null));
  try {
    const p = fakePlayer("Seller", 1000, "asgarnia");
    onOfferConfirmed({ player: p, itemId: 1333, sell: true, accepted: true });
    assert.equal(p._bal(), 1000 - C.SALE_TOLL_FLAT, "toll taken from real inventory");
    assert.equal(C.treasuryFor("merchants"), C.SALE_TOLL_FLAT, "toll credited to guild treasury");
    assert.ok(p._messages.length > 0, "seller notified");
  } finally {
    _setItemNameForTests(null);
  }
});

test("onOfferConfirmed: skips toll when seller cannot afford it", () => {
  seedCharter("merchants", "asgarnia", "weapons");
  _setItemNameForTests((id) => (id === 1333 ? "Rune scimitar" : null));
  try {
    const p = fakePlayer("PoorSeller", 5, "asgarnia");
    onOfferConfirmed({ player: p, itemId: 1333, sell: true, accepted: true });
    assert.equal(p._bal(), 5, "no coins taken from broke seller");
    assert.equal(C.treasuryFor("merchants"), 0, "no toll accrued");
  } finally {
    _setItemNameForTests(null);
  }
});

console.log(`\n${passed} tests passed`);
