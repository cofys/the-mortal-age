"use strict";

// CitizenGuards2 unit checks — pure logic, no running server.
// From server/plugins/citizens: node CitizenGuards2.test.js (plain node)
const assert = require("node:assert/strict");
const G = require("./CitizenGuards2");

const T0 = 1_800_000_000_000; // fixed anchor, avoids Date.now races

function withFixedRandom(value, fn) {
  const orig = Math.random;
  Math.random = () => value;
  try {
    return fn();
  } finally {
    Math.random = orig;
  }
}

function fresh() {
  G._resetState();
}

function mockLoc(x, y, z = 0) {
  return { getX: () => x, getY: () => y, getZ: () => z };
}

function mockPlayer(name, x = 0, y = 0) {
  return {
    getUsername: () => name,
    getHostAddress: () => "127.0.0.1",
    isPlayerBot: () => false,
    getLocation: () => mockLoc(x, y),
    sendMessage: () => {},
  };
}

function mockCitizenBot(name, x = 0, y = 0) {
  const chats = [];
  return {
    getUsername: () => name,
    getHostAddress: () => "bot",
    isPlayerBot: () => true,
    getLocation: () => mockLoc(x, y),
    forceChat: (m) => chats.push(m),
    _chats: chats,
  };
}

function mockRecord(username, role = "commoner", kingdomId = "misthalin") {
  return { username, role, kingdomId };
}

function mockDirector(records, players = []) {
  const bots = new Map();
  const getBot = (record) => {
    if (!bots.has(record.username)) {
      const bot = mockCitizenBot(record.username);
      bot.getLocalPlayers = () => players;
      bots.set(record.username, bot);
    }
    return bots.get(record.username);
  };
  return {
    roster: new Map(records.map((r) => [r.username, r])),
    // Real director API (director/CitizenDirector.js: isOnline + getBot).
    // playerFor/onlinePlayers never existed on the real director — the old
    // mock encoded dead APIs, which is why the militia tick was mute in prod.
    isOnline: (record) => true,
    getBot,
    _bots: bots,
  };
}

// --- type weights: all four reachable, weights respected ---
{
  fresh();
  const seen = new Set();
  for (let i = 0; i < 3000; i++) {
    const t = G.guardfolkTypeOf(mockRecord("GuardCitizen" + i));
    if (t) seen.add(t);
  }
  for (const t of G.GUARDFOLK_TYPES) assert.ok(seen.has(t), `type ${t} reachable`);
  // ~40% nominal share (minus professional guards + watchmen)
  let count = 0;
  for (let i = 0; i < 3000; i++) if (G.guardfolkTypeOf(mockRecord("ShareCitizen" + i))) count++;
  const share = count / 3000;
  assert.ok(share > 0.15 && share < 0.45, `share ${share} in band`);
  console.log("type weights: PASS");
}

// --- type roll boundaries ---
{
  fresh();
  // weights: gate 30, wall 25, sentry 20, militia 25
  assert.equal(G.guardfolkTypeFromRoll(0), G.GUARDFOLK_GATE);
  assert.equal(G.guardfolkTypeFromRoll(29), G.GUARDFOLK_GATE);
  assert.equal(G.guardfolkTypeFromRoll(30), G.GUARDFOLK_WALL);
  assert.equal(G.guardfolkTypeFromRoll(54), G.GUARDFOLK_WALL);
  assert.equal(G.guardfolkTypeFromRoll(55), G.GUARDFOLK_SENTRY);
  assert.equal(G.guardfolkTypeFromRoll(74), G.GUARDFOLK_SENTRY);
  assert.equal(G.guardfolkTypeFromRoll(75), G.GUARDFOLK_MILITIA);
  assert.equal(G.guardfolkTypeFromRoll(99), G.GUARDFOLK_MILITIA);
  console.log("roll boundaries: PASS");
}

// --- type stability: same name always gets same type ---
{
  fresh();
  for (let i = 0; i < 200; i++) {
    const name = "StableCitizen" + i;
    const a = G.guardfolkTypeOf(mockRecord(name));
    const b = G.guardfolkTypeOf(mockRecord(name));
    assert.equal(a, b, `stable for ${name}`);
  }
  console.log("stability: PASS");
}

// --- salt correlation: no starved decile (FNV-1a prefix-correlation lesson) ---
{
  fresh();
  const deciles = new Array(10).fill(0);
  let total = 0;
  for (let i = 0; i < 10000; i++) {
    const name = "SaltCitizen" + i;
    const gate = G.hashStr(name + "|guardfolk") % 100;
    if (gate < 40) {
      total++;
      const dec = Math.floor((G.hashStr(name + "|guardfolk-type") % 100) / 10);
      deciles[dec]++;
    }
  }
  const expected = total / 10;
  for (const d of deciles) {
    assert.ok(d > expected * 0.5, `decile ${d} not starved (expected ~${expected.toFixed(0)})`);
  }
  console.log("salt correlation: PASS");
}

