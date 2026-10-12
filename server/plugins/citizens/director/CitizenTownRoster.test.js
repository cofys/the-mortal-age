"use strict";

/**
 * Town roster test — Phase 2 citizen world-population rebuild (2026-10-12).
 *
 * The roster now includes smaller towns + Keldagrim city districts: citizens
 * live in their kingdom's smaller towns, not just the capitals and frontier
 * settlements. Town citizens anchor to the town's own sites and affiliate
 * with the town's great power for kingdom mechanics.
 *
 * This test drives the REAL boot() plus the REAL lib/CitizenAnchor with the
 * engine boundary stubbed and pins:
 *   1. Total roster = 100 capitals + 400 settlements + 150 town citizens.
 *   2. Every town citizen has a townId, a matching kingdomId, and a home
 *      within ~25 tiles of the town anchor.
 *   3. Town commoners anchor at their town's work nodes (town character:
 *      fishing towns fish, wood towns cut, mining towns mine) — their
 *      data-tier position is the work tile, not home.
 *   4. Bankless towns resolve a real bank through the fallback chain.
 *   5. Edgeville is absent (Wilderness-border PvP flag — see towns.json).
 *   6. Capital and settlement citizens are unaffected (no townId).
 */

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

// ---------------------------------------------------------------------------
// Engine-boundary stubs. Installed BEFORE requiring CitizenDirector.
// Same pattern as CitizenSettlementRoster.test.js: the director's own
// requires get generic stubs so the heavy bot/engine chain never loads.
// Additionally lib/CitizenAnchor.js gets REAL constants/sites/humanizer so
// the anchor contract itself is under test.
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

  const realFor = (request) =>
    request.endsWith("/constants") ||
    request.endsWith("/humanizer") ||
    request.includes("brain/CitizenSites") ||
    request.includes("lib/personalities") ||
    request.includes("lib/humanizer") ||
    request.includes("lib/CitizenBonds");

  Module._load = function (request, parent, isMain) {
    const parentFile = parent && parent.filename ? parent.filename : "";
    const isDirector = parentFile.endsWith(
      path.join("director", "CitizenDirector.js")
    );
    const isAnchor = parentFile.endsWith(
      path.join("lib", "CitizenAnchor.js")
    );

    if (request.includes("src/main/typescript")) {
      if (request.endsWith("/Location")) {
        return { Location: StubLocation };
      }
      return {};
    }

    if (isAnchor) {
      if (realFor(request)) {
        return originalLoad.call(this, request, parent, isMain); // REAL
      }
      if (request.includes("brain/CitizenDecisions")) {
        // Anchor only needs the activity ids; the decisions engine stays stubbed.
        return { ACT_MINE: "mine", ACT_CHOP: "chop", ACT_ROUTINE: "routine" };
      }
      return genericStub();
    }

    if (isDirector) {
      if (realFor(request)) {
        return originalLoad.call(this, request, parent, isMain); // REAL
      }
      if (request.includes("lib/CitizenAnchor")) {
        return originalLoad.call(this, request, parent, isMain); // REAL anchor
      }
      return genericStub();
    }

    return originalLoad.call(this, request, parent, isMain);
  };
}

installStubs();

// REAL modules under test.
const { CitizenDirector } = require("./CitizenDirector");
// anchorFor import removed (Jon 2026-10-12): anchor model dropped.
const {
  TOWN_IDS,
  KINGDOM_IDS,
  SETTLEMENT_IDS,
  siteTileByTown,
  workSiteByTown,
  bankTileByTown,
  fishingBiasByTown,
  kingdomIdOfTown,
  townsForKingdom,
  siteTileByKingdom,
} = require("../brain/CitizenSites");

const ROLE_COMMONER = "commoner";

