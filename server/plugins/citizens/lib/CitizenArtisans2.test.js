// CitizenArtisans2 unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const mod = require("./CitizenArtisans2");

const {
  hashStr,
  pickOne,
  fill,
  woodfolkTypeFromRoll,
  woodfolkTypeOf,
  woodlotFor,
  woodForToday,
  basketForToday,
  taskForToday,
  goodForToday,
  priceFor,
  showpieceFor,
  timberDelayFor,
  windfallFor,
  proCarpenterFor,
  requestOrder,
  orderFor,
  orderReady,
  completeOrder,
  learnWoodcraft,
  woodcraftFor,
  tickWoodfolk,
  isWorkHour,
  dayNumber,
  chance,
  seededRng,
  normalizeName,
  isRealPlayer,
  withinTiles,
  WOODFOLK_TYPES,
  BOWL_TURNER,
  BASKET_WEAVER,
  WHITTLER,
  TIMBER_HAND,
  WOODLOTS,
  WOOD_KINDS,
  BASKET_KINDS,
  WOODEN_GOODS,
  LESSONS,
  WOODFOLK_SHARE,
  WORK_START_HOUR,
  WORK_END_HOUR,
  WOODFOLK_RADIUS,
  WOODFOLK_CHANCE,
  ORDER_TTL_MS,
  LESSON_TTL_MS,
} = mod;

// local-time constructors (never Date.UTC — the PC runs on EDT)
const NOON = new Date(2026, 9, 8, 12, 0).getTime(); // October, mid-day
const MIDNIGHT = new Date(2026, 9, 8, 2, 0).getTime();
const SIX_AM = new Date(2026, 9, 8, 6, 0).getTime();
const EIGHT_PM = new Date(2026, 9, 8, 20, 0).getTime();

// --- hashStr ---
assert.equal(typeof hashStr("abc"), "number");
assert.equal(hashStr("abc"), hashStr("abc"), "hash must be deterministic");
assert.notEqual(hashStr("abc"), hashStr("abd"), "hash must differ for different strings");
assert.equal(hashStr(null), hashStr(""), "null hashes like empty string");

// --- fill ---
assert.equal(fill("Hello {name}, {good}!", { name: "Jon", good: "bowl" }), "Hello Jon, bowl!");
assert.equal(fill("no slots", {}), "no slots");
assert.equal(fill("{a}{a}", { a: "x" }), "xx");

// --- woodfolkTypeFromRoll: weights 30/30/25/15 ---
assert.equal(woodfolkTypeFromRoll(0), BOWL_TURNER);
assert.equal(woodfolkTypeFromRoll(29), BOWL_TURNER);
assert.equal(woodfolkTypeFromRoll(30), BASKET_WEAVER);
assert.equal(woodfolkTypeFromRoll(59), BASKET_WEAVER);
assert.equal(woodfolkTypeFromRoll(60), WHITTLER);
assert.equal(woodfolkTypeFromRoll(84), WHITTLER);
assert.equal(woodfolkTypeFromRoll(85), TIMBER_HAND);
assert.equal(woodfolkTypeFromRoll(99), TIMBER_HAND);

// --- distribution sanity: all types reachable, ~share of names qualify ---
{
  mod._resetState();
  const seen = new Set();
  let qualified = 0;
  for (let i = 0; i < 2000; i++) {
    const t = woodfolkTypeOf({ username: "WoodfolkTest" + i, role: "commoner" });
    if (t) {
      qualified++;
      seen.add(t);
    }
  }
  assert.deepEqual([...seen].sort(), [...WOODFOLK_TYPES].sort(), "all four types reachable");
  const pct = qualified / 2000;
  // ~40% nominal share of commoners
  assert.ok(pct > 0.2 && pct < 0.6, `qualify share ${pct} within sane bounds`);
  console.log(`distribution: PASS (${(pct * 100).toFixed(1)}%)`);
}

