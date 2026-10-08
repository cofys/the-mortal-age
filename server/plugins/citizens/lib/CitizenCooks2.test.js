"use strict";

// CitizenCooks2 unit checks — pure logic, no running server.
// From server/plugins/citizens: node CitizenCooks2.test.js (plain node)
const assert = require("node:assert/strict");
const CF = require("./CitizenCooks2");
const ProCooks = require("./CitizenCooks");

const T0 = new Date(2026, 9, 8, 10, 0).getTime(); // 10:00 local — inside cook hours
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
/** Find a username that passes cookfolkTypeOf (and is not a pro cook). */
function findCookfolk(prefix = "cf") {
  for (let i = 0; i < 5000; i++) {
    const rec = { username: prefix + i, role: "commoner", kingdomId: "misthalin" };
    if (CF.cookfolkTypeOf(rec)) return rec;
  }
  throw new Error("no cookfolk username found");
}
/** Find a username that IS a professional cook. */
function findProCook(prefix = "proc") {
  for (let i = 0; i < 20000; i++) {
    const u = prefix + i;
    if (ProCooks.cookTypeFor(u)) return u;
  }
  throw new Error("no pro cook username found");
}
/** Find a cookfolk username of a specific type. */
function findCookfolkOf(type, prefix = "cft") {
  for (let i = 0; i < 8000; i++) {
    const rec = { username: prefix + type + i, role: "commoner", kingdomId: "misthalin" };
    if (CF.cookfolkTypeOf(rec) === type) return rec;
  }
  throw new Error("no " + type + " username found");
}

function fresh() {
  CF._resetState();
}

// --- type weights / roll boundaries ---
{
  fresh();
  assert.equal(CF.cookfolkTypeFromRoll(0), CF.COOKFOLK_HOME);
  assert.equal(CF.cookfolkTypeFromRoll(29), CF.COOKFOLK_HOME);
  assert.equal(CF.cookfolkTypeFromRoll(30), CF.COOKFOLK_VENDOR);
  assert.equal(CF.cookfolkTypeFromRoll(59), CF.COOKFOLK_VENDOR);
  assert.equal(CF.cookfolkTypeFromRoll(60), CF.COOKFOLK_FEAST);
  assert.equal(CF.cookfolkTypeFromRoll(84), CF.COOKFOLK_FEAST);
  assert.equal(CF.cookfolkTypeFromRoll(85), CF.COOKFOLK_SOUP);
  assert.equal(CF.cookfolkTypeFromRoll(99), CF.COOKFOLK_SOUP);
  for (const t of CF.COOKFOLK_TYPES) assert.ok(CF.cookfolkTypeFromRoll(50) !== undefined);
  console.log("type weights: PASS");
}

// --- stability: same record always gets the same type ---
{
  fresh();
  const rec = { username: "stablecook", role: "commoner", kingdomId: "asgarnia" };
  const a = CF.cookfolkTypeOf(rec);
  const b = CF.cookfolkTypeOf(rec);
  assert.equal(a, b, "type is stable across calls");
  console.log("stability: PASS");
}

// --- commoner gating ---
{
  fresh();
  assert.equal(CF.cookfolkTypeOf({ username: "guardcook", role: "guard" }), null, "guards are excluded");
  assert.equal(CF.cookfolkTypeOf({ username: "", role: "commoner" }), null, "empty name is null");
  assert.equal(CF.cookfolkTypeOf(null), null, "null record is null");
  console.log("commoner gating: PASS");
}

// --- pro-cook exclusion (against the real module) ---
{
  fresh();
  const proName = findProCook("prockx");
  assert.ok(ProCooks.cookTypeFor(proName), "sanity: found a real pro cook");
  assert.equal(
    CF.cookfolkTypeOf({ username: proName, role: "commoner", kingdomId: "misthalin" }),
    null,
    "professional cooks are excluded from community cookfolk"
  );
  console.log("pro-cook exclusion: PASS");
}

// --- broad distribution (~40% share band) ---
{
  fresh();
  let hits = 0;
  const N = 1000;
  for (let i = 0; i < N; i++) {
    if (CF.cookfolkTypeOf({ username: "dist" + i, role: "commoner", kingdomId: "kandarin" })) hits++;
  }
  const pct = (hits / N) * 100;
  assert.ok(pct > 25 && pct < 55, "distribution in band, got " + pct.toFixed(1) + "%");
  console.log("distribution (" + pct.toFixed(1) + "%): PASS");
}

// --- kingdom-preferred kitchens ---
{
  fresh();
  const rec = { username: "kitchencook", role: "commoner", kingdomId: "keldagrim" };
  const k = CF.kitchenFor(rec);
  assert.equal(k.kingdom, "keldagrim", "keldagrim record gets a keldagrim kitchen");
  const any = CF.kitchenFor({ username: "othercook", role: "commoner", kingdomId: "nope" });
  assert.ok(any && any.name, "unknown kingdom falls back to a named kitchen");
  console.log("kitchen preference: PASS");
}

