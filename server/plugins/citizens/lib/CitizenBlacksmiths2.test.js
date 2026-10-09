"use strict";

// CitizenBlacksmiths2 unit checks — pure logic, no running server.
// From server/plugins/citizens: node lib/CitizenBlacksmiths2.test.js (plain node)
const assert = require("node:assert/strict");
const S = require("./CitizenBlacksmiths2");
const ProSmiths = require("./CitizenBlacksmiths");

const T0 = new Date(2026, 9, 8, 10, 0).getTime(); // 10:00 local — forge hours

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
// Real-API director shape: isOnline/getBot (CitizenDirector.js:1374/1379);
// the citizen bot carries getLocalPlayers (Player.ts:796). The old mocks
// used playerFor/onlinePlayers, which do not exist (blacksmiths audit 2026-10-08).
function mockDirector(records, players) {
  const roster = new Map(records.map((r) => [r.username, r]));
  const bots = new Map();
  const botFor = (rec) => {
    if (!bots.has(rec.username)) {
      const bot = mockPlayer(rec.username, 100, 100, true);
      bot.getLocalPlayers = () => players;
      bots.set(rec.username, bot);
    }
    return bots.get(rec.username);
  };
  return {
    roster,
    isOnline: () => true,
    getBot: botFor,
  };
}
function fresh() {
  S._resetState();
}

// --- type weights / roll boundaries / reachability ---
{
  fresh();
  assert.equal(S.smithfolkTypeFromRoll(0), S.SMITHFOLK_FARRIER);
  assert.equal(S.smithfolkTypeFromRoll(29), S.SMITHFOLK_FARRIER);
  assert.equal(S.smithfolkTypeFromRoll(30), S.SMITHFOLK_HONER);
  assert.equal(S.smithfolkTypeFromRoll(59), S.SMITHFOLK_HONER);
  assert.equal(S.smithfolkTypeFromRoll(60), S.SMITHFOLK_TINKERER);
  assert.equal(S.smithfolkTypeFromRoll(84), S.SMITHFOLK_TINKERER);
  assert.equal(S.smithfolkTypeFromRoll(85), S.SMITHFOLK_APPRENTICE);
  assert.equal(S.smithfolkTypeFromRoll(99), S.SMITHFOLK_APPRENTICE);
  // Every type reachable over a wide sweep.
  const seen = new Set();
  for (let i = 0; i < 400; i++) {
    const t = S.smithfolkTypeOf({ username: "sweep" + i, role: "commoner" });
    if (t) seen.add(t);
  }
  for (const t of S.SMITHFOLK_TYPES) assert.ok(seen.has(t), `type ${t} reachable`);
  console.log("type weights/reachability: PASS");
}

// --- type stability across calls ---
{
  fresh();
  for (let i = 0; i < 50; i++) {
    const a = S.smithfolkTypeOf({ username: "stable" + i, role: "commoner" });
    const b = S.smithfolkTypeOf({ username: "stable" + i, role: "commoner" });
    assert.equal(a, b, "type stable across calls");
  }
  console.log("type stability: PASS");
}

// --- commoner gating ---
{
  fresh();
  assert.equal(S.smithfolkTypeOf({ username: "x", role: "guard" }), null, "guards excluded");
  assert.equal(S.smithfolkTypeOf({ username: null, role: "commoner" }), null, "null name excluded");
  assert.equal(S.smithfolkTypeOf(null), null, "null record excluded");
  console.log("commoner gating: PASS");
}

// --- pro-smith exclusion verified against the REAL module ---
{
  fresh();
  // Find usernames the real pro module claims, and confirm we exclude them.
  let proFound = 0;
  let excluded = 0;
  for (let i = 0; i < 3000 && proFound < 20; i++) {
    const u = "procheck" + i;
    if (ProSmiths.smithTypeFor(u)) {
      proFound++;
      if (S.smithfolkTypeOf({ username: u, role: "commoner" }) === null) excluded++;
    }
  }
  assert.ok(proFound > 0, "found pro smiths to test against");
  assert.equal(excluded, proFound, "all pro smiths excluded from smithfolk");
  console.log(`pro-smith exclusion: PASS (${proFound} pro smiths all excluded)`);
}

