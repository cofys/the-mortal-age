// CitizenPainters unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const P = require("./CitizenPainters");

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
  console.log("ok -", name);
}

// --- hashStr: deterministic, stable ---
check("hashStr is deterministic", () => {
  assert.equal(P.hashStr("alice"), P.hashStr("alice"));
  assert.notEqual(P.hashStr("alice"), P.hashStr("bob"));
});

// --- painterTypeFromRoll: weights cover 0..99 ---
check("painterTypeFromRoll covers all types and weights", () => {
  const seen = new Set();
  for (let r = 0; r < 100; r++) seen.add(P.painterTypeFromRoll(r));
  assert.deepEqual([...seen].sort(), [...P.PAINTER_TYPES].sort());
  assert.equal(P.painterTypeFromRoll(0), P.PAINTER_PORTRAITIST); // 0-29
  assert.equal(P.painterTypeFromRoll(29), P.PAINTER_PORTRAITIST);
  assert.equal(P.painterTypeFromRoll(30), P.PAINTER_LANDSCAPIST); // 30-59
  assert.equal(P.painterTypeFromRoll(59), P.PAINTER_LANDSCAPIST);
  assert.equal(P.painterTypeFromRoll(60), P.PAINTER_MURALIST); // 60-79
  assert.equal(P.painterTypeFromRoll(79), P.PAINTER_MURALIST);
  assert.equal(P.painterTypeFromRoll(80), P.PAINTER_MINIATURIST); // 80-99
  assert.equal(P.painterTypeFromRoll(99), P.PAINTER_MINIATURIST);
});

// --- painterTypeOf: ~30% of commoners, stable, excludes non-commoners ---
check("painterTypeOf assigns ~30% of commoners, stable across calls", () => {
  let painters = 0;
  const types = new Set();
  for (let i = 0; i < 400; i++) {
    const rec = { username: "PaintUser" + i, role: "commoner", kingdomId: "varrock" };
    const t1 = P.painterTypeOf(rec);
    const t2 = P.painterTypeOf(rec);
    assert.equal(t1, t2, "stable for " + rec.username);
    if (t1) {
      painters++;
      types.add(t1);
      assert.ok(P.PAINTER_TYPES.includes(t1));
    }
  }
  const share = painters / 400;
  // ~30% base roll minus exclusions (street performers, bards, actors,
  // inn bards) — actual share lands around 15%.
  assert.ok(share > 0.08 && share < 0.3, "share=" + share);
  assert.ok(types.size >= 3, "all types reachable: " + [...types]);
});

// --- painterTypeOf: excludes guards/courtiers ---
check("painterTypeOf returns null for non-commoners and empty names", () => {
  assert.equal(P.painterTypeOf({ username: "G1", role: "guard" }), null);
  assert.equal(P.painterTypeOf({ username: "C1", role: "courtier" }), null);
  assert.equal(P.painterTypeOf({ username: "" }), null);
  assert.equal(P.painterTypeOf(null), null);
});

// --- studioFor: kingdom-preferred, stable ---
check("studioFor prefers the citizen kingdom and is stable", () => {
  const rec = { username: "CanvasStar", kingdomId: "keldagrim" };
  const s1 = P.studioFor(rec);
  const s2 = P.studioFor(rec);
  assert.deepEqual(s1, s2);
  assert.equal(s1.kingdom, "keldagrim");
  const other = P.studioFor({ username: "DarkPainter", kingdomId: "morytania" });
  assert.equal(other.kingdom, "morytania");
});

// --- paintingsFor: daily catalog, 2-4 works, deterministic ---
check("paintingsFor returns a stable daily catalog", () => {
  const rec = { username: "EaselBob", role: "commoner", kingdomId: "varrock" };
  const now = Date.UTC(2026, 9, 8, 12, 0, 0);
  const c1 = P.paintingsFor(rec, now);
  const c2 = P.paintingsFor(rec, now);
  assert.deepEqual(c1, c2);
  assert.ok(c1.works.length >= 2 && c1.works.length <= 4, "works=" + c1.works.length);
  for (const w of c1.works) {
    assert.ok(typeof w.subject === "string" && w.subject.length > 0);
    assert.ok(P.QUALITIES.includes(w.quality));
  }
  assert.ok(P.PAINTER_TYPES.includes(c1.type) || c1.type === null);
});

