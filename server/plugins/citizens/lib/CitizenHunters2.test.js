"use strict";

// CitizenHunters2 unit checks — pure logic, no running server.
// From server/plugins/citizens: node CitizenHunters2.test.js (plain node)
const assert = require("node:assert/strict");
const HF = require("./CitizenHunters2");
const ProHunters = require("./CitizenHunters");

const T0 = new Date(2026, 9, 8, 10, 0).getTime(); // 10:00 local — inside hunt hours
const NIGHT = new Date(2026, 9, 8, 3, 0).getTime(); // 03:00 local — outside hours
const LEDGER_TTL = 7 * 24 * 3600 * 1000;

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
    // Real-API shape (hunters audit 2026-10-08): proximity comes from the bot.
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
/** Director mock — real-API shape: isOnline/getBot (playerFor/onlinePlayers are dead). */
function mockDirector(entries, players) {
  const bots = new Map();
  return {
    roster: new Map(entries.map((r) => [r.username, r])),
    isOnline: (record) => bots.has(record.username),
    getBot: (record) => bots.get(record.username) || null,
    _bots: bots,
  };
}
/** Find a username that passes huntfolkTypeOf (and is not a pro hunter). */
function findHuntfolk(prefix = "hf") {
  for (let i = 0; i < 5000; i++) {
    const rec = { username: prefix + i, role: "commoner", kingdomId: "misthalin" };
    if (HF.huntfolkTypeOf(rec)) return rec;
  }
  throw new Error("no huntfolk username found");
}
/** Find a username that IS a professional hunter. */
function findProHunter(prefix = "proh") {
  for (let i = 0; i < 20000; i++) {
    const u = prefix + i;
    if (ProHunters.hunterTypeFor(u)) return u;
  }
  throw new Error("no pro hunter username found");
}

function fresh() {
  HF._resetState();
}

// --- type weights / roll boundaries ---
{
  fresh();
  assert.equal(HF.huntfolkTypeFromRoll(0), HF.HUNTFOLK_TRACKER);
  assert.equal(HF.huntfolkTypeFromRoll(29), HF.HUNTFOLK_TRACKER);
  assert.equal(HF.huntfolkTypeFromRoll(30), HF.HUNTFOLK_BOWMAN);
  assert.equal(HF.huntfolkTypeFromRoll(59), HF.HUNTFOLK_BOWMAN);
  assert.equal(HF.huntfolkTypeFromRoll(60), HF.HUNTFOLK_TRAPPER);
  assert.equal(HF.huntfolkTypeFromRoll(84), HF.HUNTFOLK_TRAPPER);
  assert.equal(HF.huntfolkTypeFromRoll(85), HF.HUNTFOLK_FALCONER);
  assert.equal(HF.huntfolkTypeFromRoll(99), HF.HUNTFOLK_FALCONER);
  // reachability of all four types over many names
  const seen = new Set();
  for (let i = 0; i < 3000; i++) {
    const t = HF.huntfolkTypeOf({ username: "reach" + i, role: "commoner" });
    if (t) seen.add(t);
  }
  assert.deepEqual([...seen].sort(), [...HF.HUNTFOLK_TYPES].sort(), "all four types reachable");
  console.log("type weights/reachability: PASS");
}

// --- type stability ---
{
  fresh();
  const rec = { username: "StableSue", role: "commoner" };
  const a = HF.huntfolkTypeOf(rec);
  const b = HF.huntfolkTypeOf(rec);
  assert.equal(a, b, "type stable across calls");
  console.log("type stability: PASS");
}

// --- commoner gating ---
{
  fresh();
  assert.equal(HF.huntfolkTypeOf({ username: "GuardGus", role: "guard" }), null, "guards excluded");
  assert.equal(HF.huntfolkTypeOf({ username: "MerchMeg", role: "merchant" }), null, "merchants excluded");
  assert.equal(HF.huntfolkTypeOf({ username: null, role: "commoner" }), null, "no username -> null");
  console.log("commoner gating: PASS");
}

// --- professional hunter exclusion ---
{
  fresh();
  const pro = findProHunter();
  assert.ok(ProHunters.hunterTypeFor(pro), "sanity: test username is a pro hunter");
  assert.equal(
    HF.huntfolkTypeOf({ username: pro, role: "commoner" }),
    null,
    "pro hunters excluded from huntfolk"
  );
  console.log("professional hunter exclusion: PASS");
}

