"use strict";

/**
 * CitizenRoutine settlement tests — frontier settlement citizens use their
 * settlement's sites (work/market/tavern), not the affiliated capital's.
 *
 * Before this fix, CitizenRoutine had zero settlement handling: a Brimhaven
 * citizen (affiliated with Kandarin) would try to walk to Kandarin's capital
 * work site, fail, and fall back to the director's wander safety net —
 * the "walk 10 tiles and stop" Jon reported.
 */
const assert = require("node:assert/strict");

// Stub engine modules (same pattern as CitizenRoutine.test.js).
function stubEngineModules() {
  const stubs = {
    "../../../bots/behaviours/navigation/BotNavigation": {
      requestMovement: () => {},
      clearMovementRequest: () => {},
    },
    "../../../bots/brain/actions/InteractObject": {
      createInteractObjectAction: () => ({ update: () => "running", stop: () => {} }),
    },
    "../../../bots/brain/actions/Bank": {
      createBankAction: () => ({ update: () => "running", stop: () => {} }),
    },
  };
  for (const [rel, exports] of Object.entries(stubs)) {
    const path = require.resolve(rel);
    require.cache[path] = { id: path, filename: path, loaded: true, exports };
  }
}
stubEngineModules();

const {
  _settlementIdOf: settlementIdOf,
  _siteTileLocal: siteTileLocal,
  _workSiteLocal: workSiteLocal,
} = require("./CitizenRoutine.js");
const { workSiteBySettlement, siteTileBySettlement } = require("../CitizenSites.js");
const { ATTR_CITIZEN_SETTLEMENT } = require("../../constants.js");

function fakePlayer(settlementId) {
  return {
    getAttribute: (key) => (key === ATTR_CITIZEN_SETTLEMENT ? settlementId : null),
  };
}

function testSettlementIdOf() {
  assert.equal(settlementIdOf(fakePlayer("brimhaven")), "brimhaven");
  assert.equal(settlementIdOf(fakePlayer(null)), null);
  assert.equal(settlementIdOf(fakePlayer("")), null);
  assert.equal(settlementIdOf({}), null);
  assert.equal(settlementIdOf(null), null);
  console.log("PASS: settlementIdOf reads the attribute");
}

function testWorkSiteBySettlement() {
  // Every settlement has a work site with catalog/tier/option.
  const expected = {
    alkharid: "rock",
    brimhaven: "tree",
    lletya: "tree",
    nardah: "rock",
    pollnivneach: "rock",
    rellekka: "tree",
    shilo: "tree",
    sophanem: "rock",
  };
  for (const [sid, catalog] of Object.entries(expected)) {
    const site = workSiteBySettlement(sid);
    assert.ok(site, `${sid} has a work site`);
    assert.equal(site.catalog, catalog, `${sid} catalog`);
    assert.ok(Number.isFinite(site.x) && Number.isFinite(site.y), `${sid} has coords`);
    assert.ok(site.option, `${sid} has option`);
    assert.ok(site.tier, `${sid} has tier`);
  }
  assert.equal(workSiteBySettlement("nonexistent"), null);
  console.log("PASS: workSiteBySettlement returns configured work sites");
}

function testSiteTileLocalPrefersSettlement() {
  const player = fakePlayer("brimhaven");
  // Settlement market should differ from the capital's market.
  const localMarket = siteTileLocal(player, "market");
  assert.ok(localMarket, "settlement market resolves");
  // Brimhaven market from settlements.json
  const expected = siteTileBySettlement("brimhaven", "market");
  assert.deepEqual(localMarket, expected);

  const localTavern = siteTileLocal(player, "tavern");
  assert.ok(localTavern, "settlement tavern resolves");
  console.log("PASS: siteTileLocal prefers settlement sites");
}

function testSiteTileLocalFallsBackToCapital() {
  const player = fakePlayer(null); // capital citizen
  const market = siteTileLocal(player, "market");
  assert.ok(market, "capital market resolves for non-settlement citizen");
  console.log("PASS: siteTileLocal falls back to capital for non-settlement");
}

function testWorkSiteLocalPrefersSettlement() {
  const player = fakePlayer("alkharid");
  const site = workSiteLocal(player);
  assert.ok(site, "settlement work site resolves");
  assert.equal(site.catalog, "rock", "Al Kharid works rock");
  assert.equal(site.option, "Mine");
  // Coordinates from settlements.json
  assert.equal(site.x, 3300);
  assert.equal(site.y, 3165);
  console.log("PASS: workSiteLocal returns settlement work config");
}

function testWorkSiteLocalFallsBackToCapital() {
  const player = fakePlayer(null);
  const site = workSiteLocal(player);
  assert.ok(site, "capital work site resolves for non-settlement citizen");
  assert.ok(site.catalog, "has catalog");
  console.log("PASS: workSiteLocal falls back to capital for non-settlement");
}

function run() {
  testSettlementIdOf();
  testWorkSiteBySettlement();
  testSiteTileLocalPrefersSettlement();
  testSiteTileLocalFallsBackToCapital();
  testWorkSiteLocalPrefersSettlement();
  testWorkSiteLocalFallsBackToCapital();
  console.log("\n6/6 settlement routine tests passed.");
}

if (require.main === module) {
  run();
}

module.exports = { run };
