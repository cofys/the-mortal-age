// CitizenGuardPatrols unit checks — pure logic, no running server.
// Run: node lib/CitizenGuardPatrols.test.js  (from server/plugins/citizens)
const assert = require("node:assert/strict");
const G = require("./CitizenGuardPatrols");

// Deterministic LCG — coverage is exact, not luck-based.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function loc(x, y, z = 0) {
  return { getX: () => x, getY: () => y, getZ: () => z };
}
function fakePlayer(x, y, { bot = false, username = "p" } = {}) {
  return {
    getLocation: () => loc(x, y),
    getUsername: () => username,
    isPlayerBot: () => bot,
    getHostAddress: () => (bot ? "bot" : "1.2.3.4"),
  };
}

let n = 0;
function check(name, fn) {
  n++;
  fn();
  console.log(`ok ${n} - ${name}`);
}

// 1. pickOne is deterministic with the same seed.
check("pickOne deterministic", () => {
  const a = G.pickOne(lcg(7), ["x", "y", "z"]);
  const b = G.pickOne(lcg(7), ["x", "y", "z"]);
  assert.equal(a, b);
  assert.ok(["x", "y", "z"].includes(a));
});

// 2. isNightHour boundaries.
check("isNightHour", () => {
  assert.equal(G.isNightHour(22), true);
  assert.equal(G.isNightHour(3), true);
  assert.equal(G.isNightHour(21), true);
  assert.equal(G.isNightHour(5), false);
  assert.equal(G.isNightHour(12), false);
  assert.equal(G.isNightHour(20), false);
});

// 3. chebyshev pure math.
check("chebyshev", () => {
  assert.equal(G.chebyshev(0, 0, 3, 4), 4);
  assert.equal(G.chebyshev(5, 5, 5, 5), 0);
  assert.equal(G.chebyshev(0, 0, -2, 1), 2);
});

// 4. withinTiles same-plane / different-plane.
check("withinTiles", () => {
  const a = fakePlayer(10, 10);
  const b = fakePlayer(12, 11);
  assert.equal(G.withinTiles(a, b, 2), true);
  assert.equal(G.withinTiles(a, b, 1), false);
  const c = { getLocation: () => loc(10, 10, 1) };
  assert.equal(G.withinTiles(a, c, 5), false);
});

// 5. shouldFire: cooldown blocks, chance gates.
check("shouldFire", () => {
  const now = 1000000;
  assert.equal(G.shouldFire(lcg(1), now - 1000, now, 60000, 1.0), false); // cooldown
  assert.equal(G.shouldFire(lcg(1), 0, now, 60000, 1.0), true); // passed + chance 1
  assert.equal(G.shouldFire(lcg(1), 0, now, 60000, 0.0), false); // chance 0
});

// 6. fillLine replaces slots.
check("fillLine", () => {
  assert.equal(G.fillLine("You, {name}. Move along.", { name: "Bob" }), "You, Bob. Move along.");
  assert.equal(G.fillLine("Checked the {site}.", { site: "docks" }), "Checked the docks.");
});

// 7. isRealPlayer: bot vs real vs null.
check("isRealPlayer", () => {
  assert.equal(G.isRealPlayer(fakePlayer(0, 0)), true);
  assert.equal(G.isRealPlayer(fakePlayer(0, 0, { bot: true })), false);
  assert.equal(G.isRealPlayer(null), false);
  assert.equal(G.isRealPlayer({}), false);
});

// 8. escortShouldEnd: expired / too far / fine / null.
check("escortShouldEnd", () => {
  const st = { startTile: { x: 100, y: 100 }, until: 2000 };
  assert.equal(G.escortShouldEnd(st, { x: 101, y: 101 }, 3000), true); // expired
  assert.equal(G.escortShouldEnd(st, { x: 200, y: 100 }, 1000), true); // too far
  assert.equal(G.escortShouldEnd(st, { x: 105, y: 103 }, 1000), false); // ok
  assert.equal(G.escortShouldEnd(st, null, 1000), true); // target gone
  assert.equal(G.escortShouldEnd(null, { x: 1, y: 1 }, 1000), true); // no state
});

// 9. Line pools are non-empty and slot-free after fill (except {name}/{site}).
check("line pools", () => {
  for (const pool of [G.CHECKIN_DAY, G.CHECKIN_NIGHT, G.DISTURBANCE_LINES, G.DISTURBANCE_QUERY_LINES, G.ESCORT_OFFER_LINES, G.REASSURE_LINES, G.TORCH_LINES]) {
    assert.ok(pool.length >= 2, "pool must have lines");
  }
  // Check-in lines fill cleanly.
  for (let i = 0; i < 20; i++) {
    const line = G.pickCheckInLine(lcg(i), i % 2 === 0);
    assert.ok(!line.includes("{") && !line.includes("}"), `unfilled slot: ${line}`);
    assert.ok(line.length > 0);
  }
});

