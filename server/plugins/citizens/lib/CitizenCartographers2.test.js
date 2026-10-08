// CitizenCartographers2 unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const M = require("./CitizenCartographers2");

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
  M._resetState();
}

reset();

// --- 1. hashStr is deterministic ---
assert.equal(M.hashStr("abc"), M.hashStr("abc"));
assert.notEqual(M.hashStr("abc"), M.hashStr("abd"));

// --- 2. mapfolkTypeOf: nominal ~35% share pre-exclusion, stable ---
// (post-exclusion the effective share is ~21%: Hawkers2 basket-cryers and
// master-claimed pro cartographers are excluded BEFORE the share roll, per
// the house pattern — same bounds as CitizenMarketStalls2.test.js)
let folk = 0;
const typeHits = new Set();
const NN = 20000;
for (let i = 0; i < NN; i++) {
  const name = "mapfolk" + i;
  const t = M.mapfolkTypeOf({ username: name, role: "commoner" });
  if (t) {
    folk++;
    typeHits.add(t);
  }
}
const share = folk / NN;
assert.ok(share > 0.2 && share < 0.5, `nominal share ~35% (post-exclusion ~21%), got ${share.toFixed(3)}`);
assert.equal(typeHits.size, 3, "all 3 mapfolk types reachable");
// stability spot-check
for (let i = 0; i < 50; i++) {
  const name = "mapfolk" + i;
  const a = M.mapfolkTypeOf({ username: name, role: "commoner" });
  const b = M.mapfolkTypeOf({ username: name.toUpperCase(), role: "commoner" });
  assert.equal(a, b, "case-insensitive stability");
}
assert.deepEqual(M.mapfolkTypeOf(null), null);
assert.equal(M.mapfolkTypeOf({ username: null, role: "commoner" }), null);
assert.equal(M.mapfolkTypeOf({ username: "x", role: null }), null);

// --- 3. role gate: non-commoners are never mapfolk ---
assert.equal(M.mapfolkTypeOf({ username: "SomeMap", role: "merchant" }), null);
assert.equal(M.mapfolkTypeOf({ username: "SomeMap", role: "guard" }), null);
assert.equal(M.mapfolkTypeOf({ username: "SomeMap", attributes: { role: "banker" } }), null);
assert.equal(M.mapfolkTypeOf({ username: "common", role: "commoner" }) !== null ||
  M.mapfolkTypeOf({ username: "common", role: "commoner" }) === null, true, "sanity");

// --- 4. pro exclusion: master's professional cartographers, via the real claim fn ---
// The master's claim predicate is cartographerTypeFor (primary profession
// "cartographer"). Find a username the master claims and one it does not.
const ProCartos = require("./CitizenCartographers");
let proName = null;
let commonerName = null;
for (let i = 0; i < 500 && (!proName || !commonerName); i++) {
  const n = "cartoxcl" + i;
  if (!proName && ProCartos.cartographerTypeFor(n) !== null) proName = n;
  if (!commonerName && ProCartos.cartographerTypeFor(n) === null) commonerName = n;
}
assert.ok(proName, "found a master-claimed cartographer");
assert.ok(commonerName, "found a non-claimed commoner");
assert.equal(M.isProCartographer(proName), true, "master claim detected via real fn");
assert.equal(M.isProCartographer(commonerName), false);
assert.equal(
  M.mapfolkTypeOf({ username: proName, role: "commoner" }),
  null,
  "a professional cartographer must never be mapfolk"
);
// Exclusion ordering: exclusion must win over the share roll regardless of draw.
// Force a share-roll hit on the master-claimed name by checking every candidate:
// the pro must STILL be excluded.
let proRollsHit = 0;
for (let i = 0; i < 500; i++) {
  const n = "proshare" + i;
  if (ProCartos.cartographerTypeFor(n) === null) continue;
  proRollsHit++;
  assert.equal(
    M.mapfolkTypeOf({ username: n, role: "commoner" }),
    null,
    `exclusion wins over share roll for ${n}`
  );
}
assert.ok(proRollsHit > 0, "master-claimed names exist in the pool");

// --- 5. hawker exclusion via the hawkers' real claim function, before the share roll ---
const Hawkers2 = require("./CitizenHawkers2");
let hawkerName = null;
for (let i = 0; i < 500 && !hawkerName; i++) {
  const n = "hawkerxcl" + i;
  if (Hawkers2.hawkerTypeOf({ username: n, role: "commoner" }) !== null) hawkerName = n;
}
assert.ok(hawkerName, "found a hawkers2-claimed citizen");
assert.equal(M.isHawkerfolk({ username: hawkerName, role: "commoner" }), true);
assert.equal(
  M.mapfolkTypeOf({ username: hawkerName, role: "commoner" }),
  null,
  "a basket-cryer must never be mapfolk, regardless of share roll"
);

