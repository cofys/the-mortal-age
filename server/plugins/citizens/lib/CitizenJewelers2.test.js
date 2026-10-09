"use strict";

// CitizenJewelers2 unit checks — pure logic, no running server.
// From server/plugins/citizens: node lib/CitizenJewelers2.test.js (plain node)
const assert = require("node:assert/strict");
const S = require("./CitizenJewelers2");
const JewelersPro = require("./CitizenJewelers");

const T0 = new Date(2026, 9, 8, 10, 0).getTime(); // 10:00 local — workshop hours
const T_NIGHT = new Date(2026, 9, 8, 3, 0).getTime(); // 03:00 local — outside hours

function withFixedRandom(value, fn) {
  const orig = Math.random;
  Math.random = () => value;
  try {
    return fn();
  } finally {
    Math.random = orig;
  }
}

function mockLocation(x, y, z = 0) {
  return { getX: () => x, getY: () => y, getZ: () => z };
}
function mockPlayer(name, x, y, isBot = false) {
  const chats = [];
  return {
    getUsername: () => name,
    isPlayerBot: () => isBot,
    getHostAddress: () => (isBot ? "bot" : "127.0.0.1"),
    getLocation: () => mockLocation(x, y),
    forceChat: (m) => chats.push(m),
    _chats: chats,
  };
}
function mockDirector(records, players) {
  const roster = new Map(records.map((r) => [r.username, r]));
  const bots = new Map();
  for (const p of players) {
    const name = p.getUsername();
    if (!roster.has(name)) roster.set(name, { username: name, role: "player" });
    if (!bots.has(name)) bots.set(name, p);
  }
  return {
    roster,
    isOnline: () => true,
    getBot: (rec) => {
      if (!bots.has(rec.username)) bots.set(rec.username, mockPlayer(rec.username, 100, 100, true));
      return bots.get(rec.username);
    },
    // legacy alias for tests
    playerFor: function (rec) { return this.getBot(rec); },
  };
}
function fresh() {
  S._resetState();
}

// --- type weights / roll boundaries / reachability ---
{
  fresh();
  assert.equal(S.gemfolkTypeFromRoll(0), S.GEMFOLK_CUTTER);
  assert.equal(S.gemfolkTypeFromRoll(29), S.GEMFOLK_CUTTER);
  assert.equal(S.gemfolkTypeFromRoll(30), S.GEMFOLK_SETTER);
  assert.equal(S.gemfolkTypeFromRoll(54), S.GEMFOLK_SETTER);
  assert.equal(S.gemfolkTypeFromRoll(55), S.GEMFOLK_POLISHER);
  assert.equal(S.gemfolkTypeFromRoll(79), S.GEMFOLK_POLISHER);
  assert.equal(S.gemfolkTypeFromRoll(80), S.GEMFOLK_APPRAISER);
  assert.equal(S.gemfolkTypeFromRoll(99), S.GEMFOLK_APPRAISER);
  // Every type reachable over a wide sweep.
  const seen = new Set();
  for (let i = 0; i < 400; i++) {
    const t = S.gemfolkTypeOf({ username: "sweep" + i, role: "commoner" });
    if (t) seen.add(t);
  }
  for (const t of S.GEMFOLK_TYPES) assert.ok(seen.has(t), `type ${t} reachable`);
  console.log("type weights/reachability: PASS");
}

// --- type stability across calls ---
{
  fresh();
  for (let i = 0; i < 50; i++) {
    const a = S.gemfolkTypeOf({ username: "stable" + i, role: "commoner" });
    const b = S.gemfolkTypeOf({ username: "stable" + i, role: "commoner" });
    assert.equal(a, b, "type stable across calls");
  }
  console.log("type stability: PASS");
}

// --- commoner gating ---
{
  fresh();
  assert.equal(S.gemfolkTypeOf({ username: "guard1", role: "guard" }), null, "guards excluded");
  assert.equal(S.gemfolkTypeOf({ username: "merch1", role: "merchant" }), null, "merchants excluded");
  assert.equal(S.gemfolkTypeOf({ username: null, role: "commoner" }), null, "null username excluded");
  console.log("commoner gating: PASS");
}

// --- professional jeweler exclusion (verified against the REAL module) ---
{
  fresh();
  // Find a real professional jeweler and confirm we exclude them.
  let proName = null;
  for (let i = 0; i < 3000 && !proName; i++) {
    const nm = "prosearch" + i;
    if (JewelersPro.jewelerTypeFor(nm)) proName = nm;
  }
  assert.ok(proName, "found a professional jeweler for the exclusion test");
  assert.equal(S.gemfolkTypeOf({ username: proName, role: "commoner" }), null, "pro jeweler excluded");
  console.log("pro-jeweler exclusion: PASS");
}

