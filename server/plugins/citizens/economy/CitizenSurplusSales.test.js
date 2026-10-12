"use strict";

/**
 * CitizenSurplusSales checks — banked surplus becomes real peer trade.
 *
 * Items leave the seller's bank, coins leave the buyer's purse at the
 * Prices.Economy reference price, and both land verified. No buyer with
 * coins: nothing moves. Reserve stays home. Wartime war-supply goods skip
 * the peer flow (the quartermaster takes them).
 */
const assert = require("node:assert/strict");
const { describe, it, beforeEach } = require("node:test");

// CitizenRoutine pulls engine-wired bot modules; stub them in the require
// cache so plain-node tests stay engine-free (same pattern as
// CitizenRoutine.test.js).
function stubEngineModules() {
  const stubs = {
    "../../bots/behaviours/navigation/BotNavigation": {
      requestMovement: () => {},
      clearMovementRequest: () => {},
    },
    "../../bots/brain/actions/InteractObject": {
      createInteractObjectAction: () => ({ update: () => "running", stop: () => {} }),
    },
    "../../bots/brain/actions/Bank": {
      createBankAction: () => ({ update: () => "running", stop: () => {} }),
    },
  };
  for (const [rel, exports] of Object.entries(stubs)) {
    const path = require.resolve(rel);
    require.cache[path] = { id: path, filename: path, loaded: true, exports };
  }
}
stubEngineModules();

const Manifest = require("./SurplusManifest");
const { tickSurplusSales, attemptSale } = require("./CitizenSurplusSales");
const { isKingdomAtWar, onWarDeclared } = require("../CitizenEvents");
const {
  ATTR_CITIZEN_ROLE,
  ATTR_SUPPLIER_MERCHANT,
  ATTR_KINGDOM_ID,
  ROLE_MERCHANT,
} = require("../constants");

function mockContainer(amounts = {}) {
  const m = { ...amounts };
  return {
    getAmount: (id) => m[id] ?? 0,
    deleteNumber: (id, n) => {
      m[id] = Math.max(0, (m[id] ?? 0) - n);
    },
    adds: (id, n) => {
      m[id] = (m[id] ?? 0) + n;
    },
    getFreeSlots: () => 27,
    _m: m,
  };
}

function mockBot({ bank = {}, inv = {}, attrs = {}, locals = [], username = "Seller" }) {
  const bankC = mockContainer(bank);
  const invC = mockContainer(inv);
  return {
    getBank: (tab) => (tab === 0 ? bankC : null),
    getInventory: () => invC,
    getAttribute: (k) => attrs[k] ?? null,
    getUsername: () => username,
    isPlayerBot: () => true,
    getLocalPlayers: () => locals,
    getCombat: () => ({ isInCombat: () => false }),
    _bank: bankC,
    _inv: invC,
  };
}

function sellerBot(bank, locals, username = "FisherAino") {
  return mockBot({
    bank,
    inv: {},
    attrs: { [ATTR_KINGDOM_ID]: "asgarnia" },
    locals,
    username,
  });
}

function buyerBot(inv, username = "BuyerBram", merchant = false) {
  return mockBot({
    bank: {},
    inv,
    attrs: {
      [ATTR_KINGDOM_ID]: "asgarnia",
      ...(merchant ? { [ATTR_CITIZEN_ROLE]: ROLE_MERCHANT, [ATTR_SUPPLIER_MERCHANT]: "1" } : {}),
    },
    locals: [],
    username,
  });
}

const rngAlways = () => 0; // always below the sale chance

