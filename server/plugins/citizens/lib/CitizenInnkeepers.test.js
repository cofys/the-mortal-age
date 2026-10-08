// CitizenInnkeepers unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const Inn = require("./CitizenInnkeepers");

// Deterministic LCG — coverage is exact, not luck-based.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

function freshBot(x = 3200, y = 3200, z = 0) {
  const said = [];
  return {
    said,
    getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => z }),
    getUsername: () => "TestBot",
    isPlayerBot: () => true,
    getHostAddress: () => "bot",
    forceChat: (line) => said.push(line),
  };
}

function realPlayer(name, x = 3205, y = 3205, z = 0) {
  const said = [];
  return {
    said,
    getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => z }),
    getUsername: () => name,
    isPlayerBot: () => false,
    getHostAddress: () => "127.0.0.1",
    forceChat: (line) => said.push(line),
  };
}

function mockDirector(records, players) {
  return {
    roster: new Map(records.map((r) => [r.username, r])),
    playerFor: (record) => record._bot ?? null,
    onlinePlayers: () => players,
    log: () => {},
  };
}

check("hashStr is deterministic and non-empty", () => {
  assert.equal(Inn.hashStr("a"), Inn.hashStr("a"));
  assert.notEqual(Inn.hashStr("a"), Inn.hashStr("b"));
  assert.ok(Inn.hashStr("x").length > 0);
});

check("hashChance returns 0..1 and is deterministic", () => {
  const a = Inn.hashChance("x", "y");
  assert.ok(a >= 0 && a < 1);
  assert.equal(a, Inn.hashChance("x", "y"));
});

check("innTypeFor is stable across calls and null for most", () => {
  const types = ["a1", "b2", "c3", "d4"].map((u) => Inn.innTypeFor(u));
  for (const u of ["a1", "b2"]) assert.equal(Inn.innTypeFor(u), Inn.innTypeFor(u));
  const samples = Array.from({ length: 200 }, (_, i) => Inn.innTypeFor("user" + i));
  const nonNull = samples.filter(Boolean);
  assert.ok(nonNull.length > 4 && nonNull.length < 25, `innkeeper share ${nonNull.length}/200 (primary-profession partition ~6%)`);
  for (const t of nonNull) assert.ok(Inn.INN_TYPES.includes(t));
});

check("innFor prefers the citizen kingdom, falls back otherwise", () => {
  const inn = Inn.innFor("someone", "varrock");
  assert.equal(inn.kingdom, "varrock");
  const other = Inn.innFor("someone", "nope-not-a-kingdom");
  assert.ok(Inn.INNS.includes(other));
});

check("roomsFor returns the inn's room count with derived occupancy", () => {
  const inn = Inn.INNS[0];
  const rooms = Inn.roomsFor(inn, Date.UTC(2026, 9, 8));
  assert.equal(rooms.length, inn.rooms);
  const occ = rooms.filter((r) => r.occupied).length;
  assert.ok(occ > 0 && occ < inn.rooms);
  assert.deepEqual(rooms, Inn.roomsFor(inn, Date.UTC(2026, 9, 8)));
});

check("freeRooms matches unoccupied count", () => {
  const inn = Inn.INNS[0];
  const day = Date.UTC(2026, 9, 8);
  assert.equal(Inn.freeRooms(inn, day), Inn.roomsFor(inn, day).filter((r) => !r.occupied).length);
});

check("rentRoomFor books a free room; checkOutOf clears it", () => {
  Inn.resetForTests();
  const inn = Inn.INNS.find((i) => Inn.freeRooms(i, Date.now()) > 0) ?? Inn.INNS[0];
  const booking = Inn.rentRoomFor("PlayerOne", inn.name);
  assert.ok(booking);
  assert.equal(booking.inn, inn.name);
  assert.deepEqual(Inn.lodgingFor("PlayerOne"), booking);
  // Second rent returns the same booking.
  assert.deepEqual(Inn.rentRoomFor("PlayerOne", inn.name), booking);
  assert.ok(Inn.checkOutOf("PlayerOne"));
  assert.equal(Inn.lodgingFor("PlayerOne"), null);
  assert.equal(Inn.checkOutOf("Nobody"), false);
});

check("rentRoomFor returns null for an unknown inn", () => {
  Inn.resetForTests();
  assert.equal(Inn.rentRoomFor("PlayerTwo", "the Nonexistent Inn"), null);
});

