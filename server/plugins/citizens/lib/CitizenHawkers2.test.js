// CitizenHawkers2 unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const mod = require("./CitizenHawkers2");

const {
  hashStr,
  pickOne,
  fill,
  prettyWare,
  hawkerTypeFromRoll,
  hawkerTypeOf,
  pitchFor,
  goodsFor,
  taskForToday,
  hoarseFor,
  heckledFor,
  crowdFor,
  marketWaresFor,
  tickHawker,
  isWorkHour,
  dayNumber,
  chance,
  seededRng,
  normalizeName,
  isRealPlayer,
  withinTiles,
  HAWKER_TYPES,
  PRODUCE_HAWKER,
  FISH_HAWKER,
  TRINKET_HAWKER,
  FLOWER_HAWKER,
  PITCHES,
  GOODS,
  HAWKER_SHARE,
  WORK_START_HOUR,
  WORK_END_HOUR,
  HAWKER_RADIUS,
  HAWKER_CHANCE,
  HOARSE_CHANCE,
  HECKLED_CHANCE,
  CROWD_CHANCE,
} = mod;

// local-time constructors (never Date.UTC — the PC runs on EDT;
// chosen times are safely inside/outside work hours in any TZ)
const NOON = new Date(2026, 9, 8, 12, 0).getTime(); // October, mid-day
const EIGHT_AM = new Date(2026, 9, 8, 8, 0).getTime();
const EIGHT_PM = new Date(2026, 9, 8, 20, 0).getTime();
const SIX_AM = new Date(2026, 9, 8, 6, 0).getTime();
const TEN_PM = new Date(2026, 9, 8, 22, 0).getTime();

// --- hashStr ---
assert.equal(typeof hashStr("abc"), "number");
assert.equal(hashStr("abc"), hashStr("abc"), "hash must be deterministic");
assert.notEqual(hashStr("abc"), hashStr("abd"), "hash must differ for different strings");
assert.equal(hashStr(null), hashStr(""), "null hashes like empty string");

// --- fill ---
assert.equal(fill("Hello {name}, {goods}!", { name: "Jon", goods: "turnips" }), "Hello Jon, turnips!");
assert.equal(fill("no slots", {}), "no slots");
assert.equal(fill("{a}{a}", { a: "x" }), "xx");

// --- prettyWare ---
assert.equal(prettyWare("IRON_SWORD"), "iron sword");
assert.equal(prettyWare("BREAD"), "bread");
assert.equal(prettyWare(null), "");

// --- hawkerTypeFromRoll (weights: produce 30 / fish 30 / trinket 25 / flower 15) ---
assert.equal(hawkerTypeFromRoll(0), PRODUCE_HAWKER);
assert.equal(hawkerTypeFromRoll(29), PRODUCE_HAWKER);
assert.equal(hawkerTypeFromRoll(30), FISH_HAWKER);
assert.equal(hawkerTypeFromRoll(59), FISH_HAWKER);
assert.equal(hawkerTypeFromRoll(60), TRINKET_HAWKER);
assert.equal(hawkerTypeFromRoll(84), TRINKET_HAWKER);
assert.equal(hawkerTypeFromRoll(85), FLOWER_HAWKER);
assert.equal(hawkerTypeFromRoll(99), FLOWER_HAWKER);

// --- distribution: ~35% of commoners are hawkers (post-exclusion) ---
{
  let n = 0, hawkers = 0;
  for (let i = 0; i < 4000; i++) {
    n++;
    if (hawkerTypeOf({ username: "DistHawk" + i, role: "commoner" })) hawkers++;
  }
  const pct = hawkers / n;
  assert.ok(pct > 0.2 && pct < 0.45, `expected ~35% share, got ${pct}`);
  console.log(`distribution: PASS (${(pct * 100).toFixed(1)}%)`);
}

// --- type stability ---
{
  const rec = { username: "StableHawk", role: "commoner", kingdomId: "asgarnia" };
  const a = hawkerTypeOf(rec);
  const b = hawkerTypeOf({ username: "StableHawk", role: "COMMONER", kingdom: "asgarnia" });
  assert.equal(a, b, "type must be stable across restarts/role casing");
  console.log("type stability: PASS");
}

// --- commoner gating ---
{
  assert.equal(hawkerTypeOf({ username: "GuardOne", role: "guard" }), null);
  assert.equal(hawkerTypeOf({ username: "MerchantX", role: "merchant" }), null);
  assert.equal(hawkerTypeOf({ username: "", role: "commoner" }), null);
  assert.equal(hawkerTypeOf(null), null);
  console.log("commoner gating: PASS");
}

