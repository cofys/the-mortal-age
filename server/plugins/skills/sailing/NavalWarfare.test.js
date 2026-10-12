// Naval warfare Phase 1 tests — notoriety, cannon math, hull damage, targeting.
// Pure-logic + stubbed-engine tests; no running server.
//
// Run: node -r ts-node/register/transpile-only server/plugins/skills/sailing/NavalWarfare.test.js
require("ts-node").register({ transpileOnly: true });

const assert = require("node:assert/strict");
const path = require("node:path");

const SAIL = path.resolve(__dirname);

// ---------------------------------------------------------------------------
// Stub the engine modules in require.cache before the plugins load.
// ---------------------------------------------------------------------------
function stubEngine() {
  // Facility table: hotspot -> db row id; rows resolve to names via CacheDefinitions.
  const facilityRows = new Map(); // hotspot -> row id
  const rowNames = new Map(); // row id -> facility name
  const stubs = {
    "src/main/typescript/elvarg/game/content/sailing/Sailing": {
      Sailing: {
        instanceAboard: () => undefined,
        activeBoat: () => undefined,
        sink: () => {},
      },
    },
    "src/main/typescript/elvarg/game/content/sailing/BoatManager": {
      BoatManager: { all: () => [], getSpec: () => undefined },
    },
    "src/main/typescript/elvarg/game/content/sailing/Boat": {
      BoatMoveMode: { Full: 1, Half: 2, Stopped: 3 },
    },
    "src/main/typescript/elvarg/game/World": {
      World: { getPlayers: () => [] },
    },
    "src/main/typescript/elvarg/game/model/Skill": {
      Skill: { SAILING: 21 },
    },
    "src/main/typescript/elvarg/game/model/Item": {
      Item: class {
        constructor(id, amount) {
          this.id = id;
          this.amount = amount;
        }
      },
    },
    "src/main/typescript/elvarg/game/cache/CacheDefinitions": {
      CacheDefinitions: {
        getDbRow: (row) => ({
          string: () => rowNames.get(row),
        }),
      },
    },
  };
  for (const [rel, exports] of Object.entries(stubs)) {
    const resolved = require.resolve(path.resolve(rel));
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
  }
  // Local data modules: stub boatStats, facilities, and content.
  const boatPartsPath = require.resolve(path.join(SAIL, "boatParts.js"));
  require.cache[boatPartsPath] = {
    id: boatPartsPath, filename: boatPartsPath, loaded: true,
    exports: { boatStats: () => ({ hitpoints: 100 }) },
  };
  const boatFacilitiesPath = require.resolve(path.join(SAIL, "boatFacilities.js"));
  require.cache[boatFacilitiesPath] = {
    id: boatFacilitiesPath, filename: boatFacilitiesPath, loaded: true,
    exports: {
      facilitiesOf: () => [...facilityRows.keys()],
      facilityAt: (owned, hotspot) => facilityRows.get(hotspot),
      FACILITY: { name: "name" },
      __setFacility: (hotspot, row, name) => {
        facilityRows.set(hotspot, row);
        rowNames.set(row, name);
      },
      __clearFacilities: () => { facilityRows.clear(); rowNames.clear(); },
    },
  };
  const sailingContentPath = require.resolve(path.join(SAIL, "sailingContent.js"));
  require.cache[sailingContentPath] = {
    id: sailingContentPath, filename: sailingContentPath, loaded: true,
    exports: { content: () => ({ boats: [{ type: "sloop" }] }) },
  };
  return require.cache[boatFacilitiesPath].exports;
}
const facilitiesStub = stubEngine();

// Real notoriety module (no engine deps); navalCombat with stubbed engine.
const { notorietyOf, addNotoriety, decayNotoriety } = require("./navalNotoriety.js");
const naval = require("./navalCombat.js");

// ---------------------------------------------------------------------------
// Mock player.
// ---------------------------------------------------------------------------
function mockPlayer(opts = {}) {
  const attrs = new Map(Object.entries(opts.attrs ?? {}));
  const messages = [];
  return {
    __messages: messages,
    getAttribute: (k) => attrs.get(k),
    setAttribute: (k, v) => void attrs.set(k, v),
    sendMessage: (msg) => void messages.push(msg),
  };
}

