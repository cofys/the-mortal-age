"use strict";
// CitizenWeatherReactions unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const {
  rainAttitude,
  nightBehavior,
  isEarlyRiser,
  detectTransitions,
  commitSkyState,
  pickOne,
  isRealPlayer,
  withinTiles,
  tickWeatherReactions,
  _setSky,
  _resetState,
} = require("./CitizenWeatherReactions");

// Deterministic LCG — coverage is exact, not luck-based.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function fakeSky(weather, timeOfDay) {
  return {
    getWeather: () => weather,
    getTimeOfDay: () => timeOfDay,
    WEATHER: { CLEAR: "clear", OVERCAST: "overcast", RAIN: "rain", STORM: "storm" },
    TIME: { DAWN: "dawn", DAY: "day", DUSK: "dusk", NIGHT: "night" },
  };
}

function recordWith(traits, extra = {}) {
  return {
    username: "test_citizen",
    personality: { traits, quirk: extra.quirk ?? "" },
    role: extra.role ?? "commoner",
    home: { x: 3200, y: 3200, z: 0 },
    kingdomId: "asgarnia",
  };
}

// --- rainAttitude ---
{
  assert.equal(rainAttitude(recordWith(["cheerful"])), "love");
  assert.equal(rainAttitude(recordWith(["daydreamer"])), "love");
  assert.equal(rainAttitude(recordWith(["easygoing"])), "love");
  assert.equal(rainAttitude(recordWith(["gruff"])), "hate");
  assert.equal(rainAttitude(recordWith(["fidgety"])), "hate");
  assert.equal(rainAttitude(recordWith(["proud"])), "hate");
  assert.equal(rainAttitude(recordWith(["dutiful"])), "neutral");
  assert.equal(rainAttitude(recordWith([])), "neutral");
  assert.equal(rainAttitude({}), "neutral");
  console.log("rainAttitude: 9 assertions ok");
}

// --- nightBehavior ---
{
  assert.equal(nightBehavior(recordWith(["chatty"], { quirk: "is afraid of the dark and hurries home at dusk" })), "flee");
  assert.equal(nightBehavior(recordWith(["devout"])), "pray");
  assert.equal(nightBehavior(recordWith(["dutiful"], { role: "guard" })), "stay");
  assert.equal(nightBehavior(recordWith(["chatty"])), "home");
  assert.equal(nightBehavior(recordWith([])), "home");
  console.log("nightBehavior: 5 assertions ok");
}

// --- isEarlyRiser ---
{
  assert.equal(isEarlyRiser(recordWith(["dutiful"])), true);
  assert.equal(isEarlyRiser(recordWith(["methodical"])), true);
  assert.equal(isEarlyRiser(recordWith(["daydreamer"])), false);
  assert.equal(isEarlyRiser(recordWith([])), false);
  console.log("isEarlyRiser: 4 assertions ok");
}

// --- detectTransitions ---
{
  _resetState();
  const sky = fakeSky("clear", "day");
  // First observation: records state, never fires.
  let t = detectTransitions(sky);
  assert.equal(t.rainStarted, false);
  assert.equal(t.dawnBroke, false);
  assert.equal(t.raining, false);
  commitSkyState(t.weather, t.timeOfDay);

  // clear -> rain
  const sky2 = fakeSky("rain", "day");
  t = detectTransitions(sky2);
  assert.equal(t.rainStarted, true);
  assert.equal(t.stormStarted, false);
  assert.equal(t.raining, true);
  commitSkyState(t.weather, t.timeOfDay);

  // rain -> storm
  const sky3 = fakeSky("storm", "day");
  t = detectTransitions(sky3);
  assert.equal(t.rainStarted, false); // already wet
  assert.equal(t.stormStarted, true);
  commitSkyState(t.weather, t.timeOfDay);

  // storm -> clear
  const sky4 = fakeSky("clear", "day");
  t = detectTransitions(sky4);
  assert.equal(t.rainStarted, false);
  assert.equal(t.raining, false);
  commitSkyState(t.weather, t.timeOfDay);

  // day -> dusk -> night -> dawn
  t = detectTransitions(fakeSky("clear", "dusk"));
  assert.equal(t.duskFell, true);
  assert.equal(t.nightFell, false);
  commitSkyState(t.weather, t.timeOfDay);
  t = detectTransitions(fakeSky("clear", "night"));
  assert.equal(t.duskFell, false);
  assert.equal(t.nightFell, true);
  commitSkyState(t.weather, t.timeOfDay);
  t = detectTransitions(fakeSky("clear", "dawn"));
  assert.equal(t.dawnBroke, true);
  commitSkyState(t.weather, t.timeOfDay);
  console.log("detectTransitions: 16 assertions ok");
}