// --- type stability across calls ---
{
  mod._resetState();
  for (let i = 0; i < 50; i++) {
    const a = woodfolkTypeOf({ username: "stable" + i, role: "commoner" });
    const b = woodfolkTypeOf({ username: "stable" + i, role: "commoner" });
    assert.equal(a, b, "type stable across calls");
  }
  console.log("type stability: PASS");
}

// --- guards merchants/guards, anonymous names ---
assert.equal(woodfolkTypeOf({ username: "x", role: "guard" }), null);
assert.equal(woodfolkTypeOf({ username: "x", role: "merchant" }), null);
assert.equal(woodfolkTypeOf({ username: "x", role: "courier" }), null);
assert.equal(woodfolkTypeOf({ username: "" }), null);
assert.equal(woodfolkTypeOf(null), null);
console.log("commoner gating: PASS");

// --- no overlap: a claimed master artisan is never woodfolk ---
// Run the REAL pro slow tick on a mock director to populate the _artisans
// roster map, then verify every claimed name is excluded from woodfolk.
{
  mod._resetState();
  const Pro = require("./CitizenArtisans");
  const kingdoms = ["misthalin", "asgarnia", "kandarin", "keldagrim", "morytania", "kharidian"];
  const records = [];
  let n = 0;
  for (const kid of kingdoms) {
    for (let i = 0; i < 40; i++) {
      records.push({ username: "OverlapWood" + (n++), role: "commoner", kingdomId: kid });
    }
  }
  const mockDirector = { roster: new Map(records.map((r) => [r.username, r])) };
  Pro.tickArtisans(mockDirector, NOON);
  const claimed = [...Pro._artisans.keys()];
  assert.ok(claimed.length >= 20, `enough claimed artisans in sample (${claimed.length})`);
  const violations = claimed.filter((nm) => woodfolkTypeOf({ username: nm, role: "commoner" }) !== null);
  assert.equal(violations.length, 0, "claimed master artisans must never be woodfolk");
  console.log(`pro-artisan exclusion: PASS (${claimed.length} claimed artisans all excluded)`);
}

// --- pro carpenter bridge: names the kingdom's master, never throws ---
{
  const c = proCarpenterFor("misthalin", NOON);
  // The exclusion test above populated the pro roster; misthalin should
  // have a claimed carpenter now.
  assert.ok(c && c.display, "bridge returns the kingdom's master carpenter");
  assert.equal(proCarpenterFor("nosuchkingdom", NOON), null, "unknown kingdom -> null");
  assert.doesNotThrow(() => proCarpenterFor(null, NOON), "null kingdom never throws");
  console.log("pro carpenter bridge: PASS");
}

// --- woodlotFor: kingdom-preferred, stable ---
{
  const w = woodlotFor({ username: "wuser", kingdomId: "asgarnia" });
  assert.equal(w.kingdom, "asgarnia", "kingdom-preferred woodlot");
  assert.equal(woodlotFor({ username: "wuser", kingdomId: "asgarnia" }).name, w.name, "stable");
  const w2 = woodlotFor({ username: "wuser2", kingdomId: "nosuchkingdom" });
  assert.ok(w2 && w2.name, "falls back to full pool");
  console.log("woodlot assignment: PASS");
}

// --- daily pools: wood / baskets / tasks deterministic per day, vary by day ---
{
  const a = woodForToday("wooduser", NOON);
  assert.ok(WOOD_KINDS.includes(a), `wood kind ${a}`);
  assert.equal(woodForToday("wooduser", NOON), a, "wood deterministic same day");
  assert.notEqual(woodForToday("wooduser", NOON + 30 * 86400000).constructor, undefined);
  const b = basketForToday("basketuser", NOON);
  assert.ok(BASKET_KINDS.includes(b), `basket kind ${b}`);
  assert.equal(basketForToday("basketuser", NOON), b, "basket deterministic same day");
  const t1 = taskForToday("taskuser", BOWL_TURNER, NOON);
  const t2 = taskForToday("taskuser", BOWL_TURNER, NOON);
  assert.equal(t1, t2, "task deterministic same day");
  const seenDays = new Set();
  for (let d = 0; d < 12; d++) {
    seenDays.add(taskForToday("taskuser", BOWL_TURNER, NOON + d * 86400000));
  }
  assert.ok(seenDays.size > 1, "tasks vary across days");
  console.log("daily pools: PASS");
}

