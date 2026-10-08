"use strict";
// CitizenFarmers unit checks — pure logic, no running server.
const assert = require("node:assert/strict");

const {
  hashStr,
  farmerTypeFor,
  seasonFor,
  dayOfYear,
  weatherProxyFor,
  cropStageFor,
  livestockTaskFor,
  orchardTaskFor,
  apiaryTaskFor,
  produceFor,
  hasProduceReady,
  farmProduceFor,
  taskFor,
  workLineFor,
  pitchLineFor,
  shouldFire,
  shouldPitch,
  pickOne,
  isRealPlayer,
  withinTiles,
  tickFarmers,
  _resetState,
} = require("./CitizenFarmers");

// Deterministic LCG — coverage is exact, not luck-based.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Fixed dates (UTC) across seasons.
const D = {
  spring: Date.UTC(2026, 3, 15, 12, 0), // Apr 15
  summer: Date.UTC(2026, 6, 20, 12, 0), // Jul 20
  autumn: Date.UTC(2026, 9, 10, 12, 0), // Oct 10
  winter: Date.UTC(2026, 0, 25, 12, 0), // Jan 25
};

// --- hashing ---
assert.ok(Number.isInteger(hashStr("a")) && hashStr("a") >= 0, "hashStr returns uint32");
assert.equal(hashStr("abc"), hashStr("abc"), "hashStr is deterministic");
assert.notEqual(hashStr("abc"), hashStr("abd"), "hashStr distinguishes inputs");

// --- farmer assignment ---
const types = new Set();
for (let i = 0; i < 200; i++) {
  const t = farmerTypeFor("farmeruser" + i);
  if (t) {
    types.add(t);
    assert.ok(["crop", "livestock", "orchard", "apiary"].includes(t), "valid farmer type");
  }
}
assert.ok(types.size === 4, "all four farmer types appear across 200 names");
assert.equal(farmerTypeFor("someuser"), farmerTypeFor("SOMEUSER"), "case-insensitive, stable");
assert.equal(farmerTypeFor(""), null, "empty username -> null");
assert.equal(farmerTypeFor(null), null, "null username -> null");
let farmerCount = 0;
for (let i = 0; i < 1000; i++) if (farmerTypeFor("pop" + i)) farmerCount++;
assert.ok(farmerCount > 30 && farmerCount < 120, `~6.9% farmers (primary-profession partition), got ${farmerCount}/1000`);

// --- seasons ---
assert.equal(seasonFor(0), "winter");
assert.equal(seasonFor(3), "spring");
assert.equal(seasonFor(6), "summer");
assert.equal(seasonFor(9), "autumn");
assert.equal(seasonFor(11), "winter");

// --- day of year ---
assert.equal(dayOfYear(Date.UTC(2026, 0, 1)), 1, "Jan 1 is day 1");
assert.ok(dayOfYear(Date.UTC(2026, 11, 31)) >= 365, "Dec 31 is ~365");

// --- weather proxy ---
const w1 = weatherProxyFor(D.spring);
const w2 = weatherProxyFor(D.spring);
assert.deepEqual(w1, w2, "weather proxy deterministic per day");
assert.equal(w1.season, "spring");
assert.equal(typeof w1.rain, "boolean");
const wWinter = weatherProxyFor(D.winter);
assert.equal(wWinter.season, "winter");
let rainDays = 0;
for (let d = 1; d <= 100; d++) {
  if (weatherProxyFor(Date.UTC(2026, 3, d)).rain) rainDays++;
}
assert.ok(rainDays > 25 && rainDays < 65, `spring rain ~45%, got ${rainDays}/100`);

// --- crop stages ---
const springStage = cropStageFor("cropbob", D.spring);
assert.ok(["plowing", "planting"].includes(springStage), `spring stage, got ${springStage}`);
assert.equal(cropStageFor("cropbob", D.spring), springStage, "crop stage deterministic");
assert.equal(cropStageFor("cropbob", D.autumn), "harvest", "autumn is harvest");
assert.equal(cropStageFor("cropbob", D.winter), "fallow", "winter is fallow");
const summerStage = cropStageFor("cropbob", D.summer);
assert.ok(
  ["watering", "weeding", "growing"].includes(summerStage),
  `summer stage, got ${summerStage}`
);