/** Deterministic PRNG. */
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Notoriety.
// ---------------------------------------------------------------------------
{
  const p = mockPlayer();
  assert.equal(notorietyOf(p), 0, "default notoriety is 0");
  assert.equal(addNotoriety(p, 30), 30);
  assert.ok(p.__messages.some((m) => m.toLowerCase().includes("pirate havens")), "25 threshold announces");
  assert.equal(addNotoriety(p, 1000), 100, "clamps at 100");
  assert.equal(addNotoriety(p, -1000), 0, "clamps at 0");
  console.log("ok - notoriety add/clamp/thresholds");
}
{
  const dayMs = 24 * 60 * 60 * 1000;
  const now = 1_700_000_000_000;
  const p = mockPlayer({ attrs: { "naval:notoriety": 50, "naval:notoriety-decay": now - 2 * dayMs } });
  decayNotoriety(p, now);
  assert.equal(notorietyOf(p), 44, "decays 3 per full day");
  console.log("ok - notoriety decay");
}
{
  const p = mockPlayer({ attrs: { "naval:notoriety": "pirate" } });
  assert.equal(notorietyOf(p), 0, "non-numeric attribute reads as 0");
  console.log("ok - notoriety junk attribute");
}

// ---------------------------------------------------------------------------
// Targeting math.
// ---------------------------------------------------------------------------
{
  assert.equal(naval.distance(0, 0, 3, 4), 4, "chebyshev distance");
  assert.equal(naval.distance(5, 5, 5, 5), 0);
  const north = naval.angleToward(0, 0, 0, 10);
  assert.ok(Math.abs(north - 1024) < 2, `north is ~1024, got ${north}`);
  const south = naval.angleToward(0, 0, 0, -10);
  assert.ok(south < 2 || south > 2046, `south is ~0, got ${south}`);
  console.log("ok - distance and angleToward");
}

// ---------------------------------------------------------------------------
// Cannons.
// ---------------------------------------------------------------------------
{
  facilitiesStub.__clearFacilities();
  facilitiesStub.__setFacility(0, 101, "Bronze cannon");
  facilitiesStub.__setFacility(1, 102, "Iron cannon");
  facilitiesStub.__setFacility(2, 103, "Oak mast"); // not a cannon
  const cannons = naval.cannonsOf({});
  assert.equal(cannons.count, 2, "counts cannon facilities");
  assert.equal(cannons.tier, 1, "best tier is iron (index 1)");
  console.log("ok - cannonsOf count and tier");
}
{
  const random = lcg(42);
  const damage = naval.broadsideDamage({ count: 2, tier: 1 }, random);
  // 2 cannons * (8 + 4*1) = 24 base, rolled with seeded jitter in [0.85, 1.15).
  assert.ok(damage >= 20 && damage <= 28, `damage in range, got ${damage}`);
  const damage2 = naval.broadsideDamage({ count: 2, tier: 1 }, lcg(42));
  assert.equal(damage, damage2, "seeded damage is deterministic");
  console.log("ok - broadsideDamage");
}

// ---------------------------------------------------------------------------
// Hull.
// ---------------------------------------------------------------------------
{
  const owned = { hitpoints: 0 };
  assert.equal(naval.maxHullOf(owned), 100);
  assert.equal(naval.hullOf(owned), 100, "undamaged boat reads full");
  naval.setHull(owned, 40);
  assert.equal(naval.hullOf(owned), 40);
  naval.setHull(owned, 999);
  assert.equal(naval.hullOf(owned), 100, "clamps at max");
  console.log("ok - hull get/set/clamp");
}
{
  const owned = { hitpoints: 100 };
  const noFire = naval.damageHull(owned, null, 10, () => 0.99);
  assert.equal(noFire.sunk, false);
  assert.equal(noFire.fireStarted, false);
  assert.equal(naval.hullOf(owned), 90);
  const fire = naval.damageHull(owned, null, 10, () => 0.01);
  assert.equal(fire.fireStarted, true, "low roll starts a fire");
  assert.ok(owned.combatFireTicks > 0);
  const sunk = naval.damageHull(owned, null, 1000, () => 0.99);
  assert.equal(sunk.sunk, true);
  assert.equal(owned.hitpoints, 0, "persisted HP is 0 when sunk");
  // Note: hullOf reads 0/unset as full by design (new boats have 0 hitpoints).
  console.log("ok - damageHull fire and sinking");
}

// ---------------------------------------------------------------------------
// Targeting: kraken in range.
// ---------------------------------------------------------------------------
{
  // Kraken lair at (2590, 4170); broadside range 10.
  const near = naval.findTarget({ x: 2590, y: 4165 });
  assert.ok(near && near.kind === "kraken", "kraken found in range");
  const far = naval.findTarget({ x: 3000, y: 3000 });
  assert.equal(far, undefined, "nothing in range far away");
  console.log("ok - findTarget kraken");
}

console.log("\nAll naval warfare tests passed.");
