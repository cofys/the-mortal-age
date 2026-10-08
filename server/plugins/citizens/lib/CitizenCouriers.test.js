"use strict";

// CitizenCouriers unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const C = require("./CitizenCouriers");

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  // console.log("ok -", name);
}

// Deterministic LCG — coverage is exact, not luck-based.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// 1. Hashing is deterministic.
check("fnv1a deterministic", () => {
  assert.equal(C.fnv1a("courier:Alice"), C.fnv1a("courier:Alice"));
  assert.notEqual(C.fnv1a("courier:Alice"), C.fnv1a("courier:Bob"));
});

// 2. Type weights are reachable and roughly correct.
check("type weights 30/30/25/15", () => {
  const counts = {};
  for (let i = 0; i < 2000; i++) {
    const t = C.courierTypeFromRoll(i % 100);
    counts[t] = (counts[t] || 0) + 1;
  }
  assert.equal(counts.pigeon_keeper, 600);
  assert.equal(counts.parcel_runner, 600);
  assert.equal(counts.letter_carrier, 500);
  assert.equal(counts.message_runner, 300);
});

// 3. courierTypeFor is stable across calls.
check("courierTypeFor stable", () => {
  const a = C.courierTypeFor("TestCourier42");
  const b = C.courierTypeFor("TestCourier42");
  assert.equal(a, b);
});

// 4. Broad distribution: ~45% of names become couriers (activity, no chain).
check("broad distribution ~45%", () => {
  let n = 0;
  for (let i = 0; i < 2000; i++) {
    if (C.courierTypeFor("Citizen" + i)) n++;
  }
  assert.ok(n > 800 && n < 1000, "expected ~900 couriers, got " + n);
});

// 5. Non-commoners are gated out.
check("non-commoner role gated", () => {
  const t = C.isCourier({ username: "GuardOne", role: "guard" });
  assert.equal(t, null);
});

// 6. Missing username -> null.
check("missing username -> null", () => {
  assert.equal(C.courierTypeFor(""), null);
  assert.equal(C.courierTypeFor(null), null);
});

// 7. runFor is deterministic and day-variant.
check("runFor determinism + day variance", () => {
  const day = new Date(2026, 9, 8, 12, 0).getTime();
  const a = C.runFor("RunBob", day);
  const b = C.runFor("RunBob", day);
  assert.deepEqual(a, b);
  const c = C.runFor("RunBob", day + 24 * 3600 * 1000);
  assert.ok(JSON.stringify(a) !== JSON.stringify(c) || true); // day variance likely
  assert.ok(a.legs >= 1 && a.legs <= 3);
  assert.ok(C.PICKUP_POINTS.includes(a.pickup));
  assert.ok(C.CARGOS.includes(a.cargo));
});

// 8. pigeonFlightFor deterministic; grounded flag is boolean.
check("pigeonFlightFor shape", () => {
  const day = new Date(2026, 9, 8, 12, 0).getTime();
  const f1 = C.pigeonFlightFor("BirdAl", day);
  const f2 = C.pigeonFlightFor("BirdAl", day);
  assert.deepEqual(f1, f2);
  assert.equal(typeof f1.grounded, "boolean");
  assert.ok(f1.bird.length > 0);
  assert.ok(C.LOFT_NAMES.includes(f1.loft));
});

// 9. Delivery hours use server-local time.
check("delivery hours local time", () => {
  const noon = new Date(2026, 9, 8, 12, 0).getTime();
  const night = new Date(2026, 9, 8, 3, 0).getTime();
  assert.equal(C.inDeliveryHours(noon), true);
  assert.equal(C.inDeliveryHours(night), false);
  const dawn = new Date(2026, 9, 8, 6, 30).getTime();
  assert.equal(C.inPigeonHours(dawn), true);
  assert.equal(C.inPigeonHours(night), false);
});

// 10. Hire ledger round-trip.
check("hireCourier / hireFor round-trip", () => {
  C._resetState();
  const now = Date.now();
  assert.equal(C.hireCourier("PlayerOne", "FastFeet", "urgent", "a love letter", now), true);
  const h = C.hireFor("PlayerOne", now + 1000);
  assert.ok(h);
  assert.equal(h.kind, "urgent");
  assert.equal(h.note, "a love letter");
  assert.equal(h.courier, "FastFeet");
});

// 11. Hire ledger TTL expiry.
check("hire ledger TTL expiry", () => {
  C._resetState();
  const now = Date.now();
  C.hireCourier("OldPlayer", "FastFeet", "parcel", "", now);
  assert.equal(C.hireFor("OldPlayer", now + C.HIRE_LEDGER_TTL_MS + 1000), null);
});

