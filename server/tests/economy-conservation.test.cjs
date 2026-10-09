// Economy coin-conservation tests — every coin movement must balance.
//
// These tests exercise the REAL modules (not just unit seams) with inventory
// mocks that faithfully replicate the core ItemContainer API — notably that
// add(item, refresh) takes an Item OBJECT, while adds(id, amount) takes an
// id. A previous treasury/supply bug used the wrong overload and silently
// deleted coins; the mocks here throw exactly like the core does so a
// regression fails loudly.
//
// Run from server/: node --test tests/economy-conservation.test.cjs
const assert = require("node:assert/strict");
const { describe, it, beforeEach } = require("node:test");
const path = require("node:path");
const Module = require("node:module");

const COINS = 995;
const BREAD = 2309;

// --- faithful inventory mock -----------------------------------------------
// Replicates ItemContainer semantics: adds(id, amount) and
// delete/deleteNumber(id, amount) take ids; add(item, refresh) takes an Item
// object and throws TypeError when handed a raw id (as the real one does
// when it calls item.getId()).
function mockInventory({ coins = 0, items = {}, freeSlots = 28, stackable = true } = {}) {
  const state = { coins, items: { ...items }, freeSlots, stackable };
  return {
    getAmount: (id) => (id === COINS ? state.coins : state.items[id] ?? 0),
    containsNumber: (id) => (id === COINS ? state.coins : state.items[id] ?? 0) > 0,
    getFreeSlots: () => state.freeSlots,
    adds: (id, n) => {
      n = Math.floor(n);
      if (!(n > 0)) return;
      if (id === COINS) state.coins += n;
      else {
        if (!state.stackable && state.freeSlots < n) {
          throw new Error("Not enough inventory space.");
        }
        state.items[id] = (state.items[id] ?? 0) + n;
        if (!state.stackable) state.freeSlots -= n;
      }
    },
    add: (item, refresh) => {
      // Faithful to the core: add(item: Item, refresh: boolean).
      if (!item || typeof item.getId !== "function") {
        throw new TypeError("item.getId is not a function");
      }
      const id = item.getId();
      const n = item.getAmount();
      if (id === COINS) state.coins += n;
      else state.items[id] = (state.items[id] ?? 0) + n;
    },
    delete: (id, n) => {
      n = Math.floor(n);
      if (id === COINS) state.coins = Math.max(0, state.coins - n);
      else state.items[id] = Math.max(0, (state.items[id] ?? 0) - n);
    },
    deleteNumber: function (id, n) {
      return this.delete(id, n);
    },
    refreshItems: () => {},
    _state: state,
  };
}

function mockPlayer({ coins = 0, username = "test-player", bot = false, invOpts = {} } = {}) {
  const inv = mockInventory({ coins, ...invOpts });
  const attrs = {};
  return {
    getUsername: () => username,
    isPlayerBot: () => bot,
    getAttribute: (k) => attrs[k] ?? null,
    setAttribute: (k, v) => {
      attrs[k] = v;
    },
    getInventory: () => inv,
    sendMessage: () => {},
    busy: () => false,
    _inv: inv,
    _attrs: attrs,
  };
}

// --- module loading ----------------------------------------------------------
function stubModule(resolvedPath, exportsObj) {
  const m = new Module(resolvedPath, module);
  m.exports = exportsObj;
  m.loaded = true;
  require.cache[resolvedPath] = m;
}

const ROOT = path.resolve(__dirname, "..");
// Tension.Kingdoms pulls the TS core graph (Task) — stub it; deliverSupplies
// never touches it.
stubModule(path.join(ROOT, "plugins/kingdoms/Tension.Kingdoms.js"), {});

const KingdomStore = require("../plugins/kingdoms/KingdomStore");
const Treasury = require("../plugins/kingdoms/Treasury.Kingdoms");
const ShopStore = require("../plugins/citizens/shop/PlayerShopStore");
const Shoppers = require("../plugins/citizens/shop/CitizenShoppers");
const Upkeep = require("../plugins/citizens/shop/PlayerShopUpkeep");
const OfficeTools = require("../plugins/kingdoms/OfficeTools.Kingdoms");
const Membership = require("../plugins/kingdoms/Membership.Kingdoms");

