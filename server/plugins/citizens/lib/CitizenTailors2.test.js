"use strict";

// CitizenTailors2 unit checks — pure logic, no running server.
// From server/plugins/citizens: node CitizenTailors2.test.js (plain node)
const assert = require("node:assert/strict");
const SF = require("./CitizenTailors2");
const ProTailors = require("./CitizenTailors");

const T0 = new Date(2026, 9, 8, 10, 0).getTime(); // 10:00 local — inside sew hours
const NIGHT = new Date(2026, 9, 8, 3, 0).getTime(); // 03:00 local — outside hours
const LATE = new Date(2026, 9, 8, 22, 0).getTime(); // 22:00 local — outside hours

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
function mockBot(name, x = 3000, y = 3000) {
  const chats = [];
  return {
    getUsername: () => name,
    isPlayerBot: () => true,
    getHostAddress: () => "bot",
    getLocation: () => loc(x, y),
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
  return {
    roster: new Map(entries.map((r) => [r.username, r])),
    playerFor: (record) => bots.get(record.username) || null,
    onlinePlayers: () => players,
    _bots: bots,
  };
}
/** Find a username that passes sewfolkTypeOf (and is not a pro tailor). */
function findSewfolk(prefix = "sf") {
  for (let i = 0; i < 5000; i++) {
    const rec = { username: prefix + i, role: "commoner", kingdomId: "misthalin" };
    if (SF.sewfolkTypeOf(rec)) return rec;
  }
  throw new Error("no sewfolk username found");
}
/** Find a username that IS a professional tailor. */
function findProTailor(prefix = "prot") {
  for (let i = 0; i < 20000; i++) {
    const u = prefix + i;
    if (ProTailors.tailorTypeFor(u)) return u;
  }
  throw new Error("no pro tailor username found");
}
/** Find a sewfolk username of a specific type. */
function findSewfolkOf(type, prefix = "sft") {
  for (let i = 0; i < 8000; i++) {
    const rec = { username: prefix + type + i, role: "commoner", kingdomId: "misthalin" };
    if (SF.sewfolkTypeOf(rec) === type) return rec;
  }
  throw new Error("no " + type + " username found");
}

function fresh() {
  SF._resetState();
}

// --- type weights / roll boundaries ---
{
  fresh();
  assert.equal(SF.sewfolkTypeFromRoll(0), SF.SEWFOLK_SEAMSTRESS);
  assert.equal(SF.sewfolkTypeFromRoll(29), SF.SEWFOLK_SEAMSTRESS);
  assert.equal(SF.sewfolkTypeFromRoll(30), SF.SEWFOLK_QUILTER);
  assert.equal(SF.sewfolkTypeFromRoll(54), SF.SEWFOLK_QUILTER);
  assert.equal(SF.sewfolkTypeFromRoll(55), SF.SEWFOLK_PATTERN);
  assert.equal(SF.sewfolkTypeFromRoll(79), SF.SEWFOLK_PATTERN);
  assert.equal(SF.sewfolkTypeFromRoll(80), SF.SEWFOLK_DYER);
  assert.equal(SF.sewfolkTypeFromRoll(99), SF.SEWFOLK_DYER);
  for (const t of SF.SEWFOLK_TYPES) assert.ok(SF.SEWFOLK_TYPES.includes(t));
  console.log("type weights: PASS");
}

// --- stability: same record always gets the same type ---
{
  fresh();
  const rec = findSewfolk("stab");
  const t1 = SF.sewfolkTypeOf(rec);
  for (let i = 0; i < 5; i++) assert.equal(SF.sewfolkTypeOf(rec), t1);
  assert.ok(t1, "record resolves to a type");
  console.log("stability: PASS");
}

// --- all four types reachable ---
{
  fresh();
  const seen = new Set();
  for (let i = 0; i < 20000 && seen.size < 4; i++) {
    const rec = { username: "reach" + i, role: "commoner", kingdomId: "misthalin" };
    const t = SF.sewfolkTypeOf(rec);
    if (t) seen.add(t);
  }
  assert.equal(seen.size, 4, "all four types reachable");
  console.log("type reachability: PASS");
}

// --- commoner gating ---
{
  fresh();
  const guard = { username: findSewfolk("gate").username, role: "guard", kingdomId: "misthalin" };
  assert.equal(SF.sewfolkTypeOf(guard), null, "guards never sew");
  const merchant = { username: findSewfolk("gate2").username, role: "merchant", kingdomId: "misthalin" };
  assert.equal(SF.sewfolkTypeOf(merchant), null, "merchants never sew");
  assert.equal(SF.sewfolkTypeOf({ role: "commoner" }), null, "no username means no type");
  console.log("commoner gating: PASS");
}

// --- professional tailor exclusion (verified against the REAL module) ---
{
  fresh();
  const proName = findProTailor("protail");
  const proRec = { username: proName, role: "commoner", kingdomId: "misthalin" };
  assert.ok(ProTailors.tailorTypeFor(proName), "sanity: name is a pro tailor");
  assert.equal(SF.sewfolkTypeOf(proRec), null, "pro tailors excluded from sewfolk");
  console.log("pro-tailor exclusion: PASS");
}

// --- broad distribution (~40% band) ---
{
  fresh();
  let hits = 0;
  const N = 3000;
  for (let i = 0; i < N; i++) {
    const rec = { username: "dist" + i, role: "commoner", kingdomId: "misthalin" };
    if (SF.sewfolkTypeOf(rec)) hits++;
  }
  const pct = hits / N;
  assert.ok(pct > 0.25 && pct < 0.5, `distribution ${pct} in band`);
  console.log(`distribution: PASS (${(pct * 100).toFixed(1)}%)`);
}

// --- kingdom-preferred circles ---
{
  fresh();
  const rec = findSewfolk("circ");
  rec.kingdomId = "asgarnia";
  const c1 = SF.circleFor(rec);
  assert.equal(c1.kingdom, "asgarnia", "prefers own kingdom");
  const rec2 = { username: "circx1", kingdomId: "no-such-kingdom", role: "commoner" };
  assert.ok(SF.circleFor(rec2), "unknown kingdom falls back to full pool");
  const same = SF.circleFor(rec);
  assert.equal(same.name, c1.name, "circle stable across calls");
  console.log("circles: PASS");
}

// --- project determinism + day variance ---
{
  fresh();
  const p1 = SF.projectsFor("projt", "misthalin", T0);
  const p2 = SF.projectsFor("projt", "misthalin", T0);
  assert.deepEqual(p1, p2, "projects deterministic same day");
  assert.ok(p1.length >= 1 && p1.length <= 3, "1-3 projects");
  let varied = false;
  for (let d = 0; d < 10; d++) {
    const pd = SF.projectsFor("projt", "misthalin", T0 + d * 86400000);
    if (JSON.stringify(pd) !== JSON.stringify(p1)) { varied = true; break; }
  }
  assert.ok(varied, "projects vary across days");
  console.log("projects: PASS");
}

// --- garment pool is real (or sane fallback) ---
{
  fresh();
  const pool = SF.garmentPool();
  assert.ok(Array.isArray(pool) && pool.length >= 4, "garment pool non-empty");
  for (const g of pool) assert.equal(typeof g, "string");
  console.log("garment pool: PASS");
}

// --- dye determinism + herb tie-in ---
{
  fresh();
  const d1 = SF.dyeForToday("dyet", "misthalin", T0);
  const d2 = SF.dyeForToday("dyet", "misthalin", T0);
  assert.deepEqual(d1, d2, "dye deterministic same day");
  assert.ok(d1.name && d1.plant, "dye has color and plant");
  let varied = false;
  for (let d = 0; d < 10; d++) {
    const dd = SF.dyeForToday("dyet", "misthalin", T0 + d * 86400000);
    if (dd.name !== d1.name || dd.plant !== d1.plant) { varied = true; break; }
  }
  assert.ok(varied, "dye varies across days");
  console.log("dye: PASS");
}

// --- quilt determinism + rarity ---
{
  fresh();
  const circle = { name: "the Varrock kitchen-table circle", kingdom: "misthalin" };
  const q1 = SF.quiltFor(circle, T0);
  const q2 = SF.quiltFor(circle, T0);
  assert.deepEqual(q1, q2, "quilt deterministic same day");
  if (q1) assert.ok(q1.quilt && q1.days >= 6 && q1.days <= 11, "quilt shape sane");
  let hits = 0;
  for (let d = 0; d < 200; d++) if (SF.quiltFor(circle, T0 + d * 86400000)) hits++;
  const rate = hits / 200;
  assert.ok(rate > 0.02 && rate < 0.2, `quilt rarity ${rate} in band`);
  console.log(`quilt: PASS (rate ${(rate * 100).toFixed(1)}%)`);
}

// --- commission ledger round-trip + TTL ---
{
  fresh();
  assert.equal(SF.commissionFor("Jon", T0), null, "no commission yet");
  SF.commissionGarment("Jon", "a wedding quilt", T0);
  assert.equal(SF.commissionFor("Jon", T0), "a wedding quilt", "commission recorded");
  assert.equal(SF.commissionFor("Jon", T0 + 8 * 86400000), null, "commission expires after TTL");
  assert.equal(SF.commissionGarment("Nobody", null, T0), null, "null garment rejected");
  console.log("commission ledger: PASS");
}

// --- fabric ledger round-trip + TTL ---
{
  fresh();
  SF._resetState();
  assert.equal(SF.fabricFor("Pip", T0), null, "no fabric yet");
  SF.buyFabric("Pip", "woolen broadcloth", T0);
  assert.equal(SF.fabricFor("Pip", T0), "woolen broadcloth", "fabric recorded");
  assert.equal(SF.fabricFor("Pip", T0 + 8 * 86400000), null, "fabric expires after TTL");
  console.log("fabric ledger: PASS");
}

// --- sewing-lesson ledger round-trip + TTL ---
{
  fresh();
  SF._resetState();
  assert.equal(SF.sewingFor("Ada", T0), null, "no lesson yet");
  SF.learnSewing("Ada", "the backstitch", T0);
  assert.equal(SF.sewingFor("Ada", T0), "the backstitch", "lesson recorded");
  assert.equal(SF.sewingFor("Ada", T0 + 8 * 86400000), null, "lesson expires after TTL");
  console.log("lesson ledger: PASS");
}

// --- sew hours (local-time constructors, per timezone rule) ---
{
  fresh();
  assert.ok(SF.isSewHour(new Date(2026, 9, 8, 8, 0).getTime()), "08:00 is a sew hour");
  assert.ok(SF.isSewHour(new Date(2026, 9, 8, 17, 59).getTime()), "17:59 is a sew hour");
  assert.ok(!SF.isSewHour(new Date(2026, 9, 8, 7, 59).getTime()), "07:59 is not");
  assert.ok(!SF.isSewHour(new Date(2026, 9, 8, 18, 0).getTime()), "18:00 is not");
  assert.ok(!SF.isSewHour(new Date(2026, 9, 8, 3, 0).getTime()), "03:00 is not");
  console.log("sew hours: PASS");
}

// --- player/bot/tile guards ---
{
  fresh();
  const real = mockPlayer("Jon");
  const bot = mockBot("Bot");
  assert.ok(SF.isRealPlayer(real), "real player detected");
  assert.ok(!SF.isRealPlayer(bot), "bot is not a real player");
  assert.ok(!SF.isRealPlayer(null), "null is not a real player");
  assert.ok(SF.isCitizenBot(bot), "bot detected as citizen bot");
  assert.ok(SF.withinTiles(mockBot("a"), mockPlayer("b"), 14), "nearby in range");
  assert.ok(!SF.withinTiles(mockBot("a"), mockPlayer("b", 4000, 4000), 14), "far away out of range");
  console.log("guards: PASS");
}

// --- tick fires near a real player ---
{
  fresh();
  SF._resetState();
  const rec = findSewfolk("tickf");
  const bot = mockBot(rec.username);
  const dir = mockDirector([rec], [mockPlayer("Jon")]);
  dir._bots.set(rec.username, bot);
  withFixedRandom(0.05, () => SF.tickSewfolk(dir, T0));
  assert.ok(bot._chats.length >= 1, "citizen spoke near a real player");
  console.log("tick fires: PASS");
}

// --- tick silent near bots only ---
{
  fresh();
  SF._resetState();
  const rec = findSewfolk("tickb");
  const bot = mockBot(rec.username);
  const dir = mockDirector([rec], [mockBot("Other")]);
  dir._bots.set(rec.username, bot);
  withFixedRandom(0.05, () => SF.tickSewfolk(dir, T0));
  assert.equal(bot._chats.length, 0, "silent when only bots near");
  console.log("tick silent near bots: PASS");
}

// --- tick silent outside hours ---
{
  fresh();
  SF._resetState();
  const rec = findSewfolk("tickn");
  const bot = mockBot(rec.username);
  const dir = mockDirector([rec], [mockPlayer("Jon")]);
  dir._bots.set(rec.username, bot);
  withFixedRandom(0.05, () => SF.tickSewfolk(dir, NIGHT));
  assert.equal(bot._chats.length, 0, "silent at 03:00");
  console.log("tick silent at night: PASS");
}

// --- pro tailor skipped at the type gate (no bot created) ---
{
  fresh();
  SF._resetState();
  const proName = findProTailor("protick");
  const rec = { username: proName, role: "commoner", kingdomId: "misthalin" };
  const dir = mockDirector([rec], [mockPlayer("Jon")]);
  withFixedRandom(0.05, () => SF.tickSewfolk(dir, T0));
  assert.equal(dir._bots.size, 0, "pro tailor never materializes as sewfolk");
  console.log("pro tailor skipped: PASS");
}

// --- never throws on hostile input ---
{
  fresh();
  assert.doesNotThrow(() => SF.tickSewfolk(null, T0), "null director");
  assert.doesNotThrow(() => SF.tickSewfolk({}, T0), "empty director");
  assert.doesNotThrow(() => SF.tickSewfolk({ roster: null }, T0), "null roster");
  assert.doesNotThrow(() => SF.sewfolkTypeOf(null), "null record");
  assert.doesNotThrow(() => SF.projectsFor(null, null, T0), "null project inputs");
  console.log("never throws: PASS");
}

console.log("ALL CITIZENTAILORS2 TESTS PASSED");
