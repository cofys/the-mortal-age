"use strict";

/**
 * CitizenAstronomyLife.test.js — plain-node tests for the astronomy
 * slow-tick module with a stub director.
 *
 * Run: node server/plugins/citizens/lib/CitizenAstronomyLife.test.js
 */

const assert = require("assert");

const Astro = require("./CitizenAstronomy");
const { tickAstronomy, isNightTime } = require("./CitizenAstronomyLife");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    Astro.resetForTests();
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL - ${name}: ${err.message}`);
  }
}

/** Minimal stub director: empty roster, no bots. */
function stubDirector(overrides) {
  return Object.assign({
    roster: new Map(),
    isOnline: () => false,
    getBot: () => null,
    playerFor: () => null,
    getBotsForKingdom: () => [],
    getJournal: () => ({ log: () => {} }),
    log: () => {},
    sayAs: () => {},
  }, overrides || {});
}

console.log("CitizenAstronomyLife tests:");

test("tick never throws on empty director", () => {
  tickAstronomy(stubDirector(), Date.now());
  tickAstronomy(null, Date.now());
  tickAstronomy(undefined, undefined);
});

test("isNightTime matches hour math", () => {
  const night = new Date(2026, 5, 1, 23, 0).getTime();
  const day = new Date(2026, 5, 1, 12, 0).getTime();
  assert.strictEqual(isNightTime(night), true);
  assert.strictEqual(isNightTime(day), false);
});

test("curious online citizens get registered", () => {
  const record = {
    username: "Curious Cat",
    role: "commoner",
    personality: { curious: 0.9 },
  };
  const bot = {
    getPersonality: () => ({ curious: 0.9 }),
    getUsername: () => "Curious Cat",
  };
  const director = stubDirector({
    roster: new Map([["curious cat", record]]),
    isOnline: () => true,
    getBot: () => bot,
  });
  tickAstronomy(director, Date.now());
  // kingdomIdOf resolves in the real tree → honest registration.
  const rec = Astro.astronomerFor("Curious Cat");
  assert.ok(rec, "expected Curious Cat to be registered");
  assert.strictEqual(rec.username, "Curious Cat");
});

test("night observations create charts for online astronomers", () => {
  Astro.registerAstronomer("Night Owl", "varrock");
  const bot = {
    getUsername: () => "Night Owl",
    sayPublic: () => {},
  };
  const night = new Date(2026, 5, 1, 23, 0).getTime();
  const director = stubDirector({
    playerFor: () => bot,
    getBotsForKingdom: () => [bot],
  });
  tickAstronomy(director, night);
  const charts = Astro.chartsFor("varrock");
  assert.ok(charts.length >= 1, "expected at least one chart");
  assert.strictEqual(charts[0].astronomer, "Night Owl");
});

test("daytime observations do not create charts", () => {
  Astro.registerAstronomer("Day Dreamer", "varrock");
  const bot = { getUsername: () => "Day Dreamer" };
  const day = new Date(2026, 5, 1, 12, 0).getTime();
  const director = stubDirector({ playerFor: () => bot });
  tickAstronomy(director, day);
  assert.strictEqual(Astro.chartsFor("varrock").length, 0);
});

test("celestial events get announced once per cooldown", () => {
  Astro.registerAstronomer("Event Watcher", "varrock");
  const said = [];
  const bot = {
    getUsername: () => "Event Watcher",
    sayPublic: (line) => said.push(line),
  };
  const jan2026 = new Date(2026, 0, 15, 23, 0).getTime(); // meteor shower month
  const director = stubDirector({
    playerFor: () => bot,
    getBotsForKingdom: () => [bot],
  });
  tickAstronomy(director, jan2026);
  assert.ok(said.length >= 1, "expected an announcement");
  const firstCount = said.length;
  // Second tick immediately after → throttled, no new announcement.
  tickAstronomy(director, jan2026 + 1000);
  assert.strictEqual(said.length, firstCount);
});

test("offline astronomers do not observe", () => {
  Astro.registerAstronomer("Sleeper", "varrock");
  const night = new Date(2026, 5, 1, 23, 0).getTime();
  const director = stubDirector({ playerFor: () => null });
  tickAstronomy(director, night);
  assert.strictEqual(Astro.chartsFor("varrock").length, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
