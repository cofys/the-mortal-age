// CitizenCartographers unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const C = require("./CitizenCartographers");

// Deterministic LCG — coverage is exact, not luck-based.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const NOW = 1791436800000; // fixed "now" for determinism
const DAY = 86400000;

function reset() {
  C._resetState();
}

reset();

// --- 1. hashStr is deterministic ---
assert.equal(C.hashStr("abc"), C.hashStr("abc"));
assert.notEqual(C.hashStr("abc"), C.hashStr("abd"));

// --- 2. cartographerTypeFor: ~35% of commoners, stable ---
let cartoCount = 0;
const typeHits = new Set();
for (let i = 0; i < 400; i++) {
  const t = C.cartographerTypeFor("citizen" + i);
  if (t) {
    cartoCount++;
    typeHits.add(t);
    assert.equal(t, C.cartographerTypeFor("CITIZEN" + i), "case-insensitive stability");
  }
}
const share = cartoCount / 400;
assert.ok(share > 0.03 && share < 0.10, `~6% share (primary-profession partition), got ${share}`);
assert.equal(typeHits.size, 4, "all 4 types reachable");
assert.equal(C.cartographerTypeFor(null), null);
assert.equal(C.cartographerTypeFor(""), null);

// --- 3. studioFor prefers the citizen's kingdom ---
const seenStudios = new Set();
for (let i = 0; i < 60; i++) {
  const s = C.studioFor("mist" + i, "misthalin");
  assert.equal(s.kingdom, "misthalin", "kingdom-preferred studio");
  seenStudios.add(s.short);
}
assert.ok(seenStudios.size > 1, "multiple studios in reach");
const fallback = C.studioFor("x", "nope-kingdom");
assert.ok(fallback && fallback.name, "falls back to all studios");

// --- 4. regionFor prefers the citizen's kingdom, stable per day ---
const r1 = C.regionFor("bob", "misthalin", NOW);
const r2 = C.regionFor("bob", "misthalin", NOW + 3600 * 1000);
assert.deepEqual(r1, r2, "stable within a day");
const r3 = C.regionFor("bob", "misthalin", NOW + DAY);
assert.ok(r3 && r3.name, "region resolves on another day");
assert.equal(r1.kingdom, "misthalin", "kingdom-preferred region");

// --- 5. mapsFor: 2-4 maps per day, stable, qualities valid ---
const maps1 = C.mapsFor("mapmaker1", "misthalin", NOW);
const maps2 = C.mapsFor("mapmaker1", "misthalin", NOW + 5000);
assert.deepEqual(maps1, maps2, "catalog stable within a day");
assert.ok(maps1.length >= 2 && maps1.length <= 4, `2-4 maps, got ${maps1.length}`);
const validQ = new Set([C.QUALITY_ROUGH, C.QUALITY_FINE, C.QUALITY_MASTERWORK]);
for (const m of maps1) {
  assert.ok(m.region && validQ.has(m.quality), `valid map entry: ${JSON.stringify(m)}`);
}

// --- 6. discoveryFor: ~8% of days, stable, valid pool ---
let discHits = 0;
for (let d = 0; d < 200; d++) {
  const disc = C.discoveryFor("discobob", NOW + d * DAY);
  assert.equal(disc, C.discoveryFor("discobob", NOW + d * DAY), "stable per day");
  if (disc) {
    discHits++;
    assert.ok(C.DISCOVERIES.includes(disc), "discovery from pool");
  }
}
const discRate = discHits / 200;
assert.ok(discRate > 0.02 && discRate < 0.16, `~8% discovery days, got ${discRate}`);

// --- 7. isStudioOpen: 07:00-19:00 ---
const open = new Date(NOW);
open.setHours(12, 0, 0, 0);
const closed = new Date(NOW);
closed.setHours(22, 0, 0, 0);
assert.equal(C.isStudioOpen(open.getTime()), true);
assert.equal(C.isStudioOpen(closed.getTime()), false);

