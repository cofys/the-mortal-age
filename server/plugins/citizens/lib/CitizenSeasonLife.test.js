"use strict";
// CitizenSeasonLife unit checks — season transitions, rain growth, storm
// shelter. Uses fake sky + fake director; no running server.
const assert = require("node:assert/strict");
const Life = require("./CitizenSeasonLife");
const Seasons = require("./CitizenSeasons");

function ms(y, m, d) {
  return new Date(y, m, d, 12, 0, 0).getTime();
}

function fakeSky(weather) {
  return {
    getWeather: () => weather,
    getTimeOfDay: () => "day",
    WEATHER: { CLEAR: "clear", OVERCAST: "overcast", RAIN: "rain", STORM: "storm" },
    TIME: { DAWN: "dawn", DAY: "day", DUSK: "dusk", NIGHT: "night" },
  };
}

function loc(x, y, z) {
  return { getX: () => x, getY: () => y, getZ: () => z ?? 0 };
}

// A fake bot. isRealPlayer() in the module returns true when the bot has
// getUsername as a function and isPlayerBot() !== true.
function fakeBot(username, x, y, { realPlayer = false } = {}) {
  const movedTo = [];
  return {
    _movedTo: movedTo,
    getUsername: realPlayer ? () => username : undefined,
    isPlayerBot: () => !realPlayer,
    getHostAddress: () => (realPlayer ? "127.0.0.1" : "bot"),
    getAttribute: () => ({}),
    getLocation: () => loc(x, y, 0),
    moveTo: (l) => movedTo.push(l),
    _said: [],
  };
}

function fakeDirector(records, botsByUsername) {
  const roster = new Map(records.map((r) => [r.username, r]));
  return {
    roster,
    isOnline: (r) => !!botsByUsername[r.username],
    getBot: (r) => botsByUsername[r.username] ?? null,
    api: { core: { Location: function (x, y, z) { this.x = x; this.y = y; this.z = z; } } },
    log: () => {},
  };
}

function record(username, extra = {}) {
  return {
    username,
    personality: { traits: extra.traits ?? [] },
    role: extra.role ?? "commoner",
    home: { x: 3200, y: 3200, z: 0 },
    kingdomId: "asgarnia",
  };
}

function resetAll() {
  Life._resetState();
  Seasons._resetState();
  Life._setSky(null);
}

// --- seasonTransition: announces a new season once ---
{
  resetAll();
  Life._setSky(fakeSky("clear"));
  const rec = record("ann_anna");
  const bot = fakeBot("ann_anna", 3200, 3200);
  const playerBot = fakeBot("real_jon", 3205, 3205, { realPlayer: true });
  const playerRec = record("real_jon");
  const director = fakeDirector([rec, playerRec], { ann_anna: bot, real_jon: playerBot });
  const now = ms(2026, 0, 15); // winter

  // sayPublic will fail without the engine — that's fine, journal + state
  // are what we assert. The module guards say() in try/catch.
  Life.seasonTransition(director, now, () => 0.99); // rng high: skip chance gates where present
  assert.equal(Seasons._getAnnouncedSeason(), "winter");

  // Second call: no re-announce (same season).
  Seasons._setAnnouncedSeason("winter"); // ensure persisted state
  Life.seasonTransition(director, now + 1000, () => 0);
  assert.equal(Seasons._getAnnouncedSeason(), "winter");
  console.log("seasonTransition: 2 assertions ok");
}

// --- seasonTransition: spring after winter re-announces ---
{
  resetAll();
  Life._setSky(fakeSky("clear"));
  Seasons._setAnnouncedSeason("winter");
  const director = fakeDirector([], {});
  Life.seasonTransition(director, ms(2026, 3, 15), () => 0.5); // spring
  assert.equal(Seasons._getAnnouncedSeason(), "spring");
  console.log("seasonTransition spring: 1 assertion ok");
}

// --- applyRainGrowth: no bonus when clear ---
{
  resetAll();
  Life._setSky(fakeSky("clear"));
  const director = fakeDirector([], {});
  const boosted = Life.applyRainGrowth(director, ms(2026, 3, 15), "clear", () => 0.5);
  assert.equal(boosted, 0);
  console.log("applyRainGrowth clear: 1 assertion ok");
}

// --- applyRainGrowth: no farming module in plain node -> 0, never throws ---
{
  resetAll();
  Life._setSky(fakeSky("rain"));
  const rec = record("farm_fred");
  const bot = fakeBot("farm_fred", 3200, 3200);
  const director = fakeDirector([rec], { farm_fred: bot });
  // Patches.Farming requires the engine; in plain node the require fails
  // and the module degrades to 0. The point: never throws.
  const boosted = Life.applyRainGrowth(director, ms(2026, 3, 15), "rain", () => 0.5);
  assert.ok(boosted >= 0);
  console.log("applyRainGrowth rain (no engine): 1 assertion ok");
}

// --- stormShelter: non-guards walk home, guards stay ---
{
  resetAll();
  Life._setSky(fakeSky("storm"));
  const commoner = record("shel_sue");
  const guard = record("guard_gus", { role: "guard" });
  const playerRec = record("real_jon2");
  const cBot = fakeBot("shel_sue", 3200, 3200);
  const gBot = fakeBot("guard_gus", 3201, 3201);
  const pBot = fakeBot("real_jon2", 3205, 3205, { realPlayer: true });
  const director = fakeDirector(
    [commoner, guard, playerRec],
    { shel_sue: cBot, guard_gus: gBot, real_jon2: pBot }
  );
  Life.stormShelter(director, ms(2026, 6, 15), "storm");
  assert.equal(cBot._movedTo.length, 1, "commoner walks home in storm");
  assert.equal(gBot._movedTo.length, 0, "guard holds post in storm");
  console.log("stormShelter: 2 assertions ok");
}

// --- stormShelter: no storm, nobody moves ---
{
  resetAll();
  Life._setSky(fakeSky("clear"));
  const commoner = record("shel_sam");
  const cBot = fakeBot("shel_sam", 3200, 3200);
  const director = fakeDirector([commoner], { shel_sam: cBot });
  Life.stormShelter(director, ms(2026, 6, 15), "clear");
  assert.equal(cBot._movedTo.length, 0);
  console.log("stormShelter clear: 1 assertion ok");
}

// --- tickSeasonLife: never throws, even with an empty/broken director ---
{
  resetAll();
  Life._setSky(fakeSky("rain"));
  assert.doesNotThrow(() => Life.tickSeasonLife(null, ms(2026, 3, 15), () => 0.5));
  assert.doesNotThrow(() => Life.tickSeasonLife({}, ms(2026, 3, 15), () => 0.5));
  assert.doesNotThrow(() =>
    Life.tickSeasonLife(fakeDirector([], {}), ms(2026, 0, 15), () => 0.5)
  );
  console.log("tickSeasonLife robustness: 3 assertions ok");
}

// --- pickOne is deterministic with injected rng ---
{
  resetAll();
  const arr = ["a", "b", "c"];
  assert.equal(Life.pickOne(() => 0, arr), "a");
  assert.equal(Life.pickOne(() => 0.99, arr), "c");
  console.log("pickOne: 2 assertions ok");
}

console.log("CitizenSeasonLife.test.js: ALL PASS");
