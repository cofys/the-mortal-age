// ShopApi unit checks — HTTP data layer for the marketplace overlay.
// From server/: node plugins/interface/ShopApi.test.js (plain node, no server).
// Heavy deps (PlayerShops -> CitizenDirector -> compiled TS core) are stubbed
// via require.cache injection before ShopApi is loaded.
const assert = require("node:assert/strict");
const path = require("node:path");

const SHOP_API_PATH = path.resolve(__dirname, "ShopApi.js");
const STORE_PATH = path.resolve(__dirname, "../citizens/shop/PlayerShopStore.js");
const SHOPS_PATH = path.resolve(__dirname, "../citizens/shop/PlayerShops.js");
const KINGDOMS_PATH = path.resolve(__dirname, "../kingdoms/KingdomStore.js");
const AUTH_PATH = path.resolve(__dirname, "ContentApiAuth.js");

// --- stub ContentApiAuth (P0 security fix) ----------------------------------
// The test provides tokens via query params; stub validates against a test map.
const testTokens = new Map(); // token -> player
function stubModule(resolvedPath, exportsObj) {
  const m = new (require("node:module").Module)(resolvedPath, module);
  m.exports = exportsObj;
  m.loaded = true;
  require.cache[resolvedPath] = m;
}
stubModule(AUTH_PATH, {
  setPluginApi: () => {},
  requireAuth: (query) => {
    const token = query.get("token");
    return testTokens.get(token) || null;
  },
});

// --- real store, in-memory only -------------------------------------------
const Store = require(STORE_PATH);
Store.resetForTests();
Store.upsertStall({
  owner: "Jon",
  kingdomId: "misthalin",
  stock: { 526: 10 },
  prices: { 526: 12 },
  till: 500,
  employee: null,
  rentDebt: 0,
});

// --- stub PlayerShops -------------------------------------------------------

const overlayOpened = [];
const overlayClosed = [];
stubModule(SHOPS_PATH, {
  kingdomName: (id) => ({ misthalin: "Misthalin" }[id] ?? id),
  openShopOverlay: (player, view, owner) => {
    overlayOpened.push({ player: player.getUsername(), view, owner });
    player.setAttribute("shop:overlay-open", JSON.stringify({ view, owner }));
    return true;
  },
  closeShopOverlay: (player) => {
    overlayClosed.push(player.getUsername());
    player.setAttribute("shop:overlay-open", "");
  },
  stockStall: () => {},
  unstockStall: () => {},
  priceStall: () => {},
  collectTill: () => {},
  claimReturns: () => {},
  buyStall: () => {},
  fireEmployee: () => {},
  hireEmployee: () => {},
  closeOwnStall: () => {},
  hireCandidates: () => ["Sue", "Bob"],
  executePlayerSale: (api, buyer, stall, itemId, qty) => ({
    ok: true,
    qty: 2,
    cost: 24,
    message: "You buy 2 x Test Sword for 24 coins.",
  }),
});

// --- stub KingdomStore ------------------------------------------------------
stubModule(KINGDOMS_PATH, {
  getKingdoms: () => [{ id: "misthalin", name: "Misthalin" }],
  getKingdom: (id) => ({ id, name: "Misthalin" }),
});

// --- load ShopApi with a capturing api --------------------------------------
const ShopApi = require(SHOP_API_PATH);

let endpointHandler = null;
const players = new Map();

function makePlayer(username, attrs = {}) {
  const store = { ...attrs };
  const player = {
    getUsername: () => username,
    isPlayerBot: () => false,
    getAttribute: (k) => store[k],
    setAttribute: (k, v) => {
      store[k] = v;
    },
    getInventory: () => ({
      getItems: () => [
        { getId: () => 526, getAmount: () => 5 },
        { getId: () => 995, getAmount: () => 1000 },
      ],
    }),
    sendMessage: () => {},
  };
  players.set(username.toLowerCase(), player);
  return player;
}

const api = {
  core: {
    World: {
      getPlayerByName: (name) => players.get(String(name).toLowerCase()) ?? null,
    },
    ItemDefinition: {
      forId: (id) => ({ getName: () => (id === 526 ? "Test Sword" : `Item ${id}`) }),
    },
  },
  registerContentEndpoint: (name, handler) => {
    assert.equal(name, "shop-status");
    endpointHandler = handler;
  },
};

ShopApi.attach(api);
assert.ok(endpointHandler, "endpoint registered");

function query(params) {
  const map = new Map(Object.entries(params));
  return endpointHandler({ get: (k) => map.get(k) ?? null });
}

// --- no player / unknown -----------------------------------------------------
assert.deepEqual(query({}), { open: false, error: "unauthorized" });
assert.deepEqual(query({ token: "invalid" }), { open: false, error: "unauthorized" });

// --- close action ------------------------------------------------------------
const jon = makePlayer("Jon");
const jonToken = "test-token-jon";
testTokens.set(jonToken, jon);
assert.deepEqual(query({ token: jonToken, action: "close" }), { open: false });
assert.deepEqual(overlayClosed, ["Jon"]);

// --- board view ----------------------------------------------------------------
overlayOpened.length = 0;
let res = query({ token: jonToken, view: "board" });
assert.equal(res.open, true);
assert.equal(res.view, "board");
assert.equal(res.hasStall, true);
assert.equal(res.myStall.till, 500);
assert.equal(res.stalls.length, 1);
assert.equal(res.stalls[0].owner, "Jon");
assert.equal(res.kingdoms.length, 1);
assert.deepEqual(overlayOpened[0], { player: "Jon", view: "board", owner: null });

// --- manage view ---------------------------------------------------------------
res = query({ token: jonToken, view: "manage" });
assert.equal(res.open, true);
assert.equal(res.view, "manage");
assert.equal(res.wares.length, 1);
assert.equal(res.wares[0].name, "Test Sword");
assert.equal(res.wares[0].price, 12);
assert.equal(res.inventory.length, 1, "coins excluded from stockable inventory");
assert.equal(res.inventory[0].id, 526);
assert.deepEqual(res.hireCandidates, ["Sue", "Bob"]);

// --- buy mutation ---------------------------------------------------------------
res = query({ token: jonToken, view: "browse", owner: "Jon", do: "buy", item: "526", qty: "2" });
assert.equal(res.view, "browse");
assert.equal(res.notice, "You buy 2 x Test Sword for 24 coins.");

// --- browse invalid owner falls back to board ------------------------------------
res = query({ token: jonToken, view: "browse", owner: "Nobody" });
assert.equal(res.view, "board");
assert.equal(res.notice, "That stall is gone.");

// --- manage with no stall falls back to board --------------------------------------
const amy = makePlayer("Amy");
const amyToken = "test-token-amy";
testTokens.set(amyToken, amy);
res = query({ token: amyToken, view: "manage" });
assert.equal(res.view, "board");
assert.equal(res.hasStall, false);

console.log("ShopApi.test.js: all assertions passed");
