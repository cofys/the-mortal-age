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
        getAmount(id) { return this._items.filter((i) => i.id === id).length; },
        deleteNumber(id, n) {
          let left = n;
          this._items = this._items.filter((i) => {
            if (i.id === id && left > 0) { left--; return false; }
            return true;
          });
          return this;
        },
        adds(id, n) {
          for (let k = 0; k < n; k++) this._items.push({ id });
          return this;
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
  const record = { username: "Drafty", kingdomId: "misthalin", personality: { curiosity: 0.9 }, papyrus: true };
  const director = fakeDirector([record]);
  tickMapLife(director, 1000); // first tick registers + drafts
  // The draft routes to the citizen's OWN kingdom (record.kingdomId), not the
  // brain's KINGDOM_IDS[0] fallback — regression for the kingdomIdOf trap.
  const desc = Maps.describe(record.kingdomId);
  assert.ok(desc.mapCount >= 1, `expected a drafted map, got ${desc.mapCount}`);
  assert.ok(desc.listingCount >= 1, "drafted map should be listed");
});

test("cartographer registration routes to the citizen's own kingdom", () => {
  // morytania is NOT the first kingdom (brain fallback is asgarnia) — a
  // plain roster record must register under its own kingdomId.
  const director = fakeDirector([
    { username: "MoryCarto", kingdomId: "morytania", career: "cartographer", personality: {} },
  ]);
  tickMapLife(director, Date.now());
  assert.strictEqual(Maps.cartographerCount("morytania"), 1, "cartographer should register under morytania");
  assert.strictEqual(Maps.cartographerCount("asgarnia"), 0, "nothing should fall back to the first kingdom");
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

test("masterwork announcement journals the deed in the canonical shape", () => {
  const Disc = require("./CitizenDiscovery");
  const { getJournal } = require("./CitizenJournal");
  Disc.resetForTests();
  getJournal().resetForTests();
  // Real quality 10: 4 real discoveries (+4) + 9 drafted charts (+2) +
  // 1 travel log (+1) on the base 3 — a masterwork.
  for (let i = 0; i < 4; i++) {
    Disc.recordDiscovery("dungeon_entrance", 3000 + i, 3000, 0, "MasterMia", `Cave ${i}`);
  }
  Maps.registerCartographer("MasterMia", "misthalin");
  Maps.recordLog("MasterMia", "misthalin", "asgarnia", "caravan");
  for (let i = 0; i < 9; i++) {
    assert.strictEqual(Maps.draftMap("MasterMia", "misthalin", "city").ok, true);
  }
  const director = fakeDirector([
    { username: "MasterMia", kingdomId: "misthalin", personality: { curiosity: 0.9 }, papyrus: true },
  ]);
  tickMapLife(director, 1000000); // ambient draft -> masterwork -> announce
  const events = getJournal().recent("MasterMia");
  const master = events.find((e) => e.kind === "masterwork");
  assert.ok(master, `expected a masterwork journal entry, got ${JSON.stringify(events)}`);
  assert.ok(master.text.includes("masterwork"), "entry text names the deed");
  Disc.resetForTests();
  getJournal().resetForTests();
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