// --- broad distribution (~40% nominal, pros excluded) ---
{
  fresh();
  let count = 0;
  const N = 2000;
  for (let i = 0; i < N; i++) {
    if (HF.huntfolkTypeOf({ username: "dist" + i, role: "commoner" })) count++;
  }
  const share = count / N;
  assert.ok(share > 0.25 && share < 0.5, `share ${share.toFixed(3)} in band`);
  console.log(`broad distribution (${(share * 100).toFixed(1)}%): PASS`);
}

// --- kingdom-preferred grounds ---
{
  fresh();
  const rec = { username: "LocalLad", role: "commoner", kingdomId: "keldagrim" };
  const g = HF.groundFor(rec);
  assert.equal(g.kingdom, "keldagrim", "keldagrim citizen hunts keldagrim ground");
  const rec2 = { username: "LocalLad", role: "commoner", kingdomId: "nowhere" };
  assert.ok(HF.groundFor(rec2).name, "unknown kingdom falls back to all grounds");
  assert.equal(HF.groundFor(rec).name, HF.groundFor(rec).name, "ground stable");
  console.log("kingdom-preferred grounds: PASS");
}

// --- dishForToday removed 2026-10-08: was hash-derived fabrication. ---

// --- ledgers round-trip + TTL expiry ---
{
  fresh();
  assert.equal(HF.joinHunt("Jon", "the Varrock village coppices", T0), "the Varrock village coppices");
  assert.equal(HF.huntFor("Jon", T0 + 1000), "the Varrock village coppices");
  assert.equal(HF.huntFor("Jon", T0 + LEDGER_TTL + 1000), null, "join ledger expires after 7d");
  console.log("join ledger: PASS");
}
{
  fresh();
  assert.equal(HF.buyGame("Jon", "rabbit", 12, T0), "rabbit");
  assert.deepEqual(HF.boughtGameFor("Jon", T0 + 1000), { game: "rabbit", price: 12 });
  assert.equal(HF.boughtGameFor("Jon", T0 + LEDGER_TTL + 1000), null, "buy ledger expires");
  console.log("buy ledger: PASS");
}
{
  fresh();
  assert.equal(HF.learnTracking("Jon", "reading deer sign", T0), "reading deer sign");
  assert.equal(HF.trackingFor("Jon", T0 + 1000), "reading deer sign");
  assert.equal(HF.trackingFor("Jon", T0 + LEDGER_TTL + 1000), null, "learn ledger expires");
  console.log("learn ledger: PASS");
}

// --- hunt hours (local-time constructors per the timezone rule) ---
{
  fresh();
  assert.equal(HF.isHuntHour(new Date(2026, 9, 8, 10, 0).getTime()), true, "10:00 is hunt hour");
  assert.equal(HF.isHuntHour(new Date(2026, 9, 8, 6, 0).getTime()), true, "06:00 boundary");
  assert.equal(HF.isHuntHour(new Date(2026, 9, 8, 19, 59).getTime()), true, "19:59 is hunt hour");
  assert.equal(HF.isHuntHour(new Date(2026, 9, 8, 20, 0).getTime()), false, "20:00 is not");
  assert.equal(HF.isHuntHour(new Date(2026, 9, 8, 3, 0).getTime()), false, "03:00 is not");
  console.log("hunt hours: PASS");
}

// --- guards: isRealPlayer / isCitizenBot / withinTiles ---
{
  fresh();
  assert.equal(HF.isRealPlayer(mockPlayer("RealRon")), true);
  assert.equal(HF.isRealPlayer(mockBot("BotBob")), false);
  assert.equal(HF.isRealPlayer(null), false);
  assert.equal(HF.isCitizenBot(mockBot("BotBob")), true);
  assert.equal(HF.isCitizenBot(mockPlayer("RealRon")), false);
  const a = mockBot("A", 3000, 3000);
  const b = mockPlayer("B", 3005, 3005);
  const far = mockPlayer("C", 3200, 3200);
  assert.equal(HF.withinTiles(a, b, 14), true);
  assert.equal(HF.withinTiles(a, far, 14), false);
  console.log("guards: PASS");
}

