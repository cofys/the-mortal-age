// CitizenGlassblowers2 unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const mod = require("./CitizenGlassblowers2");

const {
  hashStr,
  pickOne,
  fill,
  glassfolkTypeFromRoll,
  glassfolkTypeOf,
  workshopFor,
  sandSourceFor,
  tavernFor,
  bottlesForToday,
  culletForToday,
  sandForToday,
  taskForToday,
  sandDelayFor,
  tavernSmashFor,
  proHeadlinePiece,
  requestPickup,
  pickupFor,
  pickupReady,
  completePickup,
  tickGlassfolk,
  isWorkHour,
  dayNumber,
  chance,
  seededRng,
  normalizeName,
  isRealPlayer,
  withinTiles,
  GLASSFOLK_TYPES,
  BOTTLE_COLLECTOR,
  CULLET_SORTER,
  SAND_CARRIER,
  BOTTLE_WASHER,
  GLASSFOLK_SHARE,
  WORK_START_HOUR,
  WORK_END_HOUR,
  GLASSFOLK_RADIUS,
  EMPTY_BOTTLES,
  CULLET_COLORS,
  SAND_KINDS,
  SAND_SOURCES,
  TAVERNS,
} = mod;

// local-time constructors (never Date.UTC — the PC runs on EDT)
const NOON = new Date(2026, 9, 8, 12, 0).getTime(); // October, mid-day
const NOON_PLUS_1S = NOON + 1000;
const NOON_PLUS_4H = NOON + 4 * 3600 * 1000;
const MIDNIGHT = new Date(2026, 9, 8, 2, 0).getTime();
const NEXT_NOON = new Date(2026, 9, 9, 12, 0).getTime();

// --- hashStr ---
assert.equal(typeof hashStr("abc"), "number");
assert.equal(hashStr("abc"), hashStr("abc"), "hash must be deterministic");
assert.notEqual(hashStr("abc"), hashStr("abd"), "hash must differ for different strings");
assert.equal(hashStr(null), hashStr(""), "null hashes like empty string");

// --- fill ---
assert.equal(fill("Hello {name}, {bottles}!", { name: "Jon", bottles: "empties" }), "Hello Jon, empties!");
assert.equal(fill("no slots", {}), "no slots");
assert.equal(fill("{a}{a}", { a: "x" }), "xx");

// --- glassfolkTypeFromRoll: weights 35/25/20/20 ---
assert.equal(glassfolkTypeFromRoll(0), BOTTLE_COLLECTOR);
assert.equal(glassfolkTypeFromRoll(34), BOTTLE_COLLECTOR);
assert.equal(glassfolkTypeFromRoll(35), CULLET_SORTER);
assert.equal(glassfolkTypeFromRoll(59), CULLET_SORTER);
assert.equal(glassfolkTypeFromRoll(60), SAND_CARRIER);
assert.equal(glassfolkTypeFromRoll(79), SAND_CARRIER);
assert.equal(glassfolkTypeFromRoll(80), BOTTLE_WASHER);
assert.equal(glassfolkTypeFromRoll(99), BOTTLE_WASHER);

// --- distribution sanity: all types reachable, ~share of names qualify ---
{
  let seen = new Set();
  let qualified = 0;
  for (let i = 0; i < 2000; i++) {
    const t = glassfolkTypeOf({ username: "GlassfolkTest" + i, role: "commoner" });
    if (t) {
      qualified++;
      seen.add(t);
    }
  }
  assert.deepEqual([...seen].sort(), [...GLASSFOLK_TYPES].sort(), "all four types reachable");
  const pct = qualified / 2000;
  // ~45% nominal share of commoners (base glassblowers exclude a further chunk)
  assert.ok(pct > 0.15 && pct < 0.6, `qualify share ${pct} within sane bounds`);
}

// --- guards merchants/guards, anonymous names ---
assert.equal(glassfolkTypeOf({ username: "x", role: "guard" }), null);
assert.equal(glassfolkTypeOf({ username: "x", role: "merchant" }), null);
assert.equal(glassfolkTypeOf({ username: "" }), null);

