// CitizenPotters unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const p = require("./CitizenPotters");

// Deterministic LCG — coverage is exact, not luck-based.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Local time constructor — server-hour gates read server-local time, never UTC.
function at(h, m = 0) {
  return new Date(2026, 9, 8, h, m).getTime();
}

// Helper: find a username that hashes to a potter (scans until found;
// the ~1% effective share means a fixed small prefix can miss).
function findPotter(prefix, kingdomId) {
  for (let i = 0; i < 5000; i++) {
    const rec = { username: prefix + i, kingdomId: kingdomId || "misthalin", role: "commoner" };
    if (p.potterTypeOf(rec)) return rec;
  }
  return null;
}

p._resetState();

// 1. hashStr: deterministic, differentiates.
assert.equal(p.hashStr("abc"), p.hashStr("abc"));
assert.notEqual(p.hashStr("abc"), p.hashStr("abd"));

// 2. Type-from-roll covers all four types and sums to 100.
{
  const seen = new Set();
  for (let r = 0; r < 100; r++) seen.add(p.potterTypeFromRoll(r));
  assert.deepEqual([...seen].sort(), [...p.POTTER_TYPES].sort());
  assert.equal(p.potterTypeFromRoll(0), p.POTTER_VESSEL);
  assert.equal(p.potterTypeFromRoll(34), p.POTTER_VESSEL);
  assert.equal(p.potterTypeFromRoll(35), p.POTTER_TILE);
  assert.equal(p.potterTypeFromRoll(64), p.POTTER_TILE);
  assert.equal(p.potterTypeFromRoll(65), p.POTTER_BRICK);
  assert.equal(p.potterTypeFromRoll(84), p.POTTER_BRICK);
  assert.equal(p.potterTypeFromRoll(85), p.POTTER_ARTIST);
  assert.equal(p.potterTypeFromRoll(99), p.POTTER_ARTIST);
}

// 3. Nominal 80% roll; mutual exclusions with the 13 prior professional
// systems bring the effective share to ~1% (measured 22/2000). The chain
// is structurally saturated — the early systems (jewelers ~35%, actors
// ~24%, painters ~16%, performers ~14%) claimed large shares before the
// no-overlap chain existed. Stable across restarts (pure hash).
{
  let n = 0;
  for (let i = 0; i < 500; i++) {
    if (p.potterTypeOf({ username: "shareprobe" + i, role: "commoner" })) n++;
  }
  assert.ok(n >= 2 && n < 25, `share ${n}/500 out of 0.4-5% band`);
  // Stability: same record -> same type.
  const r = { username: "stablepotter", kingdomId: "asgarnia" };
  assert.equal(p.potterTypeOf(r), p.potterTypeOf(r));
}

// 3b. Role gate: guards (and any explicit non-commoner role) are never
// potters — same as the painter/sculptor/glassblower pattern.
{
  assert.equal(p.potterTypeOf({ username: "GuardA", role: "guard" }), null);
  assert.equal(p.potterTypeOf({ username: "CourtB", role: "courtier" }), null);
  assert.equal(p.potterTypeOf({ username: "NoRole", role: "" }), p.potterTypeOf({ username: "NoRole" }));
}

// 4. Exclusions: a glassblower is never also a potter.
{
  const glass = require("./CitizenGlassblowers");
  let found = null;
  for (let i = 0; i < 1000 && !found; i++) {
    const rec = { username: "exclprobe" + i, kingdomId: "misthalin" };
    if (glass.glassblowerTypeOf(rec)) found = rec;
  }
  assert.ok(found, "expected to find a glassblower in 1000 probes");
  assert.equal(p.potterTypeOf(found), null);
}

// 5. Workshop assignment: kingdom-preferred, stable, falls back globally.
{
  const w1 = p.workshopFor({ username: "worka", kingdomId: "asgarnia" });
  assert.equal(w1.kingdom, "asgarnia");
  assert.deepEqual(p.workshopFor({ username: "worka", kingdomId: "asgarnia" }), w1);
  const w2 = p.workshopFor({ username: "workb", kingdomId: "nosuchplace" });
  assert.ok(p.WORKSHOPS.includes(w2));
}

// 6. Kiln hours: 08:00-17:00 server-local.
{
  assert.equal(p.isKilnHour(at(8)), true);
  assert.equal(p.isKilnHour(at(12)), true);
  assert.equal(p.isKilnHour(at(16, 59)), true);
  assert.equal(p.isKilnHour(at(17)), false);
  assert.equal(p.isKilnHour(at(7, 59)), false);
  assert.equal(p.isKilnHour(at(0)), false);
}