// PlayerShops needs its heavy deps stubbed (same pattern as its diegetic test),
// but the REAL shop store + kingdom store so conservation is genuine.
const SHOPS = path.join(ROOT, "plugins/citizens/shop/PlayerShops.js");
stubModule(path.join(ROOT, "plugins/citizens/shop/PlayerShopUpkeep.js"), {
  processUpkeep: () => {},
  releaseEmployee: () => {},
});
stubModule(path.join(ROOT, "plugins/citizens/director/CitizenDirector.js"), {
  getDirector: () => null,
});
stubModule(path.join(ROOT, "plugins/citizens/CitizenEvents.js"), {
  isKingdomAtWar: () => false,
});
stubModule(path.join(ROOT, "plugins/citizens/constants.js"), {
  ATTR_CITIZEN_ROLE: "citizen:role",
  ROLE_COMMONER: "commoner",
  ATTR_CITIZEN_PERSONALITY: "citizen:personality",
});
stubModule(path.join(ROOT, "plugins/citizens/lib/citizenVoice.js"), {
  voiceFor: () => "",
  voiceLine: () => "",
});
stubModule(path.join(ROOT, "plugins/citizens/chat/CitizenSayPublic.js"), {
  sayPublic: () => {},
});
stubModule(path.join(ROOT, "plugins/interface/widgetGroup.js"), {
  FLAG_OP1: 1,
  FLAG_OP2: 2,
  FLAG_OP3: 4,
  TYPE_GRAPHIC: 1,
  TYPE_TEXT: 2,
  createWidgetGroup: () => ({}),
});
const PlayerShops = require(SHOPS);

function seedKingdom(id = "asgarnia", treasury = 100000) {
  KingdomStore.resetForTests();
  KingdomStore.upsertKingdom({
    id,
    name: "Asgarnia",
    capital: "Falador",
    hierarchy: ["Subject", "Knight"],
    treasury,
  });
}

function seedStall(owner = "stall-owner", overrides = {}) {
  ShopStore.resetForTests();
  ShopStore.upsertStall({
    owner,
    ownerKey: owner.toLowerCase(),
    kingdomId: "asgarnia",
    createdAt: Date.now(),
    stock: {},
    prices: {},
    till: 0,
    employee: null,
    lastWageAt: Date.now(),
    lastRentAt: Date.now(),
    rentDebt: 0,
    ...overrides,
  });
  return ShopStore.getStall(owner.toLowerCase());
}

beforeEach(() => {
  seedKingdom();
});

// --- treasury ----------------------------------------------------------------
describe("Treasury.grantFromTreasury conserves coins", () => {
  it("debits the treasury and credits the player 1:1", () => {
    const target = mockPlayer({ coins: 100 });
    const before = KingdomStore.getKingdom("asgarnia").treasury + target._inv._state.coins;
    const res = Treasury.grantFromTreasury("asgarnia", mockPlayer({ username: "steward" }), target, 5000);
    assert.equal(res.ok, true);
    assert.equal(res.granted, 5000);
    assert.equal(KingdomStore.getKingdom("asgarnia").treasury, 95000);
    assert.equal(target._inv._state.coins, 5100);
    const after = KingdomStore.getKingdom("asgarnia").treasury + target._inv._state.coins;
    assert.equal(after, before, "coins must be conserved across a grant");
  });

  it("refunds the treasury when the credit fails (no silent deletion)", () => {
    const target = mockPlayer({ coins: 100 });
    target.getInventory = () => {
      throw new Error("inventory exploded");
    };
    const res = Treasury.grantFromTreasury("asgarnia", mockPlayer({ username: "steward" }), target, 5000);
    assert.equal(res.ok, false);
    assert.equal(
      KingdomStore.getKingdom("asgarnia").treasury,
      100000,
      "failed grant must refund the treasury"
    );
  });

  it("regression: the old add(id, amount) overload deleted the grant", () => {
    // The faithful mock's add() throws on a raw id, exactly like the core.
    // The pre-fix code called inventory.add(COINS_ID, cost): treasury debited,
    // player never paid, catch swallowed it. This test fails on that code.
    const target = mockPlayer({ coins: 0 });
    const res = Treasury.grantFromTreasury("asgarnia", mockPlayer({ username: "steward" }), target, 1000);
    assert.equal(res.ok, true);
    assert.equal(target._inv._state.coins, 1000, "player must actually receive the grant");
  });
});

describe("Treasury.collectTax conserves coins", () => {
  it("moves the fealty tax from purse to treasury 1:1", () => {
    const p = mockPlayer({ coins: 1000 });
    const before = p._inv._state.coins + KingdomStore.getKingdom("asgarnia").treasury;
    const taken = Treasury.collectTax(p, "asgarnia", "fealty", () => {});
    assert.equal(taken, Treasury.FEALTY_TAX);
    assert.equal(p._inv._state.coins, 1000 - Treasury.FEALTY_TAX);
    assert.equal(KingdomStore.getKingdom("asgarnia").treasury, 100000 + Treasury.FEALTY_TAX);
    const after = p._inv._state.coins + KingdomStore.getKingdom("asgarnia").treasury;
    assert.equal(after, before);
  });
});

