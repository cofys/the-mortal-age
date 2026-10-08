"use strict";

// CitizenSailors2 unit checks — pure logic, no running server.
// From server/plugins/citizens: node lib/CitizenSailors2.test.js (plain node)
const assert = require("node:assert/strict");
const D = require("./CitizenSailors2");
const SailorsPro = require("./CitizenSailors");

const T0 = new Date(2026, 9, 8, 10, 0).getTime(); // 10:00 server-local — dock hours
const NIGHT = new Date(2026, 9, 8, 23, 0).getTime(); // 23:00 — outside dock hours

function mockLocation(x, y, z = 0) {
  return { getX: () => x, getY: () => y, getZ: () => z };
}
function mockCitizen(name, x = 3000, y = 3000) {
  const chats = [];
  return {
    getUsername: () => name,
    isPlayerBot: () => true,
    getHostAddress: () => "bot",
    getLocation: () => mockLocation(x, y),
    forceChat: (m) => chats.push(m),
    _chats: chats,
  };
}
function mockPlayer(name, x = 3005, y = 3005) {
  return {
    getUsername: () => name,
    isPlayerBot: () => false,
    getHostAddress: () => "127.0.0.1",
    getLocation: () => mockLocation(x, y),
  };
}
function mockRecord(username, kingdomId = "misthalin", role = "commoner") {
  return { username, kingdomId, role };
}
function mockDirector(records, citizens, players) {
  const roster = new Map(records.map((r) => [r.username, r]));
  const cits = new Map(Object.entries(citizens || {}));
  return {
    roster,
    playerFor: (record) => cits.get(record.username) || null,
    onlinePlayers: () => players || [],
  };
}
// Deterministic stub rng.
function fixedRng(v) {
  return () => v;
}

function fresh() {
  D._resetState();
}

// --- hashStr: stable, FNV-1a shaped ---
{
  fresh();
  assert.equal(D.hashStr("abc"), D.hashStr("abc"), "hash is deterministic");
  assert.ok(D.hashStr("abc") !== D.hashStr("abd"), "hash differs per input");
  console.log("hashStr: PASS");
}

// --- dockfolkTypeFromRoll: weights 30/30/25/15 ---
{
  fresh();
  assert.equal(D.dockfolkTypeFromRoll(0), D.DOCKFOLK_DOCKHAND, "roll 0 -> dockhand");
  assert.equal(D.dockfolkTypeFromRoll(29), D.DOCKFOLK_DOCKHAND, "roll 29 -> dockhand");
  assert.equal(D.dockfolkTypeFromRoll(30), D.DOCKFOLK_MENDER, "roll 30 -> sail-mender");
  assert.equal(D.dockfolkTypeFromRoll(59), D.DOCKFOLK_MENDER, "roll 59 -> sail-mender");
  assert.equal(D.dockfolkTypeFromRoll(60), D.DOCKFOLK_FISHER, "roll 60 -> shore-fisher");
  assert.equal(D.dockfolkTypeFromRoll(84), D.DOCKFOLK_FISHER, "roll 84 -> shore-fisher");
  assert.equal(D.dockfolkTypeFromRoll(85), D.DOCKFOLK_SALT, "roll 85 -> old-salt");
  assert.equal(D.dockfolkTypeFromRoll(99), D.DOCKFOLK_SALT, "roll 99 -> old-salt");
  console.log("type roll boundaries: PASS");
}

// --- dockfolkTypeOf: all types reachable, stable, commoner-gated ---
{
  fresh();
  const seen = new Set();
  let count = 0;
  for (let i = 0; i < 3000; i++) {
    const t = D.dockfolkTypeOf(mockRecord("DockName" + i));
    if (t) {
      seen.add(t);
      count++;
    }
  }
  for (const t of D.DOCKFOLK_TYPES) assert.ok(seen.has(t), `type ${t} reachable`);
  assert.ok(count / 3000 > 0.3 && count / 3000 < 0.55, `~40% share, got ${(count / 30).toFixed(1)}%`);
  assert.equal(D.dockfolkTypeOf(mockRecord("DockName7")), D.dockfolkTypeOf(mockRecord("DockName7")), "stable across calls");
  assert.equal(D.dockfolkTypeOf(mockRecord("GuardBob", "misthalin", "guard")), null, "non-commoners excluded");
  assert.equal(D.dockfolkTypeOf({}), null, "nameless record excluded");
  console.log("type identity: PASS");
}

// --- salt correlation: no bucket starved (blacksmiths2 lesson) ---
{
  fresh();
  const buckets = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  let n = 0;
  for (let i = 0; i < 3000; i++) {
    const rec = mockRecord("SaltName" + i);
    if (D.dockfolkTypeOf(rec)) {
      const roll = D.hashStr("saltname" + i + "|dockfolk-type") % 100;
      buckets[Math.floor(roll / 10)]++;
      n++;
    }
  }
  for (const b of buckets) assert.ok(b > n / 40, `no starved decile bucket (min ${Math.min(...buckets)}, n=${n})`);
  console.log("salt correlation: PASS");
}

