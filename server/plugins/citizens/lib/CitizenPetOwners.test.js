// CitizenPetOwners unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const P = require("./CitizenPetOwners");

P._resetState();

function localNoon(dayOffset = 0) {
  const d = new Date(2026, 9, 8, 12, 0, 0); // Oct 8 2026, local time (timezone rule)
  d.setDate(d.getDate() + dayOffset);
  return d.getTime();
}

function localDay(year, month, day, hour = 12, min = 0) {
  return new Date(year, month, day, hour, min, 0).getTime(); // local time, never Date.UTC
}

// --- hashing ---
{
  const a = P.hashStr("pet:alice");
  const b = P.hashStr("pet:alice");
  const c = P.hashStr("pet:bob");
  assert.equal(a, b, "hashStr deterministic");
  assert.notEqual(a, c, "hashStr varies by input");
}

// --- type roll weights: all four reachable ---
{
  const seen = new Set();
  for (let r = 0; r < 100; r++) seen.add(P.petTypeFromRoll(r));
  assert.deepEqual([...seen].sort(), ["bird", "cat", "dog", "exotic"], "all pet types reachable");
  assert.equal(P.petTypeFromRoll(0), "cat", "roll 0 -> cat (30%)");
  assert.equal(P.petTypeFromRoll(29), "cat", "roll 29 -> cat");
  assert.equal(P.petTypeFromRoll(30), "dog", "roll 30 -> dog (30%)");
  assert.equal(P.petTypeFromRoll(59), "dog", "roll 59 -> dog");
  assert.equal(P.petTypeFromRoll(60), "bird", "roll 60 -> bird (25%)");
  assert.equal(P.petTypeFromRoll(84), "bird", "roll 84 -> bird");
  assert.equal(P.petTypeFromRoll(85), "exotic", "roll 85 -> exotic (15%)");
  assert.equal(P.petTypeFromRoll(99), "exotic", "roll 99 -> exotic");
}

// --- petTypeOf: commoners get pets, stable; non-commoners null ---
{
  const rec = { username: "PetAlice", role: "commoner", kingdomId: "misthalin" };
  const t1 = P.petTypeOf(rec);
  const t2 = P.petTypeOf(rec);
  assert.ok(P.PET_TYPES.includes(t1), "commoner gets a pet type");
  assert.equal(t1, t2, "pet type stable across calls");
  assert.equal(P.petTypeOf({ username: "GuardBob", role: "guard" }), null, "guards get no pet");
  assert.equal(P.petTypeOf({ username: "CourtCid", role: "courtier" }), null, "courtiers get no pet");
  assert.equal(P.petTypeOf(null), null, "null record -> null");
  assert.equal(P.petTypeOf({}), null, "empty record -> null");
}

// --- activity system: NO professional exclusion chain ---
{
  let withPet = 0;
  for (let i = 0; i < 200; i++) {
    const t = P.petTypeOf({ username: "Citizen" + i, role: "commoner" });
    if (t) withPet++;
  }
  assert.ok(withPet > 150, `most commoners get pets without exclusions (got ${withPet}/200)`);
}

// --- distribution across the four pet types ---
{
  const counts = { cat: 0, dog: 0, bird: 0, exotic: 0 };
  for (let i = 0; i < 2000; i++) {
    counts[P.petTypeOf({ username: "Dist" + i, role: "commoner" })]++;
  }
  assert.ok(counts.cat > 450 && counts.cat < 750, `cat ~30% (got ${counts.cat})`);
  assert.ok(counts.dog > 450 && counts.dog < 750, `dog ~30% (got ${counts.dog})`);
  assert.ok(counts.exotic > 200 && counts.exotic < 400, `exotic ~15% (got ${counts.exotic})`);
}

// --- petFor: stable identity, valid fields ---
{
  const rec = { username: "PetAlice", role: "commoner", kingdomId: "misthalin" };
  const p1 = P.petFor(rec);
  const p2 = P.petFor(rec);
  assert.deepEqual(p1, p2, "pet identity stable across calls");
  assert.ok(P.PET_NAMES[p1.type].includes(p1.name), "pet name from the type's pool");
  assert.ok(P.PET_PERSONALITIES.includes(p1.personality), "personality from pool");
  assert.ok(p1.age >= 1 && p1.age <= 12, "age in 1-12 range");
  assert.equal(P.petFor({ username: "GuardBob", role: "guard" }), null, "guard has no pet");
  // Different owners get (usually) different pets
  const other = P.petFor({ username: "PetZara", role: "commoner" });
  assert.ok(other && other.name !== undefined, "second owner has a pet too");
}

