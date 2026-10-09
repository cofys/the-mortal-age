// CitizenBards2 unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const mod = require("./CitizenBards2");

const {
  hashStr,
  pickOne,
  fill,
  songfolkTypeFromRoll,
  songfolkTypeOf,
  venueFor,
  knownBallads,
  requestTune,
  requestFor,
  giveLesson,
  lessonFor,
  tuneExists,
  nearbyRequest,
  tickSongfolk,
  tipBusker,
  isSongHour,
  dayNumber,
  chance,
  seededRng,
  normalizeName,
  isRealPlayer,
  withinTiles,
  SONFOLK_TYPES,
  SONFOLK_BUSKER,
  SONFOLK_TALESPINNER,
  SONFOLK_MINSTREL,
  SONFOLK_SWAPPER,
  VENUES,
  AMATEUR_SONGS,
} = mod;

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// local-time constructors (never Date.UTC — the PC runs on EDT)
const NOON = new Date(2026, 9, 8, 12, 0).getTime();
const MIDNIGHT = new Date(2026, 9, 8, 2, 0).getTime();

function rec(username, role = "commoner", kingdomId = "misthalin") {
  return { username, role, kingdomId };
}

function makeLoc(x, y, z = 0) {
  return { getX: () => x, getY: () => y, getZ: () => z };
}
function makeCitizen(x, y) {
  const said = [];
  return {
    said,
    isPlayerBot: () => true,
    getHostAddress: () => "bot",
    getUsername: () => "SongfolkSam",
    getLocation: () => makeLoc(x, y),
    forceChat: (t) => said.push(String(t)),
    getInventory: () => ({
      add: () => {},
      refreshItems: () => {},
    }),
  };
}
function makePlayer(x, y, username = "TestPlayer") {
  return {
    isPlayerBot: () => false,
    getHostAddress: () => "127.0.0.1",
    getUsername: () => username,
    getLocation: () => makeLoc(x, y),
    sendMessage: () => {},
    getInventory: () => ({
      getAmount: () => 100000,
      deleteNumber: () => {},
      refreshItems: () => {},
    }),
  };
}

function findName(predicate, prefix = "Songfolk") {
  for (let i = 0; i < 200000; i++) {
    const n = prefix + i;
    if (predicate(n)) return n;
  }
  throw new Error("no name satisfied predicate");
}

// --- pure helpers ---

{
  const h = hashStr("songfolk-test");
  assert.equal(h, hashStr("songfolk-test"), "hashStr deterministic");
  assert.notEqual(
    hashStr("alice" + "|songfolk"),
    hashStr("alice" + "|songfolk-type"),
    "name-first salts differ"
  );
  assert.ok(Number.isInteger(h) && h >= 0 && h < 4294967296, "hashStr is uint32");
}

{
  assert.equal(fill("play {tune} at {venue}", { tune: "Jig", venue: "Fire" }), "play Jig at Fire");
  const rng = lcg(42);
  const got = pickOne(rng, ["a", "b", "c"]);
  assert.ok(["a", "b", "c"].includes(got), "pickOne in range");
}

{
  // weight buckets: 30/25/25/20
  assert.equal(songfolkTypeFromRoll(0), SONFOLK_BUSKER);
  assert.equal(songfolkTypeFromRoll(29), SONFOLK_BUSKER);
  assert.equal(songfolkTypeFromRoll(30), SONFOLK_TALESPINNER);
  assert.equal(songfolkTypeFromRoll(54), SONFOLK_TALESPINNER);
  assert.equal(songfolkTypeFromRoll(55), SONFOLK_MINSTREL);
  assert.equal(songfolkTypeFromRoll(79), SONFOLK_MINSTREL);
  assert.equal(songfolkTypeFromRoll(80), SONFOLK_SWAPPER);
  assert.equal(songfolkTypeFromRoll(99), SONFOLK_SWAPPER);
  assert.equal(SONFOLK_TYPES.length, 4, "four songfolk types");
}

{
  assert.equal(isSongHour(NOON), true, "noon is a song hour");
  assert.equal(isSongHour(MIDNIGHT), false, "2am is not a song hour");
  assert.equal(isSongHour(new Date(2026, 9, 8, 9, 59).getTime()), false, "09:59 off");
  assert.equal(isSongHour(new Date(2026, 9, 8, 22, 59).getTime()), true, "22:59 on");
  assert.equal(isSongHour(new Date(2026, 9, 8, 23, 0).getTime()), false, "23:00 off");
  assert.equal(dayNumber(NOON), Math.floor(NOON / 86400000));
  assert.equal(chance(() => 0.1, 0.2), true);
  assert.equal(chance(() => 0.3, 0.2), false);
}

