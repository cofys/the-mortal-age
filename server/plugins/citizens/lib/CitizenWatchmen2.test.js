"use strict";

// CitizenWatchmen2 unit checks — pure logic, no running server.
// From server/plugins/citizens: node CitizenWatchmen2.test.js (plain node)
const assert = require("node:assert/strict");
const W = require("./CitizenWatchmen2");

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
  W._resetState();
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
  return {
    roster: new Map(records.map((r) => [r.username, r])),
    playerFor: (record) => {
      if (!bots.has(record.username)) bots.set(record.username, mockCitizenBot(record.username));
      return bots.get(record.username);
    },
    onlinePlayers: () => players,
    _bots: bots,
  };
}

// --- type weights: all four reachable, weights respected ---
{
  fresh();
  const seen = new Set();
  for (let i = 0; i < 3000; i++) {
    const t = W.watchmanTypeOf(mockRecord("WatchCitizen" + i));
    if (t) seen.add(t);
  }
  for (const t of W.WATCH_TYPES) assert.ok(seen.has(t), `type ${t} reachable`);
  // ~45% nominal share
  let count = 0;
  for (let i = 0; i < 3000; i++) if (W.watchmanTypeOf(mockRecord("ShareCitizen" + i))) count++;
  const share = count / 3000;
  assert.ok(share > 0.35 && share < 0.55, `share ${share} near 0.45`);
  console.log("type weights: PASS");
}

// --- type stability: same name always the same type ---
{
  fresh();
  for (let i = 0; i < 200; i++) {
    const a = W.watchmanTypeOf(mockRecord("Stable" + i));
    const b = W.watchmanTypeOf(mockRecord("Stable" + i));
    assert.equal(a, b, "stable across calls");
  }
  console.log("type stability: PASS");
}

// --- professional guards excluded ---
{
  fresh();
  for (let i = 0; i < 200; i++) {
    assert.equal(W.watchmanTypeOf(mockRecord("GuardPro" + i, "guard")), null, "role guard excluded");
  }
  console.log("guard exclusion: PASS");
}

// --- non-commoner roles excluded ---
{
  fresh();
  assert.equal(W.watchmanTypeOf(mockRecord("Merch1", "merchant")), null, "merchant excluded");
  assert.equal(W.watchmanTypeOf(mockRecord("Court1", "courtier")), null, "courtier excluded");
  assert.equal(W.watchmanTypeOf({ username: "" }), null, "empty name excluded");
  assert.equal(W.watchmanTypeOf(null), null, "null record excluded");
  console.log("commoner gating: PASS");
}

// --- beats: kingdom-preferred, deterministic ---
{
  fresh();
  const b1 = W.beatFor(mockRecord("BeatCit", "commoner", "asgarnia"));
  const b2 = W.beatFor(mockRecord("BeatCit", "commoner", "asgarnia"));
  assert.equal(b1.name, b2.name, "beat stable");
  assert.equal(b1.kingdom, "asgarnia", "kingdom-preferred");
  console.log("beats: PASS");
}

// --- rota: deterministic per day, varies across days ---
{
  fresh();
  const d1 = new Date(2026, 9, 8, 12, 0).getTime();
  const d2 = new Date(2026, 9, 9, 12, 0).getTime();
  const r1 = W.rotaFor("RotaCit", "misthalin", d1);
  const r1b = W.rotaFor("RotaCit", "misthalin", d1);
  assert.deepEqual(r1, r1b, "rota deterministic same day");
  assert.ok(r1.length >= 1 && r1.length <= 2, "1-2 beats");
  let varied = false;
  for (let d = 0; d < 10; d++) {
    const rx = W.rotaFor("RotaCit", "misthalin", d1 + d * 86400000);
    if (JSON.stringify(rx) !== JSON.stringify(r1)) { varied = true; break; }
  }
  assert.ok(varied, "rota varies across days");
  console.log("rota: PASS");
}

