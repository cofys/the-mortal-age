// PlayerShops diegetic Market board test — clicking the board opens the overlay.
// From server/: node plugins/citizens/shop/PlayerShops.diegetic.test.js (plain node).
// Heavy deps are stubbed via require.cache injection before PlayerShops loads.
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

const SHOPS_PATH = path.resolve(__dirname, "PlayerShops.js");
const STORE_PATH = path.resolve(__dirname, "PlayerShopStore.js");
const UPKEEP_PATH = path.resolve(__dirname, "PlayerShopUpkeep.js");
const KINGDOMS_PATH = path.resolve(__dirname, "../../kingdoms/KingdomStore.js");
const DIRECTOR_PATH = path.resolve(__dirname, "../director/CitizenDirector.js");
const EVENTS_PATH = path.resolve(__dirname, "../CitizenEvents.js");
const CONSTANTS_PATH = path.resolve(__dirname, "../constants.js");
const VOICE_PATH = path.resolve(__dirname, "../lib/citizenVoice.js");
const SAYPUBLIC_PATH = path.resolve(__dirname, "../chat/CitizenSayPublic.js");
const WIDGETGROUP_PATH = path.resolve(__dirname, "../../interface/widgetGroup.js");
const DIEGETIC_PATH = path.resolve(__dirname, "../../world/DiegeticObjects.js");
function stubModule(resolvedPath, exportsObj) {
  const m = new Module(resolvedPath, module);
  m.exports = exportsObj;
  m.loaded = true;
  require.cache[resolvedPath] = m;
}

// --- stubs for heavy deps -------------------------------------------------
stubModule(STORE_PATH, {
  keyOf: (u) => String(u).toLowerCase(),
  load: () => {},
  save: () => {},
  getStall: () => null,
  peekReturns: () => [],
  MARKET_TAX_RATE: 0.05,
});
stubModule(UPKEEP_PATH, {
  processUpkeep: () => {},
  releaseEmployee: () => {},
});
stubModule(KINGDOMS_PATH, {
  getKingdom: () => null,
  grantTax: () => {},
});
stubModule(DIRECTOR_PATH, { getDirector: () => null });
stubModule(EVENTS_PATH, { isKingdomAtWar: () => false });
stubModule(CONSTANTS_PATH, {
  ATTR_CITIZEN_ROLE: "citizen:role",
  ROLE_COMMONER: "commoner",
  ATTR_CITIZEN_PERSONALITY: "citizen:personality",
});
stubModule(VOICE_PATH, { voiceFor: () => "", voiceLine: () => "" });
stubModule(SAYPUBLIC_PATH, { sayPublic: () => {} });
stubModule(WIDGETGROUP_PATH, {
  FLAG_OP1: 1, FLAG_OP2: 2, FLAG_OP3: 4,
  TYPE_GRAPHIC: 1, TYPE_TEXT: 2,
  createWidgetGroup: () => ({}),
});

// DiegeticObjects stub: only the board at a known spot matches.
const BOARD_SPOT = { x: 2967, y: 3378, z: 0 };
stubModule(DIEGETIC_PATH, {
  matchDiegetic: (objectId, location, type) => {
    if (type !== "board") return null;
    const x = location?.x ?? 0, y = location?.y ?? 0, z = location?.z ?? 0;
    if (objectId === 961 &&
        Math.abs(BOARD_SPOT.x - x) <= 2 &&
        Math.abs(BOARD_SPOT.y - y) <= 2 &&
        BOARD_SPOT.z === z) {
      return { type: "board", capitalId: "asgarnia" };
    }
    return null;
  },
});

const PlayerShops = require(SHOPS_PATH);

// --- fake player ----------------------------------------------------------
function makePlayer(username, isBot = false) {
  const attrs = {};
  return {
    getUsername: () => username,
    isPlayerBot: () => isBot,
    getAttribute: (k) => attrs[k],
    setAttribute: (k, v) => { attrs[k] = v; },
    sendMessage: () => {},
  };
}

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

test("clicking the Market board opens the shop overlay (board view)", () => {
  const player = makePlayer("Jon");
  const result = PlayerShops.onMarketBoardInteract({
    player,
    objectId: 961,
    location: { x: 2967, y: 3378, z: 0 },
  });
  assert.equal(result, true);
  const raw = player.getAttribute("shop:overlay-open");
  assert.ok(raw, "overlay attribute should be set");
  const parsed = JSON.parse(raw);
  assert.equal(parsed.view, "board");
});

test("clicking a non-board object is ignored", () => {
  const player = makePlayer("Jon");
  const result = PlayerShops.onMarketBoardInteract({
    player,
    objectId: 593, // a table, not the board
    location: { x: 2967, y: 3378, z: 0 },
  });
  assert.equal(result, false);
  assert.equal(player.getAttribute("shop:overlay-open"), undefined);
});

test("clicking the board far from a spawn is ignored", () => {
  const player = makePlayer("Jon");
  const result = PlayerShops.onMarketBoardInteract({
    player,
    objectId: 961,
    location: { x: 1000, y: 1000, z: 0 }, // nowhere near a capital
  });
  assert.equal(result, false);
  assert.equal(player.getAttribute("shop:overlay-open"), undefined);
});

test("bots cannot open the overlay via the board", () => {
  const bot = makePlayer("ShopBot", true);
  const result = PlayerShops.onMarketBoardInteract({
    player: bot,
    objectId: 961,
    location: { x: 2967, y: 3378, z: 0 },
  });
  assert.equal(result, false);
});

test("null event does not throw", () => {
  const result = PlayerShops.onMarketBoardInteract(null);
  assert.equal(result, false);
});

console.log(`\n${passed} tests passed`);