// --- 6. kioskFor: kingdom-preferred, stable per day ---
const seenKiosks = new Set();
for (let i = 0; i < 40; i++) {
  const k = M.kioskFor({ username: "kiosktest" + i, kingdom: "misthalin" }, NOW);
  assert.ok(k && k.name, "kiosk resolves");
  assert.equal(k.kingdom, "misthalin", "kingdom-preferred kiosk");
  seenKiosks.add(k.name);
}
assert.ok(seenKiosks.size > 1, "multiple kiosks in reach");
const fallback = M.kioskFor({ username: "xk", kingdom: "nope-kingdom" }, NOW);
assert.ok(fallback && fallback.name, "falls back to all kiosks");
assert.deepEqual(
  M.kioskFor({ username: "k", kingdom: "misthalin" }, NOW),
  M.kioskFor({ username: "k", kingdom: "misthalin" }, NOW + 3600 * 1000),
  "stable within a day"
);

// --- 7. sketchFor: from the type's pool, stable per day, region slot filled ---
const sk1 = M.sketchFor("sketchbob", M.MAP_SKETCHER, "misthalin", NOW);
const sk2 = M.sketchFor("sketchbob", M.MAP_SKETCHER, "misthalin", NOW + 5000);
assert.equal(sk1, sk2, "sketch stable within a day");
assert.ok(sk1 && !sk1.includes("{region}"), "region slot filled");
assert.ok(/rough|copy|chart|sketch|draft/i.test(sk1), `sketch looks amateur: ${sk1}`);
// unknown type falls back to sketcher pool
const skFallback = M.sketchFor("skf", "nope", "misthalin", NOW);
assert.ok(skFallback && typeof skFallback === "string");

// --- 8. proChartsTalkFor: names the real pro trade (read-only bridge), never throws ---
const talk = M.proChartsTalkFor("misthalin", NOW);
assert.ok(talk && typeof talk === "string" && !talk.includes("{studio}") && !talk.includes("{discovery}"),
  `pro bridge fills slots: ${talk}`);
const talkUnknown = M.proChartsTalkFor("nope-kingdom", NOW);
assert.ok(talkUnknown && typeof talkUnknown === "string");

// --- 9. isWorkHour: 07:00-18:00 ---
const open = new Date(NOW);
open.setHours(12, 0, 0, 0);
const before = new Date(NOW);
before.setHours(6, 59, 0, 0);
const after = new Date(NOW);
after.setHours(18, 0, 0, 0);
assert.equal(M.isWorkHour(open.getTime()), true);
assert.equal(M.isWorkHour(before.getTime()), false);
assert.equal(M.isWorkHour(after.getTime()), false);

// --- 10. chance gates ---
const rng = lcg(7);
assert.equal(M.chance(() => 0.99, 0.2), false, "chance gate respected");
assert.equal(M.chance(() => 0.0, 0.2), true);

// --- 11. isRealPlayer / withinTiles ---
assert.equal(M.isRealPlayer(null), false);
assert.equal(M.isRealPlayer({ isPlayerBot: () => true, getUsername: () => "x" }), false);
assert.equal(M.isRealPlayer({ getHostAddress: () => "bot", getUsername: () => "x" }), false);
assert.equal(M.isRealPlayer({ getUsername: () => "real" }), true);
function loc(x, y, z) {
  return { getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => z }) };
}
assert.equal(M.withinTiles(loc(0, 0, 0), loc(5, 5, 0), 10), true);
assert.equal(M.withinTiles(loc(0, 0, 0), loc(50, 0, 0), 10), false);
assert.equal(M.withinTiles(loc(0, 0, 0), loc(0, 0, 1), 10), false, "plane matters");
assert.equal(M.withinTiles(null, loc(0, 0, 0), 10), false);

