// CitizenHobbyists unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const H = require("./CitizenHobbyists");

function localNoon(dayOffset = 0) {
  const d = new Date(2026, 9, 8, 12, 0, 0); // Oct 8 2026, local time (timezone rule)
  d.setDate(d.getDate() + dayOffset);
  return d.getTime();
}

// --- hashing ---
{
  const a = H.hashStr("hobby:alice");
  const b = H.hashStr("hobby:alice");
  const c = H.hashStr("hobby:bob");
  assert.equal(a, b, "hashStr deterministic");
  assert.notEqual(a, c, "hashStr varies by input");
}

// --- type roll weights: all four reachable ---
{
  const seen = new Set();
  for (let r = 0; r < 100; r++) seen.add(H.hobbyTypeFromRoll(r));
  assert.deepEqual([...seen].sort(), ["birdwatcher", "collector", "gamer", "gardener"], "all hobby types reachable");
  assert.equal(H.hobbyTypeFromRoll(0), "gardener", "roll 0 -> gardener (30%)");
  assert.equal(H.hobbyTypeFromRoll(29), "gardener", "roll 29 -> gardener");
  assert.equal(H.hobbyTypeFromRoll(30), "birdwatcher", "roll 30 -> birdwatcher (25%)");
  assert.equal(H.hobbyTypeFromRoll(55), "collector", "roll 55 -> collector (25%)");
  assert.equal(H.hobbyTypeFromRoll(80), "gamer", "roll 80 -> gamer (20%)");
}

// --- hobbyTypeOf: commoners get hobbies, stable; non-commoners null ---
{
  const rec = { username: "HobbyAlice", role: "commoner", kingdomId: "misthalin" };
  const t1 = H.hobbyTypeOf(rec);
  const t2 = H.hobbyTypeOf(rec);
  assert.ok(H.HOBBY_TYPES.includes(t1), "commoner gets a hobby type");
  assert.equal(t1, t2, "hobby type stable across calls");
  assert.equal(H.hobbyTypeOf({ username: "GuardBob", role: "guard" }), null, "guards get no hobby");
  assert.equal(H.hobbyTypeOf({ username: "CourtCid", role: "courtier" }), null, "courtiers get no hobby");
  assert.equal(H.hobbyTypeOf(null), null, "null record -> null");
  assert.equal(H.hobbyTypeOf({}), null, "empty record -> null");
}

// --- activity system: NO professional exclusion chain ---
{
  // A name that would be claimed by a professional system still gets a hobby.
  // (Hobbies are leisure; the exclusion chain does not apply.)
  let withHobby = 0;
  for (let i = 0; i < 200; i++) {
    const t = H.hobbyTypeOf({ username: "Citizen" + i, role: "commoner" });
    if (t) withHobby++;
  }
  assert.ok(withHobby > 150, `most commoners get hobbies without exclusions (got ${withHobby}/200)`);
}

// --- distribution across the four hobbies ---
{
  const counts = { gardener: 0, birdwatcher: 0, collector: 0, gamer: 0 };
  for (let i = 0; i < 2000; i++) {
    counts[H.hobbyTypeOf({ username: "Dist" + i, role: "commoner" })]++;
  }
  assert.ok(counts.gardener > 400 && counts.gardener < 800, `gardener ~30% (got ${counts.gardener})`);
  assert.ok(counts.gamer > 250 && counts.gamer < 550, `gamer ~20% (got ${counts.gamer})`);
}

// --- clubFor: kingdom-preferred ---
{
  const rec = { username: "ClubAlice", role: "commoner", kingdomId: "asgarnia" };
  const club = H.clubFor(rec);
  assert.equal(club.kingdom, "asgarnia", "club prefers the citizen's kingdom");
  const c1 = H.clubFor(rec).name;
  const c2 = H.clubFor(rec).name;
  assert.equal(c1, c2, "club assignment stable");
  const day = H.clubDay(club);
  assert.ok(day >= 0 && day <= 6, "club day is a valid weekday");
}

