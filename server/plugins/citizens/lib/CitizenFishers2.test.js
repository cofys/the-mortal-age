"use strict";

// CitizenFishers2 unit checks — pure logic, no running server.
// From server/plugins/citizens: node CitizenFishers2.test.js (plain node)
const assert = require("node:assert/strict");
const FF = require("./CitizenFishers2");
const ProFishers = require("./CitizenFishers");

const T0 = new Date(2026, 9, 8, 10, 0).getTime(); // 10:00 local — inside fishing hours
const NIGHT = new Date(2026, 9, 8, 3, 0).getTime(); // 03:00 local — outside hours

/** Stub Math.random for a block; always restores. */
function withFixedRandom(value, fn) {
  const orig = Math.random;
  Math.random = () => value;
  try {
    return fn();
  } finally {
    Math.random = orig;
  }
}

function loc(x, y, z = 0) {
  return { getX: () => x, getY: () => y, getZ: () => z };
}
// Real engine API: Player.getLocalPlayers() (Player.ts:796). The director
// mock uses the canonical isOnline/getBot; nearby players come from the bot.
function mockBot(name, x = 3000, y = 3000, localPlayers = []) {
  const chats = [];
  return {
    getUsername: () => name,
    isPlayerBot: () => true,
    getHostAddress: () => "bot",
    getLocation: () => loc(x, y),
    getLocalPlayers: () => localPlayers,
    forceChat: (m) => chats.push(m),
    _chats: chats,
  };
}
function mockPlayer(name, x = 3005, y = 3005) {
  return {
    getUsername: () => name,
    isPlayerBot: () => false,
    getHostAddress: () => "127.0.0.1",
    getLocation: () => loc(x, y),
  };
}
function mockDirector(entries) {
  const bots = new Map();
  return {
    roster: new Map(entries.map((r) => [r.username, r])),
    isOnline: (record) => bots.has(record.username),
    getBot: (record) => bots.get(record.username) || null,
    _bots: bots,
  };
}
/** Find a username that passes fisherfolkTypeOf (and is not a pro fisher). */
function findFisherfolk(prefix = "ff") {
  for (let i = 0; i < 5000; i++) {
    const rec = { username: prefix + i, role: "commoner", kingdomId: "misthalin" };
    if (FF.fisherfolkTypeOf(rec)) return rec;
  }
  throw new Error("no fisherfolk username found");
}
/** Find a username that IS a professional fisher. */
function findProFisher(prefix = "pro") {
  for (let i = 0; i < 20000; i++) {
    const u = prefix + i;
    if (ProFishers.fisherTypeFor(u)) return u;
  }
  throw new Error("no pro fisher username found");
}

function fresh() {
  FF._resetState();
}

// --- type weights / roll boundaries ---
{
  fresh();
  assert.equal(FF.fisherfolkTypeFromRoll(0), FF.FISHERFOLK_NET);
  assert.equal(FF.fisherfolkTypeFromRoll(29), FF.FISHERFOLK_NET);
  assert.equal(FF.fisherfolkTypeFromRoll(30), FF.FISHERFOLK_LINE);
  assert.equal(FF.fisherfolkTypeFromRoll(64), FF.FISHERFOLK_LINE);
  assert.equal(FF.fisherfolkTypeFromRoll(65), FF.FISHERFOLK_CRAB);
  assert.equal(FF.fisherfolkTypeFromRoll(84), FF.FISHERFOLK_CRAB);
  assert.equal(FF.fisherfolkTypeFromRoll(85), FF.FISHERFOLK_STALL);
  assert.equal(FF.fisherfolkTypeFromRoll(99), FF.FISHERFOLK_STALL);
  // reachability of all four types over many names
  const seen = new Set();
  for (let i = 0; i < 3000; i++) {
    const t = FF.fisherfolkTypeOf({ username: "reach" + i, role: "commoner" });
    if (t) seen.add(t);
  }
  assert.deepEqual([...seen].sort(), [...FF.FISHERFOLK_TYPES].sort(), "all four types reachable");
  console.log("type weights/reachability: PASS");
}

// --- type stability ---
{
  fresh();
  const rec = { username: "StableSam", role: "commoner" };
  const a = FF.fisherfolkTypeOf(rec);
  const b = FF.fisherfolkTypeOf(rec);
  assert.equal(a, b, "type stable across calls");
  console.log("type stability: PASS");
}

// --- commoner gating ---
{
  fresh();
  assert.equal(FF.fisherfolkTypeOf({ username: "GuardGus", role: "guard" }), null, "guards excluded");
  assert.equal(FF.fisherfolkTypeOf({ username: "MerchMeg", role: "merchant" }), null, "merchants excluded");
  assert.equal(FF.fisherfolkTypeOf({ username: null, role: "commoner" }), null, "no username -> null");
  console.log("commoner gating: PASS");
}

