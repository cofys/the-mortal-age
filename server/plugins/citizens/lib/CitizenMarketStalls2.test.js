// CitizenMarketStalls2 unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const mod = require("./CitizenMarketStalls2");

const {
  hashStr,
  pickOne,
  fill,
  prettyWare,
  stallTypeFromRoll,
  stallTypeOf,
  isProStallMerchant,
  isHawkerfolk,
  stallPitchFor,
  goodsFor,
  taskForToday,
  wheelOffFor,
  movedAlongFor,
  stallCrowdFor,
  masterWaresFor,
  tickStallfolk,
  isWorkHour,
  dayNumber,
  chance,
  seededRng,
  normalizeName,
  isRealPlayer,
  withinTiles,
  STALL_TYPES,
  BARROW_FOLK,
  BLANKET_FOLK,
  CRATE_FOLK,
  SETUP_LINES,
  STALL_LINES,
  WHEEL_OFF_LINES,
  MOVED_ALONG_LINES,
  CROWD_LINES,
  MARKET_TALK_LINES,
  DAILY_TASK_LINES,
  STALLS,
  GOODS,
  STALL_RADIUS,
  STALL_CITIZEN_COOLDOWN_MS,
  STALL_CHANCE,
  STALL_SHARE,
  WHEEL_OFF_CHANCE,
  MOVED_ALONG_CHANCE,
  STALL_CROWD_CHANCE,
  WORK_START_HOUR,
  WORK_END_HOUR,
  SETUP_CUTOFF_HOUR,
  _lastFiredByCitizen,
} = mod;

// local-time constructors (never Date.UTC — the PC runs on EDT;
// chosen times are safely inside/outside work hours in any TZ)
const NOON = new Date(2026, 9, 8, 12, 0).getTime(); // October, mid-day
const EIGHT_AM = new Date(2026, 9, 8, 8, 0).getTime();
const SEVEN_AM = new Date(2026, 9, 8, 7, 0).getTime();
const SIX_AM = new Date(2026, 9, 8, 6, 0).getTime();
const SIX_PM = new Date(2026, 9, 8, 18, 0).getTime();
const TEN_PM = new Date(2026, 9, 8, 22, 0).getTime();

// --- hashStr ---
assert.equal(typeof hashStr("abc"), "number");
assert.equal(hashStr("abc"), hashStr("abc"), "hash must be deterministic");
assert.notEqual(hashStr("abc"), hashStr("abd"), "hash must differ for different strings");
assert.equal(hashStr(null), hashStr(""), "null hashes like empty string");

// --- fill ---
assert.equal(fill("Hello {name}, {goods}!", { name: "Jon", goods: "pots" }), "Hello Jon, pots!");
assert.equal(fill("no slots", {}), "no slots");
assert.equal(fill("{a}{a}", { a: "x" }), "xx", "repeats all occurrences");

// --- prettyWare ---
assert.equal(prettyWare("IRON_SWORD"), "iron sword");
assert.equal(prettyWare("MEAT_PIE"), "meat pie");

// --- distribution: ~35% nominal share of commoners (post-exclusion) ---
{
  const Hawkers2 = require("./CitizenHawkers2");
  let folk = 0;
  const n = 20000;
  for (let i = 0; i < n; i++) {
    // skip hawkerfolk-claimed names: they must never be stallfolk (exclusion runs first)
    const name = "Stall" + i;
    if (Hawkers2.hawkerTypeOf({ username: name, role: "commoner" })) continue;
    if (stallTypeOf({ username: name, role: "commoner" })) folk++;
  }
  const share = folk / n;
  assert.ok(share > 0.2 && share < 0.5, `nominal share ~35%, got ${share.toFixed(3)}`);
}

// --- type stability: same name, same type, across calls ---
{
  const a = stallTypeOf({ username: "StableStall", role: "commoner" });
  const b = stallTypeOf({ username: "StableStall", role: "commoner" });
  assert.equal(a, b, "type must be stable");
  assert.ok(a === null || STALL_TYPES.includes(a), "type must be known or null");
}