// --- commoner gating: non-commoner roles excluded ---
{
  fresh();
  assert.equal(G.guardfolkTypeOf(mockRecord("GuardRole1", "guard")), null, "role guard excluded");
  assert.equal(G.guardfolkTypeOf(mockRecord("Merchant1", "merchant")), null, "role merchant excluded");
  assert.equal(G.guardfolkTypeOf(mockRecord("GuardRole2", "GUARD")), null, "role GUARD excluded");
  console.log("commoner gating: PASS");
}

// --- kingdom-preferred muster grounds ---
{
  fresh();
  const g = G.groundFor(mockRecord("GroundCitizen1", "commoner", "asgarnia"));
  assert.equal(g.kingdom, "asgarnia", "asgarnia citizen gets asgarnia ground");
  const g2 = G.groundFor(mockRecord("GroundCitizen2", "commoner", "morytania"));
  assert.equal(g2.kingdom, "morytania", "morytania citizen gets morytania ground");
  // stability
  const g3 = G.groundFor(mockRecord("GroundCitizen1", "commoner", "asgarnia"));
  assert.equal(g.name, g3.name, "ground stable across calls");
  console.log("muster grounds: PASS");
}

// --- drill determinism: same day same drills, different day varies ---
{
  fresh();
  const d1 = G.drillsFor("DrillCitizen1", "misthalin", T0);
  const d2 = G.drillsFor("DrillCitizen1", "misthalin", T0);
  assert.deepEqual(d1, d2, "same day same drills");
  let varied = false;
  for (let i = 1; i <= 10; i++) {
    const di = G.drillsFor("DrillCitizen1", "misthalin", T0 + i * 86400000);
    if (JSON.stringify(di) !== JSON.stringify(d1)) { varied = true; break; }
  }
  assert.ok(varied, "drills vary across days");
  assert.ok(d1.length >= 1 && d1.length <= 2, "1-2 drills per day");
  console.log("drill determinism: PASS");
}

// --- ceremony determinism + rarity ---
{
  fresh();
  const ground = G.MUSTER_GROUNDS[0];
  const c1 = G.ceremonyFor(ground, T0);
  const c2 = G.ceremonyFor(ground, T0);
  assert.equal(c1, c2, "same day same ceremony");
  let count = 0;
  for (let i = 0; i < 200; i++) {
    if (G.ceremonyFor(ground, T0 + i * 86400000)) count++;
  }
  const rate = count / 200;
  assert.ok(rate > 0.02 && rate < 0.2, `ceremony rate ${rate} near 0.08`);
  console.log("ceremony determinism: PASS");
}

// --- ledgers: issue reports round-trip + TTL expiry ---
{
  fresh();
  const r = G.reportIssue("Jon", "broken north gate", T0);
  assert.equal(r, "broken north gate");
  assert.equal(G.issueFor("Jon", T0 + 1000), "broken north gate");
  assert.equal(G.issueFor("Jon", T0 + 8 * 24 * 3600 * 1000), null, "expired after 7 days");
  G._resetState();
  console.log("issue ledger: PASS");
}

// --- ledgers: militia sign-ups ---
{
  fresh();
  assert.equal(G.militiaFor("Jon", T0), false, "not volunteered yet");
  G.joinMilitia("Jon", T0);
  assert.equal(G.militiaFor("Jon", T0 + 1000), true, "volunteered");
  assert.equal(G.militiaFor("Jon", T0 + 8 * 24 * 3600 * 1000), false, "expired after 7 days");
  G._resetState();
  console.log("militia ledger: PASS");
}

// --- ledgers: drill attendance ---
{
  fresh();
  assert.equal(G.drillFor("Jon", T0), null, "no drill yet");
  G.drillWith("Jon", "the Falador Parade Ground", T0);
  assert.equal(G.drillFor("Jon", T0 + 1000), "the Falador Parade Ground");
  assert.equal(G.drillFor("Jon", T0 + 8 * 24 * 3600 * 1000), null, "expired after 7 days");
  G._resetState();
  console.log("drill ledger: PASS");
}

// --- duty hours: local-time constructors per the timezone rule ---
{
  fresh();
  const atNoon = new Date(2026, 9, 8, 12, 0).getTime();
  const atMidnight = new Date(2026, 9, 8, 0, 30).getTime();
  const atDawn = new Date(2026, 9, 8, 6, 0).getTime();
  const atEvening = new Date(2026, 9, 8, 19, 59).getTime();
  const atNight = new Date(2026, 9, 8, 20, 0).getTime();
  assert.equal(G.isDutyHour(atNoon), true, "noon is duty hour");
  assert.equal(G.isDutyHour(atMidnight), false, "midnight is not duty hour");
  assert.equal(G.isDutyHour(atDawn), true, "06:00 is duty hour");
  assert.equal(G.isDutyHour(atEvening), true, "19:59 is duty hour");
  assert.equal(G.isDutyHour(atNight), false, "20:00 is not duty hour");
  console.log("duty hours: PASS");
}