// --- goods + pricing ---
{
  const lot = WOODLOTS[0];
  const g = goodForToday(lot, NOON);
  assert.ok(WOODEN_GOODS.includes(g), `good ${g}`);
  assert.equal(goodForToday(lot, NOON), g, "good deterministic");
  const p = priceFor(g, NOON);
  assert.ok(p >= 2 && p <= 25, `price ${p} in band`);
  assert.equal(priceFor(g, NOON), p, "price deterministic");
  console.log("goods/pricing: PASS");
}

// --- showpiece: deterministic same day, ~8% rate ---
{
  const lot = WOODLOTS[0];
  const a = showpieceFor(lot, NOON);
  const b = showpieceFor(lot, NOON);
  assert.deepEqual(a, b, "showpiece deterministic same day");
  let hits = 0;
  for (let d = 0; d < 400; d++) {
    if (showpieceFor(lot, NOON + d * 86400000)) hits++;
  }
  const rate = hits / 400;
  assert.ok(rate > 0.02 && rate < 0.2, `showpiece rate ${rate.toFixed(3)} sane`);
  console.log(`showpiece: PASS (rate ${(rate * 100).toFixed(1)}%)`);
}

// --- set-pieces: deterministic, ~8% rates ---
{
  const a = timberDelayFor("misthalin", NOON);
  assert.equal(timberDelayFor("misthalin", NOON), a, "timber delay deterministic");
  assert.equal(timberDelayFor(null, NOON), null, "null kingdom -> null");
  let dh = 0;
  for (let d = 0; d < 400; d++) {
    if (timberDelayFor("misthalin", NOON + d * 86400000)) dh++;
  }
  assert.ok(dh / 400 > 0.02 && dh / 400 < 0.2, "timber delay rate sane");
  let wh = 0;
  for (let d = 0; d < 400; d++) {
    if (windfallFor("kandarin", NOON + d * 86400000)) wh++;
  }
  assert.ok(wh / 400 > 0.02 && wh / 400 < 0.2, "windfall rate sane");
  assert.equal(windfallFor("kandarin", NOON), windfallFor("kandarin", NOON), "windfall deterministic");
  console.log("set-pieces: PASS");
}

// --- order ledger: request -> ready (deterministic 1-3h) -> complete -> TTL ---
{
  mod._resetState();
  const o = requestOrder("Jon", "turner-tess", "a turned oak bowl", 2, NOON);
  assert.ok(o, "order recorded");
  assert.ok(o.readyAt > o.askedAt && o.readyAt <= o.askedAt + 3 * 3600 * 1000, "1-3h completion");
  assert.equal(orderReady(o, NOON), false, "not ready immediately");
  assert.equal(orderReady(o, o.readyAt), true, "ready at readyAt");
  const again = orderFor("Jon", o.readyAt);
  assert.ok(again && again.good === "a turned oak bowl", "order retrievable");
  assert.equal(completeOrder("Jon", o.readyAt), true, "complete deletes");
  assert.equal(orderFor("Jon", o.readyAt), null, "gone after complete");
  // TTL expiry
  requestOrder("Jon", "turner-tess", "a willow basket", 1, NOON);
  assert.equal(orderFor("Jon", NOON + ORDER_TTL_MS + 1000), null, "order expires after TTL");
  // null guards
  assert.equal(requestOrder(null, "x", "y", 1, NOON), null);
  assert.equal(requestOrder("Jon", null, "y", 1, NOON), null);
  assert.equal(requestOrder("Jon", "x", null, 1, NOON), null);
  console.log("order ledger: PASS");
}