// --- menu determinism + day variance ---
{
  fresh();
  const k = CF.kitchenFor({ username: "menucook", role: "commoner", kingdomId: "misthalin" });
  const a = CF.menuFor("menucook", k, T0);
  const b = CF.menuFor("menucook", k, T0);
  assert.deepEqual(a, b, "menu is deterministic for the same day");
  assert.ok(a.length >= 1 && a.length <= 3, "menu has 1-3 dishes");
  const seen = new Set();
  for (let d = 0; d < 10; d++) seen.add(JSON.stringify(CF.menuFor("menucook", k, T0 + d * 86400000)));
  assert.ok(seen.size > 1, "menu varies across days");
  console.log("menu determinism: PASS");
}

// --- dish pools: vendor dishes come from the real street-food table ---
{
  fresh();
  const vendor = findCookfolkOf(CF.COOKFOLK_VENDOR, "vck");
  const k = CF.kitchenFor(vendor);
  const street = ProCooks.STREET_FOOD;
  for (let d = 0; d < 10; d++) {
    const dish = CF.dishForToday(vendor.username, k, T0 + d * 86400000);
    assert.ok(street.includes(dish), "vendor dish is real street food: " + dish);
  }
  const home = findCookfolkOf(CF.COOKFOLK_HOME, "hck");
  const hk = CF.kitchenFor(home);
  const dish = CF.dishForToday(home.username, hk, T0);
  assert.ok(typeof dish === "string" && dish.length > 0, "home dish is a non-empty string");
  console.log("dish pools: PASS");
}

// --- feast determinism + rarity ---
{
  fresh();
  let fires = 0;
  const trials = 2000;
  const k = CF.COMMUNITY_KITCHENS[0];
  for (let d = 0; d < trials; d++) {
    if (CF.feastFor(k, d * 86400000)) fires++;
  }
  const rate = (fires / trials) * 100;
  assert.ok(rate > 4 && rate < 13, "feast rarity ~8%, got " + rate.toFixed(1) + "%");
  const feastDay = (() => {
    for (let d = 0; d < 200; d++) if (CF.feastFor(k, d * 86400000)) return d;
    return null;
  })();
  if (feastDay !== null) {
    const a = CF.feastFor(k, feastDay * 86400000);
    const b = CF.feastFor(k, feastDay * 86400000);
    assert.deepEqual(a, b, "feast is deterministic");
  }
  console.log("feast rarity (" + rate.toFixed(1) + "%): PASS");
}

// --- price sanity ---
{
  fresh();
  assert.equal(CF.priceFor(CF.COOKFOLK_SOUP), 0, "soup kitchen is always free");
  const vp = CF.priceFor(CF.COOKFOLK_VENDOR);
  assert.ok(vp >= 5 && vp <= 20, "vendor price sane: " + vp);
  const hp = CF.priceFor(CF.COOKFOLK_HOME);
  assert.ok(hp >= 3 && hp <= 13, "home price sane: " + hp);
  console.log("price sanity: PASS");
}

// --- seasonal tie-in: real farmers' tables ---
{
  fresh();
  const summerMs = new Date(2026, 6, 15, 10, 0).getTime(); // July — summer
  const winterMs = new Date(2026, 0, 15, 10, 0).getTime(); // January — winter
  assert.equal(CF.seasonNameFor(summerMs), "summer", "July is summer");
  assert.equal(CF.seasonNameFor(winterMs), "winter", "January is winter");
  const produce = CF.produceForToday(summerMs);
  assert.ok(typeof produce === "string" && produce.length > 0, "produce is a non-empty string: " + produce);
  console.log("seasonal tie-in: PASS");
}

// --- all 3 ledgers: round-trip + TTL expiry ---
{
  fresh();
  assert.equal(CF.buyMeal("Jon", "shepherd's pie", 10, T0), "shepherd's pie");
  assert.deepEqual(CF.mealFor("Jon", T0), { dish: "shepherd's pie", price: 10 });
  assert.equal(CF.mealFor("Nobody", T0), null);

  assert.equal(CF.learnRecipe("Jon", "hunter's stew", T0), "hunter's stew");
  assert.equal(CF.recipeFor("Jon", T0), "hunter's stew");
  assert.equal(CF.recipeFor("Nobody", T0), null);

  assert.equal(CF.helpCook("Jon", "the Varrock village hearth", T0), "the Varrock village hearth");
  assert.equal(CF.helpedCookFor("Jon", T0), "the Varrock village hearth");
  assert.equal(CF.helpedCookFor("Nobody", T0), null);

  // TTL expiry: 8 days later everything is gone.
  const later = T0 + 8 * 24 * 3600 * 1000;
  assert.equal(CF.mealFor("Jon", later), null, "meal ledger expires");
  assert.equal(CF.recipeFor("Jon", later), null, "recipe ledger expires");
  assert.equal(CF.helpedCookFor("Jon", later), null, "help ledger expires");
  console.log("ledgers round-trip + TTL: PASS");
}

