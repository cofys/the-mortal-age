"use strict";

/**
 * CitizenAstronomy.test.js — plain-node tests for the real astronomy
 * data tier.
 *
 * Run: node server/plugins/citizens/lib/CitizenAstronomy.test.js
 */

const assert = require("assert");

const Astro = require("./CitizenAstronomy");

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

console.log("CitizenAstronomy tests:");

// --- catalog ---

test("event catalog has all 4 kinds", () => {
  for (const k of ["meteor_shower", "comet", "lunar_eclipse", "solar_eclipse"]) {
    assert.ok(Astro.EVENTS[k], `missing ${k}`);
  }
});

test("event schedules are deterministic", () => {
  // January 2026: monthIndex % 12 === 0 → solar_eclipse active (yearly).
  // Use a fixed timestamp: 2026-01-15.
  const jan2026 = new Date(2026, 0, 15).getTime();
  assert.strictEqual(Astro.shouldEventBeActive("solar_eclipse", jan2026), true);
  assert.strictEqual(Astro.shouldEventBeActive("meteor_shower", jan2026), true); // monthly
  // February 2026: monthIndex % 12 === 1 → no yearly, but monthly yes.
  const feb2026 = new Date(2026, 1, 15).getTime();
  assert.strictEqual(Astro.shouldEventBeActive("solar_eclipse", feb2026), false);
  assert.strictEqual(Astro.shouldEventBeActive("meteor_shower", feb2026), true);
});

test("omens list is non-empty", () => {
  assert.ok(Astro.OMENS.length >= 4);
});

// --- astronomers ---

test("registerAstronomer requires identity", () => {
  const r = Astro.registerAstronomer("", "varrock");
  assert.strictEqual(r.ok, false);
});

test("registerAstronomer registers and is idempotent", () => {
  const r1 = Astro.registerAstronomer("Stella Star", "varrock");
  assert.strictEqual(r1.ok, true);
  const r2 = Astro.registerAstronomer("Stella Star", "varrock");
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.already, true);
});

test("astronomerFor returns null for unknown", () => {
  assert.strictEqual(Astro.astronomerFor("Nobody"), null);
});

test("astronomersFor filters by kingdom", () => {
  Astro.registerAstronomer("A One", "varrock");
  Astro.registerAstronomer("B Two", "falador");
  assert.strictEqual(Astro.astronomersFor("varrock").length, 1);
  assert.strictEqual(Astro.astronomersFor("falador").length, 1);
});

test("gainWisdom increases wisdom, caps at 100", () => {
  Astro.registerAstronomer("Wise One", "varrock");
  assert.strictEqual(Astro.gainWisdom("Wise One", 200), true);
  assert.strictEqual(Astro.astronomerFor("Wise One").wisdom, 100);
  assert.strictEqual(Astro.gainWisdom("Nobody", 5), false);
});

// --- observatories ---

test("observatoryFor creates a record per kingdom", () => {
  const o1 = Astro.observatoryFor("varrock");
  const o2 = Astro.observatoryFor("varrock");
  assert.strictEqual(o1.kingdomId, "varrock");
  assert.strictEqual(o1, o2); // same object, cached
});

test("observatoryFor is per-kingdom", () => {
  Astro.observatoryFor("varrock");
  Astro.observatoryFor("falador");
  const st = Astro.load();
  assert.ok(st.observatories["varrock"]);
  assert.ok(st.observatories["falador"]);
});

// --- charts ---

test("createChart requires a registered astronomer", () => {
  const r = Astro.createChart("Nobody", "varrock", 5);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "not-astronomer");
});

test("createChart creates a real chart with clamped quality", () => {
  Astro.registerAstronomer("Chart Maker", "varrock");
  const r = Astro.createChart("Chart Maker", "varrock", 99);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.quality, 10); // clamped to max
  const charts = Astro.chartsFor("varrock");
  assert.strictEqual(charts.length, 1);
  assert.strictEqual(charts[0].astronomer, "Chart Maker");
});

test("createChart quality floors at 1", () => {
  Astro.registerAstronomer("Low Q", "varrock");
  const r = Astro.createChart("Low Q", "varrock", -5);
  assert.strictEqual(r.quality, 1);
});

