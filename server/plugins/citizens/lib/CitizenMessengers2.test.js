// CitizenMessengers2 unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const mod = require("./CitizenMessengers2");

const {
  hashStr,
  pickOne,
  fill,
  runnerTypeFromRoll,
  runnerTypeOf,
  isMasterMessenger,
  postCornerFor,
  postOffices,
  liveGossip,
  gossipFor,
  wordFor,
  boardNoteFor,
  routeFor,
  satchelFor,
  misdeliveredFor,
  runnerCrowdFor,
  tickMessengers2,
  isWorkHour,
  dayNumber,
  chance,
  seededRng,
  normalizeName,
  isRealPlayer,
  withinTiles,
  RUNNER_TYPES,
  GOSSIP_CARRIER,
  WORD_RUNNER,
  BOARD_RUNNER,
  VERBAL_WORDS,
  STREET_GOSSIP,
  BOARD_NOTES,
  RUN_LINES,
  SATCHEL_LINES,
  MISDELIVERED_LINES,
  BREATHLESS_LINES,
  POST_CORNER_LINES,
  RUNNER_RADIUS,
  RUNNER_CITIZEN_COOLDOWN_MS,
  RUNNER_CHANCE,
  RUNNER_SHARE,
  SATCHEL_CHANCE,
  MISDELIVERED_CHANCE,
  RUNNER_CROWD_CHANCE,
  WORK_START_HOUR,
  WORK_END_HOUR,
  _lastFiredByCitizen,
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
assert.equal(fill("Hello {name}, {word}!", { name: "Jon", word: "run" }), "Hello Jon, run!");
assert.equal(fill("no slots", {}), "no slots");
assert.equal(fill("{a}{a}", { a: "x" }), "xx", "repeats all occurrences");

// --- distribution: ~35% nominal share of commoners ---
{
  let runners = 0;
  const n = 20000;
  for (let i = 0; i < n; i++) {
    // skip master-claimed names: they must never be runners (exclusion runs first)
    const name = "Runner" + i;
    if (isMasterMessenger(name)) continue;
    if (runnerTypeOf({ username: name, role: "commoner" })) runners++;
  }
  const share = runners / n;
  assert.ok(share > 0.2 && share < 0.5, `nominal share ~35%, got ${share.toFixed(3)}`);
}

// --- type stability: same name, same type, across calls ---
{
  const a = runnerTypeOf({ username: "StableRunner", role: "commoner" });
  const b = runnerTypeOf({ username: "StableRunner", role: "commoner" });
  assert.equal(a, b, "type must be stable");
  assert.ok(a === null || RUNNER_TYPES.includes(a), "type must be known or null");
}

// --- commoner gating: non-commoners are never runners ---
{
  assert.equal(runnerTypeOf({ username: "SomeRunner", role: "merchant" }), null);
  assert.equal(runnerTypeOf({ username: "SomeRunner", role: "guard" }), null);
  assert.equal(runnerTypeOf({ username: "SomeRunner", attributes: { role: "banker" } }), null);
  assert.equal(runnerTypeOf({ username: null, role: "commoner" }), null);
}

// --- pro exclusion via the master module's claimed-type function ---
{
  // find a master-claimed citizen: primary profession "messenger" via the master fn
  const master = require("./CitizenMessengers");
  let claimed = null;
  for (let i = 0; i < 5000 && !claimed; i++) {
    const name = "Master" + i;
    if (master.messengerTypeFor(name)) claimed = name;
  }
  assert.ok(claimed, "expected a master-claimed messenger name in the sweep");
  assert.equal(isMasterMessenger(claimed), true, "isMasterMessenger must agree with the master module");
  assert.equal(runnerTypeOf({ username: claimed, role: "commoner" }), null,
    "a master-claimed messenger must never be runnerfolk");
  assert.equal(master.messengerTypeFor(claimed), master.messengerTypeFor(claimed),
    "master type must be stable");
}

// --- exclusion is ordered BEFORE the share roll ---
{
  // A master-claimed citizen that would otherwise roll inside the 35% share
  // must still be excluded. Find such a name and pin the ordering.
  const master = require("./CitizenMessengers");
  let found = null;
  for (let i = 0; i < 20000 && !found; i++) {
    const name = "Order" + i;
    if (!master.messengerTypeFor(name)) continue;
    if (hashStr(name.toLowerCase() + "|messenger2") % 100 >= RUNNER_SHARE) continue;
    found = name;
  }
  assert.ok(found, "expected a master-claimed name that also rolls inside the share");
  assert.equal(runnerTypeOf({ username: found, role: "commoner" }), null,
    "exclusion must win over the share roll regardless of draw");
}

// --- type weighting follows RUNNER_WEIGHTS ---
{
  const counts = { [GOSSIP_CARRIER]: 0, [WORD_RUNNER]: 0, [BOARD_RUNNER]: 0 };
  const n = 10000;
  for (let i = 0; i < n; i++) counts[runnerTypeFromRoll(i % 100)]++;
  assert.ok(counts[GOSSIP_CARRIER] > counts[BOARD_RUNNER], "gossip-carriers must outnumber board-runners");
  assert.ok(counts[WORD_RUNNER] > counts[BOARD_RUNNER], "word-runners must outnumber board-runners");
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), n);
}