// --- distribution band (~40% nominal) ---
{
  fresh();
  let n = 0;
  for (let i = 0; i < 2000; i++) {
    if (S.smithfolkTypeOf({ username: "dist" + i, role: "commoner" })) n++;
  }
  const pct = (n / 2000) * 100;
  assert.ok(pct > 25 && pct < 55, `distribution ${pct.toFixed(1)}% in band`);
  console.log(`distribution: PASS (${pct.toFixed(1)}%)`);
}

// --- kingdom-preferred smithies ---
{
  fresh();
  const s = S.smithyFor({ username: "kpref", kingdomId: "misthalin" });
  assert.equal(s.kingdom, "misthalin", "kingdom-preferred smithy");
  const s2 = S.smithyFor({ username: "kpref2", kingdomId: "nosuchkingdom" });
  assert.ok(s2 && s2.name, "falls back to full pool");
  assert.equal(
    S.smithyFor({ username: "kpref", kingdomId: "misthalin" }).name,
    s.name,
    "smithy stable"
  );
  console.log("smithy assignment: PASS");
}

// --- jobs removed 2026-10-08: jobsFor was hash-derived fabrication. ---

// --- metalForToday removed 2026-10-08: hash-derived fabrication, no production callers. ---

// --- masterwork removed 2026-10-08: masterworkFor was hash-derived fabrication. ---

// --- priceFor removed 2026-10-08: hash-derived fabrication, no production callers. ---

// --- all 3 ledgers round-trip + TTL expiry ---
{
  fresh();
  // repair
  S.requestRepair("Jon", "a bent plowshare", T0);
  assert.equal(S.repairFor("Jon", T0 + 1000), "a bent plowshare");
  assert.equal(S.repairFor("Jon", T0 + 8 * 86400000), null, "repair ledger expires");
  // goods (reset to avoid prune rate-limit cross-test pollution)
  S._resetState();
  S.buyGoods("Jon", "a bundle of nails", 12, T0);
  assert.deepEqual(S.goodsFor("Jon", T0 + 1000), { good: "a bundle of nails", price: 12 });
  assert.equal(S.goodsFor("Jon", T0 + 8 * 86400000), null, "goods ledger expires");
  // lessons (reset again for the same reason)
  S._resetState();
  S.learnSmithing("Jon", "bellows basics", T0);
  assert.equal(S.smithingFor("Jon", T0 + 1000), "bellows basics");
  assert.equal(S.smithingFor("Jon", T0 + 8 * 86400000), null, "lesson ledger expires");
  // null guards
  assert.equal(S.requestRepair(null, "x", T0), null);
  assert.equal(S.buyGoods("Jon", null, 1, T0), null);
  console.log("ledgers: PASS");
}

// --- forge hours via local-time constructors (timezone rule) ---
{
  fresh();
  assert.ok(S.isForgeHour(new Date(2026, 9, 8, 10, 0).getTime()), "10:00 is forge hour");
  assert.ok(!S.isForgeHour(new Date(2026, 9, 8, 3, 0).getTime()), "03:00 is not");
  assert.ok(!S.isForgeHour(new Date(2026, 9, 8, 20, 0).getTime()), "20:00 is not");
  console.log("forge hours: PASS");
}

// --- guards: isRealPlayer / isCitizenBot / withinTiles ---
{
  fresh();
  assert.ok(S.isRealPlayer(mockPlayer("P", 0, 0, false)));
  assert.ok(!S.isRealPlayer(mockPlayer("B", 0, 0, true)));
  assert.ok(!S.isRealPlayer(null));
  assert.ok(S.isCitizenBot(mockPlayer("B", 0, 0, true)));
  assert.ok(!S.isCitizenBot(mockPlayer("P", 0, 0, false)));
  assert.ok(S.withinTiles(mockPlayer("A", 100, 100, true), mockPlayer("B", 105, 105, false), 14));
  assert.ok(!S.withinTiles(mockPlayer("A", 100, 100, true), mockPlayer("B", 200, 200, false), 14));
  console.log("guards: PASS");
}