// --- lesson ledger: round-trip + 7-day TTL ---
{
  mod._resetState();
  learnWoodcraft("Jon", LESSONS[0], NOON);
  assert.equal(woodcraftFor("Jon", NOON + 1000), LESSONS[0]);
  assert.equal(woodcraftFor("Jon", NOON + LESSON_TTL_MS + 1000), null, "lesson expires");
  assert.equal(learnWoodcraft(null, "x", NOON), null);
  assert.equal(woodcraftFor(null, NOON), null);
  console.log("lesson ledger: PASS");
}

// --- work hours via local-time constructors (timezone rule) ---
{
  assert.ok(isWorkHour(new Date(2026, 9, 8, 12, 0).getTime()), "12:00 is work hour");
  assert.ok(isWorkHour(SIX_AM), "06:00 is work hour (start boundary inclusive)");
  assert.ok(!isWorkHour(MIDNIGHT), "02:00 is not");
  assert.ok(!isWorkHour(EIGHT_PM), "20:00 is not (end boundary exclusive)");
  assert.equal(WORK_START_HOUR, 6);
  assert.equal(WORK_END_HOUR, 20);
  console.log("work hours: PASS");
}

// --- guards: isRealPlayer / withinTiles ---
{
  const mk = (name, x, isBot) => ({
    getUsername: () => name,
    isPlayerBot: () => isBot,
    getHostAddress: () => (isBot ? "bot" : "1.2.3.4"),
    getLocation: () => ({ getX: () => x, getY: () => 100, getZ: () => 0 }),
  });
  assert.ok(isRealPlayer(mk("P", 0, false)));
  assert.ok(!isRealPlayer(mk("B", 0, true)));
  assert.ok(!isRealPlayer(null));
  assert.ok(withinTiles(mk("A", 100, true), mk("B", 105, false), 14));
  assert.ok(!withinTiles(mk("A", 100, true), mk("B", 200, false), 14));
  assert.ok(!withinTiles(mk("A", 100, true), { getLocation: () => null }, 14));
  console.log("guards: PASS");
}

// --- tick: fires near a real player during work hours; cooldown; silence otherwise ---
{
  mod._resetState();
  // find a woodfolk username
  let citizenName = null;
  for (let i = 0; i < 3000 && !citizenName; i++) {
    const u = "TickWood" + i;
    if (woodfolkTypeOf({ username: u, role: "commoner" })) citizenName = u;
  }
  assert.ok(citizenName, "found a woodfolk citizen");

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
    tickWoodfolk(director, t);
    assert.ok(said.length > 0, "fires with a real player near during work hours");
    const saidAgain = said.length;
    // second tick immediately: cooldown blocks
    tickWoodfolk(director, t + 1000);
    assert.equal(said.length, saidAgain, "cooldown blocks repeat firing");

    // outside work hours: no fire (fresh state via _resetState)
    mod._resetState();
    said.length = 0;
    t = MIDNIGHT;
    tickWoodfolk(director, t);
    assert.equal(said.length, 0, "no firing outside work hours");

    // no real player near: no fire
    mod._resetState();
    said.length = 0;
    director.onlinePlayers = () => [
      { isPlayerBot: () => true, getHostAddress: () => "bot", getUsername: () => "BotOne",
        getLocation: () => ({ getX: () => 101, getY: () => 100, getZ: () => 0 }) },
    ];
    tickWoodfolk(director, NOON);
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
  assert.doesNotThrow(() => tickWoodfolk({}, NOON));
  assert.doesNotThrow(() => tickWoodfolk({ roster: new Map() }, NOON));
  assert.doesNotThrow(() => tickWoodfolk(null, NOON));
  assert.doesNotThrow(() => tickWoodfolk({ roster: null }, NOON));
  console.log("never-throws: PASS");
}