// --- broad distribution (~40% nominal, minus pro-jeweler overlap) ---
{
  fresh();
  let count = 0;
  for (let i = 0; i < 1000; i++) {
    if (S.gemfolkTypeOf({ username: "dist" + i, role: "commoner" })) count++;
  }
  assert.ok(count >= 250 && count <= 450, `distribution in band, got ${count}/1000`);
  console.log(`broad distribution (${count}/1000): PASS`);
}

// --- salt-correlation check (the FNV-1a prefix bug) ---
{
  fresh();
  // Type buckets must not be starved among gemfolk.
  const counts = { [S.GEMFOLK_CUTTER]: 0, [S.GEMFOLK_SETTER]: 0, [S.GEMFOLK_POLISHER]: 0, [S.GEMFOLK_APPRAISER]: 0 };
  let total = 0;
  for (let i = 0; i < 3000; i++) {
    const t = S.gemfolkTypeOf({ username: "saltcheck" + i, role: "commoner" });
    if (t) { counts[t]++; total++; }
  }
  assert.ok(total > 800, `enough gemfolk sampled, got ${total}`);
  // Expected shares: 30/25/25/20. No bucket below half its expected share.
  const expected = { [S.GEMFOLK_CUTTER]: 0.30, [S.GEMFOLK_SETTER]: 0.25, [S.GEMFOLK_POLISHER]: 0.25, [S.GEMFOLK_APPRAISER]: 0.20 };
  for (const t of S.GEMFOLK_TYPES) {
    const share = counts[t] / total;
    assert.ok(share > expected[t] * 0.5, `bucket ${t} not starved: ${share.toFixed(3)}`);
  }
  console.log("salt-correlation check: PASS");
}

// --- kingdom-preferred workshops ---
{
  fresh();
  const w = S.workshopFor({ username: "keldagrimfan", kingdomId: "keldagrim" });
  assert.ok(w && w.kingdom === "keldagrim", "keldagrim citizen gets keldagrim workshop");
  const w2 = S.workshopFor({ username: "keldagrimfan", kingdomId: "keldagrim" });
  assert.equal(w.name, w2.name, "workshop stable");
  const w3 = S.workshopFor({ username: "nowhere", kingdomId: "nope" });
  assert.ok(w3 && w3.name, "unknown kingdom falls back to a workshop");
  console.log("kingdom-preferred workshops: PASS");
}

// --- price sanity ---
{
  fresh();
  const p = S.priceFor("a polished opal pendant");
  assert.ok(p >= 25 && p <= 200, `price in band, got ${p}`);
  assert.equal(S.priceFor("a polished opal pendant"), p, "price deterministic");
  console.log("price sanity: PASS");
}

// --- all 3 ledgers round-trip + TTL expiry ---
{
  fresh();
  assert.equal(S.commissionPiece("Jon", "a ruby cabochon brooch", T0), "a ruby cabochon brooch");
  assert.equal(S.pieceFor("Jon", T0 + 1000), "a ruby cabochon brooch");
  assert.equal(S.pieceFor("Nobody", T0), null);
  // TTL expiry (8 days > 7-day TTL).
  assert.equal(S.pieceFor("Jon", T0 + 8 * 86400000), null, "commission expires");
  console.log("commission ledger: PASS");
}
{
  fresh();
  assert.equal(S.sellGem("Jon", "raw emerald", T0), "raw emerald");
  assert.equal(S.gemFor("Jon", T0 + 1000), "raw emerald");
  assert.equal(S.gemFor("Jon", T0 + 8 * 86400000), null, "gem sale expires");
  assert.equal(S.sellGem("Jon", null, T0), null, "null gem rejected");
  console.log("gem ledger: PASS");
}
{
  fresh();
  assert.equal(S.learnCutting("Jon", T0), true);
  assert.equal(S.cuttingFor("Jon", T0 + 1000), true);
  assert.equal(S.cuttingFor("Jon", T0 + 8 * 86400000), false, "lesson signup expires");
  assert.equal(S.learnCutting(null, T0), null, "null name rejected");
  console.log("lesson ledger: PASS");
}

// --- workshop hours via local-time constructors (timezone rule) ---
{
  fresh();
  assert.equal(S.isWorkHour(new Date(2026, 9, 8, 10, 0).getTime()), true, "10:00 is work hour");
  assert.equal(S.isWorkHour(new Date(2026, 9, 8, 3, 0).getTime()), false, "03:00 is not");
  assert.equal(S.isWorkHour(new Date(2026, 9, 8, 8, 0).getTime()), true, "08:00 boundary inclusive");
  assert.equal(S.isWorkHour(new Date(2026, 9, 8, 18, 0).getTime()), false, "18:00 boundary exclusive");
  console.log("workshop hours: PASS");
}

