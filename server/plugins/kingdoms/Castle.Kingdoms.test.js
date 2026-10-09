"use strict";

const assert = require("node:assert");
const { describe, it, beforeEach } = require("node:test");

// Minimal KingdomStore stub: the real module hits the DB. We swap the
// require cache entry before loading Castle.
const storePath = require.resolve("./KingdomStore.js");
let flagsByKingdom = {};

function resetStore() {
  flagsByKingdom = {};
  const stub = {
    getKingdom: (id) => {
      const flags = flagsByKingdom[id];
      return flags ? { id, flags } : null;
    },
    setFlag: (id, key, value) => {
      flagsByKingdom[id] = flagsByKingdom[id] ?? {};
      flagsByKingdom[id][key] = value;
    },
  };
  require.cache[storePath] = {
    id: storePath,
    filename: storePath,
    loaded: true,
    exports: stub,
  };
}

let Castle;
function loadCastle() {
  delete require.cache[require.resolve("./Castle.Kingdoms.js")];
  Castle = require("./Castle.Kingdoms.js");
}

const KID = "test-kingdom";
const CHEST = "founding:war-chest";

function seedKingdom(chestCoins) {
  flagsByKingdom[KID] = { [CHEST]: chestCoins };
}

beforeEach(() => {
  resetStore();
  loadCastle();
});

describe("Castle.Kingdoms", () => {
  it("fortTier defaults to 0, fortStrength 0", () => {
    seedKingdom(0);
    assert.strictEqual(Castle.fortTier(KID), 0);
    assert.strictEqual(Castle.fortStrength(KID), 0);
  });

  it("upgradeFort walks palisade -> stone -> battlements, deducting chest", () => {
    seedKingdom(50_000_000);
    let r = Castle.upgradeFort(KID);
    assert.ok(r.ok && r.tier === 1 && r.name === "palisade");
    assert.strictEqual(Castle.fortStrength(KID), 500);
    assert.strictEqual(flagsByKingdom[KID][CHEST], 45_000_000);

    r = Castle.upgradeFort(KID);
    assert.ok(r.ok && r.tier === 2 && r.name === "stone walls");
    assert.strictEqual(Castle.fortStrength(KID), 1500);

    r = Castle.upgradeFort(KID);
    assert.ok(r.ok && r.tier === 3 && r.name === "battlements");
    assert.strictEqual(Castle.fortStrength(KID), 3000);

    r = Castle.upgradeFort(KID);
    assert.ok(!r.ok && r.reason === "max-tier");
  });

  it("upgradeFort refuses when chest is short", () => {
    seedKingdom(1_000_000);
    const r = Castle.upgradeFort(KID);
    assert.ok(!r.ok && r.reason === "insufficient-funds");
    assert.strictEqual(Castle.fortTier(KID), 0);
  });

  it("buildBuilding requires keep first", () => {
    seedKingdom(100_000_000);
    const r = Castle.buildBuilding(KID, "barracks");
    assert.ok(!r.ok && r.reason === "requires-keep");
  });

  it("buildBuilding constructs keep then upgrades tiers", () => {
    seedKingdom(100_000_000);
    let r = Castle.buildBuilding(KID, "keep");
    assert.ok(r.ok && r.tier === 1 && r.cost === 10_000_000);
    r = Castle.buildBuilding(KID, "keep");
    assert.ok(r.ok && r.tier === 2 && r.cost === 25_000_000);
    r = Castle.buildBuilding(KID, "keep");
    assert.ok(r.ok && r.tier === 3 && r.cost === 50_000_000);
    r = Castle.buildBuilding(KID, "keep");
    assert.ok(!r.ok && r.reason === "max-tier");
    assert.deepStrictEqual(Castle.buildings(KID).keep, { tier: 3 });
  });

  it("buildBuilding allows other buildings after keep", () => {
    seedKingdom(100_000_000);
    Castle.buildBuilding(KID, "keep");
    const r = Castle.buildBuilding(KID, "chapel");
    assert.ok(r.ok && r.tier === 1);
  });

  it("buildBuilding refuses unknown ids and short chests", () => {
    seedKingdom(100_000_000);
    assert.ok(!Castle.buildBuilding(KID, "starship").ok);
    seedKingdom(1_000);
    const r = Castle.buildBuilding(KID, "keep");
    assert.ok(!r.ok && r.reason === "insufficient-funds");
  });

  it("setBanner stores colors + emblem, validates", () => {
    seedKingdom(0);
    assert.ok(!Castle.setBanner(KID, ["red"], "lion").ok);
    const r = Castle.setBanner(KID, ["red", "gold"], "lion");
    assert.ok(r.ok);
    assert.deepStrictEqual(Castle.banner(KID), { colors: ["red", "gold"], emblem: "lion" });
  });

  it("migrateWallsPaid converts the old boolean to fort tier 1", () => {
    flagsByKingdom[KID] = { [CHEST]: 0, "founding:walls-paid": true };
    assert.ok(Castle.migrateWallsPaid(KID));
    assert.strictEqual(Castle.fortTier(KID), 1);
    assert.ok(!Castle.migrateWallsPaid(KID)); // idempotent
  });

  it("returns no-kingdom for unknown ids", () => {
    assert.ok(!Castle.upgradeFort("nope").ok);
    assert.ok(!Castle.buildBuilding("nope", "keep").ok);
    assert.ok(!Castle.setBanner("nope", ["a", "b"], "x").ok);
  });
});
