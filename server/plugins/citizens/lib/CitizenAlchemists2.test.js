"use strict";

// CitizenAlchemists2 unit checks — pure logic, no running server.
// From server/plugins/citizens: node lib/CitizenAlchemists2.test.js (plain node)
const assert = require("node:assert/strict");
const S = require("./CitizenAlchemists2");
const ProAlch = require("./CitizenAlchemists");

const T0 = new Date(2026, 9, 8, 10, 0).getTime(); // 10:00 local — brew hours
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
  return {
    roster,
    playerFor: (rec) => {
      if (!bots.has(rec.username)) bots.set(rec.username, mockPlayer(rec.username, 100, 100, true));
      return bots.get(rec.username);
    },
    onlinePlayers: () => players,
  };
}
function fresh() {
  S._resetState();
}

// --- type weights / roll boundaries / reachability ---
{
  fresh();
  assert.equal(S.brewfolkTypeFromRoll(0), S.BREWFOLK_HEDGEWITCH);
  assert.equal(S.brewfolkTypeFromRoll(29), S.BREWFOLK_HEDGEWITCH);
  assert.equal(S.brewfolkTypeFromRoll(30), S.BREWFOLK_BREWER);
  assert.equal(S.brewfolkTypeFromRoll(59), S.BREWFOLK_BREWER);
  assert.equal(S.brewfolkTypeFromRoll(60), S.BREWFOLK_MIXER);
  assert.equal(S.brewfolkTypeFromRoll(84), S.BREWFOLK_MIXER);
  assert.equal(S.brewfolkTypeFromRoll(85), S.BREWFOLK_EXPERIMENTER);
  assert.equal(S.brewfolkTypeFromRoll(99), S.BREWFOLK_EXPERIMENTER);
  // Every type reachable over a wide sweep.
  const seen = new Set();
  for (let i = 0; i < 400; i++) {
    const t = S.brewfolkTypeOf({ username: "sweep" + i, role: "commoner" });
    if (t) seen.add(t);
  }
  for (const t of S.BREWFOLK_TYPES) assert.ok(seen.has(t), `type ${t} reachable`);
  console.log("type weights/reachability: PASS");
}

// --- type stability across calls ---
{
  fresh();
  for (let i = 0; i < 50; i++) {
    const a = S.brewfolkTypeOf({ username: "stable" + i, role: "commoner" });
    const b = S.brewfolkTypeOf({ username: "stable" + i, role: "commoner" });
    assert.equal(a, b, "type stable across calls");
  }
  console.log("type stability: PASS");
}

// --- commoner gating ---
{
  fresh();
  assert.equal(S.brewfolkTypeOf({ username: "x", role: "guard" }), null, "guards excluded");
  assert.equal(S.brewfolkTypeOf({ username: null, role: "commoner" }), null, "null name excluded");
  assert.equal(S.brewfolkTypeOf(null), null, "null record excluded");
  console.log("commoner gating: PASS");
}

// --- pro-alchemist exclusion verified against the REAL module ---
{
  fresh();
  let proFound = 0;
  let excluded = 0;
  for (let i = 0; i < 3000 && proFound < 20; i++) {
    const u = "procheck" + i;
    if (ProAlch.alchemistTypeFor(u)) {
      proFound++;
      if (S.brewfolkTypeOf({ username: u, role: "commoner" }) === null) excluded++;
    }
  }
  assert.ok(proFound > 0, "found pro alchemists to test against");
  assert.equal(excluded, proFound, "all pro alchemists excluded from brewfolk");
  console.log(`pro-alchemist exclusion: PASS (${proFound} pro alchemists all excluded)`);
}

// --- distribution band (~40% nominal, minus pro-alchemist ~6.5% and
// pro-herbalist ~35% exclusions -> ~24% effective) ---
{
  fresh();
  let n = 0;
  for (let i = 0; i < 2000; i++) {
    if (S.brewfolkTypeOf({ username: "dist" + i, role: "commoner" })) n++;
  }
  const pct = (n / 2000) * 100;
  assert.ok(pct > 15 && pct < 35, `distribution ${pct.toFixed(1)}% in band`);
  console.log(`distribution: PASS (${pct.toFixed(1)}%)`);
}

// --- no salt-correlation between gate and type (the CitizenActors lesson) ---
{
  fresh();
  const counts = { [S.BREWFOLK_HEDGEWITCH]: 0, [S.BREWFOLK_BREWER]: 0, [S.BREWFOLK_MIXER]: 0, [S.BREWFOLK_EXPERIMENTER]: 0 };
  let total = 0;
  for (let i = 0; i < 4000; i++) {
    const t = S.brewfolkTypeOf({ username: "corr" + i, role: "commoner" });
    if (t) { counts[t]++; total++; }
  }
  assert.ok(total > 0, "some brewfolk found");
  for (const t of S.BREWFOLK_TYPES) {
    const share = counts[t] / total;
    // Expected weights 30/30/25/15 — allow wide tolerance, but no bucket may be starved.
    assert.ok(share > 0.05, `type ${t} not starved (${(share * 100).toFixed(1)}%)`);
  }
  console.log(`salt correlation: PASS (mix ${S.BREWFOLK_TYPES.map((t) => `${t}:${((counts[t] / total) * 100).toFixed(0)}%`).join(" ")})`);
}