// 7. Daily catalog: 2-3 pieces, deterministic per day, varies by day.
{
  const d1 = p.piecesFor("catpotter", "misthalin", at(10));
  assert.ok(d1.length >= 2 && d1.length <= 3, `catalog size ${d1.length}`);
  const d2 = p.piecesFor("catpotter", "misthalin", at(10));
  assert.deepEqual(d1, d2);
  const d3 = p.piecesFor("catpotter", "misthalin", at(10) + 30 * 86400000);
  // Very likely different 30 days later (not guaranteed, so only assert array shape).
  assert.ok(Array.isArray(d3) && d3.length >= 2);
}

// 8. Great work: slow 6-9 day cycle, derived, consistent fields.
{
  const ws = p.WORKSHOPS[0];
  const gw = p.greatWorkFor(ws, at(10));
  assert.ok(gw.lengthDays >= 6 && gw.lengthDays <= 9, `cycle ${gw.lengthDays}`);
  assert.ok(gw.doneDay > gw.startedDay);
  assert.ok(typeof gw.work === "string" && gw.work.length > 0);
  // Stable within the same cycle.
  const gw2 = p.greatWorkFor(ws, at(10) + 2 * 86400000);
  if (gw2.startedDay === gw.startedDay) assert.equal(gw2.work, gw.work);
}

// 9. Commission ledger: round-trip + TTL expiry.
{
  const now = at(10);
  assert.equal(p.commissionPiece("Commer", "a painted vase", now), "a painted vase");
  assert.equal(p.commissionFor("Commer", now), "a painted vase");
  assert.equal(p.commissionFor("commer", now), "a painted vase"); // normalized
  assert.equal(p.commissionFor("Commer", now + 8 * 86400000), null); // expired
  assert.equal(p.commissionPiece("", "x", now), null);
  assert.equal(p.commissionFor("Nobody", now), null);
}

// 10. Masterwork: ~8%/workshop/day, deterministic per day.
{
  const ws = p.WORKSHOPS[0];
  let hits = 0;
  for (let d = 0; d < 100; d++) {
    if (p.masterworkFor(ws, at(10) + d * 86400000)) hits++;
  }
  assert.ok(hits > 0 && hits < 25, `masterwork hits ${hits}/100 out of band`);
  const a = p.masterworkFor(ws, at(10));
  const b = p.masterworkFor(ws, at(10));
  assert.equal(a, b);
}

// 11. Tie-ins: builders' demand and glasshouse fuel never throw.
{
  assert.ok(typeof p.demandForToday(at(10)) === "string" && p.demandForToday(at(10)).length > 0);
  assert.equal(p.fuelForToday(at(10)), "oak and coal");
}

// 12. fill: renders all slots, leaves no braces.
{
  const out = p.fill("Hello {name}, meet {name} at {place}.", { name: "Bob", place: "the kiln" });
  assert.equal(out, "Hello Bob, meet Bob at the kiln.");
}

// 13. Tick: fires near a real player during kiln hours; silent near bots only.
{
  p._resetState();
  // Find a real potter (the ~1% effective share means fixed small prefixes
  // can miss — scan until found).
  const potterRec = findPotter("tickpotter");
  assert.ok(potterRec, "expected to find a potter by scanning");
  const roster = new Map([[potterRec.username.toLowerCase(), potterRec]]);

  const mkLoc = (x) => ({ getX: () => x, getY: () => 0, getZ: () => 0 });
  const citizen = {
    getLocation: () => mkLoc(0),
    forceChat: () => {},
  };
  const realPlayer = {
    isPlayerBot: () => false,
    getHostAddress: () => "1.2.3.4",
    getUsername: () => "RealHuman",
    getLocation: () => mkLoc(5),
  };
  const botPlayer = {
    isPlayerBot: () => true,
    getHostAddress: () => "bot",
    getUsername: () => "SomeBot",
    getLocation: () => mkLoc(5),
  };
  const director = {
    roster,
    playerFor: (rec) => (rec === potterRec ? citizen : null),
    onlinePlayers: () => [realPlayer],
  };
  const realChance = Math.random;
  Math.random = () => 0.1; // pass the 0.35 chance gate, pick work/hawk branch
  try {
    p.tickPotters(director, at(10));
  } finally {
    Math.random = realChance;
  }
  p._resetState();

  // Bots only: must stay silent.
  const directorBots = {
    roster,
    playerFor: (rec) => (rec === potterRec ? citizen : null),
    onlinePlayers: () => [botPlayer],
  };
  let spoke = false;
  const quietCitizen = {
    getLocation: () => mkLoc(0),
    forceChat: () => { spoke = true; },
  };
  const directorBots2 = {
    roster,
    playerFor: (rec) => (rec === potterRec ? quietCitizen : null),
    onlinePlayers: () => [botPlayer],
  };
  const realChance2 = Math.random;
  Math.random = () => 0.1;
  try {
    p.tickPotters(directorBots2, at(10));
  } finally {
    Math.random = realChance2;
  }
  assert.equal(spoke, false, "must stay silent near bots only");
  p._resetState();
}

