"use strict";

// CitizenMiners2 unit checks — pure logic, no running server.
// From server/plugins/citizens: node CitizenMiners2.test.js (plain node)
const assert = require("node:assert/strict");
const MF = require("./CitizenMiners2");
const ProMiners = require("./CitizenMiners");

const T0 = new Date(2026, 9, 8, 10, 0).getTime(); // 10:00 local — inside mine hours
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
function mockBot(name, x = 3000, y = 3000, players = []) {
  const chats = [];
  return {
    getUsername: () => name,
    isPlayerBot: () => true,
    getHostAddress: () => "bot",
    getLocation: () => loc(x, y),
    getLocalPlayers: () => players,
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
function mockDirector(entries, players) {
  const bots = new Map();
  // Real director API shape: isOnline(record) + getBot(record)
  // (CitizenDirector.js:1374/1379). director.playerFor/onlinePlayers do NOT
  // exist — mocks must not codify them.
  return {
    roster: new Map(entries.map((r) => [r.username, r])),
    isOnline: (record) => bots.has(record.username),
    getBot: (record) => bots.get(record.username) || null,
    _bots: bots,
    _players: players,
  };
}
/** Find a username that passes minerfolkTypeOf (and is not a pro miner). */
function findMinerfolk(prefix = "mf") {
  for (let i = 0; i < 5000; i++) {
    const rec = { username: prefix + i, role: "commoner", kingdomId: "misthalin" };
    if (MF.minerfolkTypeOf(rec)) return rec;
  }
  throw new Error("no minerfolk username found");
}
/** Find a username that IS a professional miner. */
function findProMiner(prefix = "prom") {
  for (let i = 0; i < 20000; i++) {
    const u = prefix + i;
    if (ProMiners.minerTypeFor(u)) return u;
  }
  throw new Error("no pro miner username found");
}

function fresh() {
  MF._resetState();
}

// --- type weights / roll boundaries ---
{
  fresh();
  assert.equal(MF.minerfolkTypeFromRoll(0), MF.MINERFOLK_PROSPECTOR);
  assert.equal(MF.minerfolkTypeFromRoll(29), MF.MINERFOLK_PROSPECTOR);
  assert.equal(MF.minerfolkTypeFromRoll(30), MF.MINERFOLK_DIGGER);
  assert.equal(MF.minerfolkTypeFromRoll(64), MF.MINERFOLK_DIGGER);
  assert.equal(MF.minerfolkTypeFromRoll(65), MF.MINERFOLK_CARRIER);
  assert.equal(MF.minerfolkTypeFromRoll(84), MF.MINERFOLK_CARRIER);
  assert.equal(MF.minerfolkTypeFromRoll(85), MF.MINERFOLK_GEMHUNTER);
  assert.equal(MF.minerfolkTypeFromRoll(99), MF.MINERFOLK_GEMHUNTER);
  // reachability of all four types over many names
  const seen = new Set();
  for (let i = 0; i < 3000; i++) {
    const t = MF.minerfolkTypeOf({ username: "reach" + i, role: "commoner" });
    if (t) seen.add(t);
  }
  assert.deepEqual([...seen].sort(), [...MF.MINERFOLK_TYPES].sort(), "all four types reachable");
  console.log("type weights/reachability: PASS");
}

// --- type stability ---
{
  fresh();
  const rec = { username: "StableSue", role: "commoner" };
  const a = MF.minerfolkTypeOf(rec);
  const b = MF.minerfolkTypeOf(rec);
  assert.equal(a, b, "type stable across calls");
  console.log("type stability: PASS");
}

// --- commoner gating ---
{
  fresh();
  assert.equal(MF.minerfolkTypeOf({ username: "GuardGus", role: "guard" }), null, "guards excluded");
  assert.equal(MF.minerfolkTypeOf({ username: "MerchMeg", role: "merchant" }), null, "merchants excluded");
  assert.equal(MF.minerfolkTypeOf({ username: null, role: "commoner" }), null, "no username -> null");
  console.log("commoner gating: PASS");
}

// --- professional miner exclusion ---
{
  fresh();
  const pro = findProMiner();
  assert.ok(ProMiners.minerTypeFor(pro), "sanity: test username is a pro miner");
  assert.equal(
    MF.minerfolkTypeOf({ username: pro, role: "commoner" }),
    null,
    "professional miners are excluded from the mining folk"
  );
  console.log("pro-miner exclusion: PASS");
}

// --- broad distribution (~40% nominal, pros excluded) ---
{
  fresh();
  let n = 0;
  const N = 2000;
  for (let i = 0; i < N; i++) {
    if (MF.minerfolkTypeOf({ username: "dist" + i, role: "commoner" })) n++;
  }
  const pct = (n / N) * 100;
  assert.ok(pct > 25 && pct < 50, `share ${pct.toFixed(1)}% within expected band`);
  console.log(`broad distribution: PASS (${pct.toFixed(1)}%)`);
}

// --- kingdom-preferred claims ---
{
  fresh();
  const rec = findMinerfolk("claim");
  const c1 = MF.claimFor({ ...rec, kingdomId: "asgarnia" });
  const c2 = MF.claimFor({ ...rec, kingdomId: "asgarnia" });
  assert.equal(c1.name, c2.name, "claim stable for record");
  assert.equal(c1.kingdom, "asgarnia", "kingdom-preferred claim");
  const any = MF.claimFor({ username: "ClaimCam", kingdomId: "unknown-land" });
  assert.ok(any && any.name, "falls back to all claims");
  console.log("kingdom-preferred claims: PASS");
}

// --- finds determinism ---
{
  fresh();
  const rec = findMinerfolk("find");
  const type = MF.minerfolkTypeOf(rec);
  const f1 = MF.findsFor(rec.username, type, T0);
  const f2 = MF.findsFor(rec.username, type, T0);
  assert.deepEqual(f1, f2, "finds deterministic for day");
  assert.ok(f1.length >= 1 && f1.length <= 3, "1-3 finds");
  const f3 = MF.findsFor(rec.username, type, T0 + 86400000 * 3);
  assert.ok(Array.isArray(f3) && f3.length >= 1, "finds valid on another day");
  console.log("finds determinism: PASS");
}

// --- gem hunters find gems ---
{
  fresh();
  const gems = [];
  for (let i = 0; i < 200; i++) {
    const f = MF.findsFor("gemhunt" + i, MF.MINERFOLK_GEMHUNTER, T0);
    gems.push(...f);
  }
  assert.ok(gems.every((g) => MF.GEMS.includes(g)), "gem-hunter finds are real gem names");
  const ores = MF.findsFor("diggary" + 1, MF.MINERFOLK_DIGGER, T0);
  assert.ok(ores.every((o) => MF.ORES.includes(o)), "digger finds are real ore names");
  console.log("gem/ore pools: PASS");
}

// --- strike determinism + rarity ---
{
  fresh();
  const claim = MF.COMMUNITY_CLAIMS[0];
  let hits = 0;
  const DAYS = 200;
  for (let d = 0; d < DAYS; d++) {
    const s = MF.strikeFor(claim, T0 + d * 86400000);
    if (s) {
      hits++;
      assert.ok(MF.ORES.includes(s.ore), "strike ore is a real ore");
    }
  }
  const pct = (hits / DAYS) * 100;
  assert.ok(pct > 2 && pct < 20, `strike rate ${pct.toFixed(1)}% near 8%`);
  assert.deepEqual(MF.strikeFor(claim, T0), MF.strikeFor(claim, T0), "strike deterministic");
  console.log(`rich-vein strike: PASS (${pct.toFixed(1)}%)`);
}

// --- ledgers round-trip + TTL expiry ---
{
  fresh();
  const now = T0;
  assert.equal(MF.stakeClaim("Jon", "the Varrock copper diggings", now), "the Varrock copper diggings");
  assert.equal(MF.claimForPlayer("Jon", now + 1000), "the Varrock copper diggings");
  assert.equal(MF.claimForPlayer("Jon", now + 8 * 86400000), null, "stake ledger expires after 7d");
  console.log("stake ledger: PASS");
}
{
  fresh();
  const now = T0;
  assert.equal(MF.hireMiner("Jon", "DiggerDan", now), "DiggerDan");
  assert.equal(MF.hiredMinerFor("Jon", now + 1000), "DiggerDan");
  assert.equal(MF.hiredMinerFor("Jon", now + 8 * 86400000), null, "hire ledger expires");
  console.log("hire ledger: PASS");
}
{
  fresh();
  const now = T0;
  assert.equal(MF.buyOre("Jon", "iron", 20, now), "iron");
  assert.deepEqual(MF.boughtOreFor("Jon", now + 1000), { ore: "iron", price: 20 });
  assert.equal(MF.boughtOreFor("Jon", now + 8 * 86400000), null, "buy-ore ledger expires");
  console.log("buy-ore ledger: PASS");
}

// --- mine hours (local-time constructors per the timezone rule) ---
{
  fresh();
  assert.equal(MF.isMineHour(new Date(2026, 9, 8, 6, 0).getTime()), true, "06:00 is open");
  assert.equal(MF.isMineHour(new Date(2026, 9, 8, 12, 0).getTime()), true, "noon is open");
  assert.equal(MF.isMineHour(new Date(2026, 9, 8, 19, 59).getTime()), true, "19:59 is open");
  assert.equal(MF.isMineHour(new Date(2026, 9, 8, 20, 0).getTime()), false, "20:00 is closed");
  assert.equal(MF.isMineHour(new Date(2026, 9, 8, 5, 59).getTime()), false, "05:59 is closed");
  assert.equal(MF.isMineHour(NIGHT), false, "03:00 is closed");
  console.log("mine hours: PASS");
}

// --- guards ---
{
  fresh();
  assert.equal(MF.isRealPlayer(null), false);
  assert.equal(MF.isRealPlayer(mockBot("B")), false, "bots are not real players");
  assert.equal(MF.isRealPlayer(mockPlayer("Jon")), true);
  assert.equal(MF.isCitizenBot(mockBot("B")), true);
  assert.equal(MF.isCitizenBot(mockPlayer("Jon")), false);
  const a = mockPlayer("A", 3000, 3000);
  const b = mockPlayer("B", 3010, 3010);
  const c = mockPlayer("C", 3200, 3200);
  assert.equal(MF.withinTiles(a, b, 14), true);
  assert.equal(MF.withinTiles(a, c, 14), false);
  console.log("guards: PASS");
}

// --- tick fires near a real player ---
{
  fresh();
  const rec = findMinerfolk("fire");
  const player = mockPlayer("Jon", 3005, 3005);
  const bot = mockBot(rec.username, 3000, 3000, [player]);
  const d = mockDirector([rec], [player]);
  d._bots.set(rec.username, bot);
  withFixedRandom(0.1, () => MF.tickMinerfolk(d, T0));
  assert.equal(bot._chats.length, 1, "citizen speaks once near a real player");
  assert.ok(bot._chats[0].length > 0, "line is non-empty");
  console.log("tick fires near real player: PASS");
}

// --- tick silent near bots only ---
{
  fresh();
  const rec = findMinerfolk("quiet");
  const other = mockBot("OtherBot", 3005, 3005);
  const bot = mockBot(rec.username, 3000, 3000, [other]);
  const d = mockDirector([rec], [other]);
  d._bots.set(rec.username, bot);
  withFixedRandom(0.1, () => MF.tickMinerfolk(d, T0));
  assert.equal(bot._chats.length, 0, "silent when only bots are near");
  console.log("tick silent near bots only: PASS");
}

// --- tick silent outside mine hours ---
{
  fresh();
  const rec = findMinerfolk("night");
  const player = mockPlayer("Jon", 3005, 3005);
  const bot = mockBot(rec.username, 3000, 3000, [player]);
  const d = mockDirector([rec], [player]);
  d._bots.set(rec.username, bot);
  withFixedRandom(0.1, () => MF.tickMinerfolk(d, NIGHT));
  assert.equal(bot._chats.length, 0, "silent at 03:00");
  console.log("tick silent outside hours: PASS");
}

// --- tick skips professional miners ---
{
  fresh();
  const pro = findProMiner("proskip");
  const rec = { username: pro, role: "commoner", kingdomId: "keldagrim" };
  const bot = mockBot(pro, 3000, 3000);
  const player = mockPlayer("Jon", 3005, 3005);
  const d = mockDirector([rec], [player]);
  d._bots.set(pro, bot);
  withFixedRandom(0.1, () => MF.tickMinerfolk(d, T0));
  assert.equal(bot._chats.length, 0, "pro miner never fires the folk tick");
  console.log("tick skips pro miners: PASS");
}

// --- never throws on hostile input ---
{
  fresh();
  MF.tickMinerfolk(null, T0);
  MF.tickMinerfolk({}, T0);
  MF.tickMinerfolk({ roster: null }, T0);
  assert.equal(MF.minerfolkTypeOf(null), null);
  assert.equal(MF.minerfolkTypeOf({}), null);
  console.log("never-throws: PASS");
}

// --- fill / hash helpers ---
{
  fresh();
  assert.equal(MF.fill("Strike! {ore} at {claim}.", { ore: "iron", claim: "diggings" }), "Strike! iron at diggings.");
  assert.equal(MF.hashStr("x"), MF.hashStr("x"), "hash deterministic");
  const p = MF.priceFor("adamant", T0);
  assert.ok(p >= 54 && p <= 70, `adamant price ${p} scales with rarity`);
  console.log("helpers: PASS");
}

console.log("ALL CITIZENMINERS2 TESTS PASSED");