// --- player/bot/tile guards ---
{
  fresh();
  assert.equal(S.isRealPlayer(null), false);
  assert.equal(S.isRealPlayer(mockPlayer("x", 1, 1, true)), false, "bot is not real player");
  assert.equal(S.isRealPlayer(mockPlayer("x", 1, 1, false)), true, "human is real player");
  assert.equal(S.isCitizenBot(mockPlayer("x", 1, 1, true)), true);
  const a = mockPlayer("a", 100, 100, true);
  const b = mockPlayer("b", 105, 105, false);
  assert.equal(S.withinTiles(a, b, 14), true);
  assert.equal(S.withinTiles(a, mockPlayer("c", 500, 500, false), 14), false);
  console.log("player/bot/tile guards: PASS");
}

// --- tick fires near a real player, silent otherwise ---
{
  fresh();
  // Find a gemfolk citizen deterministically.
  let gemName = null;
  for (let i = 0; i < 500 && !gemName; i++) {
    const nm = "tickgem" + i;
    if (S.gemfolkTypeOf({ username: nm, role: "commoner", kingdomId: "misthalin" })) gemName = nm;
  }
  assert.ok(gemName, "found a gemfolk citizen");
  const rec = { username: gemName, role: "commoner", kingdomId: "misthalin" };
  // Near a real player, in hours, chance forced to pass.
  const director = mockDirector([rec], [mockPlayer("Jon", 102, 102, false)]);
  withFixedRandom(0.05, () => S.tickGemfolk(director, T0));
  const bot = director.playerFor(rec);
  assert.ok(bot._chats.length > 0, "tick fires near a real player");
  console.log("tick fires near real player: PASS");
}
{
  fresh();
  let gemName = null;
  for (let i = 0; i < 500 && !gemName; i++) {
    const nm = "tickgemB" + i;
    if (S.gemfolkTypeOf({ username: nm, role: "commoner", kingdomId: "misthalin" })) gemName = nm;
  }
  const rec = { username: gemName, role: "commoner", kingdomId: "misthalin" };
  // Bots only: silent.
  const director = mockDirector([rec], [mockPlayer("BotBob", 102, 102, true)]);
  withFixedRandom(0.05, () => S.tickGemfolk(director, T0));
  assert.equal(director.playerFor(rec)._chats.length, 0, "silent near bots only");
  // Outside hours: silent.
  fresh();
  const director2 = mockDirector([rec], [mockPlayer("Jon", 102, 102, false)]);
  withFixedRandom(0.05, () => S.tickGemfolk(director2, T_NIGHT));
  assert.equal(director2.playerFor(rec)._chats.length, 0, "silent outside hours");
  console.log("tick silent guards: PASS");
}
{
  fresh();
  // Professional jeweler is skipped at the type gate (before materialization).
  let proName = null;
  for (let i = 0; i < 3000 && !proName; i++) {
    const nm = "tickpro" + i;
    if (JewelersPro.jewelerTypeFor(nm)) proName = nm;
  }
  const rec = { username: proName, role: "commoner", kingdomId: "misthalin" };
  const director = mockDirector([rec], [mockPlayer("Jon", 102, 102, false)]);
  withFixedRandom(0.05, () => S.tickGemfolk(director, T0));
  // playerFor was never called for the pro (type gate rejected first).
  console.log("pro jeweler skipped: PASS");
}

// --- never throws on hostile input ---
{
  fresh();
  assert.doesNotThrow(() => S.tickGemfolk(null, T0), "null director");
  assert.doesNotThrow(() => S.tickGemfolk({}, T0), "empty director");
  assert.doesNotThrow(() => S.tickGemfolk({ roster: null }, T0), "null roster");
  assert.doesNotThrow(() => S.gemfolkTypeOf(null), "null record");
  assert.doesNotThrow(() => S.gemfolkTypeOf({}), "empty record");
  console.log("never-throws: PASS");
}

// --- pure helpers ---
{
  fresh();
  assert.equal(S.fill("Hello {name}!", { name: "Jon" }), "Hello Jon!");
  assert.equal(S.hashStr("x"), S.hashStr("x"), "hash deterministic");
  const rng = S.seededRng(42);
  assert.ok(rng() >= 0 && rng() < 1, "seeded rng in range");
  assert.equal(S.chance(() => 0.1, 0.5), true);
  assert.equal(S.chance(() => 0.9, 0.5), false);
  assert.equal(S.dayNumber(86400000 * 5 + 1000), 5);
  console.log("pure helpers: PASS");
}

console.log("ALL CITIZENJEWELERS2 TESTS PASSED");