describe("CitizenSurplusSales", () => {
  beforeEach(() => Manifest._resetManifest());

  it("sells banked surplus to a local buyer at the reference price", () => {
    const buyer = buyerBot({ 995: 1000 });
    const seller = sellerBot({ 317: 40 }, [buyer]); // 28 surplus shrimps
    const price = Manifest.referencePrice(317);
    assert.ok(price >= 1);

    const paid = attemptSale(seller, { username: "FisherAino" }, "asgarnia", rngAlways);

    const qty = Math.min(28, 24, Math.floor(1000 / price));
    assert.equal(paid, qty * price);
    assert.equal(seller._bank.getAmount(317), 40 - qty); // reserve 12 stays
    assert.equal(seller._inv.getAmount(995), qty * price); // coins arrived
    assert.equal(buyer._inv.getAmount(995), 1000 - qty * price); // coins left
    assert.equal(buyer._inv.getAmount(317), qty); // goods arrived
    const [m] = Manifest.recentMovements(1);
    assert.equal(m.kind, "peer-sale");
    assert.equal(m.originKingdom, "asgarnia");
    assert.equal(m.qty, qty);
  });

  it("keeps the personal reserve and sells nothing when the bank is at reserve", () => {
    const buyer = buyerBot({ 995: 1000 });
    const seller = sellerBot({ 317: 12 }, [buyer]);
    const paid = attemptSale(seller, { username: "FisherAino" }, "asgarnia", rngAlways);
    assert.equal(paid, 0);
    assert.equal(seller._bank.getAmount(317), 12);
    assert.equal(buyer._inv.getAmount(995), 1000);
  });

  it("moves nothing when no local buyer has coins", () => {
    const broke = buyerBot({ 995: 0 });
    const seller = sellerBot({ 317: 40 }, [broke]);
    const paid = attemptSale(seller, { username: "FisherAino" }, "asgarnia", rngAlways);
    assert.equal(paid, 0);
    assert.equal(seller._bank.getAmount(317), 40);
  });

  it("routes timber through merchant buyers only", () => {
    const commoner = buyerBot({ 995: 5000 }, "CommonerCat", false);
    const merchant = buyerBot({ 995: 5000 }, "MerchantMoe", true);
    const seller = sellerBot({ 1511: 40 }, [commoner, merchant]);
    const paid = attemptSale(seller, { username: "ChopperCid" }, "asgarnia", rngAlways);
    assert.ok(paid > 0, "merchant should buy the logs");
    assert.equal(commoner._inv.getAmount(995), 5000); // commoner untouched
    assert.ok(merchant._inv.getAmount(1511) > 0);
  });

  it("skips war-supply goods while the kingdom is at war", () => {
    onWarDeclared({ attackerId: "asgarnia", defenderId: "misthalin" });
    assert.ok(isKingdomAtWar("asgarnia"));
    try {
      const buyer = buyerBot({ 995: 10000 });
      const seller = sellerBot({ 1511: 100 }, [buyer]); // logs are war materials
      const paid = attemptSale(seller, { username: "ChopperCid" }, "asgarnia", rngAlways);
      assert.equal(paid, 0, "wartime logs belong to the quartermaster flow");
      assert.equal(seller._bank.getAmount(1511), 100);
    } finally {
      // warsByKingdom is module state; the next test file gets a fresh
      // require cache only if run in a separate process — node --test
      // isolates files, so no cross-file cleanup needed.
    }
  });

  it("tickSurplusSales moves goods for online citizens and caps sellers", () => {
    const buyer = buyerBot({ 995: 100000 }, "MarketBuyer", true);
    const mkSeller = (i) => {
      const bot = sellerBot({ 317: 40 }, [buyer], `Seller${i}`);
      return { username: `Seller${i}`, kingdomId: "asgarnia", _bot: bot };
    };
    const records = Array.from({ length: 12 }, (_, i) => mkSeller(i));
    const roster = new Map(records.map((r) => [r.username, r]));
    const director = {
      roster,
      isOnline: () => true,
      getBot: (r) => r._bot,
    };
    // 6% per citizen is intentionally rare — retry ticks until the flow
    // fires, then assert the per-tick cap holds.
    let sellers = 0;
    let tries = 0;
    while (sellers === 0 && tries++ < 60) {
      sellers = tickSurplusSales(director, 12);
    }
    assert.ok(sellers > 0 && sellers <= 8, `sellers ${sellers} within cap`);
    const moved = Manifest.recentMovements(50).filter((m) => m.kind === "peer-sale");
    assert.equal(moved.length, sellers);
    // Conservation: every coin the buyers lost, sellers gained; no minting.
    const buyerLost = 100000 - buyer._inv.getAmount(995);
    const sellersGained = records.reduce((s, r) => s + r._bot._inv.getAmount(995), 0);
    assert.equal(buyerLost, sellersGained);
  });
});