// --- merchant exclusion: claimed stall merchants (role "merchant") never
// become hawkers, even when the share roll would pass ---
{
  let found = null;
  for (let i = 0; i < 20000 && !found; i++) {
    const u = "MerchantGate" + i;
    if ((hashStr(normalizeName(u) + "|hawker") % 100) < HAWKER_SHARE) found = u;
  }
  assert.ok(found, "found a name that passes the share roll");
  const pro = hawkerTypeOf({ username: found, role: "commoner" });
  assert.ok(pro, "the same name IS a hawker as a commoner");
  assert.equal(hawkerTypeOf({ username: found, role: "merchant" }), null,
    "the same name is NOT a hawker as a claimed stall merchant (role gate first)");
  console.log("merchant exclusion: PASS");
}

// --- market bridge: real day wares cross-read from CitizenMarketStalls ---
{
  const wares = marketWaresFor("misthalin", NOON);
  assert.ok(Array.isArray(wares) && wares.length > 0, "bridge must return real day wares");
  assert.ok(wares.every((w) => /^[a-z ]+$/.test(w)), `wares must be pretty names, got ${wares}`);
  const again = marketWaresFor("misthalin", NOON);
  assert.deepEqual(wares, again, "bridge must be stable per kingdom/day");
  assert.equal(marketWaresFor("", NOON), null, "empty kingdom -> null");
  console.log(`market bridge: PASS (${wares.join(", ")})`);
}

// --- pitch assignment: kingdom-preferred, stable per day ---
{
  const rec = { username: "SpotHawk", role: "commoner", kingdomId: "kandarin" };
  const s1 = pitchFor(rec, PRODUCE_HAWKER, NOON);
  const s2 = pitchFor(rec, PRODUCE_HAWKER, NOON);
  assert.equal(s1.name, s2.name, "pitch stable per day");
  assert.equal(s1.kingdom, "kandarin", "kingdom-preferred pitch");
  assert.ok(PITCHES.includes(s1), "pitch comes from the pitch pool");
  assert.ok(PITCHES.length >= 10, "at least 10 pitches");
  assert.ok(pitchFor(null, FISH_HAWKER), "null record still yields a pitch (anon fallback)");
  console.log("pitch assignment: PASS");
}

// --- goods basket: seeded per day, from the type's wares ---
{
  const g1 = goodsFor("BasketHawk", FISH_HAWKER, NOON);
  const g2 = goodsFor("BasketHawk", FISH_HAWKER, NOON);
  assert.equal(g1, g2, "goods stable per day");
  assert.ok(GOODS[FISH_HAWKER].includes(g1), "goods come from the fish basket");
  const g3 = goodsFor("BasketHawk", PRODUCE_HAWKER, NOON);
  assert.ok(GOODS[PRODUCE_HAWKER].includes(g3), "goods come from the produce basket");
  assert.ok(g1 !== goodsFor("BasketHawk", FISH_HAWKER, NOON + 30 * 86400000) || true,
    "basket may rotate across days (no constraint)");
  console.log(`goods basket: PASS (${g1} / ${g3})`);
}

// --- set-pieces: deterministic per kingdom/day, within the ~6-8% bands ---
{
  const kid = "keldagrim";
  const d1 = new Date(2026, 9, 8, 12, 0).getTime();
  assert.equal(hoarseFor(kid, d1), hoarseFor(kid, d1), "hoarse deterministic");
  assert.equal(heckledFor(kid, d1), heckledFor(kid, d1), "heckled deterministic");
  const p = { name: "Canifis town square" };
  assert.equal(crowdFor(p, d1), crowdFor(p, d1), "crowd deterministic");
  // frequency over 365 days x 6 kingdoms (crowd: 12 pitches)
  const kids = ["misthalin", "asgarnia", "kandarin", "keldagrim", "morytania", "kharidian"];
  let hoarse = 0, heckled = 0, kTrials = 0;
  let crowds = 0, cTrials = 0;
  for (const k of kids) {
    for (let d = 0; d < 365; d++) {
      const t = d1 + d * 86400000;
      kTrials++;
      if (hoarseFor(k, t)) hoarse++;
      if (heckledFor(k, t)) heckled++;
    }
  }
  for (const pitch of PITCHES) {
    for (let d = 0; d < 365; d++) {
      const t = d1 + d * 86400000;
      cTrials++;
      if (crowdFor(pitch, t)) crowds++;
    }
  }
  assert.ok(hoarse / kTrials > HOARSE_CHANCE - 0.03 && hoarse / kTrials < HOARSE_CHANCE + 0.05,
    `hoarse band, got ${hoarse / kTrials}`);
  assert.ok(heckled / kTrials > HECKLED_CHANCE - 0.04 && heckled / kTrials < HECKLED_CHANCE + 0.05,
    `heckled band, got ${heckled / kTrials}`);
  assert.ok(crowds / cTrials > CROWD_CHANCE - 0.04 && crowds / cTrials < CROWD_CHANCE + 0.05,
    `crowd band, got ${crowds / cTrials}`);
  assert.equal(hoarseFor("", d1), false, "empty kingdom -> false");
  assert.equal(crowdFor(null, d1), false, "null pitch -> false");
  console.log(`set-pieces: PASS (hoarse ${(hoarse / kTrials * 100).toFixed(1)}% / heckled ${(heckled / kTrials * 100).toFixed(1)}% / crowd ${(crowds / cTrials * 100).toFixed(1)}%)`);
}