// --- citizen shoppers (offline trading) ---------------------------------------
describe("CitizenShoppers.executeSale conserves coins and items", () => {
  const director = {
    api: {
      core: {
        ItemDefinition: {
          forId: () => ({ isStackable: () => true, getName: () => "Bread" }),
        },
      },
      emitCustomEvent: () => {},
    },
  };

  it("buyer coins + till + treasury balance; stock decrements", () => {
    const bot = mockPlayer({ coins: 10000, username: "citizen-bob", bot: true });
    const stall = seedStall("stall-owner", {
      stock: { [BREAD]: 10 },
      prices: { [BREAD]: 12 },
      till: 0,
      employee: "citizen-bob",
    });
    const coinsBefore = bot._inv._state.coins + stall.till + KingdomStore.getKingdom("asgarnia").treasury;
    const itemsBefore = (stall.stock[BREAD] ?? 0) + bot._inv._state.items[BREAD] ?? 0;

    const result = Shoppers.executeSale(director, bot, {}, stall, String(BREAD), 3, 12);
    assert.ok(result, "sale should succeed");
    const cost = 36;
    const tax = Math.floor(cost * ShopStore.MARKET_TAX_RATE); // 1
    assert.equal(bot._inv._state.coins, 10000 - cost);
    assert.equal(bot._inv._state.items[BREAD], 3);
    assert.equal(stall.stock[BREAD], 7);
    assert.equal(stall.till, cost - tax);
    assert.equal(KingdomStore.getKingdom("asgarnia").treasury, 100000 + tax);
    const coinsAfter = bot._inv._state.coins + stall.till + KingdomStore.getKingdom("asgarnia").treasury;
    assert.equal(coinsAfter, coinsBefore, "coin conservation across buyer/till/treasury");
    const itemsAfter = (stall.stock[BREAD] ?? 0) + (bot._inv._state.items[BREAD] ?? 0);
    assert.equal(itemsAfter, 10, "item conservation across stall/buyer");
  });

  it("a failed transfer leaves the stall untouched (no stock burn, no mint)", () => {
    // Non-stackable ware, buyer inventory full: the old code debited the
    // stall and saved BEFORE the transfer threw — destroying stock and
    // minting till coins.
    const bot = mockPlayer({
      coins: 10000,
      username: "citizen-bob",
      bot: true,
      invOpts: { freeSlots: 0, stackable: false },
    });
    const stall = seedStall("stall-owner", {
      stock: { [BREAD]: 10 },
      prices: { [BREAD]: 12 },
      till: 0,
      employee: "citizen-bob",
    });
    const noRoomDirector = {
      api: {
        core: {
          ItemDefinition: {
            forId: () => ({ isStackable: () => false, getName: () => "Sword" }),
          },
        },
        emitCustomEvent: () => {},
      },
    };
    const result = Shoppers.executeSale(noRoomDirector, bot, {}, stall, String(BREAD), 2, 12);
    assert.equal(result, false, "sale must fail cleanly");
    assert.equal(stall.stock[BREAD], 10, "stall stock must be untouched");
    assert.equal(stall.till, 0, "till must be untouched");
    assert.equal(bot._inv._state.coins, 10000, "buyer keeps their coins");
    assert.equal(KingdomStore.getKingdom("asgarnia").treasury, 100000);
  });
});

// --- player-to-player stall sales ----------------------------------------------
describe("PlayerShops.executePlayerSale conserves coins", () => {
  const api = {
    core: {
      ItemDefinition: {
        forId: () => ({ getName: () => "Bread", isStackable: () => true }),
      },
    },
    emitCustomEvent: () => {},
  };

  it("buyer pays, till grows minus tax, kingdom gets the tax", () => {
    const buyer = mockPlayer({ coins: 10000, username: "buyer" });
    const stall = seedStall("stall-owner", {
      stock: { [BREAD]: 10 },
      prices: { [BREAD]: 12 },
      till: 0,
      employee: "some-hand", // stall open without the owner online
    });
    const coinsBefore = buyer._inv._state.coins + stall.till + KingdomStore.getKingdom("asgarnia").treasury;
    const result = PlayerShops.executePlayerSale(api, buyer, stall, BREAD, 3);
    assert.equal(result.ok, true);
    assert.equal(result.qty, 3);
    const cost = 36;
    const tax = Math.floor(cost * ShopStore.MARKET_TAX_RATE);
    assert.equal(buyer._inv._state.coins, 10000 - cost);
    assert.equal(stall.till, cost - tax);
    assert.equal(KingdomStore.getKingdom("asgarnia").treasury, 100000 + tax);
    const coinsAfter = buyer._inv._state.coins + stall.till + KingdomStore.getKingdom("asgarnia").treasury;
    assert.equal(coinsAfter, coinsBefore);
  });

  it("cannot oversell stock or overcharge", () => {
    const buyer = mockPlayer({ coins: 1000000, username: "buyer" });
    const stall = seedStall("stall-owner", {
      stock: { [BREAD]: 2 },
      prices: { [BREAD]: 12 },
      till: 0,
      employee: "some-hand",
    });
    const result = PlayerShops.executePlayerSale(api, buyer, stall, BREAD, 5000);
    assert.equal(result.ok, true);
    assert.equal(result.qty, 2, "clamped to stock");
    assert.equal(result.cost, 24);
    assert.equal(stall.stock[BREAD], 0);
  });
});