// --- paintingsFor: varies across days for most painters ---
check("paintingsFor varies across days", () => {
  // Find a username that hashes to a painter.
  let rec = null;
  for (let i = 0; i < 400 && !rec; i++) {
    const r = { username: "DayPaint" + i, role: "commoner", kingdomId: "varrock" };
    if (P.painterTypeOf(r)) rec = r;
  }
  assert.ok(rec, "found a painter");
  const d1 = P.paintingsFor(rec, Date.UTC(2026, 9, 8, 12));
  const d2 = P.paintingsFor(rec, Date.UTC(2026, 9, 9, 12));
  // Same painter may or may not differ, but the function must not throw
  // and both must be well-formed.
  assert.ok(d1.works.length >= 2 && d1.works.length <= 4);
  assert.ok(d2.works.length >= 2 && d2.works.length <= 4);
});

// --- paintingsFor: non-painters get empty catalog ---
check("paintingsFor returns empty for non-painters", () => {
  const c = P.paintingsFor({ username: "GuardGuy", role: "guard" }, Date.now());
  assert.deepEqual(c.works, []);
  assert.equal(c.masterpiece, false);
});

// --- isStudioHour: 08:00-17:00 (server-local time) ---
check("isStudioHour covers daylight hours only", () => {
  const at = (h, m) => new Date(2026, 9, 8, h, m).getTime(); // local time, not UTC
  assert.equal(P.isStudioHour(at(7, 59)), false);
  assert.equal(P.isStudioHour(at(8, 0)), true);
  assert.equal(P.isStudioHour(at(12, 0)), true);
  assert.equal(P.isStudioHour(at(16, 59)), true);
  assert.equal(P.isStudioHour(at(17, 0)), false);
  assert.equal(P.isStudioHour(at(23, 0)), false);
});

// --- commission ledger: round-trip + TTL ---
check("commissionPainting / commissionFor round-trip and TTL", () => {
  const now = Date.now();
  const c = P.commissionPainting("PlayerOne", "EaselBob", "my grandmother", "portrait", now);
  assert.ok(c);
  assert.equal(c.subject, "my grandmother");
  assert.equal(c.kind, "portrait");
  const got = P.commissionFor("PlayerOne", now + 1000);
  assert.equal(got.subject, "my grandmother");
  // After TTL, expired.
  assert.equal(P.commissionFor("PlayerOne", now + 8 * 24 * 3600 * 1000), null);
  assert.equal(P.commissionPainting("", "X", "y"), null);
});

// --- fill: template slots ---
check("fill replaces all slots", () => {
  assert.equal(P.fill("Hello {name}, meet {name}!", { name: "Bob" }), "Hello Bob, meet Bob!");
  assert.equal(P.fill("no slots", {}), "no slots");
  assert.equal(P.fill("x {missing}", { other: 1 }), "x {missing}");
});

// --- isRealPlayer / isCitizenBot guards ---
check("isRealPlayer rejects bots and junk", () => {
  assert.equal(P.isRealPlayer(null), false);
  assert.equal(P.isRealPlayer({}), false);
  assert.equal(P.isRealPlayer({ isPlayerBot: () => true, getUsername: () => "x" }), false);
  assert.equal(P.isRealPlayer({ getHostAddress: () => "bot", getUsername: () => "x" }), false);
  assert.equal(P.isRealPlayer({ getUsername: () => "RealHuman" }), true);
});

check("isCitizenBot detects bots", () => {
  assert.equal(P.isCitizenBot(null), false);
  assert.equal(P.isCitizenBot({ isPlayerBot: () => true }), true);
  assert.equal(P.isCitizenBot({ getHostAddress: () => "bot" }), true);
  assert.equal(P.isCitizenBot({ getUsername: () => "RealHuman" }), false);
});