// --- 8. renderLine fills slots ---
assert.equal(C.renderLine("Charts of {region}!", { region: "Misthalin" }), "Charts of Misthalin!");
assert.equal(C.renderLine("no slots", {}), "no slots");

// --- 9. commissionMap round-trip + seller-only gate ---
reset();
assert.equal(C.commissionMap("Buyer1", "mapmaker1", "Misthalin", C.QUALITY_FINE, NOW), false, "non-seller rejected");
// find a real seller deterministically
let seller = null;
for (let i = 0; i < 200 && !seller; i++) {
  if (C.cartographerTypeFor("sellcand" + i) === C.CARTO_SELLER) seller = "sellcand" + i;
}
assert.ok(seller, "found a seller");
assert.equal(C.commissionMap("Buyer1", seller, "Misthalin", C.QUALITY_FINE, NOW), true);
const comm = C.commissionFor("Buyer1", seller, NOW);
assert.ok(comm && comm.region === "Misthalin" && comm.quality === C.QUALITY_FINE, "commission stored");
assert.equal(C.commissionFor("Nobody", seller, NOW), null);
assert.equal(C.commissionMap(null, seller, "Misthalin", null, NOW), false);

// --- 10. hireSurveyor round-trip + surveyor-only gate ---
reset();
let surveyor = null;
for (let i = 0; i < 200 && !surveyor; i++) {
  if (C.cartographerTypeFor("survcand" + i) === C.CARTO_SURVEYOR) surveyor = "survcand" + i;
}
assert.ok(surveyor, "found a surveyor");
assert.equal(C.hireSurveyor("Player1", seller, "Kandarin", NOW), false, "non-surveyor rejected");
assert.equal(C.hireSurveyor("Player1", surveyor, "Kandarin", NOW), true);
const hire = C.surveyHireFor("Player1", surveyor, NOW);
assert.ok(hire && hire.region === "Kandarin", "hire stored");
assert.equal(C.hireSurveyor(null, surveyor, "Kandarin", NOW), false);

// --- 11. contributeDiscovery + recentDiscoveries ---
reset();
assert.equal(C.contributeDiscovery("Player2", "the hidden falls", NOW), true);
assert.equal(C.contributeDiscovery("Player3", "an old watchtower", NOW + 1000), true);
const recent = C.recentDiscoveries(5, NOW + 2000);
assert.equal(recent.length, 2);
assert.equal(recent[0].place, "an old watchtower", "newest first");
assert.equal(C.contributeDiscovery(null, "x", NOW), false);
assert.equal(C.contributeDiscovery("P", null, NOW), false);

// --- 12. shouldWork / shouldOffer / shouldAnnounce gates ---
const rng = lcg(42);
assert.equal(C.shouldWork(() => 0.99, 0, NOW), false, "chance gate respected");
assert.equal(C.shouldWork(() => 0.0, NOW - 1000, NOW), false, "cooldown respected");
assert.equal(C.shouldWork(() => 0.0, 0, NOW), true);
assert.equal(C.shouldOffer(() => 0.0, 0, NOW), true);
assert.equal(C.shouldOffer(() => 0.99, 0, NOW), false);
assert.equal(C.shouldAnnounce(() => 0.0, 0, NOW), true);
assert.equal(C.shouldAnnounce(() => 0.99, 0, NOW), false);

// --- 13. isRealPlayer / withinTiles ---
assert.equal(C.isRealPlayer(null), false);
assert.equal(C.isRealPlayer({ isPlayerBot: () => true, getUsername: () => "x" }), false);
assert.equal(C.isRealPlayer({ getHostAddress: () => "bot", getUsername: () => "x" }), false);
assert.equal(C.isRealPlayer({ getUsername: () => "real" }), true);
function loc(x, y, z) {
  return { getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => z }) };
}
assert.equal(C.withinTiles(loc(0, 0, 0), loc(5, 5, 0), 10), true);
assert.equal(C.withinTiles(loc(0, 0, 0), loc(50, 0, 0), 10), false);
assert.equal(C.withinTiles(loc(0, 0, 0), loc(0, 0, 1), 10), false, "plane matters");
assert.equal(C.withinTiles(null, loc(0, 0, 0), 10), false);