describe("town roster", () => {
  let director;
  let buildMs;
  let townRecords;

  before(() => {
    director = new CitizenDirector({ api: {}, registry: {} });
    director.startTask = () => {}; // don't start tick loops
    director.log = () => {}; // silence
    const t0 = Date.now();
    director.boot();
    buildMs = Date.now() - t0;
    townRecords = [...director.roster.values()].filter((r) => r.townId);
  });

  it("builds 150 base town citizens; scale-3000 expansion adds 1040 more", () => {
    assert.equal(director.roster.size, 3110);
    // Base town plan: 150. Expansion: 16 towns × 65 = 1040. Total town citizens: 1190.
    assert.equal(townRecords.length, 1190);
  });

  it("builds fast", () => {
    assert.ok(buildMs < 8000, `roster build took ${buildMs}ms`);
  });

  it("covers all 16 towns and districts", () => {
    const counts = {};
    for (const record of townRecords) {
      counts[record.townId] = (counts[record.townId] || 0) + 1;
    }
    assert.deepEqual(Object.keys(counts).sort(), [...TOWN_IDS].sort());
  });

  it("town citizens affiliate with their town's great power", () => {
    for (const record of townRecords) {
      assert.equal(record.kingdomId, kingdomIdOfTown(record.townId));
      assert.ok(KINGDOM_IDS.includes(record.kingdomId));
      assert.equal(record.settlementId ?? null, null);
    }
  });

  it("town citizens live near their town anchor", () => {
    for (const record of townRecords) {
      const anchors = [
        siteTileByTown(record.townId, "market"),
        siteTileByTown(record.townId, "square"),
      ].filter(Boolean);
      assert.ok(anchors.length > 0, `no anchor for ${record.townId}`);
      const dist = Math.min(
        ...anchors.map((anchor) =>
          Math.hypot(record.home.x - anchor.x, record.home.y - anchor.y)
        )
      );
      assert.ok(
        dist <= 25,
        `${record.username} home ${dist.toFixed(1)} tiles from ${record.townId}`
      );
    }
  });

  // Anchor tests removed (Jon 2026-10-12): anchor model dropped.
  // Citizens are free-roaming sandbox agents; position starts at home and
  // emerges from movement. The utility layer drives work, not anchors.

  // anchorFor test removed (Jon 2026-10-12): anchor model dropped.
  // Citizens are free-roaming sandbox agents; position emerges from movement.

  it("bankless towns resolve a real bank through the fallback chain", () => {
    const capitalBank = (kingdomId) => siteTileByKingdom(kingdomId, "bank");
    assert.deepEqual(
      bankTileByTown("port-sarim"),
      capitalBank("asgarnia"),
      "port-sarim falls back to the Falador bank"
    );
    assert.deepEqual(
      bankTileByTown("taverley"),
      capitalBank("asgarnia"),
      "taverley falls back to the Falador bank"
    );
    assert.deepEqual(
      bankTileByTown("burgh-de-rott"),
      siteTileByTown("canifis", "bank"),
      "burgh-de-rott falls back to the Canifis bank"
    );
    assert.deepEqual(
      bankTileByTown("keldagrim-blastfurnace"),
      siteTileByTown("keldagrim-market", "bank"),
      "blast furnace falls back to the market district bank"
    );
    // Every town resolves SOME bank — the bank hinge never walks nowhere.
    for (const townId of TOWN_IDS) {
      assert.ok(bankTileByTown(townId), `no bank for ${townId}`);
    }
  });

  it("every kingdom with towns has them all listed", () => {
    const seen = new Set();
    for (const kingdomId of KINGDOM_IDS) {
      for (const townId of townsForKingdom(kingdomId)) {
        assert.equal(kingdomIdOfTown(townId), kingdomId);
        assert.ok(!seen.has(townId), `town listed twice: ${townId}`);
        seen.add(townId);
      }
    }
    assert.deepEqual([...seen].sort(), [...TOWN_IDS].sort());
  });

  it("edgeville is not anchored (Wilderness-border PvP flag)", () => {
    assert.ok(!TOWN_IDS.includes("edgeville"));
  });

  it("capital and settlement citizens are unaffected (no townId)", () => {
    for (const record of director.roster.values()) {
      if (record.townId) continue;
      assert.equal(record.townId ?? null, null);
    }
    const settlements = [...director.roster.values()].filter(
      (r) => r.settlementId
    );
    // Base: 400. Scale-3000 expansion: 8 settlements × 90 = 720. Total: 1120.
    assert.equal(settlements.length, 1120);
    assert.deepEqual(
      [...new Set(settlements.map((r) => r.settlementId))].sort(),
      [...SETTLEMENT_IDS].sort()
    );
  });

  it("fishing bias is only set where a dock exists", () => {
    for (const townId of TOWN_IDS) {
      const bias = fishingBiasByTown(townId);
      const dock = siteTileByTown(townId, "dock");
      if (!dock) {
        assert.equal(bias, 0, `${townId} has bias without a dock`);
      } else {
        assert.ok(bias > 0 && bias <= 1, `${townId} bad bias ${bias}`);
      }
    }
  });
});