// --- no overlap: a professional glassblower is never a glassfolk ---
// base CitizenGlassblowers.glassblowerTypeOf rolls ~75% nominal but the 12+
// professional exclusion chain brings the effective rate down to a few
// percent; scan until we have enough pro hits instead of assuming a rate.
{
  const Pro = require("./CitizenGlassblowers");
  const pros = [];
  for (let i = 0; i < 5000 && pros.length < 40; i++) {
    const rec = { username: "OverlapGlass" + i, role: "commoner" };
    if (Pro.glassblowerTypeOf(rec)) pros.push(rec);
  }
  assert.ok(pros.length >= 20, `enough pros in sample (${pros.length})`);
  const violations = pros.filter((rec) => glassfolkTypeOf(rec) !== null).length;
  assert.equal(violations, 0, "professionals must never be glassfolk");
}

// --- workshopFor: cross-reads the professional glasshouse assignment ---
{
  const w1 = workshopFor({ username: "ShopUser", kingdom: "asgarnia", kingdomId: "asgarnia" });
  const w2 = workshopFor({ username: "ShopUser", kingdom: "asgarnia", kingdomId: "asgarnia" });
  assert.deepEqual(w1, w2, "workshop stable for same name+kingdom");
  assert.ok(w1 && w1.name, "workshop has a name");
}

// --- sandSourceFor / tavernFor: kingdom-preferred, stable ---
{
  const s1 = sandSourceFor({ username: "SandUser", kingdom: "kharidian" });
  const s2 = sandSourceFor({ username: "SandUser", kingdom: "kharidian" });
  assert.deepEqual(s1, s2, "sand source stable for same name+kingdom");
  assert.ok(s1.kingdom === "kharidian", "kingdom preferred when available");
  const s3 = sandSourceFor({ username: "SandUser", kingdom: "kandarin" });
  assert.notDeepEqual(s1, s3, "different kingdoms -> different sand pools");
  const s4 = sandSourceFor({ username: "SandUser2", kingdom: "nonsense" });
  assert.ok(s4 && s4.name, "fallback to global pool for unknown kingdom");

  const t1 = tavernFor({ username: "WashUser", kingdom: "morytania" });
  assert.ok(t1 && t1.name, "tavern has a name");
  const t2 = tavernFor({ username: "WashUser2", kingdom: "nonsense" });
  assert.ok(t2 && t2.name, "tavern fallback works");
}

// --- daily tables: stable within a day, vary across days ---
{
  const b1 = bottlesForToday("BottleUser", NOON);
  const b2 = bottlesForToday("BottleUser", NOON_PLUS_4H);
  assert.equal(b1, b2, "bottles stable within the day");
  assert.ok(EMPTY_BOTTLES.includes(b1), "bottles from the empty-bottle table");

  const c1 = culletForToday("CulletUser", NOON);
  const c2 = culletForToday("CulletUser", NOON_PLUS_1S);
  assert.equal(c1, c2, "cullet stable within the day");
  assert.ok(CULLET_COLORS.includes(c1), "cullet from the cullet table");

  const s1 = sandForToday("SandUser", NOON);
  assert.ok(SAND_KINDS.includes(s1), "sand from the sand table");

  const t1 = taskForToday("TaskUser", SAND_CARRIER, NOON);
  const t2 = taskForToday("TaskUser", SAND_CARRIER, NOON_PLUS_1S);
  assert.equal(t1, t2, "task stable within the day");

  const anyDiffer = ["BottleUser", "BottleUserB", "BottleUserC"].some(
    (u) => bottlesForToday(u, NOON) !== bottlesForToday(u, NEXT_NOON) || bottlesForToday(u, NOON) !== bottlesForToday("BottleUser", NOON)
  );
  assert.ok(anyDiffer, "bottles vary across users/days");
}

// --- empty bottles are tavern leavings, never finished glassware ---
{
  const finished = ["blown drinking glass", "green wine bottle", "potion vial", "glass carafe",
    "stained-glass pane", "glass swan", "crystal prism"];
  for (const b of EMPTY_BOTTLES) {
    assert.ok(!finished.includes(b), `${b} must not be finished glassware`);
  }
}

// --- sand sources and taverns cover all six kingdoms ---
{
  const kids = new Set(["misthalin", "asgarnia", "kandarin", "keldagrim", "morytania", "kharidian"]);
  for (const s of SAND_SOURCES) kids.add(s.kingdom);
  for (const t of TAVERNS) kids.add(t.kingdom);
  assert.ok(kids.size >= 6, "all kingdoms covered");
  for (const kid of ["misthalin", "asgarnia", "kandarin", "keldagrim", "morytania", "kharidian"]) {
    assert.ok(SAND_SOURCES.some((s) => s.kingdom === kid), `sand source in ${kid}`);
    assert.ok(TAVERNS.some((t) => t.kingdom === kid), `tavern in ${kid}`);
  }
}