// --- commoner gating: non-commoners are never stallfolk ---
{
  assert.equal(stallTypeOf({ username: "SomeStall", role: "merchant" }), null);
  assert.equal(stallTypeOf({ username: "SomeStall", role: "guard" }), null);
  assert.equal(stallTypeOf({ username: "SomeStall", attributes: { role: "banker" } }), null);
  assert.equal(stallTypeOf({ username: null, role: "commoner" }), null);
}

// --- pro exclusion: the master's professional stall merchants (role merchant) ---
{
  assert.equal(isProStallMerchant({ username: "Pro", role: "merchant" }), true);
  assert.equal(isProStallMerchant({ username: "Pro", role: "MERCHANT" }), true);
  assert.equal(isProStallMerchant({ username: "Am", role: "commoner" }), false);
  assert.equal(isProStallMerchant(null), false);
  assert.equal(stallTypeOf({ username: "ProStall", role: "merchant" }), null,
    "a professional stall merchant must never be stallfolk");
}

// --- hawker exclusion via the hawkers' real claim function, before the share roll ---
{
  const Hawkers2 = require("./CitizenHawkers2");
  // find a hawker-claimed name that also rolls inside the 35% share
  let claimed = null;
  for (let i = 0; i < 20000 && !claimed; i++) {
    const name = "HawkOrder" + i;
    if (!Hawkers2.hawkerTypeOf({ username: name, role: "commoner" })) continue;
    if (hashStr(name.toLowerCase() + "|marketstalls2") % 100 >= STALL_SHARE) continue;
    claimed = name;
  }
  assert.ok(claimed, "expected a hawker-claimed name that also rolls inside the share");
  const rec = { username: claimed, role: "commoner" };
  assert.equal(isHawkerfolk(rec), true, "isHawkerfolk must agree with the hawker module");
  assert.equal(stallTypeOf(rec), null,
    "exclusion must win over the share roll regardless of draw");
  assert.equal(Hawkers2.hawkerTypeOf(rec), Hawkers2.hawkerTypeOf(rec),
    "hawker type must be stable");
}

// --- type weighting follows STALL_WEIGHTS ---
{
  const counts = { [BARROW_FOLK]: 0, [BLANKET_FOLK]: 0, [CRATE_FOLK]: 0 };
  const n = 10000;
  for (let i = 0; i < n; i++) counts[stallTypeFromRoll(i % 100)]++;
  assert.ok(counts[BARROW_FOLK] > counts[CRATE_FOLK], "barrow-folk must outnumber crate-folk");
  assert.ok(counts[BLANKET_FOLK] > counts[CRATE_FOLK], "blanket-folk must outnumber crate-folk");
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), n);
}

// --- bridge: master wares come from the master module's real day-wares ---
{
  const ProMarket = require("./CitizenMarketStalls");
  const wares = masterWaresFor("misthalin", NOON);
  assert.ok(Array.isArray(wares) && wares.length > 0, "master wares must be non-empty");
  const expected = ProMarket.dailyWaresFor(
    "stallfolk2:misthalin", "prime", ProMarket.dateKeyFor(new Date(NOON))
  ).map(prettyWare).filter(Boolean);
  assert.deepEqual(wares, expected, "must be the master's real day wares, read-only");
  assert.equal(masterWaresFor("misthalin", NOON).length, wares.length, "stable per day");
  assert.equal(masterWaresFor("", NOON), null, "empty kingdom -> null");
  assert.equal(masterWaresFor(null, NOON), null, "null kingdom -> null");
  // bridge never mutates master state: no stall-state entries, no attribute
  assert.equal(ProMarket._stallState.size, 0, "bridge must not touch the master's stall state");
}