// --- careFor: deterministic per day, varies across days ---
{
  const c1 = P.careFor("PetAlice", localNoon(0));
  const c2 = P.careFor("PetAlice", localNoon(0));
  assert.equal(c1, c2, "care task deterministic per day");
  assert.ok(typeof c1 === "string" && c1.length > 0, "care task is a non-empty string");
  const seen = new Set();
  for (let d = 0; d < 14; d++) seen.add(P.careFor("PetAlice", localNoon(d)));
  assert.ok(seen.size > 1, "care tasks vary across days");
  assert.equal(P.careFor("", localNoon(0)), null, "empty username gets no care task");
}

// --- venueFor: kingdom-preferred, stable ---
{
  const rec = { username: "PetAlice", role: "commoner", kingdomId: "asgarnia" };
  const venue = P.venueFor(rec);
  assert.equal(venue.kingdom, "asgarnia", "venue prefers the citizen's kingdom");
  assert.equal(P.venueFor(rec).name, venue.name, "venue assignment stable");
  const day = P.showDay(venue);
  assert.ok(day >= 0 && day <= 6, "show day is a valid weekday");
  assert.equal(P.showDay(venue), day, "show day stable");
}

// --- isShowDay: true on the venue's weekday ---
{
  const venue = { name: "Test Venue", kingdom: "misthalin" };
  const day = P.showDay(venue);
  // Find a local date with that weekday
  const base = new Date(2026, 9, 8, 12, 0, 0);
  while (base.getDay() !== day) base.setDate(base.getDate() + 1);
  assert.ok(P.isShowDay(venue, base.getTime()), "isShowDay true on the venue's weekday");
  base.setDate(base.getDate() + 1);
  assert.ok(!P.isShowDay(venue, base.getTime()), "isShowDay false the day after");
}

// --- winnerFor: stable within a week, varies across weeks ---
{
  const venue = { name: "Test Venue", kingdom: "misthalin" };
  const w1 = P.winnerFor(venue, localDay(2026, 9, 8));
  const w2 = P.winnerFor(venue, localDay(2026, 9, 9));
  assert.deepEqual(w1, w2, "winner stable within the week");
  const w3 = P.winnerFor(venue, localDay(2026, 9, 20));
  assert.ok(w3.pet && w3.owner && w3.personality, "winner has all fields");
  assert.ok(P.PET_NAMES[w3.type].includes(w3.pet), "winner pet from the type's pool");
}

// --- ledgers: adoption round-trip + TTL expiry ---
{
  P._resetState();
  const now = localNoon(0);
  assert.equal(P.adoptPet("PlayerOne", "Whiskers", "cat", now), "Whiskers", "adoptPet returns the pet name");
  assert.deepEqual(P.adoptionFor("PlayerOne", now), { pet: "Whiskers", type: "cat" }, "adoption round-trip");
  const expired = now + 8 * 24 * 3600 * 1000;
  assert.equal(P.adoptionFor("PlayerOne", expired), null, "adoption expires after 7 days");
  assert.equal(P.adoptionFor("Nobody", now), null, "unknown player -> null");
  assert.equal(P.adoptPet("", "Whiskers", "cat", now), null, "empty name -> null");
}

// --- ledgers: trade round-trip + TTL expiry ---
{
  P._resetState();
  const now = localNoon(0);
  assert.equal(P.tradePet("PlayerOne", "a rare parrot", now), "a rare parrot", "tradePet returns the offer");
  assert.equal(P.tradeFor("PlayerOne", now), "a rare parrot", "trade round-trip");
  assert.equal(P.tradeFor("PlayerOne", now + 8 * 24 * 3600 * 1000), null, "trade expires after 7 days");
}

// --- ledgers: show entry round-trip + TTL expiry ---
{
  P._resetState();
  const now = localNoon(0);
  assert.equal(P.enterShow("PlayerOne", "the Varrock Pet Fair", now), "the Varrock Pet Fair", "enterShow returns the venue");
  assert.equal(P.showEntryFor("PlayerOne", now), "the Varrock Pet Fair", "show entry round-trip");
  assert.equal(P.showEntryFor("PlayerOne", now + 8 * 24 * 3600 * 1000), null, "show entry expires after 7 days");
}

// --- line pools render with all slots filled ---
{
  const rec = { username: "PetAlice", role: "commoner", kingdomId: "misthalin" };
  const pet = P.petFor(rec);
  const venue = P.venueFor(rec);
  const slots = {
    pet: pet.name, type: pet.type, personality: pet.personality,
    venue: venue.name, weekday: P.WEEKDAYS[P.showDay(venue)], owner: rec.username,
  };
  const line = P.fill("{pet} is {personality} at {venue} on {weekday}", slots);
  assert.ok(!line.includes("{"), "no unfilled slots");
  assert.ok(line.length <= 120, "line within chat length limits");
}