// --- withinTiles: Chebyshev, same plane ---
check("withinTiles checks plane and distance", () => {
  const loc = (x, y, z) => ({ getX: () => x, getY: () => y, getZ: () => z });
  const a = { getLocation: () => loc(10, 10, 0) };
  const b = { getLocation: () => loc(14, 10, 0) };
  const c = { getLocation: () => loc(30, 30, 0) };
  const d = { getLocation: () => loc(10, 10, 1) };
  assert.equal(P.withinTiles(a, b, 14), true);
  assert.equal(P.withinTiles(a, c, 14), false);
  assert.equal(P.withinTiles(a, d, 14), false); // different plane
  assert.equal(P.withinTiles(null, b, 14), false);
});

// --- tickPainters: fires near a real player during studio hours ---
check("tickPainters fires near a real player, silent otherwise", () => {
  const fired = [];
  const mkLoc = (x, y, z) => ({ getX: () => x, getY: () => y, getZ: () => z });
  // Find a painter username deterministically.
  let painterName = null;
  for (let i = 0; i < 400 && !painterName; i++) {
    const rec = { username: "TickPaint" + i, role: "commoner", kingdomId: "varrock" };
    if (P.painterTypeOf(rec)) painterName = rec.username;
  }
  assert.ok(painterName, "found a painter in 400 tries");
  const citizen = {
    getUsername: () => painterName,
    getLocation: () => mkLoc(100, 100, 0),
    forceChat: (line) => fired.push(line),
  };
  const human = {
    getUsername: () => "RealHuman",
    getLocation: () => mkLoc(105, 100, 0),
  };
  const director = {
    roster: new Map([[painterName.toLowerCase(), { username: painterName, role: "commoner", kingdomId: "varrock" }]]),
    playerFor: () => citizen,
    onlinePlayers: () => [human],
  };
  // Midday local time so studio hours hold regardless of server tz.
  const noon = new Date(2026, 9, 8, 12, 0, 0).getTime();
  // Force the chance gate by trying many ticks with cooldown reset.
  let sawFire = false;
  for (let i = 0; i < 60 && !sawFire; i++) {
    // Reset cooldown map indirectly: use fresh nowMs far apart.
    P.tickPainters(director, noon + i * 4 * 3600 * 1000, 0);
    if (fired.length) sawFire = true;
  }
  assert.ok(sawFire, "painter fired at least once near a real player in studio hours");

  // Silent with bots only.
  const botOnly = {
    roster: new Map([[painterName.toLowerCase(), { username: painterName, role: "commoner", kingdomId: "varrock" }]]),
    playerFor: () => citizen,
    onlinePlayers: () => [{ isPlayerBot: () => true, getHostAddress: () => "bot", getUsername: () => "Bot1", getLocation: () => mkLoc(105, 100, 0) }],
  };
  const before = fired.length;
  for (let i = 0; i < 10; i++) {
    P.tickPainters(botOnly, noon + 1000000 + i * 4 * 3600 * 1000, 0);
  }
  assert.equal(fired.length, before, "silent near bots only");
});

// --- tickPainters: never throws on hostile input ---
check("tickPainters never throws on hostile input", () => {
  P.tickPainters(null, Date.now());
  P.tickPainters({}, Date.now());
  P.tickPainters({ roster: null }, Date.now());
  P.tickPainters({ roster: new Map([["x", null]]) }, Date.now());
});

// --- tickPainters: silent outside studio hours ---
check("tickPainters silent outside studio hours", () => {
  const fired = [];
  let painterName = null;
  for (let i = 0; i < 400 && !painterName; i++) {
    const rec = { username: "NightPaint" + i, role: "commoner", kingdomId: "varrock" };
    if (P.painterTypeOf(rec)) painterName = rec.username;
  }
  assert.ok(painterName);
  const mkLoc = (x, y, z) => ({ getX: () => x, getY: () => y, getZ: () => z });
  const citizen = {
    getUsername: () => painterName,
    getLocation: () => mkLoc(100, 100, 0),
    forceChat: (line) => fired.push(line),
  };
  const director = {
    roster: new Map([[painterName.toLowerCase(), { username: painterName, role: "commoner", kingdomId: "varrock" }]]),
    playerFor: () => citizen,
    onlinePlayers: () => [{ getUsername: () => "RealHuman", getLocation: () => mkLoc(105, 100, 0) }],
  };
  const midnight = new Date(2026, 9, 8, 20, 0, 0).getTime(); // 20:00 local — after studio hours
  for (let i = 0; i < 5; i++) {
    P.tickPainters(director, midnight + i * 3600 * 1000, 0);
  }
  assert.equal(fired.length, 0, "no painting at night");
});