// --- pro-sailor exclusion verified against the REAL module ---
{
  fresh();
  let found = 0;
  for (let i = 0; i < 5000 && found < 5; i++) {
    const uname = "ProSailor" + i;
    if (SailorsPro.sailorTypeFor(uname)) {
      found++;
      assert.equal(D.dockfolkTypeOf(mockRecord(uname)), null, `pro sailor ${uname} excluded`);
    }
  }
  assert.ok(found > 0, "found real pro sailors to test exclusion");
  console.log("pro-sailor exclusion: PASS");
}

// --- dockFor: kingdom-preferred, stable ---
{
  fresh();
  const d1 = D.dockFor(mockRecord("Harbor1", "kandarin"));
  assert.equal(d1.kingdom, "kandarin", "kandarin citizen gets a kandarin dock");
  assert.equal(D.dockFor(mockRecord("Harbor1", "kandarin")).name, d1.name, "stable");
  const d2 = D.dockFor(mockRecord("Harbor2", "morytania"));
  assert.equal(d2.kingdom, "morytania", "morytania citizen gets a morytania dock");
  console.log("dockFor: PASS");
}

// --- jobsFor: determinism + day variance ---
{
  fresh();
  const a = D.jobsFor("Jobber", D.DOCKFOLK_MENDER, T0);
  assert.deepEqual(a, D.jobsFor("Jobber", D.DOCKFOLK_MENDER, T0), "deterministic per day");
  assert.ok(a.length >= 1 && a.length <= 3, "1-3 jobs");
  assert.ok(new Set(a).size === a.length, "no duplicate jobs");
  const seen = new Set();
  for (let d = 0; d < 10; d++) {
    seen.add(JSON.stringify(D.jobsFor("Jobber", D.DOCKFOLK_MENDER, T0 + d * 86400000)));
  }
  assert.ok(seen.size > 1, "jobs vary across days");
  console.log("jobsFor: PASS");
}

// --- catchFor / yarnFor: deterministic ---
{
  fresh();
  assert.equal(D.catchFor("Fisher1", T0), D.catchFor("Fisher1", T0), "catch deterministic");
  assert.ok(D.SHORE_CATCHES.includes(D.catchFor("Fisher1", T0)), "catch from pool");
  assert.equal(D.yarnFor("Salt1", T0), D.yarnFor("Salt1", T0), "yarn deterministic");
  assert.ok(D.SEA_YARNS.includes(D.yarnFor("Salt1", T0)), "yarn from pool");
  console.log("catchFor/yarnFor: PASS");
}

// --- arrivalFor: determinism + rarity ---
{
  fresh();
  const dock = D.COMMUNITY_DOCKS[0];
  const days = [];
  for (let d = 0; d < 60; d++) days.push(D.arrivalFor(dock, T0 + d * 86400000));
  const hits = days.filter(Boolean).length;
  assert.ok(hits >= 1 && hits <= 12, `~8%/day rarity, got ${hits}/60`);
  assert.equal(D.arrivalFor(dock, T0), D.arrivalFor(dock, T0), "deterministic per day");
  assert.equal(D.arrivalFor(null, T0), null, "null dock -> null");
  console.log("arrivalFor: PASS");
}

// --- weatherFor: real-module tie-in never throws ---
{
  fresh();
  const w = D.weatherFor(T0);
  assert.ok(["calm", "breezy", "storm"].includes(w), `weather is a known value, got ${w}`);
  console.log("weatherFor: PASS");
}

// --- ledgers: round-trip + TTL expiry ---
{
  fresh();
  assert.equal(D.hireHand("Jon", T0), true, "hire recorded");
  assert.equal(D.handFor("Jon", T0 + 1000), true, "hire retrievable");
  assert.equal(D.handFor("Jon", T0 + 8 * 86400000), false, "hire expires after TTL");
  D._resetState();
  assert.equal(D.buySupplies("Jon", "a coil of rope", T0), "a coil of rope", "supply recorded");
  assert.equal(D.suppliesFor("Jon", T0 + 1000), "a coil of rope", "supply retrievable");
  assert.equal(D.suppliesFor("Jon", T0 + 8 * 86400000), null, "supply expires after TTL");
  D._resetState();
  assert.equal(D.hearTale("Jon", T0), true, "yarn request recorded");
  assert.equal(D.taleFor("Jon", T0 + 1000), true, "yarn retrievable");
  assert.equal(D.taleFor("Jon", T0 + 8 * 86400000), false, "yarn expires after TTL");
  assert.equal(D.hireHand("", T0), false, "empty name rejected");
  assert.equal(D.buySupplies("Jon", "", T0), null, "empty supply rejected");
  console.log("ledgers: PASS");
}

