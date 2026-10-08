// CitizenBards unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const B = require("./CitizenBards");

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
  console.log("ok - " + name);
}

// --- hashing ---
check("hashStr is deterministic and spreads", () => {
  assert.equal(B.hashStr("Alice"), B.hashStr("Alice"));
  assert.notEqual(B.hashStr("Alice"), B.hashStr("Bob"));
});

// --- type rolls ---
check("bardTypeFromRoll covers all types per weights", () => {
  const seen = new Set();
  for (let r = 0; r < 100; r++) seen.add(B.bardTypeFromRoll(r));
  assert.deepEqual([...seen].sort(), ["instrumentalist", "jester", "minstrel", "storyteller"]);
  assert.equal(B.bardTypeFromRoll(0), "minstrel");
  assert.equal(B.bardTypeFromRoll(99), "jester");
});

// --- bardTypeOf exclusions ---
function rec(username, role = "commoner", kingdomId = "varrock") {
  return { username, role, kingdomId };
}

check("bardTypeOf rejects non-commoners and empties", () => {
  assert.equal(B.bardTypeOf(null), null);
  assert.equal(B.bardTypeOf(rec("x", "guard")), null);
  assert.equal(B.bardTypeOf({ username: "" }), null);
});

check("bardTypeOf is deterministic per username", () => {
  // find a username that IS a bard and one that is NOT
  let bardName = null, nonBardName = null;
  for (let i = 0; i < 500 && (!bardName || !nonBardName); i++) {
    const n = "TestUser" + i;
    const t = B.bardTypeOf(rec(n));
    if (t && !bardName) bardName = n;
    if (!t && !nonBardName) nonBardName = n;
  }
  assert.ok(bardName, "some usernames are bards");
  assert.ok(nonBardName, "some usernames are not bards");
  assert.equal(B.bardTypeOf(rec(bardName)), B.bardTypeOf(rec(bardName)));
});

check("bardTypeOf excludes street performers", () => {
  // Find a username that is a street performer and would otherwise be a bard.
  const SP = require("./CitizenStreetPerformers");
  let found = null;
  for (let i = 0; i < 2000 && !found; i++) {
    const n = "BuskerCheck" + i;
    const r = rec(n);
    if (SP.performerTypeOf(r)) found = n;
  }
  assert.ok(found, "found a street performer username");
  assert.equal(B.bardTypeOf(rec(found)), null);
});

// --- venues / troupes ---
check("venueFor prefers the citizen kingdom", () => {
  const v = B.venueFor(rec("VenueGal", "commoner", "keldagrim"));
  assert.equal(v.kingdom, "keldagrim");
  assert.ok(v.name.length > 3);
});

check("troupeForKingdom returns the kingdom troupe", () => {
  assert.equal(B.troupeForKingdom("varrock").name, "the Gilded Lute");
  assert.equal(B.troupeForKingdom("morytania").name, "the Nightingales of Darkmeyer");
  assert.ok(B.troupeForKingdom("unknown-kingdom").name.length > 3);
});

check("tourKingdomFor rotates weekly and stays in the ring", () => {
  const t = B.troupeForKingdom("varrock");
  const ring = ["varrock", "asgarnia", "kandarin", "keldagrim", "morytania"];
  const w0 = B.tourKingdomFor(t, 0);
  const w1 = B.tourKingdomFor(t, 7 * 86400000);
  assert.ok(ring.includes(w0));
  assert.ok(ring.includes(w1));
  assert.notEqual(w0, w1);
  assert.equal(B.tourKingdomFor(t, 0), B.tourKingdomFor(t, 1000)); // same week
});

// --- repertoire ---
check("songFor is daily-deterministic and varies by day", () => {
  const a = B.songFor("Bardy", "minstrel", 1000000);
  assert.equal(a, B.songFor("Bardy", "minstrel", 1000000));
  assert.ok(B.REPERTOIRE.minstrel.includes(a));
  // across many days, more than one song appears
  const songs = new Set();
  for (let d = 0; d < 30; d++) songs.add(B.songFor("Bardy", "minstrel", d * 86400000));
  assert.ok(songs.size > 1);
});

check("songExists matches case-insensitively", () => {
  assert.ok(B.songExists("The King's Road"));
  assert.ok(B.songExists("the king's road"));
  assert.ok(!B.songExists("No Such Song At All"));
});

// --- performance hours ---
check("isPerformanceHour is evening only", () => {
  const base = new Date(2026, 0, 1).getTime();
  const at = (h) => base + h * 3600000 - new Date(2026, 0, 1).getTimezoneOffset() * 60000;
  // Use local-hour construction instead of UTC math:
  const mk = (h) => new Date(2026, 5, 15, h, 0, 0).getTime();
  assert.ok(B.isPerformanceHour(mk(17)));
  assert.ok(B.isPerformanceHour(mk(22)));
  assert.ok(!B.isPerformanceHour(mk(16)));
  assert.ok(!B.isPerformanceHour(mk(23)));
  assert.ok(!B.isPerformanceHour(mk(9)));
});

// --- ballads ---
check("balladTitleFor renders with no unfilled slots", () => {
  const rng = lcg(7);
  for (let i = 0; i < 20; i++) {
    const t = B.balladTitleFor(rng, "a wedding");
    assert.ok(!t.includes("{"), "no unfilled slot: " + t);
    assert.ok(t.length > 5 && t.length <= 120);
  }
});