// --- claimed pro artisan skipped at the type gate before materialization ---
{
  mod._resetState();
  const Pro = require("./CitizenArtisans");
  const claimedNames = [...Pro._artisans.keys()];
  assert.ok(claimedNames.length > 0, "pro roster populated from earlier test");
  const nm = claimedNames[0];
  let materialized = false;
  const dir = {
    roster: new Map([[nm, { username: nm, role: "commoner", kingdomId: "misthalin" }]]),
    playerFor: () => {
      materialized = true;
      return { forceChat: () => {}, getLocation: () => ({ getX: () => 100, getY: () => 100, getZ: () => 0 }) };
    },
    onlinePlayers: () => [
      { getUsername: () => "Jon", getHostAddress: () => "1.2.3.4",
        getLocation: () => ({ getX: () => 102, getY: () => 100, getZ: () => 0 }) },
    ],
  };
  const origRandom = Math.random;
  Math.random = () => 0;
  try {
    tickWoodfolk(dir, NOON);
  } finally {
    Math.random = origRandom;
  }
  assert.ok(!materialized, "claimed artisan never materialized (type gate first)");
  console.log("pro gate ordering: PASS");
}

// --- ready-order priority: a maker names the waiting player ---
{
  mod._resetState();
  // find a turner/weaver/whittler (not a timber hand)
  let citizenName = null;
  let citizenType = null;
  for (let i = 0; i < 5000 && !citizenName; i++) {
    const u = "ReadyWood" + i;
    const t = woodfolkTypeOf({ username: u, role: "commoner" });
    if (t && t !== TIMBER_HAND) {
      citizenName = u;
      citizenType = t;
    }
  }
  assert.ok(citizenName, "found a non-timber-hand woodfolk citizen");
  const said = [];
  const director = {
    roster: new Map([[citizenName, { username: citizenName, role: "commoner", kingdom: "misthalin" }]]),
    playerFor: () => ({
      forceChat: (line) => said.push(line),
      getLocation: () => ({ getX: () => 100, getY: () => 100, getZ: () => 0 }),
    }),
    onlinePlayers: () => [
      { getUsername: () => "Jon", getHostAddress: () => "1.2.3.4",
        getLocation: () => ({ getX: () => 102, getY: () => 100, getZ: () => 0 }) },
    ],
  };
  // Jon's order is ready (asked 5h ago, 1-3h completion)
  requestOrder("Jon", citizenName, "a turned oak bowl", 1, NOON - 5 * 3600 * 1000);
  const origRandom = Math.random;
  Math.random = () => 0;
  try {
    tickWoodfolk(director, NOON);
  } finally {
    Math.random = origRandom;
  }
  assert.ok(said.some((l) => l.includes("Jon")), `ready order names the player (type ${citizenType})`);
  mod._resetState();
  console.log("ready-order priority: PASS");
}

// --- pure helpers: chance / seededRng / dayNumber / normalizeName ---
{
  assert.ok(chance(() => 0.1, 0.15), "chance true");
  assert.ok(!chance(() => 0.5, 0.15), "chance false");
  const r1 = seededRng(42);
  const r2 = seededRng(42);
  assert.equal(r1(), r2(), "seeded rng deterministic");
  assert.equal(dayNumber(86400000), 1, "day number");
  assert.equal(normalizeName("Some Name"), "some name", "normalize fallback");
  console.log("pure helpers: PASS");
}

// --- tuning constants pinned ---
{
  assert.equal(WOODFOLK_SHARE, 40);
  assert.equal(WOODFOLK_RADIUS, 14);
  assert.equal(WOODFOLK_CHANCE, 0.15);
  assert.equal(WOODFOLK_TYPES.length, 4);
  assert.equal(WOODLOTS.length, 12);
  assert.equal(LESSONS.length, 5);
  console.log("tuning constants: PASS");
}

console.log("ALL CITIZENARTISANS2 TESTS PASSED");