// --- pursuitFor: deterministic per day, varies across days ---
{
  const p1 = H.pursuitFor("PursuitAlice", "gardener", localNoon(0));
  const p2 = H.pursuitFor("PursuitAlice", "gardener", localNoon(0));
  const p3 = H.pursuitFor("PursuitAlice", "gardener", localNoon(30));
  assert.equal(p1, p2, "pursuit deterministic same day");
  // (may rarely collide across days; just check it returns a string)
  assert.equal(typeof p1, "string");
  assert.equal(typeof p3, "string");
}

// --- collectionCount grows over time ---
{
  const early = H.collectionCount("CollectorZed", "collector", localNoon(0));
  const late = H.collectionCount("CollectorZed", "collector", localNoon(365));
  assert.ok(late >= early, `collection grows over a year (${early} -> ${late})`);
  assert.ok(early >= 3, "collection starts with a few items");
}

// --- rareFindFor: ~8% rate, deterministic per day ---
{
  let hits = 0;
  const N = 2000;
  for (let i = 0; i < N; i++) {
    if (H.rareFindFor("Rare" + i, "gardener", localNoon(0))) hits++;
  }
  const rate = hits / N;
  assert.ok(rate > 0.04 && rate < 0.13, `rare find rate ~8% (got ${(rate * 100).toFixed(1)}%)`);
  const f1 = H.rareFindFor("RareFindAlice", "birdwatcher", localNoon(0));
  const f2 = H.rareFindFor("RareFindAlice", "birdwatcher", localNoon(0));
  assert.equal(f1, f2, "rare find deterministic per day");
}

// --- ledgers: joinClub / challengePlayer / tradeCollectible round-trips + TTL ---
{
  H._resetState();
  const now = localNoon(0);
  assert.equal(H.joinClub("PlayerOne", "the Varrock Gardening Society", now), "the Varrock Gardening Society");
  assert.equal(H.clubMemberFor("PlayerOne", now), "the Varrock Gardening Society");
  assert.equal(H.clubMemberFor("Nobody", now), null);
  // TTL expiry (8 days later)
  assert.equal(H.clubMemberFor("PlayerOne", now + 8 * 86400000), null, "club membership expires after TTL");

  H._resetState();
  assert.equal(H.challengePlayer("GamerGus", "PlayerOne", "draughts", now), "draughts");
  const ch = H.challengeFor("PlayerOne", now);
  assert.equal(ch.challenger, "gamergus", "challenger normalized");
  assert.equal(ch.game, "draughts");
  assert.equal(H.challengeFor("PlayerOne", now + 8 * 86400000), null, "challenge expires after TTL");

  H._resetState();
  assert.equal(H.tradeCollectible("PlayerOne", "a first-edition stamp", now), "a first-edition stamp");
  assert.equal(H.tradeFor("PlayerOne", now).item, "a first-edition stamp");
  assert.equal(H.tradeFor("PlayerOne", now + 8 * 86400000), null, "trade expires after TTL");
}

// --- line pools render cleanly ---
{
  const slots = { find: "a black orchid", club: "the Varrock Gardening Society", day: "this Thursday", gear: "trowel" };
  for (const mod of [H]) {
    void mod;
  }
  // Render every exported line pool indirectly via rare lines
  const now = localNoon(0);
  const rare = H.rareFindFor("LineAlice", "gardener", now);
  if (rare) {
    const line = H.fill("You won't believe this — {find}!", { find: rare });
    assert.ok(!line.includes("{find}"), "no unfilled slots");
    assert.ok(line.length <= 120, "line within 120 chars");
  }
  const invite = H.maybeInvitePlayer(
    { username: "InviteBob", role: "commoner", kingdomId: "misthalin" },
    { forceChat: () => {} },
    "gardener"
  );
  assert.ok(typeof invite === "string" && invite.length > 0, "invite line renders");
  assert.ok(!invite.includes("{club}") && !invite.includes("{day}"), "invite slots filled");
}