// --- professional fisher exclusion ---
{
  fresh();
  const pro = findProFisher();
  assert.ok(ProFishers.fisherTypeFor(pro), "sanity: test username is a pro fisher");
  assert.equal(
    FF.fisherfolkTypeOf({ username: pro, role: "commoner" }),
    null,
    "professional fishers are excluded from the dockside folk"
  );
  console.log("pro-fisher exclusion: PASS");
}

// --- broad distribution (~45% nominal, pros excluded) ---
{
  fresh();
  let n = 0;
  const N = 2000;
  for (let i = 0; i < N; i++) {
    if (FF.fisherfolkTypeOf({ username: "dist" + i, role: "commoner" })) n++;
  }
  const pct = (n / N) * 100;
  assert.ok(pct > 30 && pct < 55, `share ${pct.toFixed(1)}% within expected band`);
  console.log(`broad distribution: PASS (${pct.toFixed(1)}%)`);
}

// --- kingdom-preferred spots ---
{
  fresh();
  const rec = findFisherfolk("spot");
  const s1 = FF.spotFor({ ...rec, kingdomId: "asgarnia" });
  const s2 = FF.spotFor({ ...rec, kingdomId: "asgarnia" });
  assert.equal(s1.name, s2.name, "spot stable for record");
  assert.equal(s1.kingdom, "asgarnia", "kingdom-preferred spot");
  const any = FF.spotFor({ username: "SpotSam", kingdomId: "unknown-land" });
  assert.ok(any && any.name, "falls back to all spots");
  console.log("kingdom-preferred spots: PASS");
}

// --- catch determinism + day variance ---
{
  fresh();
  const rec = findFisherfolk("catch");
  const spot = FF.spotFor(rec);
  const type = FF.fisherfolkTypeOf(rec);
  const c1 = FF.catchFor(rec.username, type, spot, T0);
  const c2 = FF.catchFor(rec.username, type, spot, T0);
  assert.deepEqual(c1, c2, "catch deterministic for day");
  assert.ok(c1.length >= 1 && c1.length <= 3, "1-3 fish");
  const c3 = FF.catchFor(rec.username, type, spot, T0 + 86400000 * 3);
  // day variance is probabilistic; just assert shape, not difference
  assert.ok(Array.isArray(c3) && c3.length >= 1, "catch valid on another day");
  console.log("catch determinism: PASS");
}

// --- crabbers catch crabs ---
{
  fresh();
  assert.deepEqual(FF.catchPoolFor(FF.FISHERFOLK_CRAB, "sea"), FF.CRAB_CATCHES);
  const pool = FF.catchPoolFor(FF.FISHERFOLK_LINE, "river");
  assert.ok(pool.includes("trout") || pool.includes("salmon"), "river pool from pro tables");
  console.log("crabber pools: PASS");
}

// --- big catch determinism + rarity ---
{
  fresh();
  const spot = FF.COMMUNITY_SPOTS[0];
  let hits = 0;
  const DAYS = 200;
  for (let d = 0; d < DAYS; d++) {
    const b = FF.bigCatchFor(spot, T0 + d * 86400000);
    if (b) {
      hits++;
      assert.ok(b.weightKg >= 4 && b.weightKg <= 15, "weight in band");
      assert.ok(typeof b.fish === "string" && b.fish.length > 0, "fish named");
    }
  }
  const pct = (hits / DAYS) * 100;
  assert.ok(pct > 2 && pct < 20, `big-catch rate ${pct.toFixed(1)}% near 8%`);
  assert.deepEqual(FF.bigCatchFor(spot, T0), FF.bigCatchFor(spot, T0), "big catch deterministic");
  console.log(`big catch: PASS (${pct.toFixed(1)}%)`);
}

// --- ledgers round-trip + TTL expiry ---
{
  fresh();
  const now = T0;
  assert.equal(FF.fishAlongside("Jon", "Finn", now), "Finn");
  assert.equal(FF.fishAlongFor("Jon", now + 1000), "Finn");
  assert.equal(FF.fishAlongFor("Jon", now + 8 * 86400000), null, "fish-along expires after 7d");
  console.log("fish-along ledger: PASS");
}
{
  fresh();
  const now = T0;
  assert.equal(FF.buyCatch("Jon", "bass", 12, now), "bass");
  assert.deepEqual(FF.boughtCatchFor("Jon", now + 1000), { fish: "bass", price: 12 });
  assert.equal(FF.boughtCatchFor("Jon", now + 8 * 86400000), null, "buy ledger expires");
  console.log("buy-catch ledger: PASS");
}
{
  fresh();
  const now = T0;
  assert.equal(FF.learnTechnique("Jon", "Watch the float.", now), "Watch the float.");
  assert.equal(FF.techniqueFor("Jon", now + 1000), "Watch the float.");
  assert.equal(FF.techniqueFor("Jon", now + 8 * 86400000), null, "technique ledger expires");
  console.log("technique ledger: PASS");
}

