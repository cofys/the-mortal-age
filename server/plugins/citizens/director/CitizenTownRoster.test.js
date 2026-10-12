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
const { anchorFor } = require("../lib/CitizenAnchor");
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

  it("builds 150 town citizens on top of the 650 roster", () => {
    assert.equal(director.roster.size, 650);
    assert.equal(townRecords.length, 150);
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

  it("town commoners anchor at their town's work nodes (data-tier position)", () => {
    for (const record of townRecords) {
      if (record.role !== ROLE_COMMONER) continue;
      const work = workSiteByTown(record.townId);
      const dock = siteTileByTown(record.townId, "dock");
      if (record.workKind === "fishing") {
        assert.ok(dock, `${record.townId} fisher without a dock`);
        assert.deepEqual(record.position, {
          x: dock.x,
          y: dock.y,
          z: dock.z ?? 0,
        });
      } else if (work) {
        assert.deepEqual(record.position, {
          x: work.x,
          y: work.y,
          z: work.z ?? 0,
        });
        assert.equal(record.workKind, work.catalog);
      } else {
        // No gather site (Blast Furnace district): anchors at home.
        assert.deepEqual(record.position, {
          x: record.home.x,
          y: record.home.y,
          z: record.home.z ?? 0,
        });
        assert.equal(record.workKind ?? null, null);
      }
    }
  });

  it("town character drives the work mix: fishing towns fish", () => {
    const fishers = (townId) =>
      townRecords.filter(
        (r) => r.townId === townId && r.role === ROLE_COMMONER && r.workKind === "fishing"
      ).length;
    const commoners = (townId) =>
      townRecords.filter((r) => r.townId === townId && r.role === ROLE_COMMONER)
        .length;
    // Catherby (bias 0.7) and Port Sarim (bias 0.75) are fishing towns.
    assert.ok(
      fishers("catherby") >= Math.floor(commoners("catherby") * 0.4),
      `catherby fishers: ${fishers("catherby")}/${commoners("catherby")}`
    );
    assert.ok(
      fishers("port-sarim") >= Math.floor(commoners("port-sarim") * 0.4),
      `port-sarim fishers: ${fishers("port-sarim")}/${commoners("port-sarim")}`
    );
    // Seers' Village has no dock: every commoner cuts yews.
    assert.equal(fishers("seers-village"), 0);
    assert.ok(
      townRecords.every(
        (r) =>
          r.townId !== "seers-village" ||
          r.role !== ROLE_COMMONER ||
          r.workKind === "tree"
      )
    );
    // Mine camp: every commoner mines.
    assert.ok(
      townRecords.every(
        (r) =>
          r.townId !== "keldagrim-minescamp" ||
          r.role !== ROLE_COMMONER ||
          r.workKind === "rock"
      )
    );
  });

  it("anchorFor agrees with the roster records", () => {
    for (const record of townRecords) {
      const again = anchorFor(record);
      const expected = record.workKind
        ? { x: record.position.x, y: record.position.y, z: record.position.z }
        : null;
      if (expected) {
        assert.ok(again, `anchorFor lost the anchor for ${record.username}`);
        assert.deepEqual(
          { x: again.x, y: again.y, z: again.z },
          expected,
          `anchor drift for ${record.username}`
        );
        assert.equal(again.workKind, record.workKind);
      } else {
        assert.equal(again, null, `unexpected anchor for ${record.username}`);
      }
    }
  });

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
    assert.equal(settlements.length, 400);
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