// --- pickOne / isRealPlayer / withinTiles ---
{
  const rng = lcg(42);
  const T0 = Date.now();
  assert.equal(pickOne(rng, ["a"]), "a");
  const v = pickOne(lcg(1), ["x", "y", "z"]);
  assert.ok(["x", "y", "z"].includes(v));

  assert.equal(isRealPlayer(null), false);
  assert.equal(isRealPlayer({ isPlayerBot: () => true }), false);
  assert.equal(isRealPlayer({ getHostAddress: () => "bot", getUsername: () => "x" }), false);
  assert.equal(isRealPlayer({ getUsername: () => "real_joe" }), true);

  const at = (x, y, z = 0) => ({ getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => z }) });
  assert.equal(withinTiles(at(0, 0), at(10, 10), 16), true);
  assert.equal(withinTiles(at(0, 0), at(17, 0), 16), false);
  assert.equal(withinTiles(at(0, 0, 0), at(0, 0, 1), 16), false);
  console.log("pickOne/isRealPlayer/withinTiles: 9 assertions ok");
}

// --- tickWeatherReactions: rain reaction fires for a hater near a player ---
{
  _resetState();
  _setSky(fakeSky("clear", "day"));
  const said = [];
  const moved = [];
  const journaled = [];
  const bot = {
    forceChat: (line) => said.push(line),
    moveTo: (loc) => moved.push(loc),
    getLocation: () => ({ getX: () => 3200, getY: () => 3200, getZ: () => 0 }),
  };
  const realPlayer = {
    getUsername: () => "real_joe",
    getLocation: () => ({ getX: () => 3205, getY: () => 3205, getZ: () => 0 }),
  };
  const record = recordWith(["gruff"]);
  const director = {
    roster: new Map([[record.username, record]]),
    playerFor: () => bot,
    onlinePlayers: () => [realPlayer],
    api: { core: { Location: function (x, y, z) { this.x = x; this.y = y; this.z = z; } } },
  };
  // Stub the journal module before ticking.
  const Module = require("module");
  const origResolve = Module._resolveFilename;
  require.cache[require.resolve("./CitizenJournal")] = {
    exports: { getJournal: () => ({ log: (u, k, text, opts) => journaled.push({ u, text, opts }) }) },
  };

  const rng = lcg(7);
  const T0 = Date.now();
  tickWeatherReactions(director, T0, rng); // first tick: records state, no reaction
  assert.equal(said.length, 0);

  _setSky(fakeSky("rain", "day"));
  tickWeatherReactions(director, T0 + 60000, rng); // rain starts -> hater reacts
  assert.equal(said.length, 1);
  assert.equal(moved.length, 1); // hater walks home
  assert.equal(journaled.length, 1);
  assert.ok(journaled[0].text.includes("rain"));

  // Cooldown: second tick does not re-fire.
  tickWeatherReactions(director, T0 + 61000, rng);
  assert.equal(said.length, 1);
  console.log("tickWeatherReactions (rain hater): 6 assertions ok");

  delete require.cache[require.resolve("./CitizenJournal")];
  Module._resolveFilename = origResolve;
}

// --- tickWeatherReactions: rain lover cheers but does not walk home ---
{
  _resetState();
  _setSky(fakeSky("clear", "day"));
  const said = [];
  const moved = [];
  const bot = {
    forceChat: (line) => said.push(line),
    moveTo: (loc) => moved.push(loc),
    getLocation: () => ({ getX: () => 3200, getY: () => 3200, getZ: () => 0 }),
  };
  const realPlayer = {
    getUsername: () => "real_joe",
    getLocation: () => ({ getX: () => 3205, getY: () => 3205, getZ: () => 0 }),
  };
  const record = recordWith(["cheerful"]);
  const director = {
    roster: new Map([[record.username, record]]),
    playerFor: () => bot,
    onlinePlayers: () => [realPlayer],
    api: { core: { Location: function (x, y, z) { this.x = x; this.y = y; this.z = z; } } },
  };
  require.cache[require.resolve("./CitizenJournal")] = {
    exports: { getJournal: () => ({ log: () => {} }) },
  };
  const rng = lcg(11);
  const T0 = Date.now();
  tickWeatherReactions(director, T0, rng);
  _setSky(fakeSky("rain", "day"));
  tickWeatherReactions(director, T0 + 60000, rng);
  assert.equal(said.length, 1);
  assert.equal(moved.length, 0); // lover stays out in the rain
  console.log("tickWeatherReactions (rain lover): 2 assertions ok");
  delete require.cache[require.resolve("./CitizenJournal")];
}