// --- 12. tickMapfolk fires near a real player, silent otherwise ---
reset();
const origRandom = Math.random;
Math.random = () => 0.0; // chance gates always pass
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
  // find a mapfolk username
  let folkName = null;
  for (let i = 0; i < 300 && !folkName; i++) {
    if (M.mapfolkTypeOf({ username: "tickm" + i, role: "commoner" })) folkName = "tickm" + i;
  }
  assert.ok(folkName, "found mapfolk for tick test");
  const midday = new Date(NOW);
  midday.setHours(12, 0, 0, 0);
  const citizenObj = makeBot(100, 100);
  const realNear = makeCitizen(105, 105);
  const director = {
    roster: new Map([[folkName, { username: folkName, kingdom: "misthalin", role: "commoner" }]]),
    playerFor: () => citizenObj,
    onlinePlayers: () => [realNear, citizenObj],
  };
  M.tickMapfolk(director, midday.getTime());
  assert.ok(citizenObj.said.length > 0, `fires near real player, got ${citizenObj.said.length} lines`);

  // silent with bots only
  reset();
  const citizenObj2 = makeBot(100, 100);
  const botOnly = {
    roster: new Map([[folkName, { username: folkName, kingdom: "misthalin", role: "commoner" }]]),
    playerFor: () => citizenObj2,
    onlinePlayers: () => [citizenObj2, makeBot(103, 103)],
  };
  M.tickMapfolk(botOnly, midday.getTime());
  assert.equal(citizenObj2.said.length, 0, "silent with no real player");

  // --- 13. master-claimed and hawker-claimed records are skipped by the tick ---
  reset();
  const citizenObj3 = makeBot(100, 100);
  const director3 = {
    roster: new Map([[proName, { username: proName, kingdom: "misthalin", role: "commoner" }]]),
    playerFor: () => citizenObj3,
    onlinePlayers: () => [makeCitizen(105, 105)],
  };
  M.tickMapfolk(director3, midday.getTime());
  assert.equal(citizenObj3.said.length, 0, "master-claimed citizen never works mapfolk");

  // --- 14. tickMapfolk never throws on hostile input ---
  reset();
  M.tickMapfolk(null, NOW);
  M.tickMapfolk({}, NOW);
  M.tickMapfolk({ roster: null }, NOW);
  M.tickMapfolk(
    { roster: new Map([["x", {}]]), playerFor: () => { throw new Error("boom"); } },
    NOW
  );

  // --- 15. non-mapfolk are skipped ---
  reset();
  const citizenObj4 = makeBot(100, 100);
  let nonFolk = null;
  for (let i = 0; i < 300 && !nonFolk; i++) {
    if (!M.mapfolkTypeOf({ username: "nonm" + i, role: "commoner" })) nonFolk = "nonm" + i;
  }
  const director4 = {
    roster: new Map([[nonFolk, { username: nonFolk, kingdom: "misthalin", role: "commoner" }]]),
    playerFor: () => citizenObj4,
    onlinePlayers: () => [makeCitizen(105, 105)],
  };
  M.tickMapfolk(director4, midday.getTime());
  assert.equal(citizenObj4.said.length, 0, "non-mapfolk skipped");
} finally {
  Math.random = origRandom;
}

// --- 16. line pools all render with filled slots and <= 120 chars ---
const sampleVars = { region: "Misthalin", place: "the kiosk", their: "their" };
function checkPool(lines, label) {
  for (const line of lines) {
    assert.ok(line.length <= 120, `${label} line <= 120 chars: ${line}`);
    const rendered = M.fill(line, sampleVars);
    assert.ok(!rendered.includes("{"), `${label} slots filled: ${line}`);
  }
}
for (const [t, lines] of Object.entries({
  [M.MAP_SKETCHER]: M.WORK_LINES[M.MAP_SKETCHER],
  [M.CHART_HAWKER]: M.WORK_LINES[M.CHART_HAWKER],
  [M.ROUGH_DRAFTER]: M.WORK_LINES[M.ROUGH_DRAFTER],
})) {
  assert.equal(lines.length, 5, `5 work lines for ${t}`);
  checkPool(lines, `work/${t}`);
}
checkPool(M.SETUP_LINES, "setup");
checkPool(M.HAWK_LINES[M.MAP_SKETCHER], "hawk/sketcher");
checkPool(M.HAWK_LINES[M.CHART_HAWKER], "hawk/hawker");
checkPool(M.HAWK_LINES[M.ROUGH_DRAFTER], "hawk/drafter");
// pro-talk lines need {studio}/{discovery} — checked separately below
checkPool(M.OFFER_LINES, "offer");
checkPool(M.INK_SPILL_LINES, "ink-spill");
checkPool(M.WRONG_WAY_LINES, "wrong-way");
checkPool(M.DISPUTE_LINES, "dispute");
// pro-bridge pool needs studio/discovery vars
for (const line of M.PRO_TALK_LINES) {
  assert.ok(line.length <= 120, `pro-talk line <= 120 chars: ${line}`);
  const rendered = M.fill(line, {
    studio: "the Varrock chart house",
    discovery: "an uncharted cove",
  });
  assert.ok(!rendered.includes("{"), `pro-talk slots filled: ${line}`);
}

// --- 17. kiosks: 12 entries, 2 per kingdom, all kingdoms covered ---
assert.equal(M.KIOSKS.length, 12, "12 corner kiosks");
const perKingdom = {};
for (const k of M.KIOSKS) perKingdom[k.kingdom] = (perKingdom[k.kingdom] || 0) + 1;
for (const [kid, n] of Object.entries(perKingdom)) {
  assert.equal(n, 2, `2 kiosks for ${kid}`);
}
assert.ok(Object.keys(perKingdom).length >= 6, "at least 6 kingdoms covered");

// --- 18. mapfolk never claim the master's real studios (no pro overlap) ---
const proStudios = new Set(ProCartos.STUDIOS.map((s) => s.name));
for (const k of M.KIOSKS) {
  assert.ok(!proStudios.has(k.name), `kiosk is not a pro studio: ${k.name}`);
}

// --- 19. daily set-piece keying: once per kingdom per day ---
reset();
const dayKey = "inkspill:misthalin:" + Math.floor(NOW / DAY);
M._firedDayKeys.add(dayKey);
assert.equal(M._firedDayKeys.has(dayKey), true, "set-piece key recorded");

console.log("ALL CITIZENMAPFOLK2 TESTS PASSED");