// --- upkeep: wages and rent ------------------------------------------------------
describe("PlayerShopUpkeep.processUpkeep accounting", () => {
  const hooks = {};

  it("deducts exactly one daily wage per day, advancing the watermark", () => {
    const twoDaysAgo = Date.now() - 2 * ShopStore.DAY_MS - 1000;
    seedStall("stall-owner", {
      till: 1000,
      employee: "hand",
      lastWageAt: twoDaysAgo,
      lastRentAt: Date.now(),
    });
    Upkeep.processUpkeep(hooks, Date.now());
    const stall = ShopStore.getStall("stall-owner");
    assert.equal(stall.till, 1000 - 2 * ShopStore.DAILY_WAGE);
    assert.ok(Date.now() - stall.lastWageAt < ShopStore.DAY_MS, "watermark advances by whole days");
    // Second sweep immediately: no double-pay.
    Upkeep.processUpkeep(hooks, Date.now());
    assert.equal(ShopStore.getStall("stall-owner").till, 1000 - 2 * ShopStore.DAILY_WAGE);
  });

  it("releases the employee instead of going negative when the till is short", () => {
    seedStall("stall-owner", {
      till: 10,
      employee: "hand",
      lastWageAt: Date.now() - 2 * ShopStore.DAY_MS,
      lastRentAt: Date.now(),
    });
    Upkeep.processUpkeep(hooks, Date.now());
    const stall = ShopStore.getStall("stall-owner");
    assert.equal(stall.employee, null, "unpaid hand walks");
    assert.equal(stall.till, 10, "till never goes negative for wages");
  });

  it("collects weekly rent and tracks arrears without repossessing early", () => {
    const { weeklyRent } = ShopStore.stallCosts("asgarnia");
    seedStall("stall-owner", {
      till: weeklyRent * 3,
      lastRentAt: Date.now() - ShopStore.WEEK_MS - 1000,
      lastWageAt: Date.now(),
    });
    Upkeep.processUpkeep(hooks, Date.now());
    const stall = ShopStore.getStall("stall-owner");
    assert.equal(stall.till, weeklyRent * 2);
    assert.equal(stall.rentDebt, 0);
    assert.ok(ShopStore.getStall("stall-owner"), "stall survives one paid week");
  });

  it("repossesses after MISSED_RENT_WEEKS of arrears and queues returns", () => {
    seedStall("stall-owner", {
      till: 0,
      stock: { [BREAD]: 5 },
      lastRentAt: Date.now() - 3 * ShopStore.WEEK_MS,
      lastWageAt: Date.now(),
    });
    Upkeep.processUpkeep(hooks, Date.now());
    assert.equal(ShopStore.getStall("stall-owner"), null, "stall repossessed");
    const returns = ShopStore.peekReturns("stall-owner");
    const bread = returns.find((r) => r.id === BREAD);
    assert.ok(bread && bread.qty === 5, "stock queued for claim");
  });
});

// --- quartermaster supply deliveries --------------------------------------------
describe("OfficeTools.deliverSupplies pays the supplier", () => {
  it("moves goods out and coins in 1:1 (regression: payout used wrong overload)", () => {
    seedKingdom("asgarnia", 100000);
    OfficeTools.setSupplyOrder("asgarnia", { units: 100, pricePer: 5, by: "quartermaster" });
    const supplier = mockPlayer({ coins: 0, username: "supplier" });
    supplier.setAttribute(Membership.KINGDOM_ID_ATTRIBUTE, "asgarnia");
    supplier._inv._state.items[BREAD] = 10;

    const treasuryBefore = KingdomStore.getKingdom("asgarnia").treasury;
    const res = OfficeTools.deliverSupplies(supplier, "asgarnia", BREAD, 10);
    assert.equal(res.ok, true, res.message);
    // Bread: 2 units each; 10 bread = 20 units @ 5c = 100c payout.
    assert.equal(supplier._inv._state.items[BREAD], 0, "goods leave the supplier");
    assert.equal(supplier._inv._state.coins, 100, "supplier is actually paid");
    assert.equal(
      KingdomStore.getKingdom("asgarnia").treasury,
      treasuryBefore - 100,
      "treasury pays exactly the payout"
    );
    const coinsAfter = supplier._inv._state.coins + KingdomStore.getKingdom("asgarnia").treasury;
    assert.equal(coinsAfter, treasuryBefore, "coin conservation across supplier/treasury");
  });
});
