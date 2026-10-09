"use strict";

/**
 * Regression test — merchant spawn ReferenceError (2026-10-09).
 *
 * CitizenDirector.spawnCitizen's merchant branch referenced ATTR_PRIME_MERCHANT,
 * ATTR_SUPPLIER_MERCHANT, ATTR_WARE_ITEM and ATTR_WARE_PRICE that were NOT in
 * the file's require("../constants") destructure (they ARE exported from
 * constants.js). Every merchant-role citizen threw
 * `ReferenceError: ATTR_PRIME_MERCHANT is not defined` at spawn and never
 * materialized. ACTIVITY_PRIME_MERCHANT (used for the activity attach a few
 * lines later) had the same defect.
 *
 * This test drives the REAL spawnCitizen with the engine boundary stubbed
 * (bot Player, World, bot runtime, TS Location) and asserts, for prime /
 * supplier / provisioner merchant records, that the specialization
 * attributes are set and the opening-float inventory is seeded.
 * The api.core.ItemIds map is deliberately EMPTY so the test also pins the
 * ?? fallback ids (1277 bronze sword / 2309 bread / 995 coins).
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

// ---------------------------------------------------------------------------
// Engine-boundary stubs. Installed BEFORE requiring CitizenDirector.
// ---------------------------------------------------------------------------
let currentBot = null;
let currentRuntime = null;

function makeMockBot() {
  const attributes = new Map();
  const inventoryAdds = [];
  return {
    attributes,
    inventoryAdds,
    setPlayerBot: () => {},
    setAttribute: (key, value) => {
      attributes.set(key, value);
    },
    getAttribute: (key) => attributes.get(key),
    getInventory: () => ({
      adds: (id, amount) => {
        inventoryAdds.push([id, amount]);
      },
    }),
    moveTo: () => {},
  };
}

function makeMockRuntime() {
  return {
    entries: [],
    entriesByUsername: new Map(),
    botStatesByName: new Map(),
    playerBotUsernames: new Set(),
  };
}

// Generic no-op module: anything destructured off it or read as a property
// becomes a no-op function, so heavy citizen/bot modules never load.
function genericStub() {
  const noop = () => {};
  return new Proxy(
    {},
    {
      get: (target, prop) => (typeof prop === "string" ? noop : undefined),
    }
  );
}

class StubLocation {
  constructor(x, y, z) {
    this.x = x;
    this.y = y;
    this.z = z;
  }
  clone() {
    return new StubLocation(this.x, this.y, this.z);
  }
}

function installStubs() {
  const Module = require("node:module");
  const originalLoad = Module._load;
  const path = require("node:path");

  Module._load = function (request, parent, isMain) {
    const parentFile = parent && parent.filename ? parent.filename : "";
    const isDirector = parentFile.endsWith(
      path.join("director", "CitizenDirector.js")
    );

    // TypeScript engine modules: only Location is needed on the spawn path.
    if (request.includes("src/main/typescript")) {
      if (request.endsWith("/Location")) {
        return { Location: StubLocation };
      }
      return {};
    }

    if (isDirector) {
      if (request === "../constants") {
        return originalLoad.call(this, request, parent, isMain); // REAL
      }
      if (request.includes("BotPlayerFactory")) {
        return { createBotPlayer: () => currentBot };
      }
      if (request.includes("BotRuntimeRegistry")) {
        return { getActiveBotRuntime: () => ({ runtime: currentRuntime }) };
      }
      if (request.includes("PlayerBotState")) {
        return { createInitialState: () => ({}), resetMovementState: () => {} };
      }
      if (request.includes("bots/brain/attachBrain")) {
        return { attachBrain: () => true };
      }
      return genericStub();
    }

    return originalLoad.call(this, request, parent, isMain);
  };
}

installStubs();

// REAL modules under test.
const {
  ATTR_PRIME_MERCHANT,
  ATTR_SUPPLIER_MERCHANT,
  ATTR_WARE_ITEM,
  ATTR_WARE_PRICE,
  ROLE_MERCHANT,
} = require("../constants");
const { CitizenDirector } = require("./CitizenDirector");

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
const BRONZE_SWORD = 1277; // ItemIds.BRONZE_SWORD ?? 1277
const BREAD = 2309; // ItemIds.BREAD ?? 2309
const COINS = 995; // ItemIds.COINS ?? 995

function makeRecord(merchantKind) {
  return {
    username: `Merchant Test ${merchantKind}`,
    role: ROLE_MERCHANT,
    merchantKind,
    personality: "testy",
    seed: 42,
    goal: null,
    kingdomId: "varrock",
    home: { x: 3200, y: 3200, z: 0 },
  };
}

function makeDirector() {
  const api = {
    core: {
      ItemIds: {}, // empty on purpose: pins the ?? fallback ids
      World: {
        players: { add: () => {} },
        getAddPlayerQueue: () => [],
      },
    },
    emitCustomEvent: () => {},
    emitPlayerLogin: () => {},
    log: () => {},
  };
  const registry = {
    world: {},
    byId: new Map(),
  };
  // Every activity lookup resolves, so spawnCitizen reaches the end.
  registry.byId.get = (id) => ({ id });
  return new CitizenDirector({ api, registry });
}

function spawnMerchant(merchantKind) {
  currentBot = makeMockBot();
  currentRuntime = makeMockRuntime();
  const director = makeDirector();
  const record = makeRecord(merchantKind);
  const ok = director.spawnCitizen(record);
  return { ok, bot: currentBot, record };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("CitizenDirector.spawnCitizen merchant branch", () => {
  it("spawns a prime merchant: attributes + sword/coin float, no ReferenceError", () => {
    const { ok, bot } = spawnMerchant("prime");
    assert.strictEqual(ok, true, "spawnCitizen should return true");
    assert.strictEqual(bot.attributes.get(ATTR_PRIME_MERCHANT), "1");
    assert.strictEqual(bot.attributes.get(ATTR_WARE_ITEM), BRONZE_SWORD);
    assert.strictEqual(bot.attributes.get(ATTR_WARE_PRICE), 78);
    assert.strictEqual(
      bot.attributes.has(ATTR_SUPPLIER_MERCHANT),
      false,
      "prime must not carry the supplier marker"
    );
    assert.deepStrictEqual(bot.inventoryAdds, [
      [COINS, 800],
      [BRONZE_SWORD, 10],
    ]);
  });

  it("spawns a supplier merchant: attributes + sword/coin float, no ReferenceError", () => {
    const { ok, bot } = spawnMerchant("supplier");
    assert.strictEqual(ok, true, "spawnCitizen should return true");
    assert.strictEqual(bot.attributes.get(ATTR_SUPPLIER_MERCHANT), "1");
    assert.strictEqual(bot.attributes.get(ATTR_WARE_ITEM), BRONZE_SWORD);
    assert.strictEqual(bot.attributes.get(ATTR_WARE_PRICE), 78);
    assert.strictEqual(
      bot.attributes.has(ATTR_PRIME_MERCHANT),
      false,
      "supplier must not carry the prime marker"
    );
    assert.deepStrictEqual(bot.inventoryAdds, [
      [BRONZE_SWORD, 60],
      [COINS, 300],
    ]);
  });

  it("spawns a provisioner merchant: bread float, no merchant markers", () => {
    const { ok, bot } = spawnMerchant("provisioner");
    assert.strictEqual(ok, true, "spawnCitizen should return true");
    assert.strictEqual(bot.attributes.has(ATTR_PRIME_MERCHANT), false);
    assert.strictEqual(bot.attributes.has(ATTR_SUPPLIER_MERCHANT), false);
    assert.strictEqual(bot.attributes.has(ATTR_WARE_ITEM), false);
    assert.strictEqual(bot.attributes.has(ATTR_WARE_PRICE), false);
    assert.deepStrictEqual(bot.inventoryAdds, [[BREAD, 24]]);
  });
});