// --- work hours: 07:00-19:00 local ---
{
  assert.equal(isWorkHour(NOON), true, "noon in hours");
  assert.equal(isWorkHour(EIGHT_AM), true, "08:00 in hours");
  assert.equal(isWorkHour(SIX_AM), false, "06:00 out of hours");
  assert.equal(isWorkHour(EIGHT_PM), false, "20:00 out of hours");
  assert.equal(isWorkHour(TEN_PM), false, "22:00 out of hours");
  assert.equal(WORK_START_HOUR, 7);
  assert.equal(WORK_END_HOUR, 19);
  console.log("work hours: PASS");
}

// --- guards: isRealPlayer, withinTiles, chance ---
{
  assert.equal(isRealPlayer(null), false);
  assert.equal(isRealPlayer({ isPlayerBot: () => true, getUsername: () => "Bot" }), false);
  assert.equal(isRealPlayer({ getHostAddress: () => "bot", getUsername: () => "Bot" }), false);
  assert.equal(isRealPlayer({ getHostAddress: () => "1.2.3.4", getUsername: () => "Jon" }), true);
  const a = { getLocation: () => ({ getX: () => 100, getY: () => 100, getZ: () => 0 }) };
  const b = { getLocation: () => ({ getX: () => 110, getY: () => 105, getZ: () => 0 }) };
  const c = { getLocation: () => ({ getX: () => 200, getY: () => 100, getZ: () => 0 }) };
  assert.equal(withinTiles(a, b, 14), true);
  assert.equal(withinTiles(a, c, 14), false);
  assert.equal(withinTiles(a, null, 14), false);
  const rng = seededRng(12345);
  assert.equal(typeof chance(rng, 0.5), "boolean");
  assert.equal(chance(() => 0, 0.5), true);
  assert.equal(chance(() => 0.999, 0.5), false);
  console.log("guards: PASS");
}

// --- tick: fires near a real player during work hours; cooldown; silence otherwise ---
{
  mod._resetState();
  // find a hawker username
  let citizenName = null;
  for (let i = 0; i < 3000 && !citizenName; i++) {
    const u = "TickHawk" + i;
    if (hawkerTypeOf({ username: u, role: "commoner" })) citizenName = u;
  }
  assert.ok(citizenName, "found a hawker citizen");

  const said = [];
  const mkCitizen = () => ({
    forceChat: (line) => said.push(line),
    getLocation: () => ({ getX: () => 100, getY: () => 100, getZ: () => 0 }),
  });
  const mkPlayer = (name, x) => ({
    getUsername: () => name,
    getHostAddress: () => "1.2.3.4",
    getLocation: () => ({ getX: () => x, getY: () => 100, getZ: () => 0 }),
  });

  const director = {
    roster: new Map([[citizenName, { username: citizenName, role: "commoner", kingdom: "misthalin" }]]),
    playerFor: () => mkCitizen(),
    onlinePlayers: () => [mkPlayer("Jon", 105)],
  };

  // monotonic timestamps: each tick call advances past the 3h cooldown
  let t = NOON;
  // deterministic rng: chance gate always passes (0) so the gate order is deterministic
  const origRandom = Math.random;
  Math.random = () => 0;
  try {
    tickHawker(director, t);
    assert.ok(said.length > 0, "fires with a real player near during work hours");
    const saidAgain = said.length;
    // second tick immediately: cooldown blocks
    tickHawker(director, t + 1000);
    assert.equal(said.length, saidAgain, "cooldown blocks repeat firing");

    // outside work hours: no fire (fresh state via _resetState)
    mod._resetState();
    said.length = 0;
    tickHawker(director, TEN_PM);
    assert.equal(said.length, 0, "no firing outside work hours");

    // no real player near: no fire
    mod._resetState();
    said.length = 0;
    director.onlinePlayers = () => [
      { isPlayerBot: () => true, getHostAddress: () => "bot", getUsername: () => "BotOne",
        getLocation: () => ({ getX: () => 101, getY: () => 100, getZ: () => 0 }) },
    ];
    tickHawker(director, NOON);
    assert.equal(said.length, 0, "no firing when only bots are near");
  } finally {
    Math.random = origRandom;
  }
  mod._resetState();
  console.log("tick gates: PASS");
}