// --- fishing hours (local-time constructors per the timezone rule) ---
{
  fresh();
  assert.equal(FF.isFishingHour(new Date(2026, 9, 8, 5, 0).getTime()), true, "05:00 is open");
  assert.equal(FF.isFishingHour(new Date(2026, 9, 8, 12, 0).getTime()), true, "noon is open");
  assert.equal(FF.isFishingHour(new Date(2026, 9, 8, 19, 59).getTime()), true, "19:59 is open");
  assert.equal(FF.isFishingHour(new Date(2026, 9, 8, 20, 0).getTime()), false, "20:00 is closed");
  assert.equal(FF.isFishingHour(new Date(2026, 9, 8, 4, 59).getTime()), false, "04:59 is closed");
  assert.equal(FF.isFishingHour(NIGHT), false, "03:00 is closed");
  console.log("fishing hours: PASS");
}

// --- guards ---
{
  fresh();
  assert.equal(FF.isRealPlayer(null), false);
  assert.equal(FF.isRealPlayer(mockBot("B")), false, "bots are not real players");
  assert.equal(FF.isRealPlayer(mockPlayer("Jon")), true);
  assert.equal(FF.isCitizenBot(mockBot("B")), true);
  assert.equal(FF.isCitizenBot(mockPlayer("Jon")), false);
  const a = mockPlayer("A", 3000, 3000);
  const b = mockPlayer("B", 3010, 3010);
  const c = mockPlayer("C", 3200, 3200);
  assert.equal(FF.withinTiles(a, b, 14), true);
  assert.equal(FF.withinTiles(a, c, 14), false);
  console.log("guards: PASS");
}

// --- tick fires near a real player ---
{
  fresh();
  const rec = findFisherfolk("fire");
  const bot = mockBot(rec.username, 3000, 3000, [mockPlayer("Jon", 3005, 3005)]);
  const d = mockDirector([rec]);
  d._bots.set(rec.username, bot);
  withFixedRandom(0.1, () => FF.tickFisherfolk(d, T0));
  assert.equal(bot._chats.length, 1, "citizen speaks once near a real player");
  assert.ok(bot._chats[0].length > 0, "line is non-empty");
  console.log("tick fires near real player: PASS");
}

// --- tick silent near bots only ---
{
  fresh();
  const rec = findFisherfolk("quiet");
  const bot = mockBot(rec.username, 3000, 3000, [mockBot("OtherBot", 3005, 3005)]);
  const d = mockDirector([rec]);
  d._bots.set(rec.username, bot);
  withFixedRandom(0.1, () => FF.tickFisherfolk(d, T0));
  assert.equal(bot._chats.length, 0, "silent when only bots are near");
  console.log("tick silent near bots only: PASS");
}

// --- tick silent outside fishing hours ---
{
  fresh();
  const rec = findFisherfolk("night");
  const bot = mockBot(rec.username, 3000, 3000, [mockPlayer("Jon", 3005, 3005)]);
  const d = mockDirector([rec]);
  d._bots.set(rec.username, bot);
  withFixedRandom(0.1, () => FF.tickFisherfolk(d, NIGHT));
  assert.equal(bot._chats.length, 0, "silent at 03:00");
  console.log("tick silent outside hours: PASS");
}

// --- tick skips professional fishers ---
{
  fresh();
  const pro = findProFisher("proskip");
  const rec = { username: pro, role: "commoner", kingdomId: "kandarin" };
  const bot = mockBot(pro, 3000, 3000, [mockPlayer("Jon", 3005, 3005)]);
  const d = mockDirector([rec]);
  d._bots.set(pro, bot);
  withFixedRandom(0.1, () => FF.tickFisherfolk(d, T0));
  assert.equal(bot._chats.length, 0, "pro fisher never fires the folk tick");
  console.log("tick skips pro fishers: PASS");
}

// --- never throws on hostile input ---
{
  fresh();
  FF.tickFisherfolk(null, T0);
  FF.tickFisherfolk({}, T0);
  FF.tickFisherfolk({ roster: null }, T0);
  assert.equal(FF.fisherfolkTypeOf(null), null);
  assert.equal(FF.fisherfolkTypeOf({}), null);
  console.log("never-throws: PASS");
}

// --- fill / hash helpers ---
{
  fresh();
  assert.equal(FF.fill("Hello {name}, nice {fish}.", { name: "Jon", fish: "bass" }), "Hello Jon, nice bass.");
  assert.equal(FF.hashStr("x"), FF.hashStr("x"), "hash deterministic");
  assert.ok(FF.priceFor("bass", T0) >= 5 && FF.priceFor("bass", T0) <= 40, "price in band");
  console.log("helpers: PASS");
}

console.log("ALL CITIZENFISHERS2 TESTS PASSED");