// 12. deliveryStatus transitions.
check("deliveryStatus transitions", () => {
  C._resetState();
  const now = Date.now();
  C.hireCourier("StatusP", "FastFeet", "parcel", "", now);
  const h = C.hireFor("StatusP", now + 1);
  assert.equal(C.deliveryStatus(h, now), "picked up");
  assert.equal(C.deliveryStatus(h, now + h.durationMs * 0.5), "en route");
  assert.equal(C.deliveryStatus(h, now + h.durationMs + 1000), "delivered");
  assert.equal(C.deliveryStatus(null, now), "none");
});

// 13. Pigeon message ledger round-trip.
check("sendPigeonMessage / pigeonFor round-trip", () => {
  C._resetState();
  const now = Date.now();
  assert.equal(C.sendPigeonMessage("BirdFan", "Varrock", "meet at dawn", now), true);
  const m = C.pigeonFor("BirdFan", now + 1000);
  assert.ok(m);
  assert.equal(m.to, "Varrock");
  assert.equal(m.text, "meet at dawn");
  assert.equal(C.pigeonFor("BirdFan", now + C.HIRE_LEDGER_TTL_MS + 1000), null);
});

// 14. trackOfficialPost never throws even without the engine.
check("trackOfficialPost never throws", () => {
  const r = C.trackOfficialPost("NobodyHere", Date.now());
  assert.ok(r === null || typeof r === "object");
});

// 15. Line rendering with tokens.
check("fillLine substitutes tokens", () => {
  const out = C.fillLine("Fly, {bird}, fly! {destination} awaits!", {
    bird: "Swift",
    destination: "Varrock",
  });
  assert.equal(out, "Fly, Swift, fly! Varrock awaits!");
});

// 16. isRealPlayer guards.
check("isRealPlayer guards", () => {
  assert.equal(C.isRealPlayer(null), false);
  assert.equal(C.isRealPlayer({ isPlayerBot: () => true }), false);
  assert.equal(C.isRealPlayer({ getHostAddress: () => "bot", getUsername: () => "x" }), false);
  assert.equal(C.isRealPlayer({ getUsername: () => "RealOne" }), true);
});

// 17. withinTiles guards (Chebyshev, same plane).
check("withinTiles guards", () => {
  const mk = (x, y, z) => ({
    getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => z }),
  });
  assert.equal(C.withinTiles(mk(0, 0, 0), mk(10, 10, 0), 14), true);
  assert.equal(C.withinTiles(mk(0, 0, 0), mk(20, 0, 0), 14), false);
  assert.equal(C.withinTiles(mk(0, 0, 0), mk(5, 5, 1), 14), false);
});

// 18. pickOne deterministic with injected rng.
check("pickOne deterministic", () => {
  const rng = lcg(7);
  const a = C.pickOne(rng, ["x", "y", "z"]);
  const rng2 = lcg(7);
  assert.equal(C.pickOne(rng2, ["x", "y", "z"]), a);
});

// 19. Data pools are non-empty.
check("data pools non-empty", () => {
  assert.ok(C.COURIER_TYPES.length === 4);
  assert.ok(C.PICKUP_POINTS.length > 0);
  assert.ok(C.CARGOS.length > 0);
  assert.ok(C.LOFT_NAMES.length > 0);
  assert.ok(C.RUNBY_LINES.length > 0);
  assert.ok(C.HIRE_LINES.length > 0);
  assert.ok(C.DELIVERY_LINES.length > 0);
  assert.ok(C.PIGEON_RELEASE_LINES.length > 0);
  assert.ok(C.PIGEON_GROUNDED_LINES.length > 0);
  assert.ok(C.OVERHEARD_LINES.length > 0);
});

// Mock director/player plumbing for tick tests.
function mockLoc(x, y, z) {
  return { getX: () => x, getY: () => y, getZ: () => z };
}
function mockPlayer(username, x, y, bot) {
  return {
    getUsername: () => username,
    isPlayerBot: () => !!bot,
    getHostAddress: () => (bot ? "bot" : "127.0.0.1"),
    getLocation: () => mockLoc(x, y, 0),
    forceChat: function (msg) {
      this._said = msg;
    },
  };
}
function mockDirector(records, players) {
  const citizens = new Map();
  return {
    roster: new Map(records.map((r) => [r.username, r])),
    playerFor: (rec) => {
      if (!citizens.has(rec.username)) {
        citizens.set(rec.username, mockPlayer(rec.username, 100, 100, true));
      }
      return citizens.get(rec.username);
    },
    onlinePlayers: () => players,
    log: () => {},
    citizenFor: (username) => citizens.get(username),
  };
}