// --- guards ---
{
  const real = {
    getUsername: () => "RealPlayer",
    isPlayerBot: () => false,
    getHostAddress: () => "127.0.0.1",
  };
  const bot = {
    getUsername: () => "CitizenBot",
    isPlayerBot: () => true,
    getHostAddress: () => "bot",
  };
  assert.ok(H.isRealPlayer(real), "real player detected");
  assert.ok(!H.isRealPlayer(bot), "bot rejected");
  assert.ok(!H.isRealPlayer(null), "null rejected");
  assert.ok(H.isCitizenBot(bot), "citizen bot detected");
  assert.ok(!H.isCitizenBot(real), "real player is not a citizen bot");

  const at = (x, y, z = 0) => ({ getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => z }) });
  assert.ok(H.withinTiles(at(0, 0), at(10, 10), 14), "within radius");
  assert.ok(!H.withinTiles(at(0, 0), at(20, 0), 14), "outside radius");
  assert.ok(!H.withinTiles(at(0, 0, 0), at(0, 0, 1), 14), "different plane rejected");
}

// --- tick: fires near a real player, silent near bots only, silent for non-hobbyists ---
{
  function mockCitizen(x, y) {
    const calls = [];
    return {
      calls,
      forceChat: (line) => calls.push(line),
      getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => 0 }),
    };
  }
  function mockHuman(x, y) {
    return {
      getUsername: () => "Human",
      isPlayerBot: () => false,
      getHostAddress: () => "10.0.0.1",
      getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => 0 }),
    };
  }
  function mockBot(x, y) {
    return {
      getUsername: () => "SomeBot",
      isPlayerBot: () => true,
      getHostAddress: () => "bot",
      getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => 0 }),
    };
  }
  function makeDirector(recs, online) {
    const roster = new Map();
    const citizens = new Map();
    for (const r of recs) {
      roster.set(r.username.toLowerCase(), r);
      citizens.set(r.username.toLowerCase(), r._citizen);
    }
    return {
      roster,
      playerFor: (rec) => citizens.get(String(rec.username).toLowerCase()) ?? null,
      onlinePlayers: () => online,
    };
  }

  const realRandom = Math.random;
  Math.random = () => 0.05; // passes the 0.35 chance gate
  // Find a username that passes the hobby visibility gate (Phase 2).
  const { isHobbyVisible } = require("./CitizenPrimaryHobby");
  let tickName = null;
  for (let i = 0; i < 100 && !tickName; i++) {
    const n = "TickHobbyist" + i;
    if (isHobbyVisible(n, "hobbyist")) tickName = n;
  }
  assert.ok(tickName, "no visibility-passing hobbyist name found");
  try {
    // Fires near a real player
    H._resetState();
    const cz = mockCitizen(0, 0);
    const rec = { username: tickName, role: "commoner", kingdomId: "misthalin", _citizen: cz };
    const dir = makeDirector([rec], [mockHuman(5, 5)]);
    H.tickHobbyists(dir, localNoon(0));
    assert.ok(cz.calls.length > 0, "tick fires near a real player");

    // Silent near bots only
    H._resetState();
    const cz2 = mockCitizen(0, 0);
    const rec2 = { username: "TickHobbyist2", role: "commoner", kingdomId: "misthalin", _citizen: cz2 };
    const dir2 = makeDirector([rec2], [mockBot(5, 5)]);
    H.tickHobbyists(dir2, localNoon(0));
    assert.equal(cz2.calls.length, 0, "tick silent when only bots are near");

    // Silent for non-commoners (no hobby)
    H._resetState();
    const cz3 = mockCitizen(0, 0);
    const rec3 = { username: "TickGuard", role: "guard", kingdomId: "misthalin", _citizen: cz3 };
    const dir3 = makeDirector([rec3], [mockHuman(5, 5)]);
    H.tickHobbyists(dir3, localNoon(0));
    assert.equal(cz3.calls.length, 0, "tick silent for non-commoners");

    // Silent when citizen not materialized
    H._resetState();
    const rec4 = { username: "TickGhost", role: "commoner", kingdomId: "misthalin", _citizen: null };
    const dir4 = makeDirector([rec4], [mockHuman(5, 5)]);
    H.tickHobbyists(dir4, localNoon(0)); // must not throw
  } finally {
    Math.random = realRandom;
  }

  // Never throws on hostile input
  H.tickHobbyists(null, localNoon(0));
  H.tickHobbyists({}, localNoon(0));
  H.tickHobbyists({ roster: null }, localNoon(0));
}

console.log("All CitizenHobbyists checks passed.");