// --- tick: never throws with empty/missing director bits ---
{
  mod._resetState();
  assert.doesNotThrow(() => tickHawker({}, NOON));
  assert.doesNotThrow(() => tickHawker({ roster: new Map() }, NOON));
  assert.doesNotThrow(() => tickHawker(null, NOON));
  assert.doesNotThrow(() => tickHawker({ roster: null }, NOON));
  console.log("never-throws: PASS");
}

// --- crowd moment: at most once per pitch per day ---
{
  mod._resetState();
  // find a hawker whose pitch has a crowd today (and no hoarse crier that day)
  let citizenName = null, type = null, t0 = null;
  for (let i = 0; i < 3000 && !t0; i++) {
    const u = "CrowdHawk" + i;
    const rec = { username: u, role: "commoner", kingdomId: "misthalin" };
    const ty = hawkerTypeOf(rec);
    if (!ty) continue;
    for (let d = 0; d < 180 && !t0; d++) {
      const t = NOON + d * 86400000;
      const spot = pitchFor(rec, ty, t);
      if (crowdFor(spot, t) && !hoarseFor("misthalin", t)) {
        citizenName = u; type = ty; t0 = t;
      }
    }
  }
  assert.ok(t0, "found a hawker with a crowd day");

  const said = [];
  const director = {
    roster: new Map([[citizenName, { username: citizenName, role: "commoner", kingdomId: "misthalin" }]]),
    playerFor: () => ({
      forceChat: (line) => said.push(line),
      getLocation: () => ({ getX: () => 100, getY: () => 100, getZ: () => 0 }),
    }),
    onlinePlayers: () => [{
      getUsername: () => "Jon",
      getHostAddress: () => "1.2.3.4",
      getLocation: () => ({ getX: () => 105, getY: () => 100, getZ: () => 0 }),
    }],
  };

  // deterministic rng: chance gate passes (0), heckled check skipped (0.5),
  // picks stable (0.5); second tick needs its own passing gate value
  const origRandom = Math.random;
  const seq = [0, 0.5, 0.5, 0, 0.5, 0.5, 0.5, 0.5];
  let calls = 0;
  Math.random = () => seq[calls++ % seq.length];
  try {
    tickHawker(director, t0);
    const crowdLines1 = said.filter((s) => s.toLowerCase().includes("crowd")).length;
    assert.ok(crowdLines1 > 0, "first tick fires the crowd moment");
    // past the 3h cooldown, same day: crowd key already spent -> normal line
    tickHawker(director, t0 + 3 * 3600 * 1000 + 1);
  } finally {
    Math.random = origRandom;
  }
  const crowdLines = said.filter((s) => s.toLowerCase().includes("crowd")).length;
  assert.equal(crowdLines, 1, `crowd moment fires at most once per pitch per day (got ${crowdLines})`);
  mod._resetState();
  console.log("crowd moment: PASS");
}

// --- pure helpers ---
{
  assert.equal(typeof pickOne(() => 0.1, ["a", "b"]), "string");
  assert.equal(pickOne(() => 0.9, ["a", "b"]), "b");
  const r1 = seededRng(42), r2 = seededRng(42);
  assert.equal(r1(), r2(), "seeded rng deterministic");
  assert.equal(dayNumber(0), 0);
  assert.equal(dayNumber(86400000), 1);
  assert.equal(taskForToday("SomeName", FISH_HAWKER, NOON), taskForToday("SomeName", FISH_HAWKER, NOON),
    "daily task stable");
  assert.ok(HAWKER_TYPES.includes(TRINKET_HAWKER));
  assert.ok(PITCHES.length >= 10 && Object.keys(GOODS).length === 4);
  console.log("pure helpers: PASS");
}

// --- tuning constants pinned ---
{
  assert.equal(HAWKER_SHARE, 35);
  assert.equal(HAWKER_RADIUS, 14);
  assert.equal(HAWKER_CHANCE, 0.15);
  assert.equal(HOARSE_CHANCE, 0.06);
  assert.equal(HECKLED_CHANCE, 0.08);
  assert.equal(CROWD_CHANCE, 0.08);
  console.log("tuning constants: PASS");
}

console.log("ALL CITIZENHAWKERS2 TESTS PASSED");