// --- tickWeatherReactions: no player near -> silent ---
{
  _resetState();
  _setSky(fakeSky("clear", "day"));
  const said = [];
  const bot = {
    forceChat: (line) => said.push(line),
    getLocation: () => ({ getX: () => 3200, getY: () => 3200, getZ: () => 0 }),
  };
  const record = recordWith(["gruff"]);
  const director = {
    roster: new Map([[record.username, record]]),
    playerFor: () => bot,
    onlinePlayers: () => [], // nobody around
    api: { core: {} },
  };
  require.cache[require.resolve("./CitizenJournal")] = {
    exports: { getJournal: () => ({ log: () => {} }) },
  };
  const rng = lcg(13);
  const T0 = Date.now();
  tickWeatherReactions(director, T0, rng);
  _setSky(fakeSky("storm", "day"));
  tickWeatherReactions(director, T0 + 60000, rng);
  assert.equal(said.length, 0); // silent with no audience
  console.log("tickWeatherReactions (no player): 1 assertion ok");
  delete require.cache[require.resolve("./CitizenJournal")];
}

// --- tickWeatherReactions: dawn wakes early risers, not daydreamers ---
{
  _resetState();
  _setSky(fakeSky("clear", "night"));
  const said = [];
  const mkBot = () => ({
    forceChat: (line) => said.push(line),
    getLocation: () => ({ getX: () => 3200, getY: () => 3200, getZ: () => 0 }),
  });
  const realPlayer = {
    getUsername: () => "real_joe",
    getLocation: () => ({ getX: () => 3205, getY: () => 3205, getZ: () => 0 }),
  };
  const riser = { ...recordWith(["dutiful"]), username: "riser" };
  const sleeper = { ...recordWith(["daydreamer"]), username: "sleeper" };
  const director = {
    roster: new Map([[riser.username, riser], [sleeper.username, sleeper]]),
    playerFor: () => mkBot(),
    onlinePlayers: () => [realPlayer],
    api: { core: {} },
  };
  require.cache[require.resolve("./CitizenJournal")] = {
    exports: { getJournal: () => ({ log: () => {} }) },
  };
  const rng = lcg(17);
  const T0 = Date.now();
  tickWeatherReactions(director, T0, rng);
  _setSky(fakeSky("clear", "dawn"));
  tickWeatherReactions(director, T0 + 60000, rng);
  assert.equal(said.length, 1); // only the early riser speaks
  console.log("tickWeatherReactions (dawn): 1 assertion ok");
  delete require.cache[require.resolve("./CitizenJournal")];
}

// --- tickWeatherReactions: guard stays at post at night ---
{
  _resetState();
  _setSky(fakeSky("clear", "dusk"));
  const said = [];
  const moved = [];
  const bot = {
    forceChat: (line) => said.push(line),
    moveTo: (loc) => moved.push(loc),
    getLocation: () => ({ getX: () => 3200, getY: () => 3200, getZ: () => 0 }),
  };
  const realPlayer = {
    getUsername: () => "real_joe",
    getLocation: () => ({ getX: () => 3205, getY: () => 3205, getZ: () => 0 }),
  };
  const record = recordWith(["dutiful"], { role: "guard" });
  const director = {
    roster: new Map([[record.username, record]]),
    playerFor: () => bot,
    onlinePlayers: () => [realPlayer],
    api: { core: { Location: function (x, y, z) { this.x = x; this.y = y; this.z = z; } } },
  };
  require.cache[require.resolve("./CitizenJournal")] = {
    exports: { getJournal: () => ({ log: () => {} }) },
  };
  const rng = lcg(19);
  const T0 = Date.now();
  tickWeatherReactions(director, T0, rng);
  _setSky(fakeSky("clear", "night"));
  tickWeatherReactions(director, T0 + 60000, rng);
  assert.equal(said.length, 0); // guard holds post, silent
  assert.equal(moved.length, 0);
  console.log("tickWeatherReactions (guard at night): 2 assertions ok");
  delete require.cache[require.resolve("./CitizenJournal")];
}

// --- tickWeatherReactions: never throws on a hostile director ---
{
  _resetState();
  _setSky(null); // no sky at all
  tickWeatherReactions({}, Date.now(), lcg(23)); // must not throw
  _setSky({ getWeather: () => { throw new Error("sky exploded"); } });
  tickWeatherReactions({ roster: new Map() }, Date.now(), lcg(29)); // must not throw
  console.log("tickWeatherReactions (never throws): 2 assertions ok");
}

console.log("\nAll CitizenWeatherReactions tests passed.");