// --- kingdom-preferred stillrooms ---
{
  fresh();
  const r1 = S.stillroomFor({ username: "still1", kingdomId: "asgarnia" });
  assert.equal(r1.kingdom, "asgarnia", "asgarnia citizen gets an asgarnia stillroom");
  const r2 = S.stillroomFor({ username: "still1", kingdomId: "asgarnia" });
  assert.equal(r1.name, r2.name, "stillroom stable across calls");
  console.log("stillrooms: PASS");
}

// --- brews determinism + day variance ---
{
  fresh();
  const a = S.brewsFor("brewuser", T0);
  const b = S.brewsFor("brewuser", T0);
  assert.deepEqual(a, b, "brews deterministic same day");
  assert.ok(a.length >= 1 && a.length <= 3, "1-3 brews per day");
  let differs = false;
  for (let d = 1; d <= 10; d++) {
    const c = S.brewsFor("brewuser", T0 + d * 86400000);
    if (JSON.stringify(c) !== JSON.stringify(a)) { differs = true; break; }
  }
  assert.ok(differs, "brews vary across days");
  for (const brew of a) assert.ok(S.COMMUNITY_BREWS.includes(brew), `brew "${brew}" in the pool`);
  console.log("brews: PASS");
}

// --- brews are non-medical (no health cures) ---
{
  fresh();
  const medical = ["fever", "wound", "cough", "plague", "heal", "cure", "salve", "poultice", "tonic for the sick"];
  for (const brew of S.COMMUNITY_BREWS) {
    for (const m of medical) {
      assert.ok(!brew.toLowerCase().includes(m), `brew "${brew}" is not medical (contains "${m}")`);
    }
  }
  console.log("non-medical brews: PASS");
}

// --- herb tie-in (unwraps {name, rarity} objects) ---
{
  fresh();
  const herb = S.herbForToday("herbuser", "misthalin", T0);
  assert.ok(typeof herb === "string" && herb.length > 0, "herb is a non-empty string");
  assert.ok(!herb.includes("[object Object]"), "herb object unwrapped correctly");
  console.log(`herb tie-in: PASS (${herb})`);
}

// --- mishap determinism + rarity ---
{
  fresh();
  const room = { name: "Widow Pimm's stillroom" };
  const m1 = S.mishapFor(room, T0);
  const m2 = S.mishapFor(room, T0);
  assert.equal(m1, m2, "mishap deterministic same day");
  let hits = 0;
  for (let d = 0; d < 200; d++) {
    if (S.mishapFor(room, T0 + d * 86400000)) hits++;
  }
  const rate = hits / 200;
  assert.ok(rate > 0.02 && rate < 0.2, `mishap rarity ~8% (got ${(rate * 100).toFixed(1)}%)`);
  console.log(`mishap: PASS (${(rate * 100).toFixed(1)}%)`);
}

// --- price sanity ---
{
  fresh();
  for (let i = 0; i < 20; i++) {
    const p = S.priceFor(S.COMMUNITY_BREWS[i % S.COMMUNITY_BREWS.length]);
    assert.ok(p >= 15 && p <= 74, `price ${p} in 15-74 band`);
  }
  console.log("prices: PASS");
}

// --- all 3 ledgers round-trip + TTL expiry ---
{
  fresh();
  assert.equal(S.requestBrew("Jon", "a glow draught (lantern-bright)", T0), "a glow draught (lantern-bright)");
  assert.equal(S.brewForPlayer("Jon", T0), "a glow draught (lantern-bright)");
  assert.equal(S.brewForPlayer("Jon", T0 + 8 * 86400000), null, "brew request expires after TTL");

  fresh();
  assert.equal(S.buyPotion("Jon", "a rosewater scent elixir", 42, T0), "a rosewater scent elixir");
  assert.deepEqual(S.potionFor("Jon", T0), { brew: "a rosewater scent elixir", price: 42 });
  assert.equal(S.potionFor("Jon", T0 + 8 * 86400000), null, "purchase expires after TTL");

  fresh();
  assert.equal(S.learnBrewing("Jon", T0), true);
  assert.equal(S.brewingLessonFor("Jon", T0), true);
  assert.equal(S.brewingLessonFor("Jon", T0 + 8 * 86400000), null, "lesson expires after TTL");
  console.log("ledgers: PASS");
}