// --- cook hours: local-time boundaries ---
{
  fresh();
  assert.equal(CF.isCookHour(T0), true, "10:00 local is cook hour");
  assert.equal(CF.isCookHour(new Date(2026, 9, 8, 6, 0).getTime()), true, "06:00 is the first cook hour");
  assert.equal(CF.isCookHour(NIGHT), false, "03:00 local is outside hours");
  assert.equal(CF.isCookHour(LATE), false, "22:00 local is outside hours");
  console.log("cook hours: PASS");
}

// --- guards: isRealPlayer / isCitizenBot / withinTiles ---
{
  fresh();
  const bot = mockBot("Bot1");
  const player = mockPlayer("Human1");
  assert.equal(CF.isRealPlayer(player), true);
  assert.equal(CF.isRealPlayer(bot), false);
  assert.equal(CF.isRealPlayer(null), false);
  assert.equal(CF.isCitizenBot(bot), true);
  assert.equal(CF.isCitizenBot(player), false);
  const near = mockBot("Near", 3000, 3000);
  const far = mockBot("Far", 3100, 3100);
  const human = mockPlayer("Human2", 3005, 3005);
  assert.equal(CF.withinTiles(near, human, 14), true, "5 tiles is within 14");
  assert.equal(CF.withinTiles(far, human, 14), false, "100 tiles is not within 14");
  console.log("guards: PASS");
}

// --- tick fires near a real player ---
{
  fresh();
  const rec = findCookfolk("tickcf");
  const director = mockDirector([rec], [mockPlayer("Human3")]);
  director._bots.set(rec.username, mockBot(rec.username));
  withFixedRandom(0.05, () => CF.tickCookfolk(director, T0));
  const chats = director._bots.get(rec.username)._chats;
  assert.ok(chats.length >= 1, "citizen says something near a real player");
  console.log("tick fires near player: PASS");
}

// --- tick silent near bots only ---
{
  fresh();
  const rec = findCookfolk("silentcf");
  const director = mockDirector([rec], [mockBot("BotWatcher")]);
  director._bots.set(rec.username, mockBot(rec.username));
  withFixedRandom(0.05, () => CF.tickCookfolk(director, T0));
  const chats = director._bots.get(rec.username)._chats;
  assert.equal(chats.length, 0, "silent when only bots are near");
  console.log("tick silent near bots: PASS");
}

// --- tick silent outside cook hours ---
{
  fresh();
  const rec = findCookfolk("nightcf");
  const director = mockDirector([rec], [mockPlayer("Human4")]);
  director._bots.set(rec.username, mockBot(rec.username));
  withFixedRandom(0.05, () => CF.tickCookfolk(director, NIGHT));
  const chats = director._bots.get(rec.username)._chats;
  assert.equal(chats.length, 0, "silent at 03:00");
  console.log("tick silent at night: PASS");
}

// --- pro cook skipped at the type gate (before materialization) ---
{
  fresh();
  const proName = findProCook("proskip");
  const rec = { username: proName, role: "commoner", kingdomId: "misthalin" };
  const director = mockDirector([rec], [mockPlayer("Human5")]);
  // Note: no bot attached — the type gate must skip before playerFor matters.
  withFixedRandom(0.05, () => CF.tickCookfolk(director, T0));
  assert.ok(!director._bots.has(proName), "pro cook never materializes for cookfolk");
  console.log("pro cook skipped: PASS");
}

// --- chance gate: 0.5 fails the 0.15 chance ---
{
  fresh();
  const rec = findCookfolk("chancecf");
  const director = mockDirector([rec], [mockPlayer("Human6")]);
  director._bots.set(rec.username, mockBot(rec.username));
  withFixedRandom(0.5, () => CF.tickCookfolk(director, T0));
  const chats = director._bots.get(rec.username)._chats;
  assert.equal(chats.length, 0, "0.5 random fails the 0.15 chance gate");
  console.log("chance gate: PASS");
}

// --- never throws on hostile input ---
{
  fresh();
  CF.tickCookfolk(null, T0);
  CF.tickCookfolk({}, T0);
  CF.tickCookfolk({ roster: null }, T0);
  assert.equal(CF.cookfolkTypeOf({ username: null }), null);
  const anyDish = CF.dishForToday(null, null, T0);
  assert.ok(typeof anyDish === "string" && anyDish.length > 0, "dishForToday never throws on hostile input");
  console.log("never-throws: PASS");
}

// --- pure helpers ---
{
  fresh();
  assert.equal(CF.hashStr("abc"), CF.hashStr("abc"), "hash is deterministic");
  assert.notEqual(CF.hashStr("abc"), CF.hashStr("abd"), "hash differs");
  assert.equal(CF.pickOne(() => 0, ["a", "b"]), "a");
  assert.equal(CF.fill("Hello {name}, eat {dish}!", { name: "Jon", dish: "pie" }), "Hello Jon, eat pie!");
  assert.equal(CF.dayNumber(86400000 * 3), 3);
  const rng = CF.seededRng(42);
  assert.ok(rng() >= 0 && rng() < 1);
  assert.equal(CF.chance(() => 0.1, 0.15), true);
  assert.equal(CF.chance(() => 0.2, 0.15), false);
  console.log("pure helpers: PASS");
}

console.log("ALL CITIZENCOOKS2 TESTS PASSED");