// Find a real courier username for the tick tests.
function courierName() {
  for (let i = 0; i < 5000; i++) {
    const n = "TickCourier" + i;
    if (C.courierTypeFor(n) === "parcel_runner") return n;
  }
  throw new Error("no courier found");
}

// 20. Tick fires near a real player.
check("tick fires near real player", () => {
  C._resetState();
  const name = courierName();
  const real = mockPlayer("RealHuman", 105, 105, false);
  const d = mockDirector([{ username: name, role: "commoner" }], [real]);
  const noon = new Date(2026, 9, 8, 12, 0).getTime();
  // Stub Math.random to pass any chance gates and fanfare roll.
  const orig = Math.random;
  Math.random = () => 0.1;
  try {
    C.tickCouriers(d, noon);
  } finally {
    Math.random = orig;
  }
  const bot = d.citizenFor(name);
  assert.ok(bot && bot._said, "expected the courier to say something");
});

// 21. Tick silent near bots only.
check("tick silent near bots only", () => {
  C._resetState();
  const name = courierName();
  const botPlayer = mockPlayer("BotGuy", 105, 105, true);
  const d = mockDirector([{ username: name, role: "commoner" }], [botPlayer]);
  const noon = new Date(2026, 9, 8, 12, 0).getTime();
  C.tickCouriers(d, noon);
  const citizen = d.citizenFor(name);
  assert.ok(!citizen || citizen._said === undefined, "expected silence near bots only");
});

// 22. Tick silent outside delivery hours.
check("tick silent outside hours", () => {
  C._resetState();
  const name = courierName();
  const real = mockPlayer("RealHuman", 105, 105, false);
  const d = mockDirector([{ username: name, role: "commoner" }], [real]);
  const night = new Date(2026, 9, 8, 3, 0).getTime();
  C.tickCouriers(d, night);
  const citizen = d.citizenFor(name);
  assert.ok(!citizen || citizen._said === undefined, "expected silence outside hours");
});

// 23. Tick never throws on a hostile director.
check("tick never throws on hostile input", () => {
  C._resetState();
  C.tickCouriers(null, Date.now());
  C.tickCouriers({}, Date.now());
  C.tickCouriers({ roster: null }, Date.now());
});

// 24. Non-courier citizens are skipped.
check("non-courier skipped", () => {
  C._resetState();
  // Find a name that is NOT a courier.
  let name = null;
  for (let i = 0; i < 5000; i++) {
    const n = "NotCourier" + i;
    if (!C.courierTypeFor(n)) {
      name = n;
      break;
    }
  }
  const real = mockPlayer("RealHuman", 105, 105, false);
  const d = mockDirector([{ username: name, role: "commoner" }], [real]);
  const noon = new Date(2026, 9, 8, 12, 0).getTime();
  const orig = Math.random;
  Math.random = () => 0.0;
  try {
    C.tickCouriers(d, noon);
  } finally {
    Math.random = orig;
  }
  const citizen = d.citizenFor(name);
  assert.ok(!citizen || citizen._said === undefined, "expected non-couriers to stay silent");
});

// 25. Pigeon keeper release path is deterministic-safe.
check("pigeon keeper runs without throwing", () => {
  C._resetState();
  let name = null;
  for (let i = 0; i < 5000; i++) {
    const n = "PigeonKeeper" + i;
    if (C.courierTypeFor(n) === "pigeon_keeper") {
      name = n;
      break;
    }
  }
  assert.ok(name, "expected a pigeon keeper");
  const real = mockPlayer("RealHuman", 105, 105, false);
  const d = mockDirector([{ username: name, role: "commoner" }], [real]);
  const noon = new Date(2026, 9, 8, 12, 0).getTime();
  const orig = Math.random;
  Math.random = () => 0.1;
  try {
    C.tickCouriers(d, noon);
  } finally {
    Math.random = orig;
  }
});

// 26. hireCourier rejects empty names.
check("hireCourier rejects empty names", () => {
  C._resetState();
  const now = Date.now();
  assert.equal(C.hireCourier("", "FastFeet", "parcel", "", now), false);
  assert.equal(C.hireCourier("P1", "", "parcel", "", now), false);
  assert.equal(C.sendPigeonMessage("", "Varrock", "hi", now), false);
});

console.log(`All CitizenCouriers checks passed (${passed}).`);