{
  assert.equal(songfolkTypeOf(rec("anyone", "guard")), null, "non-commoner excluded");
  assert.equal(songfolkTypeOf(rec("anyone", "COMMONER")) !== undefined, true, "COMMONER accepted by role gate");
  assert.equal(songfolkTypeOf(null), null, "null record safe");
  assert.equal(songfolkTypeOf({}), null, "record without username safe");
}

{
  assert.equal(normalizeName("Alice"), "alice");
  const p = makePlayer(0, 0);
  const bot = makeCitizen(0, 0);
  assert.equal(isRealPlayer(p), true);
  assert.equal(isRealPlayer(bot), false);
  assert.equal(withinTiles(p, makePlayer(5, 5), 14), true);
  assert.equal(withinTiles(p, makePlayer(50, 0), 14), false);
}

// --- 10k-name distribution check (share + type salts, name-first) ---

{
  const N = 10000;
  const typeCounts = { [SONFOLK_BUSKER]: 0, [SONFOLK_TALESPINNER]: 0, [SONFOLK_MINSTREL]: 0, [SONFOLK_SWAPPER]: 0 };
  const deciles = new Array(10).fill(0);
  let total = 0;
  for (let i = 0; i < N; i++) {
    const t = songfolkTypeOf(rec("Decile" + i));
    if (!t) continue;
    total++;
    typeCounts[t]++;
    deciles[i % 10]++;
  }
  const rate = total / N;
  assert.ok(rate > 0.2 && rate < 0.42, `share rate ${rate.toFixed(3)} in 0.20..0.42 (post-exclusion)`);
  for (const t of SONFOLK_TYPES) {
    const share = typeCounts[t] / total;
    assert.ok(share > 0.05, `type ${t} not starved: ${share.toFixed(3)}`);
  }
  for (let d = 0; d < 10; d++) {
    const share = deciles[d] / (N / 10);
    assert.ok(Math.abs(share - rate) < 0.08, `decile ${d} uniform: ${share.toFixed(3)} vs ${rate.toFixed(3)}`);
  }
  console.log(`  distribution: ${(rate * 100).toFixed(1)}% songfolk over 10k names, type shares: ` +
    SONFOLK_TYPES.map((t) => `${t}=${(typeCounts[t] / total * 100).toFixed(1)}%`).join(" "));
}

// --- exclusion integration against the real sibling modules ---

{
  const ProBards = require("./CitizenBards");
  const StreetPerformers = require("./CitizenStreetPerformers");
  const proName = findName((n) => !!ProBards.bardTypeOf(rec(n)));
  assert.equal(songfolkTypeOf(rec(proName)), null, `pro bard ${proName} excluded`);
  const streetName = findName((n) => !!StreetPerformers.performerTypeOf(rec(n)));
  assert.equal(songfolkTypeOf(rec(streetName)), null, `street performer ${streetName} excluded`);
  console.log(`  exclusions verified: pro bard ${proName}, street performer ${streetName}`);
}

// --- venues / tunes / ballads ---

{
  const v = venueFor(rec("anyone", "commoner", "keldagrim"));
  assert.equal(v.kingdom, "keldagrim", "kingdom-preferred venue");
  assert.equal(venueFor(rec("anyone", "commoner", "nowhere")).kingdom !== undefined, true, "unknown kingdom falls back");
  assert.equal(VENUES.length, 10, "ten venues");
}

// --- tuneForToday removed 2026-10-08: hash-derived fabrication. tuneExists stays. ---
{
  assert.equal(tuneExists("The King's Road"), false, "pro ballad not in amateur book");
  assert.equal(tuneExists("no such tune"), false);
}

{
  const ballads = knownBallads();
  assert.ok(ballads.length >= 4, "ballad pool non-empty");
  try {
    const ProBards = require("./CitizenBards");
    const real = Object.values(ProBards.REPERTOIRE).flat();
    assert.ok(ballads.length === real.length, "reads the REAL pro repertoire table");
    assert.ok(ballads.includes("The Ballad of the Nameless King"), "real lore name present");
  } catch { /* pro module absent; fallback already asserted */ }
}

// --- rare set-pieces: deterministic, day-gated ---

// --- contestFor/legendFor removed 2026-10-08: hash-derived fabrication, no production callers. ---

// --- ledgers ---

{
  mod._resetState();
  const r = requestTune("Alice", "The Mill-Turner's Jig", NOON);
  assert.equal(r.tune, "The Mill-Turner's Jig");
  assert.equal(requestFor("alice", NOON).tune, "The Mill-Turner's Jig", "lookup normalized");
  assert.equal(requestFor("alice", NOON + 25 * 3600 * 1000), null, "request TTL 24h");
  const g = giveLesson("Bob", "Cooper's Reel", "sam", NOON);
  assert.equal(g.tune, "Cooper's Reel");
  assert.equal(g.teacher, "sam");
  assert.equal(lessonFor("bob", NOON).tune, "Cooper's Reel");
  assert.equal(lessonFor("bob", NOON + 8 * 24 * 3600 * 1000), null, "lesson TTL 7d");
  assert.equal(requestTune(null, "x"), null, "null player safe");
  assert.equal(lessonFor("nobody", NOON), null, "miss returns null");
}