// --- stall pitch assignment: kingdom-preferred, stable per day ---
{
  const pitch = stallPitchFor({ username: "CornerStall", kingdomId: "misthalin" }, NOON);
  assert.ok(pitch && pitch.name, "pitch must have a name");
  assert.equal(pitch.kingdom, "misthalin", "must prefer the citizen's kingdom");
  const again = stallPitchFor({ username: "CornerStall", kingdomId: "misthalin" }, NOON);
  assert.equal(pitch.name, again.name, "pitch must be stable per day");
  assert.ok(STALLS.every((s) => s.name && s.kingdom), "every pitch needs a name and kingdom");
  assert.equal(stallPitchFor({ username: "CornerStall", kingdomId: "nosuchplace" }, NOON) !== null, true);
}

// --- goods: seeded per day, from the type's pool ---
{
  const Hawkers2 = require("./CitizenHawkers2");
  let nm = null;
  for (let i = 0; i < 20000 && !nm; i++) {
    const cand = "GoodsStall" + i;
    if (Hawkers2.hawkerTypeOf({ username: cand, role: "commoner" })) continue;
    if (stallTypeOf({ username: cand, role: "commoner" })) nm = cand;
  }
  assert.ok(nm, "expected a stallfolk name for the goods test");
  const type = stallTypeOf({ username: nm, role: "commoner" });
  const g = goodsFor(nm, type, NOON);
  assert.ok(GOODS[type].includes(g), "goods must come from the type's pool");
  assert.equal(goodsFor(nm, type, NOON), g, "goods stable per day");
  const task = taskForToday(nm, type, NOON);
  assert.ok(task.replace("{place}", "x").length > 0, "task must be a line template");
}

// --- set-piece bands: ~6% wheel-off, ~7% moved-along, ~8% crowd ---
{
  const n = 40000;
  let who = 0, mov = 0, cro = 0;
  for (let i = 0; i < n; i++) {
    const kid = "bandtest" + (i % 97);
    if (wheelOffFor(kid, NOON + i * 60000)) who++;
    if (movedAlongFor(kid, NOON + i * 60000)) mov++;
    if (stallCrowdFor({ name: "bandpitch" + (i % 97) }, NOON + i * 60000)) cro++;
  }
  const w = who / n, m = mov / n, c = cro / n;
  assert.ok(w > 0.03 && w < 0.1, `wheel-off ~6%, got ${w.toFixed(3)}`);
  assert.ok(m > 0.04 && m < 0.11, `moved-along ~7%, got ${m.toFixed(3)}`);
  assert.ok(c > 0.05 && c < 0.12, `crowd ~8%, got ${c.toFixed(3)}`);
  assert.equal(wheelOffFor(null, NOON), false);
  assert.equal(movedAlongFor(undefined, NOON), false);
  assert.equal(stallCrowdFor(null, NOON), false);
  assert.equal(wheelOffFor("misthalin", NOON), wheelOffFor("misthalin", NOON), "wheel-off deterministic per day");
}

// --- work hours (amateur market hours: 07:00-18:00) ---
{
  assert.equal(isWorkHour(SEVEN_AM), true, "07:00 is in hours");
  assert.equal(isWorkHour(EIGHT_AM), true, "08:00 is in hours");
  assert.equal(isWorkHour(NOON), true);
  assert.equal(isWorkHour(SIX_PM), false, "18:00 is out of hours");
  assert.equal(isWorkHour(SIX_AM), false, "06:00 is out of hours");
  assert.equal(isWorkHour(TEN_PM), false);
  assert.equal(WORK_START_HOUR, 7);
  assert.equal(WORK_END_HOUR, 18);
  assert.equal(SETUP_CUTOFF_HOUR, 10);
}

