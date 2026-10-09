"use strict";
// CitizenSeasons unit checks — pure date math and multipliers, no engine.
const assert = require("node:assert/strict");
const S = require("./CitizenSeasons");

function ms(y, m, d) {
  return new Date(y, m, d, 12, 0, 0).getTime();
}

// --- seasonOf: month boundaries ---
{
  assert.equal(S.seasonOf(ms(2026, 0, 15)), "winter"); // Jan
  assert.equal(S.seasonOf(ms(2026, 1, 15)), "winter"); // Feb
  assert.equal(S.seasonOf(ms(2026, 2, 15)), "spring"); // Mar
  assert.equal(S.seasonOf(ms(2026, 4, 15)), "spring"); // May
  assert.equal(S.seasonOf(ms(2026, 5, 15)), "summer"); // Jun
  assert.equal(S.seasonOf(ms(2026, 7, 15)), "summer"); // Aug
  assert.equal(S.seasonOf(ms(2026, 8, 15)), "autumn"); // Sep
  assert.equal(S.seasonOf(ms(2026, 10, 15)), "autumn"); // Nov
  assert.equal(S.seasonOf(ms(2026, 11, 15)), "winter"); // Dec
  console.log("seasonOf: 9 assertions ok");
}

// --- isWinter / coldMultiplier ---
{
  assert.equal(S.isWinter(ms(2026, 0, 15)), true);
  assert.equal(S.isWinter(ms(2026, 6, 15)), false);
  assert.equal(S.isWinter(ms(2026, 11, 15)), true);
  assert.equal(S.coldMultiplier(ms(2026, 0, 15)), 2.0); // winter: sick season
  assert.equal(S.coldMultiplier(ms(2026, 6, 15)), 0.8); // summer: healthiest
  assert.equal(S.coldMultiplier(ms(2026, 3, 15)), 1.0); // spring: baseline
  console.log("isWinter/coldMultiplier: 6 assertions ok");
}

// --- growthMultiplier: season x weather ---
{
  // Spring rain: fastest growth in the realm.
  const springRain = S.growthMultiplier(ms(2026, 3, 15), "rain");
  assert.ok(Math.abs(springRain - 1.25 * 1.5) < 1e-9, `spring rain=${springRain}`);
  // Winter storm: slowest.
  const winterStorm = S.growthMultiplier(ms(2026, 0, 15), "storm");
  assert.ok(Math.abs(winterStorm - 0.7 * 0.8) < 1e-9, `winter storm=${winterStorm}`);
  // Clear summer: baseline-ish.
  const summerClear = S.growthMultiplier(ms(2026, 6, 15), "clear");
  assert.ok(Math.abs(summerClear - 1.1) < 1e-9, `summer clear=${summerClear}`);
  // Unknown/null weather defaults to clear.
  assert.equal(S.growthMultiplier(ms(2026, 6, 15), null), 1.1);
  assert.equal(S.growthMultiplier(ms(2026, 6, 15), "hail"), 1.1);
  // Rain always beats clear in the same season.
  assert.ok(S.growthMultiplier(ms(2026, 9, 15), "rain") > S.growthMultiplier(ms(2026, 9, 15), "clear"));
  console.log("growthMultiplier: 6 assertions ok");
}

// --- outdoorWorkPenalty ---
{
  assert.equal(S.outdoorWorkPenalty("storm"), -30); // genuinely dangerous
  assert.equal(S.outdoorWorkPenalty("rain"), -8); // merely miserable
  assert.equal(S.outdoorWorkPenalty("clear"), 0);
  assert.equal(S.outdoorWorkPenalty("overcast"), 0);
  assert.equal(S.outdoorWorkPenalty(null), 0);
  assert.ok(S.outdoorWorkPenalty("storm") < S.outdoorWorkPenalty("rain"));
  console.log("outdoorWorkPenalty: 6 assertions ok");
}

// --- warmClothesNeeded / seasonalFestival / describe ---
{
  assert.equal(S.warmClothesNeeded(ms(2026, 0, 15)), true);
  assert.equal(S.warmClothesNeeded(ms(2026, 6, 15)), false);
  assert.equal(S.seasonalFestival("autumn"), "harvest-home");
  assert.equal(S.seasonalFestival("winter"), "embernight");
  assert.equal(S.seasonalFestival("spring"), "springtide");
  assert.equal(S.seasonalFestival("summer"), "midsummer");
  assert.equal(S.seasonalFestival("bogus"), null);
  assert.equal(S.describe(ms(2026, 0, 5)), "early winter");
  assert.equal(S.describe(ms(2026, 0, 15)), "mid winter");
  assert.equal(S.describe(ms(2026, 0, 25)), "late winter");
  assert.equal(S.describe(ms(2026, 3, 15)), "mid spring");
  console.log("warmClothes/seasonalFestival/describe: 11 assertions ok");
}

// --- rainBonusMs: weather-attributable bonus only ---
{
  // Spring rain on a 60s tick: 60s * 1.25 * (1.5 - 1) = 37.5s bonus.
  const bonus = S.rainBonusMs(ms(2026, 3, 15), "rain");
  assert.equal(bonus, Math.round(60000 * 1.25 * 0.5));
  assert.ok(bonus > 0);
  // Clear weather: no bonus (seasonal baseline is the engine's own clock).
  assert.equal(S.rainBonusMs(ms(2026, 3, 15), "clear"), 0);
  // Winter storm: weather multiplier < 1, no bonus.
  assert.equal(S.rainBonusMs(ms(2026, 0, 15), "storm"), 0);
  // Overcast: no bonus.
  assert.equal(S.rainBonusMs(ms(2026, 6, 15), "overcast"), 0);
  // Summer rain still helps, less than spring.
  const summerRain = S.rainBonusMs(ms(2026, 6, 15), "rain");
  assert.ok(summerRain > 0 && summerRain < bonus);
  console.log("rainBonusMs: 6 assertions ok");
}

// --- persistence seams ---
{
  S._resetState();
  assert.equal(S._getAnnouncedSeason(), null);
  S._setAnnouncedSeason("winter");
  assert.equal(S._getAnnouncedSeason(), "winter");
  S._resetState();
  assert.equal(S._getAnnouncedSeason(), null);
  console.log("persistence seams: 4 assertions ok");
}

console.log("CitizenSeasons.test.js: ALL PASS");