// --- livestock daily rhythm ---
assert.equal(livestockTaskFor(Date.UTC(2026, 6, 20, 5, 0)), "milking");
assert.equal(livestockTaskFor(Date.UTC(2026, 6, 20, 9, 0)), "feeding");
assert.equal(livestockTaskFor(Date.UTC(2026, 6, 20, 14, 0)), "grazing");
assert.equal(livestockTaskFor(Date.UTC(2026, 6, 20, 18, 0)), "penning");
assert.equal(livestockTaskFor(Date.UTC(2026, 6, 20, 22, 0)), "resting");

// --- orchard / apiary by season ---
assert.equal(orchardTaskFor(D.spring), "pruning");
assert.equal(orchardTaskFor(D.autumn), "picking");
assert.equal(orchardTaskFor(D.winter), "mending");
assert.equal(apiaryTaskFor(D.summer), "harvesting");
assert.equal(apiaryTaskFor(D.winter), "wintering");

// --- produce ---
assert.ok(produceFor("crop", "autumn").includes("wheat"), "autumn wheat");
assert.deepEqual(produceFor("crop", "winter"), [], "no winter crops");
assert.ok(produceFor("orchard", "autumn").includes("apple"), "autumn apples");
assert.deepEqual(produceFor("orchard", "spring"), [], "no spring fruit");
assert.ok(produceFor("apiary", "summer").includes("honey"), "summer honey");
assert.ok(produceFor("livestock", "spring").includes("milk"), "spring milk");

// --- produce readiness ---
// Find a crop farmer and check harvest readiness in autumn.
let cropFarmer = null;
for (let i = 0; i < 500 && !cropFarmer; i++) {
  if (farmerTypeFor("seekcrop" + i) === "crop") cropFarmer = "seekcrop" + i;
}
assert.ok(cropFarmer, "found a crop farmer in 500 names");
assert.equal(hasProduceReady(cropFarmer, D.autumn), true, "crop farmer has produce at harvest");
assert.equal(hasProduceReady(cropFarmer, D.winter), false, "no produce in winter fallow");
assert.equal(hasProduceReady("definitelynotafarmerxyz", D.autumn), false, "non-farmer -> false");
const offer = farmProduceFor(cropFarmer, D.autumn);
assert.ok(offer && offer.items.includes("wheat") && offer.season === "autumn", "produce offer shape");
assert.equal(farmProduceFor("definitelynotafarmerxyz", D.autumn), null, "non-farmer -> null offer");

// --- task routing ---
for (let i = 0; i < 50; i++) {
  const t = taskFor("routecheck" + i, D.summer);
  const type = farmerTypeFor("routecheck" + i);
  if (type === "crop") assert.ok(["watering", "weeding", "growing"].includes(t), `crop summer task ${t}`);
  if (type === "livestock") assert.ok(["milking", "feeding", "grazing", "penning", "resting"].includes(t));
  if (type === "orchard") assert.equal(t, "watering");
  if (type === "apiary") assert.equal(t, "harvesting");
}
assert.equal(taskFor("definitelynotafarmerxyz", D.summer), null, "non-farmer -> null task");

// --- work lines ---
const rng = lcg(42);
assert.ok(workLineFor(rng, "harvest").startsWith("*"), "harvest line is an emote");
assert.equal(workLineFor(rng, "nosuchtask"), null, "unknown task -> null");
const pitch = pitchLineFor(rng, cropFarmer, D.autumn);
assert.ok(typeof pitch === "string" && pitch.length > 0, "pitch line generated");
assert.equal(pitchLineFor(rng, cropFarmer, D.winter), null, "no pitch when no produce");
assert.equal(pitchLineFor(rng, "definitelynotafarmerxyz", D.autumn), null, "non-farmer -> null pitch");

// --- gating ---
assert.equal(shouldFire(lcg(1), 0, 5 * 3600 * 1000), true, "fires when cooldown clear and chance passes (seed 1)");
assert.equal(shouldFire(lcg(1), 900, 1000), false, "cooldown blocks");
assert.equal(shouldPitch(lcg(1), 0, 3 * 3600 * 1000), true, "pitch fires when clear");
assert.equal(shouldPitch(lcg(1), 900, 1000), false, "pitch cooldown blocks");

// --- player helpers ---
assert.equal(isRealPlayer(null), false);
assert.equal(isRealPlayer({}), false);
assert.equal(isRealPlayer({ isPlayerBot: () => true }), false, "bots are not real");
assert.equal(isRealPlayer({ getHostAddress: () => "bot" }), false, "bot host not real");
assert.equal(isRealPlayer({ getUsername: () => "Cofy" }), true, "real player passes");