// --- line pools: no leftover raw slots, all non-empty ---
{
  for (const t of STALL_TYPES) {
    assert.ok(Array.isArray(STALL_LINES[t]) && STALL_LINES[t].length > 0, t + " needs lines");
    for (const line of STALL_LINES[t]) {
      assert.ok(!/\{\w+\}/.test(fill(line, { goods: "g" })), `unfilled slot in ${t} line`);
    }
    assert.ok(Array.isArray(GOODS[t]) && GOODS[t].length > 0, t + " needs goods");
    assert.ok(Array.isArray(DAILY_TASK_LINES[t]) && DAILY_TASK_LINES[t].length > 0, t + " needs task lines");
  }
  assert.ok(SETUP_LINES.length > 0, "SETUP_LINES must be non-empty");
  for (const [label, pool] of [
    ["WHEEL_OFF_LINES", WHEEL_OFF_LINES], ["MOVED_ALONG_LINES", MOVED_ALONG_LINES],
    ["CROWD_LINES", CROWD_LINES], ["MARKET_TALK_LINES", MARKET_TALK_LINES],
  ]) {
    assert.ok(Array.isArray(pool) && pool.length > 0, label + " must be non-empty");
    for (const line of pool) {
      assert.ok(!/\{\w+\}/.test(fill(line, { ware: "w", goods: "g", place: "p" })), `unfilled slot in ${label}`);
    }
  }
  assert.ok(MARKET_TALK_LINES.every((l) => l.includes("{ware}")), "market talk must name the real ware");
}

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
  assert.equal(withinTiles(loc(0, 0, 0), loc(14, 14, 0), STALL_RADIUS), true);
  assert.equal(withinTiles(loc(0, 0, 0), loc(15, 0, 0), STALL_RADIUS), false);
  assert.equal(withinTiles(loc(0, 0, 0), loc(0, 0, 1), STALL_RADIUS), false);
}

// --- tick never throws on empty / junk directors ---
{
  tickStallfolk({}, NOON);
  tickStallfolk(null, NOON);
  tickStallfolk({ roster: { values: () => { throw new Error("boom"); } } }, NOON);
  tickStallfolk({ roster: { values: () => [null, undefined, {}] } }, NOON);
}