// --- brew hours via local-time constructors (timezone rule) ---
{
  fresh();
  assert.ok(S.isBrewHour(new Date(2026, 9, 8, 10, 0).getTime()), "10:00 local is brew hour");
  assert.ok(!S.isBrewHour(new Date(2026, 9, 8, 3, 0).getTime()), "03:00 local is not brew hour");
  assert.ok(!S.isBrewHour(new Date(2026, 9, 8, 21, 0).getTime()), "21:00 local is not brew hour");
  console.log("brew hours: PASS");
}

// --- player/bot/tile guards ---
{
  fresh();
  const real = mockPlayer("Jon", 100, 100, false);
  const bot = mockPlayer("Bot", 100, 100, true);
  assert.ok(S.isRealPlayer(real), "real player passes");
  assert.ok(!S.isRealPlayer(bot), "bot fails isRealPlayer");
  assert.ok(S.isCitizenBot(bot), "bot passes isCitizenBot");
  const near = mockPlayer("N", 105, 105, false);
  const far = mockPlayer("F", 500, 500, false);
  assert.ok(S.withinTiles(real, near, 14), "near player within tiles");
  assert.ok(!S.withinTiles(real, far, 14), "far player outside tiles");
  console.log("guards: PASS");
}

// --- tick fires near a real player, silent otherwise ---
{
  fresh();
  // Find an eligible brewfolk name dynamically.
  let uname = null;
  for (let i = 0; i < 3000 && !uname; i++) {
    if (S.brewfolkTypeOf({ username: "tick" + i, role: "commoner" })) uname = "tick" + i;
  }
  assert.ok(uname, "found an eligible brewfolk name");
  const rec = { username: uname, role: "commoner", kingdomId: "misthalin" };
  const realNear = mockPlayer("Jon", 102, 102, false);
  const dir = mockDirector([rec], [realNear]);
  withFixedRandom(0.05, () => S.tickBrewfolk(dir, T0)); // 0.05 < BREW_CHANCE (0.15)
  const bot = dir.playerFor(rec);
  assert.ok(bot._chats.length >= 1, "tick fires near a real player");
  console.log("tick fires: PASS");
}
{
  fresh();
  let uname = null;
  for (let i = 0; i < 3000 && !uname; i++) {
    if (S.brewfolkTypeOf({ username: "tickb" + i, role: "commoner" })) uname = "tickb" + i;
  }
  const rec = { username: uname, role: "commoner", kingdomId: "misthalin" };
  const onlyBots = [mockPlayer("Bot1", 102, 102, true)];
  const dir = mockDirector([rec], onlyBots);
  withFixedRandom(0.05, () => S.tickBrewfolk(dir, T0));
  const bot = dir.playerFor(rec);
  assert.equal(bot._chats.length, 0, "silent when only bots are near");
  console.log("tick silent near bots: PASS");
}
{
  fresh();
  let uname = null;
  for (let i = 0; i < 3000 && !uname; i++) {
    if (S.brewfolkTypeOf({ username: "tickn" + i, role: "commoner" })) uname = "tickn" + i;
  }
  const rec = { username: uname, role: "commoner", kingdomId: "misthalin" };
  const realNear = mockPlayer("Jon", 102, 102, false);
  const dir = mockDirector([rec], [realNear]);
  withFixedRandom(0.05, () => S.tickBrewfolk(dir, T_NIGHT));
  const bot = dir.playerFor(rec);
  assert.equal(bot._chats.length, 0, "silent outside brew hours");
  console.log("tick silent at night: PASS");
}

// --- pro alchemist skipped at the type gate before materialization ---
{
  fresh();
  let proName = null;
  for (let i = 0; i < 5000 && !proName; i++) {
    if (ProAlch.alchemistTypeFor("proalch" + i)) proName = "proalch" + i;
  }
  assert.ok(proName, "found a pro alchemist name");
  const rec = { username: proName, role: "commoner", kingdomId: "misthalin" };
  assert.equal(S.brewfolkTypeOf(rec), null, "pro alchemist excluded from brewfolk");
  console.log("pro alchemist exclusion: PASS");
}

// --- never throws on hostile input ---
{
  fresh();
  assert.doesNotThrow(() => S.tickBrewfolk(null, T0), "null director");
  assert.doesNotThrow(() => S.tickBrewfolk({}, T0), "empty director");
  assert.doesNotThrow(() => S.brewfolkTypeOf(undefined), "undefined record");
  assert.doesNotThrow(() => S.brewsFor(null, T0), "null username");
  assert.doesNotThrow(() => S.mishapFor(null, T0), "null stillroom");
  console.log("never throws: PASS");
}

// --- pure helpers ---
{
  fresh();
  assert.equal(S.fill("Hello {name}!", { name: "Jon" }), "Hello Jon!");
  assert.equal(typeof S.dayNumber(T0), "number");
  assert.ok(S.chance(() => 0.05, 0.15), "chance passes below p");
  assert.ok(!S.chance(() => 0.5, 0.15), "chance fails above p");
  console.log("helpers: PASS");
}

console.log("ALL CITIZENALCHEMISTS2 TESTS PASSED");