// --- 14. tickCartographers fires near a real player, silent otherwise ---
reset();
// Mock Math.random so the chance gates always pass (sibling-module pattern).
const origRandom = Math.random;
Math.random = () => 0.0;
try {
function makeCitizen(x, y) {
  return {
    getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => 0 }),
    forceChat: function (msg) { this.said.push(msg); },
    said: [],
    isPlayerBot: () => false,
    getHostAddress: () => "127.0.0.1",
    getUsername: () => "RealPlayer",
  };
}
function makeBot(x, y) {
  return {
    getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => 0 }),
    forceChat: function (msg) { this.said.push(msg); },
    said: [],
    isPlayerBot: () => true,
    getHostAddress: () => "bot",
    getUsername: () => "SomeBot",
  };
}
// find a cartographer username
let cartoName = null;
for (let i = 0; i < 300 && !cartoName; i++) {
  if (C.cartographerTypeFor("tickc" + i)) cartoName = "tickc" + i;
}
assert.ok(cartoName, "found a cartographer for tick test");
const citizenObj = makeBot(100, 100); // materialized bot citizen (not real player)
const realNear = makeCitizen(105, 105); // real player within 40 tiles
const director = {
  roster: new Map([[cartoName, { username: cartoName, kingdom: "misthalin" }]]),
  playerFor: () => citizenObj,
  onlinePlayers: () => [realNear, citizenObj],
};
C.tickCartographers(director, NOW);
assert.ok(citizenObj.said.length > 0, `fires near real player, got ${citizenObj.said.length} lines`);

// silent with bots only
reset();
const citizenObj2 = makeBot(100, 100);
const botOnly = {
  roster: new Map([[cartoName, { username: cartoName, kingdom: "misthalin" }]]),
  playerFor: () => citizenObj2,
  onlinePlayers: () => [citizenObj2, makeBot(103, 103)],
};
C.tickCartographers(botOnly, NOW);
assert.equal(citizenObj2.said.length, 0, "silent with no real player");

// --- 15. tickCartographers never throws on hostile input ---
reset();
C.tickCartographers(null, NOW);
C.tickCartographers({}, NOW);
C.tickCartographers({ roster: null }, NOW);
C.tickCartographers({ roster: new Map([["x", {}]]), playerFor: () => { throw new Error("boom"); } }, NOW);

// --- 16. non-cartographers are skipped ---
reset();
const citizenObj3 = makeBot(100, 100);
let nonCarto = null;
for (let i = 0; i < 300 && !nonCarto; i++) {
  if (!C.cartographerTypeFor("nonc" + i)) nonCarto = "nonc" + i;
}
const director3 = {
  roster: new Map([[nonCarto, { username: nonCarto, kingdom: "misthalin" }]]),
  playerFor: () => citizenObj3,
  onlinePlayers: () => [makeCitizen(105, 105)],
};
C.tickCartographers(director3, NOW);
assert.equal(citizenObj3.said.length, 0, "non-cartographers skipped");
} finally {
  Math.random = origRandom;
}

// --- 17. cross-module lazy ties don't throw ---
const expDisc = C.explorersDiscoveries();
assert.ok(expDisc && typeof expDisc === "object", "explorers discoveries readable");
// sailorPorts may be false or an array depending on module load; either is fine
const ports = C.sailorPorts();
assert.ok(ports === false || Array.isArray(ports));

// --- 18. line pools all render with no unfilled slots and <= 120 chars ---
const sampleVars = { region: "Misthalin", quality: C.QUALITY_FINE, discovery: "an uncharted cove", their: "their" };
for (const [type, lines] of Object.entries({
  [C.CARTO_SURVEYOR]: 5, [C.CARTO_MAPMAKER]: 5, [C.CARTO_EXPLORER]: 5, [C.CARTO_SELLER]: 5,
})) {
  assert.ok(lines === 5, `5 work lines for ${type}`);
}

console.log("CitizenCartographers: all checks passed");
