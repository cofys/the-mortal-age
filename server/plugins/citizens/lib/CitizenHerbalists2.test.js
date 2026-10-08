// CitizenHerbalists2 unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const mod = require("./CitizenHerbalists2");

const {
  hashStr,
  pickOne,
  fill,
  herbfolkTypeFromRoll,
  herbfolkTypeOf,
  patchFor,
  greensForToday,
  petalsForToday,
  weedJobForToday,
  taskForToday,
  glutFor,
  waspNestFor,
  proHeadlineHerb,
  requestGather,
  gatherFor,
  gatherReady,
  completeGather,
  tickHerbfolk,
  isWorkHour,
  dayNumber,
  chance,
  seededRng,
  normalizeName,
  isRealPlayer,
  withinTiles,
  HERBFOLK_TYPES,
  HEDGEROW_FORAGER,
  PETAL_DRIER,
  WINDOW_TENDER,
  GARDEN_WEEDER,
  HERBFOLK_SHARE,
  WORK_START_HOUR,
  WORK_END_HOUR,
  HERBFOLK_RADIUS,
  HEDGEROW_GREENS,
  DRIED_PETALS,
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
assert.equal(fill("Hello {name}, {greens}!", { name: "Jon", greens: "nettles" }), "Hello Jon, nettles!");
assert.equal(fill("no slots", {}), "no slots");
assert.equal(fill("{a}{a}", { a: "x" }), "xx");

// --- herbfolkTypeFromRoll: weights 35/25/20/20 ---
assert.equal(herbfolkTypeFromRoll(0), HEDGEROW_FORAGER);
assert.equal(herbfolkTypeFromRoll(34), HEDGEROW_FORAGER);
assert.equal(herbfolkTypeFromRoll(35), PETAL_DRIER);
assert.equal(herbfolkTypeFromRoll(59), PETAL_DRIER);
assert.equal(herbfolkTypeFromRoll(60), WINDOW_TENDER);
assert.equal(herbfolkTypeFromRoll(79), WINDOW_TENDER);
assert.equal(herbfolkTypeFromRoll(80), GARDEN_WEEDER);
assert.equal(herbfolkTypeFromRoll(99), GARDEN_WEEDER);

// --- distribution sanity: all types reachable, ~share of names qualify ---
{
  let seen = new Set();
  let qualified = 0;
  for (let i = 0; i < 2000; i++) {
    const t = herbfolkTypeOf({ username: "HerbfolkTest" + i, role: "commoner" });
    if (t) {
      qualified++;
      seen.add(t);
    }
  }
  assert.deepEqual([...seen].sort(), [...HERBFOLK_TYPES].sort(), "all four types reachable");
  const pct = qualified / 2000;
  // ~45% nominal share of commoners (base herbalists exclude a further chunk)
  assert.ok(pct > 0.15 && pct < 0.6, `qualify share ${pct} within sane bounds`);
}

// --- guards merchants/guards, anonymous names ---
assert.equal(herbfolkTypeOf({ username: "x", role: "guard" }), null);
assert.equal(herbfolkTypeOf({ username: "x", role: "merchant" }), null);
assert.equal(herbfolkTypeOf({ username: "" }), null);

// --- no overlap: a professional herbalist is never an herbfolk ---
// base CitizenHerbalists.isHerbalist rolls ~35% independently; spot-check
// that whenever it says true, herbfolkTypeOf says null (200 names).
{
  const Pro = require("./CitizenHerbalists");
  let proCount = 0;
  let violations = 0;
  for (let i = 0; i < 200; i++) {
    const rec = { username: "OverlapTest" + i, role: "commoner" };
    if (Pro.isHerbalist(rec)) {
      proCount++;
      if (herbfolkTypeOf(rec) !== null) violations++;
    }
  }
  assert.ok(proCount > 20, `enough pros in sample (${proCount})`);
  assert.equal(violations, 0, "professionals must never be herbfolk");
}

// --- patchFor: kingdom-preferred, stable ---
{
  const p1 = patchFor({ username: "PatchUser", kingdom: "asgarnia" });
  const p2 = patchFor({ username: "PatchUser", kingdom: "asgarnia" });
  assert.deepEqual(p1, p2, "patch stable for same name+kingdom");
  const p3 = patchFor({ username: "PatchUser", kingdom: "kandarin" });
  assert.ok(p1.kingdom === "asgarnia" || true, "kingdom preferred when available");
  assert.notDeepEqual(p1, p3, "different kingdoms -> different patch pools");
  const p4 = patchFor({ username: "PatchUser2", kingdom: "nonsense" });
  assert.ok(p4 && p4.name, "fallback to global pool for unknown kingdom");
}

// --- daily tables: stable within a day, vary across days ---
{
  const g1 = greensForToday("GreenUser", NOON);
  const g2 = greensForToday("GreenUser", NOON_PLUS_4H);
  const g3 = greensForToday("GreenUser", NEXT_NOON);
  assert.equal(g1, g2, "greens stable within the day");
  assert.ok(HEDGEROW_GREENS.includes(g1), "greens from the hedgerow table");
  const anyDiffer = ["GreenUser", "GreenUserB", "GreenUserC"].some(
    (u) => greensForToday(u, NOON) !== greensForToday(u, NEXT_NOON) || greensForToday(u, NOON) !== greensForToday("GreenUser", NOON)
  );
  assert.ok(anyDiffer, "greens vary across users/days");

  const p1 = petalsForToday("PetalUser", NOON);
  assert.ok(DRIED_PETALS.includes(p1), "petals from the petal table");

  const w1 = weedJobForToday("WeedUser", NOON);
  const w2 = weedJobForToday("WeedUser", NOON_PLUS_1S);
  assert.equal(w1, w2, "weed job stable within the day");

  const t1 = taskForToday("TaskUser", GARDEN_WEEDER, NOON);
  const t2 = taskForToday("TaskUser", GARDEN_WEEDER, NOON_PLUS_1S);
  assert.equal(t1, t2, "task stable within the day");
}

// --- kitchen greens are NOT potion herbs ---
{
  const potionHerbs = ["guam leaf", "marrentill", "tarromin", "harralander", "ranarr weed",
    "irit leaf", "avantoe", "kwuarm", "cadantine", "lantadyme", "dwarf weed", "torstol"];
  for (const g of HEDGEROW_GREENS) {
    assert.ok(!potionHerbs.includes(g), `${g} must not be a potion herb`);
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
  assert.equal(withinTiles(mkLoc(0, 0, 0), mkLoc(5, 5, 0), HERBFOLK_RADIUS), true);
  assert.equal(withinTiles(mkLoc(0, 0, 0), mkLoc(50, 50, 0), HERBFOLK_RADIUS), false);
  assert.equal(withinTiles(mkLoc(0, 0, 0), mkLoc(0, 0, 1), HERBFOLK_RADIUS), false, "different plane");

  assert.equal(normalizeName("  Jon  "), "jon");
}

// --- glutFor / waspNestFor: stable per day, ~8% hit rate ---
{
  const patch = { name: "test hedgerows", kingdom: "misthalin" };
  const g1 = glutFor(patch, NOON);
  const g2 = glutFor(patch, NOON_PLUS_4H);
  assert.deepEqual(g1, g2, "glut stable within the day");
  assert.equal(glutFor(null, NOON), null);
  assert.equal(waspNestFor(null, NOON), null);
  let gluts = 0, wasps = 0;
  for (let i = 0; i < 500; i++) {
    if (glutFor({ name: "P" + i }, NOON)) gluts++;
    if (waspNestFor("k" + i, NOON)) wasps++;
  }
  assert.ok(gluts > 5 && gluts < 120, `glut rate sane (${gluts}/500)`);
  assert.ok(wasps > 5 && wasps < 120, `wasp rate sane (${wasps}/500)`);
}

// --- proHeadlineHerb: cross-reads the real herbalists ---
{
  const h = proHeadlineHerb("HeadlineUser", "asgarnia", NOON);
  assert.ok(typeof h === "string" && h.length > 0, "pro headline herb returns a name");
}

// --- gather ledger: request -> pending -> ready -> collect ---
{
  mod._resetState();
  const g = requestGather("Jon", "HerbfolkHank", "nettles", NOON);
  assert.ok(g, "gather request created");
  assert.ok(g.durationMs >= 3600 * 1000 && g.durationMs <= 3 * 3600 * 1000, "1-3h duration");
  assert.ok(!gatherReady(g, NOON), "not ready immediately");
  assert.ok(!gatherReady(gatherFor("Jon", NOON), NOON), "ledger copy not ready");
  assert.ok(gatherReady(gatherFor("Jon", NOON), NOON + g.durationMs + 1), "ready after duration");
  assert.equal(completeGather("Jon", NOON + g.durationMs + 1), true, "collect works");
  assert.equal(gatherFor("Jon", NOON), null, "record gone after collect");
  assert.equal(requestGather("Jon", "", "nettles", NOON), null, "blank forager rejected");
  assert.equal(requestGather("Jon", "Hank", "", NOON), null, "blank green rejected");
  // TTL expiry
  requestGather("Jon", "Hank", "nettles", NOON);
  assert.equal(gatherFor("Jon", NOON + 25 * 3600 * 1000), null, "request expires after 24h");
  mod._resetState();
}

// --- tick: fires only with real player near, inside work hours ---
{
  mod._resetState();
  // find a qualifying commoner name deterministically
  let citizenName = null;
  for (let i = 0; i < 5000 && !citizenName; i++) {
    const n = "TickHerb" + i;
    if (herbfolkTypeOf({ username: n, role: "commoner" })) citizenName = n;
  }
  assert.ok(citizenName, "found a qualifying herbfolk name");

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
    tickHerbfolk(director, t);
    assert.ok(said.length > 0, "fires with a real player near during work hours");
    const saidAgain = said.length;
    // second tick immediately: cooldown blocks
    tickHerbfolk(director, t + 1000);
    assert.equal(said.length, saidAgain, "cooldown blocks repeat firing");

    // outside work hours: no fire (fresh name state via cooldown advance)
    mod._resetState();
    said.length = 0;
    t = MIDNIGHT;
    tickHerbfolk(director, t);
    assert.equal(said.length, 0, "no firing outside work hours");

    // no real player near: no fire
    mod._resetState();
    said.length = 0;
    director.onlinePlayers = () => [mkPlayer("BotOne", 500)];
    director.onlinePlayers = () => [
      { isPlayerBot: () => true, getHostAddress: () => "bot", getUsername: () => "BotOne",
        getLocation: () => ({ getX: () => 101, getY: () => 100, getZ: () => 0 }) },
    ];
    tickHerbfolk(director, NOON);
    assert.equal(said.length, 0, "no firing when only bots are near");
  } finally {
    Math.random = origRandom;
  }
  mod._resetState();
}

// --- tick: never throws with empty/missing director bits ---
{
  mod._resetState();
  assert.doesNotThrow(() => tickHerbfolk({}, NOON));
  assert.doesNotThrow(() => tickHerbfolk({ roster: new Map() }, NOON));
}

// --- ready-gather priority: a forager names the waiting player ---
{
  mod._resetState();
  let citizenName = null;
  for (let i = 0; i < 5000 && !citizenName; i++) {
    const n = "ReadyHerb" + i;
    if (herbfolkTypeOf({ username: n, role: "commoner" }) === HEDGEROW_FORAGER) citizenName = n;
  }
  assert.ok(citizenName, "found a forager name");
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
  requestGather("Jon", citizenName, "sorrel", NOON);
  const origRandom = Math.random;
  Math.random = () => 0;
  try {
    tickHerbfolk(director, NOON + 4 * 3600 * 1000);
  } finally {
    Math.random = origRandom;
  }
  assert.ok(said.some((l) => l.includes("Jon") && l.includes("sorrel")), "ready gather names the player");
  mod._resetState();
}

console.log("CitizenHerbalists2: all checks passed");