// --- tick fires near real player ---
{
  fresh();
  // Find a smithfolk username.
  let uname = null;
  for (let i = 0; i < 2000 && !uname; i++) {
    const u = "tickfire" + i;
    if (S.smithfolkTypeOf({ username: u, role: "commoner" })) uname = u;
  }
  assert.ok(uname, "found a smithfolk citizen");
  const rec = { username: uname, role: "commoner", kingdomId: "misthalin" };
  const real = mockPlayer("Jon", 102, 102, false);
  const dir = mockDirector([rec], [real]);
  withFixedRandom(0.05, () => S.tickSmithfolk(dir, T0)); // 0.05 < 0.15 chance gate
  const bot = dir.getBot(rec);
  assert.ok(bot._chats.length >= 1, "citizen spoke near a real player");
  console.log("tick fires near player: PASS");
}

// --- tick silent near bots only ---
{
  fresh();
  let uname = null;
  for (let i = 0; i < 2000 && !uname; i++) {
    const u = "tickbot" + i;
    if (S.smithfolkTypeOf({ username: u, role: "commoner" })) uname = u;
  }
  const rec = { username: uname, role: "commoner", kingdomId: "misthalin" };
  const botOnly = mockPlayer("BotBob", 102, 102, true);
  const dir = mockDirector([rec], [botOnly]);
  withFixedRandom(0.05, () => S.tickSmithfolk(dir, T0));
  const bot = dir.getBot(rec);
  assert.equal(bot._chats.length, 0, "silent near bots only");
  console.log("tick silent near bots: PASS");
}

// --- tick silent outside forge hours ---
{
  fresh();
  let uname = null;
  for (let i = 0; i < 2000 && !uname; i++) {
    const u = "ticknight" + i;
    if (S.smithfolkTypeOf({ username: u, role: "commoner" })) uname = u;
  }
  const rec = { username: uname, role: "commoner", kingdomId: "misthalin" };
  const real = mockPlayer("Jon", 102, 102, false);
  const dir = mockDirector([rec], [real]);
  const night = new Date(2026, 9, 8, 3, 0).getTime();
  withFixedRandom(0.05, () => S.tickSmithfolk(dir, night));
  // getBot may never have been called (type gate passes but hour gate fails first? no —
  // type gate passes, then materialization happens, then hour gate). Either way no chat.
  let chats = 0;
  try {
    chats = dir.getBot(rec)._chats.length;
  } catch { /* never materialized */ }
  assert.equal(chats, 0, "silent at 03:00");
  console.log("tick silent outside hours: PASS");
}

// --- pro smith skipped at the type gate before materialization ---
{
  fresh();
  let proU = null;
  for (let i = 0; i < 5000 && !proU; i++) {
    const u = "proskip" + i;
    if (ProSmiths.smithTypeFor(u)) proU = u;
  }
  assert.ok(proU, "found a pro smith");
  const rec = { username: proU, role: "commoner", kingdomId: "misthalin" };
  const real = mockPlayer("Jon", 102, 102, false);
  let materialized = false;
  const dir = {
    roster: new Map([[proU, rec]]),
    isOnline: () => true,
    getBot: () => {
      materialized = true;
      return mockPlayer(proU, 100, 100, true);
    },
  };
  withFixedRandom(0.05, () => S.tickSmithfolk(dir, T0));
  assert.ok(!materialized, "pro smith never materialized (type gate first)");
  console.log("pro smith gate ordering: PASS");
}

// --- never throws on hostile input ---
{
  fresh();
  assert.doesNotThrow(() => S.tickSmithfolk(null, T0));
  assert.doesNotThrow(() => S.tickSmithfolk({}, T0));
  assert.doesNotThrow(() => S.tickSmithfolk({ roster: null }, T0));
  assert.doesNotThrow(() => S.smithfolkTypeOf({ username: {}, role: "commoner" }));
  console.log("never-throws: PASS");
}

// --- pure helpers ---
{
  fresh();
  assert.equal(S.fill("Hi {name}, take {item}.", { name: "Jon", item: "nails" }), "Hi Jon, take nails.");
  assert.equal(S.fill("No slots.", { name: "Jon" }), "No slots.");
  assert.ok(S.hashStr("abc") !== S.hashStr("abd"), "hash differs");
  assert.equal(S.hashStr("abc"), S.hashStr("abc"), "hash stable");
  assert.ok(S.chance(() => 0.1, 0.15), "chance true");
  assert.ok(!S.chance(() => 0.5, 0.15), "chance false");
  console.log("pure helpers: PASS");
}

console.log("ALL CITIZENBLACKSMITHS2 TESTS PASSED");