// --- bridge: post offices come from the master module's real data ---
{
  const offices = postOffices();
  const master = require("./CitizenMessengers");
  assert.ok(Array.isArray(offices) && offices.length > 0, "post offices must be non-empty");
  assert.deepEqual(offices, master.POST_OFFICES, "must be the master's real post-office list");
}

// --- post corner assignment: kingdom-preferred, stable per day ---
{
  const corner = postCornerFor({ username: "CornerRunner", kingdomId: "varrock" }, NOON);
  assert.ok(corner && corner.name, "corner must have a name");
  assert.equal(corner.kingdom, "varrock", "must prefer the citizen's kingdom");
  const again = postCornerFor({ username: "CornerRunner", kingdomId: "varrock" }, NOON);
  assert.equal(corner.name, again.name, "corner must be stable per day");
  assert.equal(postCornerFor({ username: "CornerRunner", kingdomId: "nosuchplace" }, NOON) !== null, true);
}

// --- gossip bridge: reads live rumors when present, falls back to street talk ---
{
  const Rumors = require("./CitizenRumors");
  Rumors.resetForTests();
  const quiet = liveGossip();
  assert.ok(Array.isArray(quiet), "liveGossip must return an array");
  const fallback = gossipFor("QuietRunner", NOON);
  assert.ok(STREET_GOSSIP.includes(fallback), "quiet pools must fall back to street gossip");
  // seed a real rumor and confirm the runner repeats it
  Rumors.seedRumor(Math.random, {
    kind: "test", what: "the granary roof collapsed in the rain",
    who: "a mason", where: "the square",
  });
  const live = liveGossip();
  assert.ok(live.includes("the granary roof collapsed in the rain"), "must read the real rumor pool");
  const g = gossipFor("QuietRunner", NOON);
  assert.equal(g, live[0], "when the pool is live the gossip must come from it");
  Rumors.resetForTests();
}

// --- verbal routes and daily words/notes ---
{
  const route = routeFor("RouteRunner", NOON);
  assert.ok(route && route.origin && route.dest, "route needs both ends");
  assert.ok(route.origin.name && route.dest.name, "corners need names");
  assert.equal(routeFor("RouteRunner", NOON).dest.name, route.dest.name, "route stable per day");
  assert.ok(VERBAL_WORDS.includes(wordFor("RouteRunner", NOON)), "word must come from the verbal pool");
  assert.equal(wordFor("RouteRunner", NOON), wordFor("RouteRunner", NOON), "word stable per day");
  assert.ok(BOARD_NOTES.includes(boardNoteFor("BoardRunner", NOON)), "note must come from the board pool");
}

// --- set-piece bands: ~6% satchel, ~7% misdelivered, ~8% crowd ---
{
  const n = 40000;
  let sat = 0, mis = 0, cro = 0;
  for (let i = 0; i < n; i++) {
    const kid = "bandtest" + (i % 97);
    if (satchelFor(kid, NOON + i * 60000)) sat++;
    if (misdeliveredFor(kid, NOON + i * 60000)) mis++;
    if (runnerCrowdFor({ name: "bandcorner" + (i % 97) }, NOON + i * 60000)) cro++;
  }
  const s = sat / n, m = mis / n, c = cro / n;
  assert.ok(s > 0.03 && s < 0.1, `satchel ~6%, got ${s.toFixed(3)}`);
  assert.ok(m > 0.04 && m < 0.11, `misdelivered ~7%, got ${m.toFixed(3)}`);
  assert.ok(c > 0.05 && c < 0.12, `crowd ~8%, got ${c.toFixed(3)}`);
  assert.equal(satchelFor(null, NOON), false);
  assert.equal(misdeliveredFor(undefined, NOON), false);
  assert.equal(runnerCrowdFor(null, NOON), false);
  assert.equal(satchelFor("varrock", NOON), satchelFor("varrock", NOON), "satchel deterministic per day");
}