// --- isRealPlayer / isCitizenBot / withinTiles guards ---
{
  assert.equal(P.isRealPlayer(null), false, "null -> false");
  assert.equal(P.isRealPlayer({ isPlayerBot: () => true }), false, "bot -> false");
  assert.equal(P.isRealPlayer({ getHostAddress: () => "bot", getUsername: () => "x" }), false, "bot host -> false");
  assert.equal(P.isRealPlayer({ getUsername: () => "RealPlayer" }), true, "real player -> true");
  assert.equal(P.isCitizenBot({ isPlayerBot: () => true }), true, "citizen bot detected");

  const loc = (x, y, z) => ({ getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => z }) });
  assert.ok(P.withinTiles(loc(0, 0, 0), loc(10, 10, 0), 14), "within radius");
  assert.ok(!P.withinTiles(loc(0, 0, 0), loc(20, 0, 0), 14), "outside radius");
  assert.ok(!P.withinTiles(loc(0, 0, 0), loc(0, 0, 1), 14), "different plane -> false");
  assert.ok(!P.withinTiles(null, loc(0, 0, 0), 14), "null a -> false");
}

// --- tickPetOwners: never throws on hostile input ---
{
  P._resetState();
  assert.doesNotThrow(() => P.tickPetOwners(null, Date.now()), "null director");
  assert.doesNotThrow(() => P.tickPetOwners({}, Date.now()), "empty director");
  assert.doesNotThrow(() => P.tickPetOwners({ roster: null }, Date.now()), "null roster");
}

// --- tickPetOwners: silent with bots only, fires near a real player ---
{
  P._resetState();
  const now = localNoon(0);
  const mkCitizen = (name) => ({
    getUsername: () => name,
    getLocation: () => ({ getX: () => 0, getY: () => 0, getZ: () => 0 }),
    forceChat: function (line) { this._said = line; },
  });
  const realPlayer = {
    getUsername: () => "RealPlayer",
    getLocation: () => ({ getX: () => 5, getY: () => 5, getZ: () => 0 }),
  };
  const botPlayer = {
    isPlayerBot: () => true,
    getHostAddress: () => "bot",
    getUsername: () => "BotOne",
    getLocation: () => ({ getX: () => 5, getY: () => 5, getZ: () => 0 }),
  };

  // Find a pet-owner name deterministically (must also pass visibility gate)
  const { isHobbyVisible } = require("./CitizenPrimaryHobby");
  let ownerName = null;
  for (let i = 0; i < 500 && !ownerName; i++) {
    const n = "Owner" + i;
    if (P.petTypeOf({ username: n, role: "commoner" }) && isHobbyVisible(n, "pet_owner")) ownerName = n;
  }
  assert.ok(ownerName, "found a pet-owner test name");

  const mkDirector = (players) => ({
    roster: new Map([[ownerName.toLowerCase(), { username: ownerName, role: "commoner", kingdomId: "misthalin" }]]),
    playerFor: () => mkCitizen(ownerName),
    onlinePlayers: () => players,
  });

  // Bots only: silent
  P._resetState();
  const silentCitizen = mkCitizen(ownerName);
  const silentDirector = {
    roster: new Map([[ownerName.toLowerCase(), { username: ownerName, role: "commoner", kingdomId: "misthalin" }]]),
    playerFor: () => silentCitizen,
    onlinePlayers: () => [botPlayer],
  };
  // Force past the chance gate by running many ticks
  for (let i = 0; i < 40; i++) {
    P._resetState();
    P.tickPetOwners(silentDirector, now + i * 4 * 3600 * 1000);
  }
  assert.equal(silentCitizen._said, undefined, "silent near bots only");

  // Real player near: eventually fires
  let fired = false;
  for (let i = 0; i < 40 && !fired; i++) {
    P._resetState();
    const c = mkCitizen(ownerName);
    const d = mkDirector([realPlayer]);
    d.playerFor = () => c;
    P.tickPetOwners(d, now + i * 4 * 3600 * 1000);
    if (c._said) fired = true;
  }
  assert.ok(fired, "fires near a real player");
}

// --- tickPetOwners: skips non-pet-owners ---
{
  P._resetState();
  const now = localNoon(0);
  const citizen = {
    getUsername: () => "GuardBob",
    getLocation: () => ({ getX: () => 0, getY: () => 0, getZ: () => 0 }),
    forceChat: function (line) { this._said = line; },
  };
  const director = {
    roster: new Map([["guardbob", { username: "GuardBob", role: "guard" }]]),
    playerFor: () => citizen,
    onlinePlayers: () => [{ getUsername: () => "Real", getLocation: () => ({ getX: () => 1, getY: () => 1, getZ: () => 0 }) }],
  };
  for (let i = 0; i < 10; i++) {
    P._resetState();
    P.tickPetOwners(director, now + i * 4 * 3600 * 1000);
  }
  assert.equal(citizen._said, undefined, "non-pet-owner never fires");
}

console.log("All CitizenPetOwners checks passed.");