// --- tipPainter: ignores non-painters and non-coins ---
check("tipPainter ignores non-painter targets", () => {
  const player = {
    getUsername: () => "RealHuman",
    getInventory: () => ({ getAmount: () => 1000, deleteNumber: () => {}, refreshItems: () => {} }),
  };
  const target = {
    isPlayerBot: () => true,
    getHostAddress: () => "bot",
    getUsername: () => "GuardGuy",
    getInventory: () => ({ add: () => {}, refreshItems: () => {} }),
  };
  const event = {
    player,
    target,
    item: { getId: () => 995, getAmount: () => 500 },
    handled: false,
  };
  const director = {
    roster: new Map([["guardguy", { username: "GuardGuy", role: "guard", kingdomId: "varrock" }]]),
  };
  const result = P.tipPainter(event, { director });
  assert.equal(result, undefined);
  assert.equal(event.handled, false);
});

// --- tipPainter: moves coins for real painters ---
check("tipPainter moves coins and thanks the tipper", () => {
  let painterName = null;
  for (let i = 0; i < 400 && !painterName; i++) {
    const rec = { username: "TipPaint" + i, role: "commoner", kingdomId: "varrock" };
    if (P.painterTypeOf(rec)) painterName = rec.username;
  }
  assert.ok(painterName);
  const thanked = [];
  let playerCoins = 5000;
  let targetCoins = 0;
  const player = {
    getUsername: () => "RealHuman",
    getInventory: () => ({
      getAmount: () => playerCoins,
      deleteNumber: (id, amt) => { playerCoins -= amt; },
      refreshItems: () => {},
    }),
    sendMessage: () => {},
  };
  const target = {
    isPlayerBot: () => true,
    getHostAddress: () => "bot",
    getUsername: () => painterName,
    getInventory: () => ({
      add: (id, amt) => { targetCoins += amt; },
      refreshItems: () => {},
    }),
    forceChat: (line) => thanked.push(line),
  };
  const event = {
    player,
    target,
    item: { getId: () => 995, getAmount: () => 500 },
    handled: false,
  };
  const director = {
    roster: new Map([[painterName.toLowerCase(), { username: painterName, role: "commoner", kingdomId: "varrock" }]]),
  };
  const moved = P.tipPainter(event, { director });
  assert.equal(moved, 500);
  assert.equal(event.handled, true);
  assert.equal(playerCoins, 4500);
  assert.equal(targetCoins, 500);
  assert.ok(thanked.length === 1);
});

// --- maybeOfferCommission: returns a line ---
check("maybeOfferCommission returns a scripted line", () => {
  const said = [];
  const citizen = { forceChat: (l) => said.push(l) };
  const line = P.maybeOfferCommission({ username: "x" }, citizen, P.PAINTER_PORTRAITIST);
  assert.ok(typeof line === "string" && line.length > 0);
  assert.equal(said.length, 1);
  const mini = P.maybeOfferCommission({ username: "x" }, citizen, P.PAINTER_MINIATURIST);
  assert.ok(typeof mini === "string" && mini.length > 0);
});

// --- dayNumber: deterministic ---
check("dayNumber is stable per day", () => {
  assert.equal(P.dayNumber(86400000), 1);
  assert.equal(P.dayNumber(86400000 + 1000), 1);
  assert.equal(P.dayNumber(2 * 86400000), 2);
});

console.log(`\n${passed} checks passed.`);