// --- work hours ---
{
  assert.equal(isWorkHour(SIX_AM), true, "06:00 is in hours");
  assert.equal(isWorkHour(NOON), true);
  assert.equal(isWorkHour(EIGHT_PM), false, "20:00 is out of hours");
  assert.equal(isWorkHour(TEN_PM), false);
  assert.equal(WORK_START_HOUR, 6);
  assert.equal(WORK_END_HOUR, 20);
}

// --- line pools: no leftover raw slots, all non-empty ---
{
  for (const t of RUNNER_TYPES) {
    assert.ok(Array.isArray(RUN_LINES[t]) && RUN_LINES[t].length > 0, t + " needs lines");
    for (const line of RUN_LINES[t]) {
      assert.ok(!/\{\w+\}/.test(fill(line, {
        runner: "R", gossip: "g", word: "w", note: "n", dest: "d", corner: "c",
      })), `unfilled slot in ${t} line`);
    }
  }
  for (const [label, pool] of [
    ["SATCHEL_LINES", SATCHEL_LINES], ["MISDELIVERED_LINES", MISDELIVERED_LINES],
    ["BREATHLESS_LINES", BREATHLESS_LINES], ["POST_CORNER_LINES", POST_CORNER_LINES],
  ]) {
    assert.ok(Array.isArray(pool) && pool.length > 0, label + " must be non-empty");
    for (const line of pool) {
      assert.ok(!/\{\w+\}/.test(fill(line, { corner: "c", office: "o" })), `unfilled slot in ${label}`);
    }
  }
  assert.ok(POST_CORNER_LINES.every((l) => l.includes("{office}")), "post-corner talk must name the real office");
}

// --- VERBAL_WORDS / STREET_GOSSIP / BOARD_NOTES are non-empty ---
assert.ok(VERBAL_WORDS.length > 0 && STREET_GOSSIP.length > 0 && BOARD_NOTES.length > 0);

// --- seededRng / chance ---
{
  const r1 = seededRng(42), r2 = seededRng(42);
  assert.equal(r1(), r2(), "seeded rng must be deterministic");
  let hits = 0;
  const n = 20000;
  for (let i = 0; i < n; i++) if (chance(Math.random, 0.5)) hits++;
  assert.ok(Math.abs(hits / n - 0.5) < 0.02, "chance must track p");
}

// --- isRealPlayer / withinTiles ---
{
  assert.equal(isRealPlayer(null), false);
  assert.equal(isRealPlayer({ isPlayerBot: () => true, getUsername: () => "x" }), false);
  assert.equal(isRealPlayer({ getHostAddress: () => "bot", getUsername: () => "x" }), false);
  assert.equal(isRealPlayer({ getUsername: () => "Jon" }), true);
  const loc = (x, y, z) => ({ getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => z }) });
  assert.equal(withinTiles(loc(0, 0, 0), loc(14, 14, 0), RUNNER_RADIUS), true);
  assert.equal(withinTiles(loc(0, 0, 0), loc(15, 0, 0), RUNNER_RADIUS), false);
  assert.equal(withinTiles(loc(0, 0, 0), loc(0, 0, 1), RUNNER_RADIUS), false);
}

// --- tick never throws on empty / junk directors ---
{
  tickMessengers2({}, NOON);
  tickMessengers2(null, NOON);
  tickMessengers2({ roster: { values: () => { throw new Error("boom"); } } }, NOON);
  tickMessengers2({ roster: { values: () => [null, undefined, {}] } }, NOON);
}

// --- tick gates: per-citizen try/catch + cooldown ---
{
  mod._resetState();
  const forced = [];
  const director = {
    roster: new Map([
      ["Explode", { username: "ExplodeRunner", role: "commoner",
        get boom() { throw new Error("bad record"); } }],
      ["Runner", { username: "GateRunner", role: "commoner" }],
    ]),
    playerFor: (record) => {
      if (record.username === "GateRunner") {
        return {
          forceChat: (s) => forced.push(s),
          getLocation: () => ({ getX: () => 100, getY: () => 100, getZ: () => 0 }),
        };
      }
      return null;
    },
    onlinePlayers: () => [
      { isPlayerBot: () => false, getHostAddress: () => "1.2.3.4",
        getUsername: () => "Jon", getLocation: () => ({ getX: () => 105, getY: () => 100, getZ: () => 0 }) },
    ],
  };
  // GateRunner may not be a runner; either way the tick must not throw.
  tickMessengers2(director, EIGHT_AM);
  tickMessengers2(director, EIGHT_AM); // cooldown gate: second pass stays quiet or repeats safely
}