check("isEvening gates bards correctly", () => {
  assert.ok(Inn.isEvening(new Date(2026, 9, 8, 20, 0).getTime()));
  assert.ok(Inn.isEvening(new Date(2026, 9, 8, 2, 0).getTime()));
  assert.ok(!Inn.isEvening(new Date(2026, 9, 8, 12, 0).getTime()));
});

check("line pools are non-empty and fill templates", () => {
  const rng = lcg(7);
  const inn = Inn.INNS[0];
  assert.ok(Inn.welcomeLine(rng, inn, 3).includes(inn.name));
  assert.ok(Inn.roomOfferLine(rng, inn, 2, 12).length > 10);
  assert.ok(Inn.stableLine(rng).length > 5);
  assert.ok(Inn.mealLine(rng, "stew").includes("stew"));
  assert.ok(Inn.bardVerse(rng).length > 10);
  assert.ok(Inn.checkinLine(rng, 4).includes("4"));
  assert.ok(Inn.checkoutLine(rng, inn).includes(inn.name));
  assert.ok(Inn.fullLine(rng, inn).includes(inn.name));
});

check("roomPrice varies by tier", () => {
  const prices = new Set(Inn.INNS.map((i) => Inn.roomPrice(i)));
  assert.ok(prices.size >= 3);
  for (const p of prices) assert.ok(p > 0);
});

check("shouldFire respects cooldown and chance", () => {
  const now = 100_000_000; // well past the 3h cooldown from epoch
  const rng = () => 0.0; // always under chance
  assert.ok(Inn.shouldFire(rng, 0, now));
  assert.ok(!Inn.shouldFire(rng, now - 1000, now)); // within cooldown
  assert.ok(!Inn.shouldFire(() => 0.99, 0, now)); // over chance
});

check("shouldOffer respects hourly gate", () => {
  const now = 5_000_000;
  assert.ok(Inn.shouldOffer(0, now));
  assert.ok(!Inn.shouldOffer(now - 1000, now));
  assert.ok(Inn.shouldOffer(now - 2 * 3600 * 1000, now));
});

check("tickInnkeepers fires near real players, silent near bots only", () => {
  Inn.resetForTests();
  // Find a username that is an innkeeper.
  let keeper = null;
  for (let i = 0; i < 500 && !keeper; i++) {
    const u = "keeper" + i;
    if (Inn.innTypeFor(u)) keeper = u;
  }
  assert.ok(keeper, "found an innkeeper username");
  const bot = freshBot();
  const rec = { username: keeper, kingdom: "varrock", _bot: bot };
  const human = realPlayer("HumanOne");
  const d = mockDirector([rec], [human]);
  // Chance gate is 0.35/tick; retry until it fires (bounded).
  for (let i = 0; i < 30 && bot.said.length === 0; i++) {
    Inn.tickInnkeepers(d, Date.now() + i * 1000);
  }
  assert.ok(bot.said.length >= 1, "innkeeper spoke near a real player");
});

check("tickInnkeepers is silent with no real player", () => {
  Inn.resetForTests();
  let keeper = null;
  for (let i = 0; i < 500 && !keeper; i++) {
    const u = "quiet" + i;
    if (Inn.innTypeFor(u)) keeper = u;
  }
  const bot = freshBot();
  const rec = { username: keeper, kingdom: "varrock", _bot: bot };
  const d = mockDirector([rec], [freshBot(3210, 3210)]); // bot only
  Inn.tickInnkeepers(d, Date.now());
  assert.equal(bot.said.length, 0, "silent with no real player");
});

check("tickInnkeepers never throws on hostile input", () => {
  Inn.resetForTests();
  assert.doesNotThrow(() => Inn.tickInnkeepers(null, Date.now()));
  assert.doesNotThrow(() => Inn.tickInnkeepers({}, Date.now()));
  assert.doesNotThrow(() =>
    Inn.tickInnkeepers({ roster: { values: () => { throw new Error("boom"); } } }, Date.now())
  );
});

check("seedInnRumor never throws", () => {
  Inn.resetForTests();
  assert.doesNotThrow(() => Inn.seedInnRumor(lcg(3), "the Blue Moon Inn", "dragons in the cellar."));
});

check("innMealFor returns a non-empty meal string", () => {
  Inn.resetForTests();
  const meal = Inn.innMealFor("cookuser", "varrock", Date.now());
  assert.ok(typeof meal === "string" && meal.length > 2);
});

console.log(`\n${passed} checks passed.`);