// --- tick fires near a real player ---
{
  fresh();
  const rec = findHuntfolk("tickfire");
  const player = mockPlayer("RealRon");
  const players = [player];
  const bot = mockBot(rec.username, 3000, 3000, players);
  players.push(bot);
  const d = mockDirector([rec], players);
  d._bots.set(rec.username, bot);
  withFixedRandom(0.05, () => HF.tickHuntfolk(d, T0));
  assert.ok(bot._chats.length >= 1, "huntfolk chats near a real player");
  console.log("tick fires near real player: PASS");
}

// --- tick silent near bots only ---
{
  fresh();
  const rec = findHuntfolk("tickbot");
  const players = [];
  const bot = mockBot(rec.username, 3000, 3000, players);
  const other = mockBot("BotBob", 3005, 3005, players);
  players.push(bot, other);
  const d = mockDirector([rec], players);
  d._bots.set(rec.username, bot);
  withFixedRandom(0.05, () => HF.tickHuntfolk(d, T0));
  assert.equal(bot._chats.length, 0, "silent when only bots are near");
  console.log("tick silent near bots only: PASS");
}

// --- tick silent outside hunt hours ---
{
  fresh();
  const rec = findHuntfolk("ticknight");
  const player = mockPlayer("RealRon");
  const players = [player];
  const bot = mockBot(rec.username, 3000, 3000, players);
  players.push(bot);
  const d = mockDirector([rec], players);
  d._bots.set(rec.username, bot);
  withFixedRandom(0.05, () => HF.tickHuntfolk(d, NIGHT));
  assert.equal(bot._chats.length, 0, "silent at 03:00");
  console.log("tick silent outside hours: PASS");
}

// --- tick skips professional hunters ---
{
  fresh();
  const pro = findProHunter("tickpro");
  const rec = { username: pro, role: "commoner", kingdomId: "misthalin" };
  const player = mockPlayer("RealRon");
  const players = [player];
  const d = mockDirector([rec], players);
  withFixedRandom(0.05, () => HF.tickHuntfolk(d, T0));
  assert.equal(d._bots.size, 0, "no bot engaged — pro skipped at the type gate");
  console.log("tick skips pro hunter: PASS");
}

// --- tick journals kind:work entries (dead journalize fixed by the audit) ---
{
  fresh();
  const { getJournal } = require("./CitizenJournal");
  getJournal().resetForTests();
  const rec = findHuntfolk("tickjournal");
  const player = mockPlayer("RealRon");
  const players = [player];
  const bot = mockBot(rec.username, 3000, 3000, players);
  players.push(bot);
  const d = mockDirector([rec], players);
  d._bots.set(rec.username, bot);
  withFixedRandom(0.05, () => HF.tickHuntfolk(d, T0));
  const events = getJournal().recent(rec.username, 10);
  assert.ok(events.some((e) => e.kind === "work"), "journal holds kind:work for huntfolk");
  const ground = HF.groundFor(rec);
  assert.ok(events.some((e) => e.kind === "work" && e.text.includes(ground.name)),
    "work loop journals the kingdom-preferred ground");
  console.log("tick journals work: PASS");
}


// --- never throws on hostile input ---
{
  fresh();
  assert.doesNotThrow(() => HF.tickHuntfolk(null, T0), "null director");
  assert.doesNotThrow(() => HF.tickHuntfolk({}, T0), "empty director");
  assert.doesNotThrow(() => HF.tickHuntfolk({ roster: null }, T0), "null roster");
  assert.doesNotThrow(() => HF.huntfolkTypeOf(null), "null record");
  console.log("never-throws: PASS");
}

// --- pure helpers ---
{
  fresh();
  assert.equal(HF.fill("Bagged {game} at {ground}!", { game: "rabbit", ground: "the meadows" }),
    "Bagged rabbit at the meadows!");
  assert.equal(HF.fill("No tokens.", {}), "No tokens.");
  const rng = HF.seededRng(42);
  assert.ok(rng() >= 0 && rng() < 1, "seeded rng in range");
  assert.equal(HF.chance(() => 0.1, 0.15), true);
  assert.equal(HF.chance(() => 0.2, 0.15), false);
  assert.equal(HF.hashStr("x"), HF.hashStr("x"), "hash deterministic");
  assert.equal(HF.dayNumber(86400000 * 3), 3);
  console.log("pure helpers: PASS");
}

console.log("ALL CITIZENHUNTERS2 TESTS PASSED");