// --- guards: tick fires near real player, silent near bots only ---
{
  fresh();
  // Find a guardfolk citizen
  let guardName = null;
  for (let i = 0; i < 5000 && !guardName; i++) {
    const n = "TickCitizen" + i;
    if (G.guardfolkTypeOf(mockRecord(n))) guardName = n;
  }
  assert.ok(guardName, "found a guardfolk citizen");
  const rec = mockRecord(guardName);
  const player = mockPlayer("Jon", 0, 0);
  const director = mockDirector([rec], [player]);
  const noon = new Date(2026, 9, 8, 12, 0).getTime();
  withFixedRandom(0.05, () => G.tickGuardfolk(director, noon)); // 0.05 < 0.15 chance gate
  const bot = director._bots.get(guardName);
  assert.ok(bot._chats.length >= 1, "citizen spoke near a real player");
  console.log("tick fires near player: PASS");
}

// --- guards: tick silent near bots only ---
{
  fresh();
  let guardName = null;
  for (let i = 0; i < 5000 && !guardName; i++) {
    const n = "BotCitizen" + i;
    if (G.guardfolkTypeOf(mockRecord(n))) guardName = n;
  }
  const rec = mockRecord(guardName);
  const botPlayer = mockCitizenBot("OtherBot", 0, 0);
  const director = mockDirector([rec], [botPlayer]);
  const noon = new Date(2026, 9, 8, 12, 0).getTime();
  withFixedRandom(0.05, () => G.tickGuardfolk(director, noon));
  const bot = director._bots.get(guardName);
  assert.equal(bot._chats.length, 0, "silent when only bots are near");
  console.log("tick silent near bots: PASS");
}

// --- guards: tick silent outside duty hours ---
{
  fresh();
  let guardName = null;
  for (let i = 0; i < 5000 && !guardName; i++) {
    const n = "NightCitizen" + i;
    if (G.guardfolkTypeOf(mockRecord(n))) guardName = n;
  }
  const rec = mockRecord(guardName);
  const player = mockPlayer("Jon", 0, 0);
  const director = mockDirector([rec], [player]);
  const midnight = new Date(2026, 9, 8, 2, 0).getTime();
  withFixedRandom(0.05, () => G.tickGuardfolk(director, midnight));
  const bot = director._bots.get(guardName);
  assert.equal(bot._chats.length, 0, "silent outside duty hours");
  console.log("tick silent outside hours: PASS");
}

// --- guards: non-guardfolk citizens are skipped ---
{
  fresh();
  // A non-commoner can never be guardfolk
  const rec = mockRecord("ProGuard1", "guard");
  const player = mockPlayer("Jon", 0, 0);
  const director = mockDirector([rec], [player]);
  const noon = new Date(2026, 9, 8, 12, 0).getTime();
  withFixedRandom(0.05, () => G.tickGuardfolk(director, noon));
  // Guards are skipped at the type gate before materialization, so no bot
  // is ever created — which also proves the gate ordering.
  assert.equal(director._bots.has("ProGuard1"), false, "no bot created for professional guard");
  console.log("non-guardfolk skipped: PASS");
}

// --- guards: never throws on hostile input ---
{
  fresh();
  assert.doesNotThrow(() => G.tickGuardfolk(null, T0), "null director");
  assert.doesNotThrow(() => G.tickGuardfolk({}, T0), "empty director");
  assert.doesNotThrow(() => G.guardfolkTypeOf(null), "null record");
  assert.doesNotThrow(() => G.guardfolkTypeOf({}), "empty record");
  assert.doesNotThrow(() => G.reportIssue(null, null), "null ledger args");
  assert.doesNotThrow(() => G.ceremonyFor(null, T0), "null ground");
  console.log("never-throws: PASS");
}

// --- helpers: fill, hash, pickOne ---
{
  fresh();
  assert.equal(G.fill("Drill at {ground}.", { ground: "the Green" }), "Drill at the Green.");
  assert.equal(G.fill("No slots.", {}), "No slots.");
  assert.equal(typeof G.hashStr("test"), "number");
  assert.ok(G.pickOne(() => 0, ["a", "b"]) === "a");
  assert.ok(G.pickOne(() => 0.99, ["a", "b"]) === "b");
  console.log("helpers: PASS");
}

console.log("ALL CITIZENGUARDS2 TESTS PASSED");