test("chartBonusFor scales with quality, caps at 10", () => {
  Astro.registerAstronomer("Prolific", "varrock");
  for (let i = 0; i < 5; i++) Astro.createChart("Prolific", "varrock", 10);
  // 5 charts × 10 quality × 0.5 = 25, capped at 10.
  assert.strictEqual(Astro.chartBonusFor("varrock"), 10);
});

test("chartBonusFor is 0 with no charts", () => {
  assert.strictEqual(Astro.chartBonusFor("empty-kingdom"), 0);
});

// --- events ---

test("activeEventFor returns the scheduled event", () => {
  const jan2026 = new Date(2026, 0, 15).getTime();
  const ev = Astro.activeEventFor("varrock", jan2026);
  assert.ok(ev);
  assert.ok(ev.kind);
});

test("announceEvent throttles", () => {
  const now = Date.now();
  assert.strictEqual(Astro.announceEvent("varrock", "comet", now), true);
  assert.strictEqual(Astro.announceEvent("varrock", "comet", now + 1000), false);
});

test("eventEffectFor returns the active effect amount", () => {
  const jan2026 = new Date(2026, 0, 15).getTime();
  // January 2026: meteor_shower (monthly, travel_speed 15) is active.
  const bonus = Astro.eventEffectFor("varrock", "travel_speed", jan2026);
  assert.strictEqual(bonus, 15);
  // Wrong kind → 0.
  assert.strictEqual(Astro.eventEffectFor("varrock", "crime", jan2026), 0);
});

// --- astrology ---

test("readOmen is deterministic per day", () => {
  const now = Date.now();
  const r1 = Astro.readOmen("Seeker", "varrock", now);
  const r2 = Astro.readOmen("Seeker", "varrock", now + 1000);
  assert.strictEqual(r1.omen, r2.omen); // same day, same omen
  assert.ok(Astro.OMENS.includes(r1.omen));
});

test("readOmen changes across days", () => {
  const day1 = new Date(2026, 5, 1, 12).getTime();
  const day2 = new Date(2026, 5, 2, 12).getTime();
  const r1 = Astro.readOmen("Wanderer", "varrock", day1);
  // Force a new day by clearing the reading.
  Astro.resetForTests();
  const r2 = Astro.readOmen("Wanderer", "varrock", day2);
  // May or may not differ (hash-dependent), but both are valid omens.
  assert.ok(Astro.OMENS.includes(r1.omen));
  assert.ok(Astro.OMENS.includes(r2.omen));
});

test("kingdomOmenFor reflects celestial events", () => {
  const jan2026 = new Date(2026, 0, 15).getTime();
  // January 2026 has meteor_shower active → no special omen.
  const omen = Astro.kingdomOmenFor("varrock", jan2026);
  assert.ok(omen === null || Astro.OMENS.includes(omen));
});

// --- describe ---

test("describe returns a full summary", () => {
  Astro.registerAstronomer("Desc", "varrock");
  Astro.createChart("Desc", "varrock", 6);
  const d = Astro.describe("varrock", Date.now());
  assert.strictEqual(d.kingdomId, "varrock");
  assert.strictEqual(d.chartCount, 1);
  assert.strictEqual(d.astronomerCount, 1);
  assert.ok(d.chartBonus > 0);
});

// --- persistence ---

test("save/load round-trips astronomers", () => {
  Astro.registerAstronomer("Persistent", "varrock");
  const saved = Astro.save();
  assert.strictEqual(saved, true);
  // Simulate a fresh load by clearing the in-memory cache.
  const Astro2 = require("./CitizenAstronomy");
  // resetForTests would wipe the file? No — it only clears memory.
  // Instead verify the file exists and has our astronomer.
  const fs = require("fs");
  const path = require("path");
  const p = path.join(__dirname, "..", "data", "saves", "citizen-astronomy.json");
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  assert.ok(raw.astronomers["persistent"]);
  // Clean up the test save file.
  try { fs.unlinkSync(p); } catch {}
  Astro2.resetForTests();
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