// 10. notorietyOf falls back to 0 when memory is unavailable.
check("notorietyOf safe fallback", () => {
  assert.equal(G.notorietyOf("nobody", Date.now(), { notoriety: () => { throw new Error("x"); } }), 0);
  assert.equal(G.notorietyOf("bad", Date.now(), { notoriety: () => 0.9 }), 0.9);
});

// 11. Tuning constants are sane.
check("tuning constants", () => {
  assert.ok(G.CHECKIN_RADIUS >= G.ESCORT_OFFER_RADIUS);
  assert.ok(G.RESPONSE_RADIUS > 0);
  assert.ok(G.NOTORIETY_THRESHOLD > 0 && G.NOTORIETY_THRESHOLD <= 1);
  assert.ok(G.ESCORT_FOLLOW_MAX_TILES > 0);
  assert.ok(G.REASSURE_RADIUS > 0);
});

// 12. findPlayerByName is case-insensitive.
check("findPlayerByName", () => {
  const players = [fakePlayer(0, 0, { username: "Alice" }), fakePlayer(0, 0, { username: "bob" })];
  assert.equal(G.findPlayerByName(players, "BOB").getUsername(), "bob");
  assert.equal(G.findPlayerByName(players, "carol"), null);
});

// 13. tickGuardPatrols never throws on an empty/broken director.
check("tickGuardPatrols never throws", () => {
  G.tickGuardPatrols(null, Date.now(), lcg(1));
  G.tickGuardPatrols({}, Date.now(), lcg(1));
  G.tickGuardPatrols({ roster: new Map() }, Date.now(), lcg(1));
});

// 14. tickGuardPatrols with a guard + player fires a check-in (rng forced).
check("tickGuardPatrols check-in fires", () => {
  const said = [];
  const guard = {
    ...fakePlayer(100, 100, { username: "GuardOne" }),
    getLocalPlayers: () => [real],
    forceChat: (s) => said.push(s),
    moveTo: () => {},
  };
  const real = { ...fakePlayer(101, 100, { username: "Hero" }), getLocalPlayers: () => [] };
  guard.getLocalPlayers = () => [real, guard];
  const record = { username: "GuardOne", role: "guard" };
  const director = {
    roster: new Map([["guardone", record]]),
    playerFor: () => guard,
    onlinePlayers: () => [real],
    api: { core: {} },
  };
  // rng always returns 0 -> passes every chance gate, picks first lines.
  G.tickGuardPatrols(director, Date.now(), () => 0);
  assert.ok(said.length >= 1, "guard should have said something");
  assert.ok(said.some((s) => typeof s === "string" && s.length > 0));
});

// 15. Disturbance: notorious player draws a response.
check("tickGuardPatrols disturbance response", () => {
  const said = [];
  const moved = [];
  const real = { ...fakePlayer(105, 100, { username: "Villain" }), getLocalPlayers: () => [] };
  const guard = {
    ...fakePlayer(100, 100, { username: "GuardTwo" }),
    getLocalPlayers: () => [real, guard],
    forceChat: (s) => said.push(s),
    moveTo: (l) => moved.push(l),
  };
  const record = { username: "GuardTwo", role: "guard" };
  const director = {
    roster: new Map([["guardtwo", record]]),
    playerFor: () => guard,
    onlinePlayers: () => [real],
    api: { core: { Location: function (x, y, z) { this.x = x; this.y = y; this.z = z; } } },
  };
  // Inject high notoriety via require cache seam: temporarily stub CitizenMemory.
  const memPath = require.resolve("./CitizenMemory");
  const orig = require.cache[memPath];
  require.cache[memPath] = {
    id: memPath, filename: memPath, loaded: true,
    exports: { getMemory: () => ({ notoriety: () => 0.9 }) },
  };
  try {
    G.tickGuardPatrols(director, Date.now(), () => 0);
  } finally {
    if (orig) require.cache[memPath] = orig; else delete require.cache[memPath];
  }
  assert.ok(said.some((s) => /stand down|break it up|nobody bleeds/i.test(s)), `said: ${said.join(" | ")}`);
  assert.ok(moved.length >= 1, "guard should have moved toward the disturbance");
});

console.log(`\n${n}/${n} assertions passed`);
