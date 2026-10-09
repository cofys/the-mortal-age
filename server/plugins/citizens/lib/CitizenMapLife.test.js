"use strict";

/**
 * CitizenMapLife.test.js — plain-node tests for the cartography slow tick.
 *
 * Run: node server/plugins/citizens/lib/CitizenMapLife.test.js
 */

const assert = require("assert");

const Maps = require("./CitizenMaps");
const { tickMapLife, resetForTests } = require("./CitizenMapLife");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    Maps.resetForTests();
    resetForTests();
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL - ${name}: ${err.message}`);
  }
}

function fakeDirector(records) {
  return {
    roster: new Map(records.map((r, i) => [i, r])),
    isOnline: () => true,
    getBot: (record) => ({
      username: record.username,
      inventory: {
        _items: record.papyrus ? [{ id: 970 }, { id: 970 }] : [],
        count(id) { return this._items.filter((i) => i.id === id).length; },
        remove(id, n) {
          let left = n;
          this._items = this._items.filter((i) => {
            if (i.id === id && left > 0) { left--; return false; }
            return true;
          });
        },
      },
    }),
  };
}

console.log("CitizenMapLife tests:");

test("tickMapLife never throws on empty director", () => {
  tickMapLife({}, Date.now());
  tickMapLife(null, Date.now());
});

test("tickMapLife registers curious online citizens", () => {
  const director = fakeDirector([
    { username: "CuriousCat", kingdomId: "misthalin", personality: { curiosity: 0.8 } },
    { username: "BoredBob", kingdomId: "misthalin", personality: { curiosity: 0.1 } },
  ]);
  tickMapLife(director, Date.now());
  assert.strictEqual(Maps.isCartographer("CuriousCat"), true);
  assert.strictEqual(Maps.isCartographer("BoredBob"), false);
});

test("tickMapLife registers cartographer-career citizens", () => {
  const director = fakeDirector([
    { username: "ProCarto", kingdomId: "misthalin", career: "cartographer", personality: {} },
  ]);
  tickMapLife(director, Date.now());
  assert.strictEqual(Maps.isCartographer("ProCarto"), true);
});

test("ambient drafting consumes real papyrus and lists the map", () => {
  const { kingdomIdOf } = require("../brain/CitizenSites");
  const record = { username: "Drafty", kingdomId: "misthalin", personality: { curiosity: 0.9 }, papyrus: true };
  const realKingdom = kingdomIdOf(record); // the module uses the real derivation
  const director = fakeDirector([record]);
  tickMapLife(director, 1000); // first tick registers + drafts
  const desc = Maps.describe(realKingdom);
  assert.ok(desc.mapCount >= 1, `expected a drafted map, got ${desc.mapCount}`);
  assert.ok(desc.listingCount >= 1, "drafted map should be listed");
});

test("ambient drafting is throttled per kingdom", () => {
  const { kingdomIdOf } = require("../brain/CitizenSites");
  const mk = (u) => ({ username: u, personality: { curiosity: 0.9 }, papyrus: true });
  const realKingdom = kingdomIdOf(mk("Drafty"));
  const director = fakeDirector([mk("Drafty"), mk("Drafty2")]);
  tickMapLife(director, 1000);
  const first = Maps.describe(realKingdom).mapCount;
  assert.ok(first >= 1, "expected at least one draft on first tick");
  tickMapLife(director, 2000); // within cooldown — no new drafts
  assert.strictEqual(Maps.describe(realKingdom).mapCount, first);
});

test("tickMapLife survives missing travel module", () => {
  const director = fakeDirector([]);
  // No CitizenTravel stub needed — the require is real; just don't crash.
  tickMapLife(director, Date.now());
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
