"use strict";
// CitizenDayNight unit checks — pure date math and multipliers, no engine.
const assert = require("node:assert/strict");
const D = require("./CitizenDayNight");

function msAt(hour, y = 2026, m = 5, d = 15) {
  return new Date(y, m, d, hour, 0, 0).getTime();
}

// --- timeOfDay: hour bands (mirrors the Sky) ---
{
  assert.equal(D.timeOfDay(msAt(6)), "dawn");
  assert.equal(D.timeOfDay(msAt(7)), "dawn");
  assert.equal(D.timeOfDay(msAt(8)), "day");
  assert.equal(D.timeOfDay(msAt(12)), "day");
  assert.equal(D.timeOfDay(msAt(16)), "day");
  assert.equal(D.timeOfDay(msAt(17)), "dusk");
  assert.equal(D.timeOfDay(msAt(19)), "dusk");
  assert.equal(D.timeOfDay(msAt(20)), "night");
  assert.equal(D.timeOfDay(msAt(23)), "night");
  assert.equal(D.timeOfDay(msAt(0)), "night");
  assert.equal(D.timeOfDay(msAt(4)), "night");
  console.log("timeOfDay: 11 assertions ok");
}

// --- isNight / isDay / isDawn / isDusk ---
{
  assert.equal(D.isNight(msAt(22)), true);
  assert.equal(D.isNight(msAt(12)), false);
  assert.equal(D.isDay(msAt(12)), true);
  assert.equal(D.isDay(msAt(22)), false);
  assert.equal(D.isDawn(msAt(6)), true);
  assert.equal(D.isDawn(msAt(12)), false);
  assert.equal(D.isDusk(msAt(18)), true);
  assert.equal(D.isDusk(msAt(12)), false);
  console.log("isNight/isDay/isDawn/isDusk: 8 assertions ok");
}

// --- isSleepHour: 21:00-05:00 ---
{
  assert.equal(D.isSleepHour(msAt(22)), true);
  assert.equal(D.isSleepHour(msAt(2)), true);
  assert.equal(D.isSleepHour(msAt(21)), true);
  assert.equal(D.isSleepHour(msAt(4)), true);
  assert.equal(D.isSleepHour(msAt(5)), false);
  assert.equal(D.isSleepHour(msAt(12)), false);
  assert.equal(D.isSleepHour(msAt(20)), false);
  console.log("isSleepHour: 7 assertions ok");
}

// --- isNightOwl: trait/quirk detection, pure ---
{
  assert.equal(D.isNightOwl({ personality: { traits: ["night-owl"] } }), true);
  assert.equal(D.isNightOwl({ personality: { traits: ["nocturnal"] } }), true);
  assert.equal(D.isNightOwl({ personality: { quirk: "a night owl who never sleeps" } }), true);
  assert.equal(D.isNightOwl({ personality: { traits: ["dutiful"] } }), false);
  assert.equal(D.isNightOwl({}), false);
  assert.equal(D.isNightOwl(null), false);
  console.log("isNightOwl: 6 assertions ok");
}

// --- nightWorkPenalty / nightCrimeMultiplier / monsterDanger ---
{
  assert.equal(D.nightWorkPenalty(msAt(22)), -15);
  assert.equal(D.nightWorkPenalty(msAt(12)), 0);
  assert.equal(D.nightCrimeMultiplier(msAt(22)), 2.0);
  assert.equal(D.nightCrimeMultiplier(msAt(12)), 1.0);
  assert.equal(D.monsterDanger(msAt(22)), 2.5);
  assert.equal(D.monsterDanger(msAt(12)), 1.0);
  console.log("penalties/multipliers: 6 assertions ok");
}

// --- lampsLit: dusk/night/dawn ---
{
  assert.equal(D.lampsLit(msAt(18)), true); // dusk
  assert.equal(D.lampsLit(msAt(22)), true); // night
  assert.equal(D.lampsLit(msAt(6)), true); // dawn
  assert.equal(D.lampsLit(msAt(12)), false); // day
  console.log("lampsLit: 4 assertions ok");
}

// --- describe: human time descriptions ---
{
  assert.equal(D.describe(msAt(0)), "the dead of night");
  assert.equal(D.describe(msAt(3)), "night");
  assert.equal(D.describe(msAt(6)), "early morning");
  assert.equal(D.describe(msAt(10)), "morning");
  assert.equal(D.describe(msAt(12)), "midday");
  assert.equal(D.describe(msAt(15)), "afternoon");
  assert.equal(D.describe(msAt(18)), "dusk");
  console.log("describe: 7 assertions ok");
}

// --- noteTransitionAnnounced: dedupe + dirty flag ---
{
  D._resetForTests();
  assert.equal(D.noteTransitionAnnounced("dusk"), true); // first: announce
  assert.equal(D.noteTransitionAnnounced("dusk"), false); // repeat: skip
  assert.equal(D.noteTransitionAnnounced("night"), true); // new: announce
  assert.equal(D.lastTransition(), "night");
  assert.equal(D.save(), true); // dirty -> saved
  assert.equal(D.save(), false); // clean -> nothing
  D._resetForTests();
  console.log("transitions/persistence: 6 assertions ok");
}

console.log("CitizenDayNight: all tests passed");
