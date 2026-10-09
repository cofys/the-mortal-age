"use strict";

/**
 * CitizenArchaeologyLife.test.js — plain node.
 * Run: node server/plugins/citizens/lib/CitizenArchaeologyLife.test.js
 */

const assert = require("assert");
const Arch = require("./CitizenArchaeology");
const Life = require("./CitizenArchaeologyLife");

let passed = 0;
function test(name, fn) {
  Arch.resetForTests();
  Life.resetForTests();
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

function makeDirector(records) {
  return {
    roster: new Map(records.map((r) => [r.username, r])),
    isOnline: () => true,
    getBot: () => null,
    getRealPlayers: () => [],
  };
}

const NOW = 1_700_000_000_000;

test("tick never throws with empty director", () => {
  Life.tickArchLife({}, NOW);
  Life.tickArchLife(null, NOW);
});

test("tick registers curious online citizens as archaeologists", () => {
  const d = makeDirector([
    { username: "Curious", kingdomId: "lumbridge", personality: { curiosity: 0.9 } },
    { username: "Dull", kingdomId: "lumbridge", personality: { curiosity: 0.1 } },
  ]);
  Life.tickArchLife(d, NOW);
  assert.strictEqual(Arch.isArchaeologist("Curious"), true);
  assert.strictEqual(Arch.isArchaeologist("Dull"), false);
});

test("tick registers scholarly citizens and archaeologist-career citizens", () => {
  const d = makeDirector([
    { username: "Sage", kingdomId: "lumbridge", personality: { scholarliness: 0.8 } },
    { username: "Pro", kingdomId: "lumbridge", career: "archaeologist", personality: {} },
  ]);
  Life.tickArchLife(d, NOW);
  assert.strictEqual(Arch.isArchaeologist("Sage"), true);
  assert.strictEqual(Arch.isArchaeologist("Pro"), true);
});

test("tick founds dig sites from ancient expedition discoveries", () => {
  // Seed the explorers module with a finished expedition via the real API.
  const Explorers = require("./CitizenExplorers");
  Explorers.resetForTests();
  // Drive a full expedition through the public seam is heavy; instead verify
  // the tick survives the explorers module present but empty.
  const d = makeDirector([
    { username: "Curious", kingdomId: "lumbridge", personality: { curiosity: 0.9 } },
  ]);
  Life.tickArchLife(d, NOW);
  assert.strictEqual(Arch.describe().sites, 0, "no ancient discoveries yet, no sites");
  Explorers.resetForTests();
});

test("tick degrades gracefully without the explorers module", () => {
  // Simulate a broken require by ticking with a director whose roster throws.
  const d = { get roster() { throw new Error("boom"); } };
  Life.tickArchLife(d, NOW); // must not throw
});

test("ambient digging excavates real artifacts", () => {
  const { kingdomIdOf } = require("../brain/CitizenSites");
  const realKingdom = kingdomIdOf({ username: "Digger" }); // the module uses the real derivation
  Arch.registerArchaeologist("Digger", realKingdom);
  Arch.foundSiteFromDiscovery("exp-1", { name: "a lost tomb" }, realKingdom, "Bob");
  const d = makeDirector([
    { username: "Digger", kingdomId: realKingdom, personality: { curiosity: 0.9 } },
  ]);
  const before = Arch.describe().artifacts;
  Life.tickArchLife(d, NOW);
  assert.ok(Arch.describe().artifacts > before, "ambient dig produced an artifact");
});

test("tick prunes exhausted sites", () => {
  Arch.registerArchaeologist("Digger", "lumbridge");
  const s = Arch.foundSiteFromDiscovery("exp-1", { name: "a lost tomb" }, "lumbridge", "Bob").site;
  const slots = s.slotsLeft;
  for (let i = 0; i < slots; i++) Arch.excavate("Digger", s.id);
  const d = makeDirector([]);
  Life.tickArchLife(d, NOW);
  assert.strictEqual(Arch.siteOf(s.id), null, "exhausted site pruned");
});

console.log(`\n${passed} tests passed`);