function fakeLoc(x, y, z) {
  return { getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => z }) };
}
assert.equal(withinTiles(fakeLoc(0, 0, 0), fakeLoc(10, 5, 0), 14), true);
assert.equal(withinTiles(fakeLoc(0, 0, 0), fakeLoc(20, 0, 0), 14), false);
assert.equal(withinTiles(fakeLoc(0, 0, 0), fakeLoc(0, 0, 1), 14), false, "different plane fails");

// --- tick: farmer fires near a real player ---
_resetState();
const chatLines = [];
const citizenPlayer = {
  getUsername: () => "farmbob",
  getLocation: () => ({ getX: () => 100, getY: () => 100, getZ: () => 0 }),
  forceChat: (msg) => chatLines.push(msg),
};
// Find a username that is a farmer.
let farmerName = null;
for (let i = 0; i < 500 && !farmerName; i++) {
  if (farmerTypeFor("tickfarm" + i)) farmerName = "tickfarm" + i;
}
assert.ok(farmerName, "found farmer for tick test");
const realPlayer = {
  getUsername: () => "Cofy",
  getLocation: () => ({ getX: () => 105, getY: () => 105, getZ: () => 0 }),
};
const roster = new Map([[farmerName, { username: farmerName, role: "commoner" }]]);
const director = {
  roster,
  playerFor: (rec) => (rec.username === farmerName ? citizenPlayer : null),
  onlinePlayers: () => [realPlayer],
};
// Force the chance gate: run many ticks until one fires (cooldown starts clear).
let fired = false;
for (let i = 0; i < 40 && !fired; i++) {
  chatLines.length = 0;
  tickFarmers(director, Date.now() + i * 5 * 60 * 60 * 1000); // 5h apart beats cooldown
  fired = chatLines.length > 0;
}
assert.ok(fired, "farmer produced visible work near a real player within 40 ticks");
assert.ok(typeof chatLines[0] === "string" && chatLines[0].length > 0, "visible line is non-empty text");

// --- tick: non-farmer commoner is skipped ---
_resetState();
const chat2 = [];
let plainJoe = null;
for (let i = 0; i < 500 && !plainJoe; i++) {
  if (farmerTypeFor("plainjoe" + i) === null) plainJoe = "plainjoe" + i;
}
assert.ok(plainJoe, "found a non-farmer commoner name");
const director2 = {
  roster: new Map([[plainJoe, { username: plainJoe, role: "commoner" }]]),
  playerFor: () => ({ ...citizenPlayer, forceChat: (m) => chat2.push(m) }),
  onlinePlayers: () => [realPlayer],
};
for (let i = 0; i < 5; i++) tickFarmers(director2, Date.now() + i * 5 * 60 * 60 * 1000);
assert.equal(chat2.length, 0, "non-farmer commoner never fires");

// --- tick: no real players nearby -> silence ---
_resetState();
const chat3 = [];
const director3 = {
  roster,
  playerFor: () => ({ ...citizenPlayer, forceChat: (m) => chat3.push(m) }),
  onlinePlayers: () => [{ isPlayerBot: () => true }], // only bots around
};
for (let i = 0; i < 5; i++) tickFarmers(director3, Date.now() + i * 5 * 60 * 60 * 1000);
assert.equal(chat3.length, 0, "no output when only bots are near");

// --- tick: guards never farm ---
_resetState();
const chat4 = [];
const director4 = {
  roster: new Map([[farmerName, { username: farmerName, role: "guard" }]]),
  playerFor: () => ({ ...citizenPlayer, forceChat: (m) => chat4.push(m) }),
  onlinePlayers: () => [realPlayer],
};
for (let i = 0; i < 5; i++) tickFarmers(director4, Date.now() + i * 5 * 60 * 60 * 1000);
assert.equal(chat4.length, 0, "guard role never farms");

// --- tick never throws on hostile input ---
assert.doesNotThrow(() => tickFarmers({}, 0), "empty director ok");
assert.doesNotThrow(() => tickFarmers({ roster: "nope" }, Date.now()), "bad roster ok");
assert.doesNotThrow(() => tickFarmers(null, Date.now()), "null director ok");

console.log("CitizenFarmers: all assertions passed");