// --- tick gates: per-citizen try/catch + cooldown ---
{
  mod._resetState();
  const forced = [];
  const director = {
    roster: new Map([
      ["Explode", { username: "ExplodeStall", role: "commoner",
        get boom() { throw new Error("bad record"); } }],
      ["Stall", { username: "GateStall", role: "commoner" }],
    ]),
    playerFor: (record) => {
      if (record.username === "GateStall") {
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
  // GateStall may not be stallfolk; either way the tick must not throw.
  tickStallfolk(director, EIGHT_AM);
  tickStallfolk(director, EIGHT_AM); // cooldown gate: second pass stays quiet or repeats safely
}

// --- crowd moment fires at most once per pitch per day ---
{
  mod._resetState();
  // find a day (deterministic, not necessarily today) where the kingdom has
  // the stall-crowd moment but no wheel-off/moved-along set-piece
  const CROWD_DAY = (() => {
    const pitch = STALLS.find((s) => s.kingdom === "misthalin");
    for (let d = 0; d < 500; d++) {
      const t = NOON + d * 86400000;
      if (wheelOffFor("misthalin", t) || movedAlongFor("misthalin", t)) continue;
      if (stallCrowdFor(pitch, t)) return t;
    }
    return null;
  })();
  assert.ok(CROWD_DAY, "expected a day with a stall-crowd moment");
  const day = dayNumber(CROWD_DAY);
  const Hawkers2 = require("./CitizenHawkers2");
  let stallName = null, pitchName = null, stallType = null;
  for (let i = 0; i < 60000 && !stallName; i++) {
    const nm = "crowdcheck2" + i;
    const rec = { username: nm, role: "commoner", kingdomId: "misthalin" };
    if (Hawkers2.hawkerTypeOf(rec)) continue;
    const type = stallTypeOf(rec);
    if (!type) continue;
    const pitch = stallPitchFor(rec, CROWD_DAY);
    if (!pitch || !stallCrowdFor(pitch, CROWD_DAY)) continue;
    stallName = nm;
    stallType = type;
    pitchName = pitch.name;
  }
  assert.ok(stallName, "expected stallfolk whose pitch has the crowd moment today");
  const crowdKey = "stallcrowd:" + pitchName + ":" + day;

  const forced = [];
  const director = {
    roster: new Map([[stallName, { username: stallName, role: "commoner", kingdomId: "misthalin" }]]),
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
    tickStallfolk(director, CROWD_DAY);
    assert.ok(forced.length === 1, "first tick must fire exactly one line");
    assert.ok(CROWD_LINES.some((l) => fill(l, {
      goods: goodsFor(stallName, stallType, CROWD_DAY) ?? "wares",
      place: pitchName,
    }) === forced[0]), "first tick must fire the haggle-crowd moment");
    assert.ok(_lastFiredByCitizen.has(crowdKey), "crowd moment must record its once-per-day key");
    // second tick: clear only the citizen cooldown, keep the crowd key
    _lastFiredByCitizen.delete(stallName);
    forced.length = 0;
    tickStallfolk(director, CROWD_DAY);
    assert.ok(forced.length === 1, "second tick must also fire");
    assert.ok(!CROWD_LINES.some((l) => fill(l, {
      goods: goodsFor(stallName, stallType, CROWD_DAY) ?? "wares",
      place: pitchName,
    }) === forced[0]), "the crowd moment must not fire twice for the same pitch+day");
  } finally {
    Math.random = realRandom;
  }
}

// --- morning setup flavor fires before 10:00 ---
{
  mod._resetState();
  // find a day with no set-pieces seeded for the kingdom and no pitch crowd,
  // so the main branch is the only thing that can fire
  const SETUP_DAY = (() => {
    for (let d = 0; d < 500; d++) {
      const t = new Date(2026, 9, 8 + d, 8, 0).getTime();
      if (wheelOffFor("misthalin", t) || movedAlongFor("misthalin", t)) continue;
      const rec = { username: "setupprobe", role: "commoner", kingdomId: "misthalin" };
      const pitch = stallPitchFor(rec, t);
      if (pitch && stallCrowdFor(pitch, t)) continue;
      return t;
    }
    return null;
  })();
  assert.ok(SETUP_DAY, "expected a day with no set-pieces");
  const Hawkers2 = require("./CitizenHawkers2");
  let stallName = null;
  for (let i = 0; i < 60000 && !stallName; i++) {
    const nm = "setupcheck" + i;
    const rec = { username: nm, role: "commoner", kingdomId: "misthalin" };
    if (Hawkers2.hawkerTypeOf(rec)) continue;
    if (!stallTypeOf(rec)) continue;
    const pitch = stallPitchFor(rec, SETUP_DAY);
    if (pitch && stallCrowdFor(pitch, SETUP_DAY)) continue;
    stallName = nm;
  }
  assert.ok(stallName, "expected a stallfolk name for the setup test");
  const forced = [];
  const director = {
    roster: new Map([[stallName, { username: stallName, role: "commoner", kingdomId: "misthalin" }]]),
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
    Math.random = () => 0; // roll < 0.6 -> main branch; before 10:00 -> setup flavor
    tickStallfolk(director, SETUP_DAY);
    assert.equal(forced.length, 1, "morning tick must fire exactly one line");
    assert.ok(SETUP_LINES.includes(forced[0]),
      `morning fire must be setup flavor, got: ${forced[0]}`);
  } finally {
    Math.random = realRandom;
  }
}

// --- tuning constants are pinned ---
{
  assert.equal(STALL_RADIUS, 14);
  assert.equal(STALL_CITIZEN_COOLDOWN_MS, 3 * 60 * 60 * 1000);
  assert.equal(STALL_CHANCE, 0.15);
  assert.equal(STALL_SHARE, 35);
  assert.equal(WHEEL_OFF_CHANCE, 0.06);
  assert.equal(MOVED_ALONG_CHANCE, 0.07);
  assert.equal(STALL_CROWD_CHANCE, 0.08);
  assert.equal(BARROW_FOLK, "barrow-stallfolk");
  assert.equal(BLANKET_FOLK, "blanket-stallfolk");
  assert.equal(CRATE_FOLK, "crate-stallfolk");
  assert.equal(STALL_TYPES.length, 3);
}

console.log("ALL CITIZENMARKETSTALLS2 TESTS PASSED");