// --- fire scare: deterministic, rare ---
{
  fresh();
  const d = new Date(2026, 9, 8, 23, 0).getTime();
  const s1 = W.fireScareFor("misthalin", d);
  const s2 = W.fireScareFor("misthalin", d);
  assert.equal(s1, s2, "fire scare deterministic");
  let hits = 0;
  for (let i = 0; i < 40; i++) {
    if (W.fireScareFor("misthalin", d + i * 86400000)) hits++;
  }
  assert.ok(hits >= 0 && hits <= 8, `fire scare rare (${hits}/40)`);
  console.log("fire scare: PASS");
}

// --- official shift tie-in reads the real CitizenGuards table ---
{
  fresh();
  const day = new Date(2026, 9, 8, 12, 0).getTime(); // noon local
  const night = new Date(2026, 9, 8, 23, 0).getTime(); // 11pm local
  assert.equal(W.officialShiftFor(day), "day", "noon is day shift");
  assert.equal(W.officialShiftFor(night), "night", "11pm is night shift");
  console.log("shift tie-in: PASS");
}

// --- watch hours via local-time constructors (timezone rule) ---
{
  fresh();
  const noon = new Date(2026, 9, 8, 12, 0).getTime();
  const midnight = new Date(2026, 9, 8, 0, 30).getTime();
  const evening = new Date(2026, 9, 8, 21, 0).getTime();
  assert.ok(W.isWatchHour(W.WATCH_NIGHT, evening), "night watch at 21:00");
  assert.ok(W.isWatchHour(W.WATCH_NIGHT, midnight), "night watch at 00:30");
  assert.ok(!W.isWatchHour(W.WATCH_NIGHT, noon), "night watch off at noon");
  assert.ok(W.isWatchHour(W.WATCH_DAY, noon), "day warden at noon");
  assert.ok(!W.isWatchHour(W.WATCH_DAY, evening), "day warden off at 21:00");
  assert.ok(W.isWatchHour(W.WATCH_GATE, noon), "gate-minder at noon");
  assert.ok(!W.isWatchHour(W.WATCH_GATE, midnight), "gate-minder off at 00:30");
  assert.ok(W.isWatchHour(W.WATCH_FIRE, evening), "fire lookout at 21:00");
  assert.ok(!W.isWatchHour(W.WATCH_FIRE, noon), "fire lookout off at noon");
  console.log("watch hours: PASS");
}

// --- all 3 ledgers round-trip + TTL expiry ---
{
  fresh();
  const now = T0;
  assert.equal(W.reportCrime("Jon", "cutpurse on the east lane", now), "jon");
  assert.equal(W.reportFor("Jon", now), "cutpurse on the east lane");
  assert.equal(W.joinWatch("Jon", now), "jon");
  assert.equal(W.watcherFor("Jon", now), true);
  assert.equal(W.hireWarden("Jon", now), "jon");
  assert.equal(W.wardenFor("Jon", now), true);
  // TTL expiry
  const later = now + 8 * 24 * 3600 * 1000;
  assert.equal(W.reportFor("Jon", later), null, "crime report expires");
  assert.equal(W.watcherFor("Jon", later), false, "volunteer expires");
  assert.equal(W.wardenFor("Jon", later), false, "hire expires");
  assert.equal(W.reportCrime(null, "x", now), null, "null name rejected");
  console.log("ledgers: PASS");
}

// --- guards: isRealPlayer / isCitizenBot / withinTiles ---
{
  fresh();
  assert.equal(W.isRealPlayer(mockPlayer("Jon")), true);
  assert.equal(W.isRealPlayer(mockCitizenBot("Bot")), false);
  assert.equal(W.isRealPlayer(null), false);
  assert.equal(W.isCitizenBot(mockCitizenBot("Bot")), true);
  assert.equal(W.isCitizenBot(mockPlayer("Jon")), false);
  assert.equal(W.withinTiles(mockPlayer("A", 0, 0), mockPlayer("B", 5, 5), 14), true);
  assert.equal(W.withinTiles(mockPlayer("A", 0, 0), mockPlayer("B", 50, 50), 14), false);
  console.log("guards: PASS");
}