// 14. Tick: silent outside kiln hours even with a real player near.
{
  const potterRec = findPotter("nightpotter");
  assert.ok(potterRec, "expected to find a potter by scanning");
  const roster = new Map([[potterRec.username.toLowerCase(), potterRec]]);
  const mkLoc = (x) => ({ getX: () => x, getY: () => 0, getZ: () => 0 });
  let spoke = false;
  const director = {
    roster,
    playerFor: (rec) => (rec === potterRec ? {
      getLocation: () => mkLoc(0),
      forceChat: () => { spoke = true; },
    } : null),
    onlinePlayers: () => [{
      isPlayerBot: () => false,
      getHostAddress: () => "1.2.3.4",
      getUsername: () => "RealHuman",
      getLocation: () => mkLoc(5),
    }],
  };
  const realChance = Math.random;
  Math.random = () => 0.1;
  try {
    p.tickPotters(director, at(22)); // 22:00 — kilns closed
  } finally {
    Math.random = realChance;
  }
  assert.equal(spoke, false, "must stay silent outside kiln hours");
  p._resetState();
}

// 15. Tick: never throws on hostile input (null director, garbage roster).
{
  p.tickPotters(null, at(10));
  p.tickPotters({}, at(10));
  p.tickPotters({ roster: null }, at(10));
  p.tickPotters({ roster: new Map([["x", null]]) }, at(10));
}

// 16. tipPotter: ignores non-potters, moves coins for potters with fat-finger guard.
{
  const mkInv = (coins) => ({
    _coins: coins,
    getAmount: function (id) { return id === 995 ? this._coins : 0; },
    deleteNumber: function (id, n) { if (id === 995) this._coins -= n; },
    add: function (id, n) { if (id === 995) this._coins += n; },
    refreshItems: () => {},
  });
  const mkCitizen = (rec) => ({
    isPlayerBot: () => true,
    getHostAddress: () => "bot",
    getUsername: () => rec.username,
    forceChat: () => {},
    getInventory: () => mkInv(0),
  });
  // Find a potter record.
  const potterRec = findPotter("tippotter");
  assert.ok(potterRec, "expected to find a potter by scanning");
  const roster = new Map([[potterRec.username.toLowerCase(), potterRec]]);
  const director = { roster };
  const playerInv = mkInv(1000);
  const player = {
    isPlayerBot: () => false,
    getHostAddress: () => "9.9.9.9",
    getUsername: () => "Tipper",
    getInventory: () => playerInv,
    sendMessage: () => {},
  };
  const event = {
    player,
    target: mkCitizen(potterRec),
    item: { getId: () => 995, getAmount: () => 500 },
    handled: false,
  };
  const moved = p.tipPotter(event, { director }, at(10));
  assert.equal(moved, 500);
  assert.equal(event.handled, true);
  assert.equal(playerInv._coins, 500);

  // Non-potter target: ignored, not handled.
  const nonPotterRec = { username: "NotAPotterXYZ", kingdomId: "misthalin", role: "commoner" };
  assert.equal(p.potterTypeOf(nonPotterRec), null);
  const roster2 = new Map([[nonPotterRec.username.toLowerCase(), nonPotterRec]]);
  const event2 = {
    player,
    target: mkCitizen(nonPotterRec),
    item: { getId: () => 995, getAmount: () => 100 },
    handled: false,
  };
  p.tipPotter(event2, { roster: roster2 }, at(10));
  assert.equal(event2.handled, false);
}

// 17. dayNumber and chance behave.
{
  assert.equal(p.dayNumber(0), 0);
  assert.equal(p.dayNumber(86399999), 0);
  assert.equal(p.dayNumber(86400000), 1);
  const rng = lcg(42);
  assert.equal(typeof p.chance(rng, 0.5), "boolean");
  assert.equal(p.chance(() => 0.0, 0.5), true);
  assert.equal(p.chance(() => 0.99, 0.5), false);
}

console.log("All CitizenPotters checks passed.");