// --- crowd moment fires at most once per corner per day ---
{
  mod._resetState();
  // find a runner name whose corner has the crowd moment on a deterministic
  // day (not necessarily today), with no satchel/misdelivered set-piece
  // intercepting it
  const CROWD_DAY = (() => {
    const corner = postOffices().find((o) => o.kingdom === "varrock");
    for (let d = 0; d < 500; d++) {
      const t = NOON + d * 86400000;
      if (satchelFor("varrock", t) || misdeliveredFor("varrock", t)) continue;
      if (runnerCrowdFor(corner, t)) return t;
    }
    return null;
  })();
  assert.ok(CROWD_DAY, "expected a day with a runner crowd moment");
  const day = dayNumber(CROWD_DAY);
  let runnerName = null, cornerName = null;
  for (let i = 0; i < 60000 && !runnerName; i++) {
    const nm = "crowdcheck" + i;
    if (isMasterMessenger(nm)) continue;
    if (!runnerTypeOf({ username: nm, role: "commoner" })) continue;
    if (satchelFor("varrock", NOON)) continue;
    if (misdeliveredFor("varrock", NOON)) continue;
    const corner = postCornerFor({ username: nm, role: "commoner", kingdomId: "varrock" }, CROWD_DAY);
    if (!corner || !runnerCrowdFor(corner, CROWD_DAY)) continue;
    runnerName = nm;
    cornerName = corner.name;
  }
  assert.ok(runnerName, "expected a runner whose corner has the crowd moment today");
  const crowdKey = "messenger2crowd:" + cornerName + ":" + day;

  const forced = [];
  const director = {
    roster: new Map([[runnerName, { username: runnerName, role: "commoner", kingdomId: "varrock" }]]),
    playerFor: () => ({
      forceChat: (s) => forced.push(s),
      getLocation: () => ({ getX: () => 0, getY: () => 0, getZ: () => 0 }),
    }),
    onlinePlayers: () => [
      { isPlayerBot: () => false, getHostAddress: () => "h",
        getUsername: () => "Jon", getLocation: () => ({ getX: () => 1, getY: () => 1, getZ: () => 0 }) },
    ],
  };
  const realRandom = Math.random;
  try {
    Math.random = () => 0; // deterministic: chance gates pass, picks first lines
    tickMessengers2(director, CROWD_DAY);
    assert.ok(forced.length === 1, "first tick must fire exactly one line");
    assert.ok(BREATHLESS_LINES.some((l) => fill(l, { corner: cornerName }) === forced[0]),
      "first tick must fire the breathless crowd moment");
    assert.ok(_lastFiredByCitizen.has(crowdKey), "crowd moment must record its once-per-day key");
    // second tick: clear only the citizen cooldown, keep the crowd key
    _lastFiredByCitizen.delete(runnerName);
    forced.length = 0;
    tickMessengers2(director, CROWD_DAY);
    assert.ok(forced.length === 1, "second tick must also fire");
    assert.ok(!BREATHLESS_LINES.some((l) => fill(l, { corner: cornerName }) === forced[0]),
      "the crowd moment must not fire twice for the same corner+day");
  } finally {
    Math.random = realRandom;
  }
}

// --- tuning constants are pinned ---
{
  assert.equal(RUNNER_RADIUS, 14);
  assert.equal(RUNNER_CITIZEN_COOLDOWN_MS, 3 * 60 * 60 * 1000);
  assert.equal(RUNNER_CHANCE, 0.15);
  assert.equal(RUNNER_SHARE, 35);
  assert.equal(SATCHEL_CHANCE, 0.06);
  assert.equal(MISDELIVERED_CHANCE, 0.07);
  assert.equal(RUNNER_CROWD_CHANCE, 0.08);
  assert.equal(GOSSIP_CARRIER, "gossip-carrier");
  assert.equal(WORD_RUNNER, "word-runner");
  assert.equal(BOARD_RUNNER, "board-runner");
  assert.equal(RUNNER_TYPES.length, 3);
}

console.log("ALL CITIZENMESSENGERS2 TESTS PASSED");