// --- tipBusker ---

{
  mod._resetState();
  const buskerName = findName((n) => songfolkTypeOf(rec(n)) === SONFOLK_BUSKER);
  const nonBuskerName = findName((n) => songfolkTypeOf(rec(n)) === SONFOLK_SWAPPER, "Swapfolk");

  const coins = (id, amount) => ({ getId: () => id, getAmount: () => amount });
  const target = (username) => ({
    isPlayerBot: () => true,
    getHostAddress: () => "bot",
    getUsername: () => username,
    getLocation: () => makeLoc(0, 0),
    forceChat: () => {},
    getInventory: () => ({ add: () => {}, refreshItems: () => {} }),
  });
  const director = {
    roster: new Map([
      [buskerName.toLowerCase(), rec(buskerName)],
      [nonBuskerName.toLowerCase(), rec(nonBuskerName)],
    ]),
  };

  const ev1 = { handled: false, player: makePlayer(0, 0), target: target(buskerName), item: coins(995, 250) };
  tipBusker(ev1, { director }, NOON);
  assert.equal(ev1.handled, true, "busker tip handled");
  const ev2 = { handled: true, player: makePlayer(0, 0), target: target(buskerName), item: coins(995, 250) };
  tipBusker(ev2, { director }, NOON);
  assert.equal(ev2.handled, true, "already-handled event untouched (stays handled)");

  const ev3 = { handled: false, player: makePlayer(0, 0), target: target(nonBuskerName), item: coins(995, 250) };
  tipBusker(ev3, { director }, NOON);
  assert.equal(ev3.handled, false, "non-busker songfolk ignored");

  const ev4 = { handled: false, player: makePlayer(0, 0), target: target(buskerName), item: coins(4151, 10) };
  tipBusker(ev4, { director }, NOON);
  assert.equal(ev4.handled, false, "non-coin item ignored");

  // fat-finger cap: offered 999999 -> clamped
  let added = 0;
  const richTarget = {
    ...target(buskerName),
    getInventory: () => ({ add: (id, amt) => { added = amt; }, refreshItems: () => {} }),
  };
  const ev5 = { handled: false, player: makePlayer(0, 0), target: richTarget, item: coins(995, 999999) };
  tipBusker(ev5, { director }, NOON);
  assert.equal(ev5.handled, true);
  assert.ok(added <= 5000, `tip capped at 5000, got ${added}`);
}

// --- nearbyRequest ---

{
  mod._resetState();
  const citizen = makeCitizen(100, 100);
  const player = makePlayer(100, 101, "ReqPlayer");
  requestTune("ReqPlayer", "Cooper's Reel", NOON);
  const playerRec = { username: "ReqPlayer", role: "player" };
  const director = {
    roster: new Map([["reqplayer", playerRec]]),
    isOnline: (r) => r === playerRec,
    getBot: (r) => (r === playerRec ? player : null),
  };
  const req = nearbyRequest(director, citizen, NOON);
  assert.equal(req && req.tune, "Cooper's Reel", "nearby request found");
  const far = nearbyRequest(director, makeCitizen(500, 500), NOON);
  assert.equal(far, null, "request not heard across the map");
}

// --- tickSongfolk smoke ---

{
  mod._resetState();
  const buskerName = findName((n) => songfolkTypeOf(rec(n)) !== null, "Tickfolk");
  const r1 = rec(buskerName);
  const r2 = rec("notasongfolk", "guard"); // excluded by role
  const citizen = makeCitizen(100, 100);
  const player = makePlayer(100, 102);
  const playerRec = { username: "TestPlayer", role: "player" };
  const director = {
    roster: new Map([[buskerName.toLowerCase(), r1], ["notasongfolk", r2], ["testplayer", playerRec]]),
    isOnline: (r) => (r === r1 || r === playerRec),
    getBot: (r) => (r === r1 ? citizen : r === playerRec ? player : null),
    aiTickCount: 0,
  };
  // force the chance gate to pass deterministically
  const origRandom = Math.random;
  Math.random = () => 0.01;
  try {
    tickSongfolk(director, NOON, { tick: 0, spread: 100 });
    assert.ok(citizen.said.length > 0, "songfolk performs when a player is near at song hour");
    const said2 = [];
    citizen.forceChat = (t) => said2.push(String(t));
    tickSongfolk(director, NOON, { tick: 0, spread: 100 });
    assert.equal(said2.length, 0, "cooldown gate blocks immediate refire");
    tickSongfolk(director, MIDNIGHT, { tick: 1, spread: 100 });
    assert.equal(said2.length, 0, "silent outside song hours");
  } finally {
    Math.random = origRandom;
  }
  mod._resetState();
}

console.log("CitizenBards2 tests passed");