// --- isWorkHour: local-time hours 06:00-20:00 ---
assert.equal(isWorkHour(NOON), true, "noon is a work hour");
assert.equal(isWorkHour(MIDNIGHT), false, "02:00 is not a work hour");
assert.equal(isWorkHour(new Date(2026, 9, 8, 5, 59).getTime()), false);
assert.equal(isWorkHour(new Date(2026, 9, 8, 6, 0).getTime()), true);
assert.equal(isWorkHour(new Date(2026, 9, 8, 19, 59).getTime()), true);
assert.equal(isWorkHour(new Date(2026, 9, 8, 20, 0).getTime()), false);
assert.equal(WORK_START_HOUR, 6);
assert.equal(WORK_END_HOUR, 20);

// --- dayNumber / seededRng / chance ---
assert.equal(dayNumber(0), 0);
assert.equal(dayNumber(86400000), 1);
{
  const r1 = seededRng(42);
  const r2 = seededRng(42);
  assert.equal(r1(), r2(), "seeded rng deterministic");
  let seenTrue = false, seenFalse = false;
  const r = seededRng(7);
  for (let i = 0; i < 100; i++) chance(r, 0.5) ? (seenTrue = true) : (seenFalse = true);
  assert.ok(seenTrue && seenFalse, "chance is probabilistic");
  assert.equal(chance(seededRng(1), 0), false);
  assert.equal(chance(seededRng(1), 1), true);
}

// --- isRealPlayer / withinTiles / normalizeName ---
{
  const bot = { isPlayerBot: () => true, getHostAddress: () => "bot", getUsername: () => "Bot" };
  const human = { getUsername: () => "Jon", getHostAddress: () => "1.2.3.4" };
  assert.equal(isRealPlayer(bot), false);
  assert.equal(isRealPlayer(human), true);
  assert.equal(isRealPlayer(null), false);

  const mkLoc = (x, y, z) => ({ getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => z }) });
  assert.equal(withinTiles(mkLoc(0, 0, 0), mkLoc(5, 5, 0), GLASSFOLK_RADIUS), true);
  assert.equal(withinTiles(mkLoc(0, 0, 0), mkLoc(50, 50, 0), GLASSFOLK_RADIUS), false);
  assert.equal(withinTiles(mkLoc(0, 0, 0), mkLoc(0, 0, 1), GLASSFOLK_RADIUS), false, "different plane");

  assert.equal(normalizeName("  Jon  "), "jon");
}

// --- sandDelayFor / tavernSmashFor: stable per day, ~8% hit rate ---
{
  const d1 = sandDelayFor("asgarnia", NOON);
  const d2 = sandDelayFor("asgarnia", NOON_PLUS_4H);
  assert.equal(d1, d2, "sand delay stable within the day");
  assert.equal(sandDelayFor(null, NOON), null);
  assert.equal(tavernSmashFor(null, NOON), null);
  let delays = 0, smashes = 0;
  for (let i = 0; i < 500; i++) {
    if (sandDelayFor("k" + i, NOON)) delays++;
    if (tavernSmashFor("k" + i, NOON)) smashes++;
  }
  assert.ok(delays > 5 && delays < 120, `sand delay rate sane (${delays}/500)`);
  assert.ok(smashes > 5 && smashes < 120, `tavern smash rate sane (${smashes}/500)`);
}

// --- proHeadlinePiece: cross-reads the real glassblowers ---
{
  const p = proHeadlinePiece("HeadlineUser", "asgarnia", NOON);
  assert.ok(typeof p === "string" && p.length > 0, "pro headline piece returns a name");
}