// --- tick fires near a real player, silent near bots only ---
{
  fresh();
  // find a watchman name that passes the type gate
  let wname = null;
  for (let i = 0; i < 500; i++) {
    const cand = "TickWatch" + i;
    const t = W.watchmanTypeOf(mockRecord(cand));
    if (t === W.WATCH_DAY) { wname = cand; break; }
  }
  assert.ok(wname, "found a day-warden name");
  const noon = new Date(2026, 9, 8, 12, 0).getTime();
  const rec = mockRecord(wname, "commoner", "misthalin");
  const real = mockPlayer("Jon", 1, 1);
  const d = mockDirector([rec], [real]);
  withFixedRandom(0.05, () => W.tickWatchmen(d, noon));
  const bot = d._bots.get(wname);
  assert.ok(bot._chats.length >= 1, "watchman speaks near a real player");

  fresh();
  const d2 = mockDirector([rec], [mockCitizenBot("OtherBot", 1, 1)]);
  withFixedRandom(0.05, () => W.tickWatchmen(d2, noon));
  const bot2 = d2._bots.get(wname);
  assert.equal(bot2._chats.length, 0, "silent near bots only");
  console.log("tick proximity: PASS");
}

// --- tick silent outside watch hours ---
{
  fresh();
  let wname = null;
  for (let i = 0; i < 500; i++) {
    const cand = "OffHour" + i;
    if (W.watchmanTypeOf(mockRecord(cand)) === W.WATCH_DAY) { wname = cand; break; }
  }
  assert.ok(wname, "found a day-warden name");
  const night = new Date(2026, 9, 8, 23, 0).getTime();
  const rec = mockRecord(wname, "commoner", "misthalin");
  const d = mockDirector([rec], [mockPlayer("Jon", 1, 1)]);
  withFixedRandom(0.05, () => W.tickWatchmen(d, night));
  assert.equal(d._bots.get(wname)._chats.length, 0, "day warden silent at night");
  console.log("tick hours: PASS");
}

// --- professional guards skipped by the tick ---
{
  fresh();
  const noon = new Date(2026, 9, 8, 12, 0).getTime();
  const rec = mockRecord("ProGuard1", "guard", "misthalin");
  const d = mockDirector([rec], [mockPlayer("Jon", 1, 1)]);
  withFixedRandom(0.05, () => W.tickWatchmen(d, noon));
  // Guard role is skipped at the type gate (gate 2), before materialization
  // (gate 3) — so no bot is ever created for them.
  assert.equal(d._bots.get("ProGuard1"), undefined, "guard role skipped before materialization");
  console.log("tick guard skip: PASS");
}

// --- tick never throws on hostile input ---
{
  fresh();
  assert.doesNotThrow(() => W.tickWatchmen(null, T0), "null director");
  assert.doesNotThrow(() => W.tickWatchmen({}, T0), "empty director");
  assert.doesNotThrow(() => W.tickWatchmen({ roster: null }, T0), "null roster");
  assert.doesNotThrow(() => W.watchmanTypeOf({ username: 12345 }), "numeric username");
  console.log("never-throws: PASS");
}

// --- helpers: hashStr / fill / watchmanTypeFromRoll ---
{
  fresh();
  assert.equal(W.hashStr("abc"), W.hashStr("abc"), "hashStr deterministic");
  assert.equal(W.fill("Hi {name}, walk the {beat}.", { name: "Jon", beat: "east lane" }), "Hi Jon, walk the east lane.");
  assert.equal(W.watchmanTypeFromRoll(0), W.WATCH_NIGHT);
  assert.equal(W.watchmanTypeFromRoll(29), W.WATCH_NIGHT);
  assert.equal(W.watchmanTypeFromRoll(30), W.WATCH_DAY);
  assert.equal(W.watchmanTypeFromRoll(54), W.WATCH_DAY);
  assert.equal(W.watchmanTypeFromRoll(55), W.WATCH_GATE);
  assert.equal(W.watchmanTypeFromRoll(79), W.WATCH_GATE);
  assert.equal(W.watchmanTypeFromRoll(80), W.WATCH_FIRE);
  assert.equal(W.watchmanTypeFromRoll(99), W.WATCH_FIRE);
  console.log("helpers: PASS");
}

console.log("ALL CITIZENWATCHMEN2 TESTS PASSED");
