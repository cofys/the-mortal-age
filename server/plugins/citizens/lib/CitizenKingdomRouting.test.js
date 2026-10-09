"use strict";

/**
 * CitizenKingdomRouting.test.js — regression for the kingdomIdOf trap in the
 * Life ticks: the brain's kingdomIdOf() ALWAYS returns a truthy string
 * (KINGDOM_IDS[0] fallback for anything without getAttribute), so calling it
 * BEFORE reading the roster record's own kingdomId silently pinned every
 * plain roster record to the first kingdom. The fix reads
 * record.kingdomId first and keeps the brain read as the live-entity fallback.
 *
 * This suite uses the REAL brain/brain/CitizenSites (not stubbed), so it
 * FAILS on the old ordering and PASSES on the new one.
 *
 * Run: node server/plugins/citizens/lib/CitizenKingdomRouting.test.js
 */

const assert = require("assert");
const path = require("path");
const os = require("os");
const fs = require("fs");

// --- stubs (sayPublic only; CitizenSites is REAL on purpose) ---

const sayPublicPath = path.resolve(__dirname, "../chat/CitizenSayPublic.js");
require.cache[sayPublicPath] = {
  id: sayPublicPath, filename: sayPublicPath, loaded: true,
  exports: { sayPublic: () => {} },
};

const perceptionPath = path.resolve(__dirname, "../brain/CitizenPerception.js");
require.cache[perceptionPath] = {
  id: perceptionPath, filename: perceptionPath, loaded: true,
  exports: { getLocalPlayers: () => [] },
};

const Galleries = require("./CitizenGalleries");
const Life = require("./CitizenGalleriesLife");
const { KINGDOM_IDS, kingdomIdOf: brainKingdomIdOf } = require("../brain/CitizenSites");

const SAVE_PATH = path.join(os.tmpdir(), `citizen-kingdom-routing-test-${process.pid}.json`);
const ART_SAVE_PATH = path.join(os.tmpdir(), `citizen-kingdom-routing-art-${process.pid}.json`);
Galleries._setSavePathForTests(SAVE_PATH);
require("./CitizenArt")._setSavePathForTests(ART_SAVE_PATH);

const FIRST_KINGDOM = KINGDOM_IDS[0]; // the brain's fallback — the wrong answer
const HOME = KINGDOM_IDS.includes("morytania") ? "morytania" : KINGDOM_IDS[KINGDOM_IDS.length - 1];
if (HOME === FIRST_KINGDOM) throw new Error("test needs a non-first kingdom");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    for (const p of [SAVE_PATH, ART_SAVE_PATH]) {
      try { fs.unlinkSync(p); } catch { /* fresh */ }
    }
    Galleries.resetForTests();
    Life.resetForTests();
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL - ${name}: ${err.message}`);
  }
}

function mockDirector(records) {
  return { roster: new Map(records.map((r) => [r.username.toLowerCase(), r])) };
}

console.log("CitizenKingdomRouting tests (real brain kingdomIdOf):");

test("sanity: the real brain falls back to the first kingdom for plain records", () => {
  const plain = { username: "Plain", kingdomId: HOME };
  assert.strictEqual(brainKingdomIdOf(plain), FIRST_KINGDOM);
});

test("curator registration routes to the citizen's own kingdom, not the first", () => {
  const director = mockDirector([
    { username: "MoryCurator", kingdomId: HOME, career: "curator", personality: {} },
  ]);
  Life.tickGalleriesLife(director, Date.now());
  assert.ok(Galleries.isCurator("morycurator"), "expected the curator to register");
  const info = Galleries.curatorInfo("morycurator");
  assert.ok(info, "expected curator info");
  assert.strictEqual(info.kingdomId, HOME, `curator must land in ${HOME}, not the brain fallback`);
  assert.notStrictEqual(info.kingdomId, FIRST_KINGDOM);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