// --- pickup ledger: request -> pending -> ready -> collect ---
{
  mod._resetState();
  const pk = requestPickup("Jon", "GlassfolkGary", "empty green wine bottles", 12, NOON);
  assert.ok(pk, "pickup request created");
  assert.equal(pk.count, 12, "count recorded");
  assert.ok(pk.durationMs >= 3600 * 1000 && pk.durationMs <= 3 * 3600 * 1000, "1-3h duration");
  assert.ok(!pickupReady(pk, NOON), "not ready immediately");
  assert.ok(!pickupReady(pickupFor("Jon", NOON), NOON), "ledger copy not ready");
  assert.ok(pickupReady(pickupFor("Jon", NOON), NOON + pk.durationMs + 1), "ready after duration");
  assert.equal(completePickup("Jon", NOON + pk.durationMs + 1), true, "collect works");
  assert.equal(pickupFor("Jon", NOON), null, "record gone after collect");
  assert.equal(requestPickup("Jon", "", "bottles", 5, NOON), null, "blank collector rejected");
  assert.equal(requestPickup("Jon", "Gary", "", 5, NOON), null, "blank bottles rejected");
  assert.equal(requestPickup("", "Gary", "bottles", 5, NOON), null, "blank player rejected");
  // TTL expiry
  requestPickup("Jon", "Gary", "bottles", 5, NOON);
  assert.equal(pickupFor("Jon", NOON + 25 * 3600 * 1000), null, "request expires after 24h");
  mod._resetState();
}

// --- tick: fires only with real player near, inside work hours ---
{
  mod._resetState();
  // find a qualifying commoner name deterministically
  let citizenName = null;
  for (let i = 0; i < 5000 && !citizenName; i++) {
    const n = "TickGlass" + i;
    if (glassfolkTypeOf({ username: n, role: "commoner" })) citizenName = n;
  }
  assert.ok(citizenName, "found a qualifying glassfolk name");

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
  // monkey-patch chance to always pass so the gate order is deterministic
  const origRandom = Math.random;
  Math.random = () => 0;
  try {
    tickGlassfolk(director, t);
    assert.ok(said.length > 0, "fires with a real player near during work hours");
    const saidAgain = said.length;
    // second tick immediately: cooldown blocks
    tickGlassfolk(director, t + 1000);
    assert.equal(said.length, saidAgain, "cooldown blocks repeat firing");

    // outside work hours: no fire (fresh state via _resetState)
    mod._resetState();
    said.length = 0;
    t = MIDNIGHT;
    tickGlassfolk(director, t);
    assert.equal(said.length, 0, "no firing outside work hours");

    // no real player near: no fire
    mod._resetState();
    said.length = 0;
    director.onlinePlayers = () => [
      { isPlayerBot: () => true, getHostAddress: () => "bot", getUsername: () => "BotOne",
        getLocation: () => ({ getX: () => 101, getY: () => 100, getZ: () => 0 }) },
    ];
    tickGlassfolk(director, NOON);
    assert.equal(said.length, 0, "no firing when only bots are near");
  } finally {
    Math.random = origRandom;
  }
  mod._resetState();
}

// --- tick: never throws with empty/missing director bits ---
{
  mod._resetState();
  assert.doesNotThrow(() => tickGlassfolk({}, NOON));
  assert.doesNotThrow(() => tickGlassfolk({ roster: new Map() }, NOON));
}

// --- ready-pickup priority: a collector names the waiting player ---
{
  mod._resetState();
  let citizenName = null;
  for (let i = 0; i < 5000 && !citizenName; i++) {
    const n = "ReadyGlass" + i;
    if (glassfolkTypeOf({ username: n, role: "commoner" }) === BOTTLE_COLLECTOR) citizenName = n;
  }
  assert.ok(citizenName, "found a collector name");
  const said = [];
  const citizen = {
    forceChat: (line) => said.push(line),
    getLocation: () => ({ getX: () => 100, getY: () => 100, getZ: () => 0 }),
  };
  const player = {
    getUsername: () => "Jon",
    getHostAddress: () => "9.9.9.9",
    getLocation: () => ({ getX: () => 102, getY: () => 100, getZ: () => 0 }),
  };
  const director = {
    roster: new Map([[citizenName, { username: citizenName, role: "commoner", kingdom: "misthalin" }]]),
    playerFor: () => citizen,
    onlinePlayers: () => [player],
  };
  requestPickup("Jon", citizenName, "empty rum bottles", 7, NOON);
  const origRandom = Math.random;
  Math.random = () => 0;
  try {
    tickGlassfolk(director, NOON + 4 * 3600 * 1000);
  } finally {
    Math.random = origRandom;
  }
  assert.ok(said.some((l) => l.includes("Jon") && l.includes("empty rum bottles")), "ready pickup names the player");
  mod._resetState();
}

console.log("CitizenGlassblowers2: all checks passed");
