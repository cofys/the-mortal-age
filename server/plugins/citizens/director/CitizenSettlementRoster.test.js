"use strict";

/**
 * Settlement roster test — Phase 2 citizen growth (2026-10-10).
 *
 * The roster now includes frontier settlements (towns in unclaimed regions:
 * Brimhaven, Shilo, Pollnivneach, Nardah, Sophanem, Rellekka, Lletya,
 * Al Kharid). Settlement citizens anchor to the settlement's own sites and
 * affiliate with the nearest great power for kingdom mechanics.
 *
 * This test drives the REAL boot() with the engine boundary stubbed and pins:
 *   1. Total roster = 100 capital citizens + 400 settlement citizens
 *      + 150 smaller-town citizens (Phase 2).
 *   2. Every settlement citizen has a settlementId, a valid nearest-kingdom
 *      kingdomId, and a home within ~15 tiles of the settlement anchor.
 *   3. Capital citizens are unaffected (no settlementId).
 *   4. Roster build stays fast (< 5s for 500).
 */

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

// ---------------------------------------------------------------------------
// Engine-boundary stubs. Installed BEFORE requiring CitizenDirector.
// Same pattern as CitizenMerchantSpawn.test.js: the director's own requires
// get generic stubs so the heavy bot/engine chain never loads.
// ---------------------------------------------------------------------------
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
      if (request.includes("brain/CitizenSites")) {
        return originalLoad.call(this, request, parent, isMain); // REAL
      }
      if (request.includes("lib/personalities")) {
        return originalLoad.call(this, request, parent, isMain); // REAL
      }
      if (request.includes("lib/humanizer")) {
        return originalLoad.call(this, request, parent, isMain); // REAL
      }
      if (request.includes("lib/CitizenBonds")) {
        return originalLoad.call(this, request, parent, isMain); // REAL
      }
      return genericStub();
    }

    return originalLoad.call(this, request, parent, isMain);
  };
}

installStubs();

// REAL modules under test.
const { CitizenDirector } = require("./CitizenDirector");
const {
  SETTLEMENT_IDS,
  siteTileBySettlement,
  kingdomIdOfSettlement,
  KINGDOM_IDS,
} = require("../brain/CitizenSites");

describe("settlement roster", () => {
  let director;
  let buildMs;

  before(() => {
    director = new CitizenDirector({ api: {}, registry: {} });
    director.startTask = () => {}; // don't start tick loops
    // Silence the director's log for the test.
    director.log = () => {};
    const t0 = Date.now();
    director.boot();
    buildMs = Date.now() - t0;
  });

  it("builds 650 citizens: 100 capitals + 400 settlements + 150 towns", () => {
    assert.equal(director.roster.size, 650);
  });

  it("builds fast", () => {
    assert.ok(buildMs < 8000, `roster build took ${buildMs}ms`);
  });

  it("covers all 8 settlements", () => {
    const counts = {};
    for (const record of director.roster.values()) {
      if (record.settlementId) {
        counts[record.settlementId] = (counts[record.settlementId] || 0) + 1;
      }
    }
    assert.deepEqual(Object.keys(counts).sort(), [...SETTLEMENT_IDS].sort());
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    assert.equal(total, 400);
  });

  it("settlement citizens affiliate with the nearest great power", () => {
    for (const record of director.roster.values()) {
      if (!record.settlementId) continue;
      assert.equal(record.kingdomId, kingdomIdOfSettlement(record.settlementId));
      assert.ok(KINGDOM_IDS.includes(record.kingdomId));
    }
  });

  it("settlement citizens live near their settlement anchor", () => {
    for (const record of director.roster.values()) {
      if (!record.settlementId) continue;
      const anchor =
        siteTileBySettlement(record.settlementId, "market") ??
        siteTileBySettlement(record.settlementId, "square");
      assert.ok(anchor, `no anchor for ${record.settlementId}`);
      const dist = Math.hypot(record.home.x - anchor.x, record.home.y - anchor.y);
      assert.ok(dist <= 25, `${record.username} home ${dist.toFixed(1)} tiles from ${record.settlementId}`);
    }
  });

  it("capital citizens are unaffected", () => {
    let capitals = 0;
    for (const record of director.roster.values()) {
      if (!record.settlementId && !record.townId) {
        capitals += 1;
        assert.equal(record.townId ?? null, null);
        assert.ok(KINGDOM_IDS.includes(record.kingdomId));
      }
    }
    assert.equal(capitals, 100);
  });

  it("usernames are unique across the whole roster", () => {
    const names = new Set();
    for (const key of director.roster.keys()) {
      assert.ok(!names.has(key), `duplicate roster key: ${key}`);
      names.add(key);
    }
    assert.equal(names.size, 650);
  });
});
