"use strict";

/**
 * CitizenObservatoriesLife.test.js — plain-node tests (no jest).
 * Run: node server/plugins/citizens/lib/CitizenObservatoriesLife.test.js
 */

const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");

const Obs = require("./CitizenObservatories");
const Life = require("./CitizenObservatoriesLife");

const tmpSave = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "obslife-test-")), "citizen-observatories.json");
Obs._setSavePathForTests(tmpSave);

// Stub the astronomy profession layer: comet active on even timestamps.
const astroPath = path.join(__dirname, "CitizenAstronomy.js");
require.cache[astroPath] = {
  exports: {
    observatoryFor: (kid) => (kid === "misthalin" ? { kingdomId: kid, tile: { x: 100, y: 200 } } : null),
    astronomerFor: (u) => (u === "Stargazer_Sue" ? { username: u, kingdomId: "misthalin" } : null),
    chartsFor: () => [],
    activeEventFor: (kid, nowMs) => (kid === "misthalin" && nowMs % 2 === 0 ? { kind: "comet" } : null),
  },
};

const NIGHT = new Date(2026, 5, 15, 23, 0, 0).getTime();
const EVEN_NIGHT = NIGHT % 2 === 0 ? NIGHT : NIGHT + 1;

let passed = 0;
function test(name, fn) {
  Obs.resetForTests();
  Life.resetForTests();
  try {
    fn();
    passed += 1;
  } catch (e) {
    console.error(`FAIL: ${name}\n  ${e.message}`);
    process.exitCode = 1;
  }
}

function makeDirector(bots = []) {
  const journaled = [];
  return {
    journaled,
    journalCitizens: (text, tags) => journaled.push({ text, tags }),
    getOnlineCitizens: () => bots,
  };
}

test("tick never throws with null director", () => {
  Life.tickObservatories(null, EVEN_NIGHT);
  Life.tickObservatories(undefined, EVEN_NIGHT);
});

test("tick starts viewing party when event active", () => {
  const d = makeDirector();
  Life.tickObservatories(d, EVEN_NIGHT);
  const party = Obs.partyFor("misthalin", EVEN_NIGHT);
  assert.ok(party, "party should start when comet active");
  assert.strictEqual(party.eventKind, "comet");
  assert.ok(d.journaled.some((j) => j.tags.includes("party")), "party should be journaled");
});

test("tick announces party near kingdom bots (throttled)", () => {
  const said = [];
  const bot = {
    getKingdomId: () => "misthalin",
    sayPublic: (line) => said.push(line),
  };
  const d = makeDirector([bot]);
  Life.tickObservatories(d, EVEN_NIGHT);
  assert.ok(said.length > 0, "bot should announce the party");
  const saidAgain = [];
  const bot2 = { getKingdomId: () => "misthalin", sayPublic: (l) => saidAgain.push(l) };
  const d2 = makeDirector([bot2]);
  Life.tickObservatories(d2, EVEN_NIGHT + 1000);
  assert.strictEqual(saidAgain.length, 0, "announcement should be throttled");
});

test("tick closes finished tours", () => {
  const r = Obs.scheduleTour("Stargazer_Sue", "misthalin", EVEN_NIGHT);
  assert.ok(r.ok);
  const d = makeDirector();
  Life.tickObservatories(d, EVEN_NIGHT + 10 * 3600 * 1000);
  const tours = Obs.toursFor("misthalin", EVEN_NIGHT + 10 * 3600 * 1000);
  assert.strictEqual(tours.length, 0, "finished tour should be closed");
});

test("tick announces upcoming tours", () => {
  const r = Obs.scheduleTour("Stargazer_Sue", "misthalin", EVEN_NIGHT);
  assert.ok(r.ok);
  const d = makeDirector();
  // 20 min before the tour starts (within the 30-min announcement window)
  Life.tickObservatories(d, EVEN_NIGHT + 40 * 60 * 1000);
  assert.ok(d.journaled.some((j) => j.tags.includes("tour")), "tour should be journaled");
});

test("tick does nothing without observatory", () => {
  const d = makeDirector();
  Life.tickObservatories(d, EVEN_NIGHT); // asgarnia has no observatory in stub
  assert.strictEqual(Obs.partyFor("asgarnia", EVEN_NIGHT), null);
});

console.log(`CitizenObservatoriesLife: ${passed} passed`);
if (process.exitCode) console.log("FAILURES PRESENT");