// --- commissions ---
check("commissionTroup / commissionFor round-trip", () => {
  const now = Date.now();
  const c = B.commissionTroup("HeroPlayer", "asgarnia", "wedding", now);
  assert.equal(c.troupe, "the Silver Strings");
  assert.equal(c.occasion, "wedding");
  const back = B.commissionFor("HeroPlayer", now);
  assert.equal(back.troupe, "the Silver Strings");
  assert.equal(B.commissionFor("Nobody", now), null);
});

// --- song requests ---
check("requestSong / requestFor round-trip", () => {
  const now = Date.now();
  B.requestSong("HeroPlayer2", "The King's Road", now);
  const back = B.requestFor("HeroPlayer2", now);
  assert.equal(back.song, "The King's Road");
});

// --- fill / pickOne ---
check("fill replaces all slots", () => {
  assert.equal(B.fill("Hello {name}, {name}!", { name: "Jo" }), "Hello Jo, Jo!");
});
check("pickOne stays in range", () => {
  const rng = lcg(42);
  for (let i = 0; i < 50; i++) {
    const v = B.pickOne(rng, ["a", "b", "c"]);
    assert.ok(["a", "b", "c"].includes(v));
  }
});

// --- isRealPlayer / withinTiles ---
function fakePlayer(username, x, y, z, bot = false) {
  return {
    getUsername: () => username,
    isPlayerBot: () => bot,
    getHostAddress: () => (bot ? "bot" : "127.0.0.1"),
    getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => z }),
  };
}

check("isRealPlayer gates bots and nulls", () => {
  assert.ok(B.isRealPlayer(fakePlayer("Jo", 0, 0, 0)));
  assert.ok(!B.isRealPlayer(fakePlayer("Bot1", 0, 0, 0, true)));
  assert.ok(!B.isRealPlayer(null));
  assert.ok(!B.isRealPlayer({}));
});

check("withinTiles uses Chebyshev distance on the same plane", () => {
  const a = fakePlayer("A", 100, 100, 0);
  assert.ok(B.withinTiles(a, fakePlayer("B", 105, 103, 0), 14));
  assert.ok(!B.withinTiles(a, fakePlayer("B", 120, 100, 0), 14));
  assert.ok(!B.withinTiles(a, fakePlayer("B", 100, 100, 1), 14));
});

// --- court bard ---
check("courtBardFor picks a stable bard of the kingdom", () => {
  const roster = new Map();
  for (let i = 0; i < 60; i++) roster.set("CB" + i, rec("CB" + i, "commoner", "varrock"));
  const first = B.courtBardFor("varrock", roster);
  const second = B.courtBardFor("varrock", roster);
  if (first) {
    assert.equal(first.username, second.username);
    assert.ok(B.bardTypeOf(first));
  }
});

// --- nearbyRequest ---
check("nearbyRequest finds a real player with a request", () => {
  const now = Date.now();
  B.requestSong("NearHero", "The Miller's Daughter", now);
  const citizen = fakePlayer("BardyMcBard", 50, 50, 0, true);
  const director = {
    onlinePlayers: () => [
      fakePlayer("NearHero", 52, 51, 0),
      fakePlayer("FarHero", 500, 500, 0),
    ],
  };
  const req = B.nearbyRequest(director, citizen, now);
  assert.ok(req);
  assert.equal(req.song, "The Miller's Daughter");
});

// --- tick never throws ---
check("tickBards never throws on hostile input", () => {
  B.tickBards(null, Date.now());
  B.tickBards({}, Date.now());
  B.tickBards({ roster: new Map() }, Date.now());
  const bad = new Map();
  bad.set("x", null);
  bad.set("y", { username: "Y" }); // no role
  B.tickBards({ roster: bad, playerFor: () => { throw new Error("boom"); } }, Date.now());
});

// --- tick fires near a real player in the evening ---
check("tickBards fires near a real player, silent near bots only", () => {
  // find a bard username
  let bardName = null;
  for (let i = 0; i < 500 && !bardName; i++) {
    if (B.bardTypeOf(rec("EveningBard" + i))) bardName = "EveningBard" + i;
  }
  assert.ok(bardName);
  const said = [];
  const citizen = {
    getUsername: () => bardName,
    isPlayerBot: () => true,
    getHostAddress: () => "bot",
    getLocation: () => ({ getX: () => 10, getY: () => 10, getZ: () => 0 }),
    forceChat: (t) => said.push(t),
  };
  const mkDirector = (players) => ({
    roster: new Map([[bardName.toLowerCase(), rec(bardName)]]),
    playerFor: () => citizen,
    onlinePlayers: () => players,
  });
  const evening = new Date(2026, 5, 15, 19, 0, 0).getTime();
  const rng = () => 0; // always pass chance
  B.tickBards(mkDirector([fakePlayer("Hero", 12, 11, 0)]), evening, { rngFor: () => rng });
  assert.ok(said.length > 0, "bard performed for a real player, said: " + JSON.stringify(said));
  assert.ok(said.every((t) => !t.includes("{") && t.length <= 120), "no unfilled slots, length-capped");

  const said2 = [];
  const citizen2 = { ...citizen, forceChat: (t) => said2.push(t) };
  const d2 = mkDirector([fakePlayer("Bot9", 12, 11, 0, true)]);
  d2.playerFor = () => citizen2;
  B.tickBards(d2, evening, { rngFor: () => rng });
  assert.equal(said2.length, 0, "silent when only bots are near");
});

console.log(`\n${passed} checks passed.`);