// --- isDockHour: local-time constructors per the timezone rule ---
{
  fresh();
  assert.equal(D.isDockHour(new Date(2026, 9, 8, 6, 0).getTime()), true, "06:00 open");
  assert.equal(D.isDockHour(new Date(2026, 9, 8, 19, 59).getTime()), true, "19:59 open");
  assert.equal(D.isDockHour(new Date(2026, 9, 8, 20, 0).getTime()), false, "20:00 closed");
  assert.equal(D.isDockHour(new Date(2026, 9, 8, 5, 59).getTime()), false, "05:59 closed");
  console.log("isDockHour: PASS");
}

// --- guards: isRealPlayer / isCitizenBot / withinTiles ---
{
  fresh();
  assert.equal(D.isRealPlayer(mockPlayer("P")), true, "real player passes");
  assert.equal(D.isRealPlayer(mockCitizen("C")), false, "bot fails");
  assert.equal(D.isRealPlayer(null), false, "null fails");
  assert.equal(D.isCitizenBot(mockCitizen("C")), true, "citizen bot passes");
  assert.equal(D.isCitizenBot(mockPlayer("P")), false, "real player fails bot check");
  const a = mockCitizen("A", 3000, 3000);
  assert.equal(D.withinTiles(a, mockPlayer("P", 3010, 3010), 14), true, "within radius");
  assert.equal(D.withinTiles(a, mockPlayer("P", 3100, 3100), 14), false, "outside radius");
  console.log("guards: PASS");
}

// --- tick fires near a real player, silent otherwise ---
{
  fresh();
  // Find a deterministic dockfolk citizen.
  let uname = null;
  for (let i = 0; i < 5000 && !uname; i++) {
    if (D.dockfolkTypeOf(mockRecord("TickDock" + i))) uname = "TickDock" + i;
  }
  assert.ok(uname, "found a dockfolk citizen");
  const rec = mockRecord(uname);
  const citizen = mockCitizen(uname, 3000, 3000);
  const real = mockPlayer("Jon", 3005, 3005);
  const director = mockDirector([rec], { [uname]: citizen }, [real]);
  const origRandom = Math.random;
  Math.random = fixedRng(0.05); // below DOCKFOLK_CHANCE 0.15
  try {
    D.tickDockfolk(director, T0);
  } finally {
    Math.random = origRandom;
  }
  assert.ok(citizen._chats.length >= 1, "citizen speaks near a real player");

  // Silent near bots only.
  fresh();
  const citizen2 = mockCitizen(uname, 3000, 3000);
  const botOnly = mockDirector([rec], { [uname]: citizen2 }, [mockCitizen("Bot2", 3005, 3005)]);
  Math.random = fixedRng(0.05);
  try {
    D.tickDockfolk(botOnly, T0);
  } finally {
    Math.random = origRandom;
  }
  assert.equal(citizen2._chats.length, 0, "silent near bots only");

  // Silent outside dock hours.
  fresh();
  const citizen3 = mockCitizen(uname, 3000, 3000);
  const night = mockDirector([rec], { [uname]: citizen3 }, [real]);
  Math.random = fixedRng(0.05);
  try {
    D.tickDockfolk(night, NIGHT);
  } finally {
    Math.random = origRandom;
  }
  assert.equal(citizen3._chats.length, 0, "silent at 23:00");

  // Non-dockfolk skipped before materialization.
  fresh();
  let plain = null;
  for (let i = 0; i < 5000 && !plain; i++) {
    if (!D.dockfolkTypeOf(mockRecord("PlainDock" + i))) plain = "PlainDock" + i;
  }
  const recP = mockRecord(plain);
  const directorP = mockDirector([recP], {}, [real]);
  D.tickDockfolk(directorP, T0);
  console.log("tick behavior: PASS");
}

// --- tick never throws on hostile input ---
{
  fresh();
  assert.doesNotThrow(() => D.tickDockfolk(null, T0), "null director");
  assert.doesNotThrow(() => D.tickDockfolk({}, T0), "empty director");
  assert.doesNotThrow(() => D.tickDockfolk({ roster: null }, T0), "null roster");
  console.log("never-throws: PASS");
}

// --- pure helpers ---
{
  fresh();
  assert.equal(D.fill("Hi {name}, {job}!", { name: "Jon", job: "loading" }), "Hi Jon, loading!");
  assert.equal(D.fill("No tokens.", {}), "No tokens.");
  const rng = D.seededRng(42);
  assert.ok(rng() >= 0 && rng() < 1, "seededRng in range");
  assert.equal(D.chance(fixedRng(0.1), 0.15), true, "chance passes below p");
  assert.equal(D.chance(fixedRng(0.2), 0.15), false, "chance fails above p");
  assert.equal(D.dayNumber(86400000 * 3), 3, "dayNumber");
  console.log("pure helpers: PASS");
}

console.log("ALL CITIZENSAILORS2 TESTS PASSED");
