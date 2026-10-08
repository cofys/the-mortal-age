// CitizenClockmakers2 unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const mod = require("./CitizenClockmakers2");

const {
  hashStr,
  pickOne,
  fill,
  timefolkTypeFromRoll,
  timefolkTypeOf,
  spotFor,
  taskForToday,
  ropeSnapFor,
  hoarseFor,
  cloggedFor,
  pealFor,
  proClockFor,
  requestWakeup,
  wakeupFor,
  cancelWakeup,
  nearbyDueWakeup,
  tickTimefolk,
  isWorkHour,
  dayNumber,
  chance,
  seededRng,
  normalizeName,
  isRealPlayer,
  withinTiles,
  TIMEFOLK_TYPES,
  KNOCKER_UPPER,
  BELL_TENDER,
  HOUR_CALLER,
  SANDGLASS_MINDER,
  ROUNDS,
  BELLS,
  SQUARES,
  GLASSES,
  TIMEFOLK_SHARE,
  WORK_START_HOUR,
  WORK_END_HOUR,
  TIMEFOLK_RADIUS,
  TIMEFOLK_CHANCE,
  WAKEUP_GRACE_MS,
} = mod;

// local-time constructors (never Date.UTC — the PC runs on EDT)
const NOON = new Date(2026, 9, 8, 12, 0).getTime(); // October, mid-day
const FOUR_AM = new Date(2026, 9, 8, 4, 30).getTime();
const NINE_PM = new Date(2026, 9, 8, 21, 0).getTime();
const TWO_AM = new Date(2026, 9, 8, 2, 0).getTime();

// --- hashStr ---
assert.equal(typeof hashStr("abc"), "number");
assert.equal(hashStr("abc"), hashStr("abc"), "hash must be deterministic");
assert.notEqual(hashStr("abc"), hashStr("abd"), "hash must differ for different strings");
assert.equal(hashStr(null), hashStr(""), "null hashes like empty string");

// --- fill ---
assert.equal(fill("Hello {name}, {hour}!", { name: "Jon", hour: 7 }), "Hello Jon, 7!");
assert.equal(fill("no slots", {}), "no slots");
assert.equal(fill("{a}{a}", { a: "x" }), "xx");

// --- timefolkTypeFromRoll (weights: knock 25 / bell 25 / hour 30 / glass 20) ---
assert.equal(timefolkTypeFromRoll(0), KNOCKER_UPPER);
assert.equal(timefolkTypeFromRoll(24), KNOCKER_UPPER);
assert.equal(timefolkTypeFromRoll(25), BELL_TENDER);
assert.equal(timefolkTypeFromRoll(49), BELL_TENDER);
assert.equal(timefolkTypeFromRoll(50), HOUR_CALLER);
assert.equal(timefolkTypeFromRoll(79), HOUR_CALLER);
assert.equal(timefolkTypeFromRoll(80), SANDGLASS_MINDER);
assert.equal(timefolkTypeFromRoll(99), SANDGLASS_MINDER);

// --- distribution: ~40% of commoners are timefolk (post-exclusion) ---
{
  let n = 0, timefolk = 0;
  for (let i = 0; i < 4000; i++) {
    n++;
    if (timefolkTypeOf({ username: "DistTime" + i, role: "commoner" })) timefolk++;
  }
  const pct = timefolk / n;
  assert.ok(pct > 0.2 && pct < 0.45, `expected ~40% share, got ${pct}`);
  console.log(`distribution: PASS (${(pct * 100).toFixed(1)}%)`);
}

// --- type stability ---
{
  const rec = { username: "StableTime", role: "commoner", kingdomId: "asgarnia" };
  const a = timefolkTypeOf(rec);
  const b = timefolkTypeOf({ username: "StableTime", role: "COMMONER", kingdom: "asgarnia" });
  assert.equal(a, b, "type must be stable across restarts/role casing");
  console.log("type stability: PASS");
}

// --- commoner gating ---
{
  assert.equal(timefolkTypeOf({ username: "GuardOne", role: "guard" }), null);
  assert.equal(timefolkTypeOf({ username: "MerchantX", role: "merchant" }), null);
  assert.equal(timefolkTypeOf({ username: "", role: "commoner" }), null);
  assert.equal(timefolkTypeOf(null), null);
  console.log("commoner gating: PASS");
}

// --- pro-clockmaker exclusion: names claimed by the REAL CitizenClockmakers
// module (clockmakerTypeOf non-null) must never become timefolk ---
{
  const Pro = require("./CitizenClockmakers");
  const claimed = [];
  for (let i = 0; i < 20000 && claimed.length < 40; i++) {
    const u = "ProClock" + i;
    const rec = { username: u, role: "commoner", kingdomId: "misthalin" };
    let type = null;
    try { type = Pro.clockmakerTypeOf(rec); } catch { /* ignore */ }
    if (type) claimed.push(u);
  }
  assert.ok(claimed.length >= 20, `found only ${claimed.length} claimed clockmakers`);
  let excluded = 0;
  for (const u of claimed) {
    const t = timefolkTypeOf({ username: u, role: "commoner", kingdomId: "misthalin" });
    if (t === null) excluded++;
  }
  assert.equal(excluded, claimed.length, "every claimed pro clockmaker must be excluded");
  console.log(`pro-clockmaker exclusion: PASS (${claimed.length} claimed clockmakers all excluded)`);
}

// --- pro gate ordering: pro check runs before the share roll ---
{
  // A name that would pass the 40% share roll but is claimed pro: still null.
  const Pro = require("./CitizenClockmakers");
  let found = null;
  for (let i = 0; i < 20000 && !found; i++) {
    const u = "OrderClock" + i;
    const rec = { username: u, role: "commoner", kingdomId: "misthalin" };
    let type = null;
    try { type = Pro.clockmakerTypeOf(rec); } catch { /* ignore */ }
    if (type && (hashStr(normalizeName(u) + "|timefolk") % 100) < TIMEFOLK_SHARE) found = u;
  }
  assert.ok(found, "found a claimed clockmaker that would pass the share roll");
  assert.equal(timefolkTypeOf({ username: found, role: "commoner", kingdomId: "misthalin" }), null,
    "pro gate must fire before the share roll");
  console.log("pro gate ordering: PASS");
}

// --- pro bridge: real guild workshop + great work cross-read ---
{
  const bridge = proClockFor("misthalin", NOON);
  assert.ok(bridge && bridge.workshop && bridge.workshop.name, "bridge must return a workshop");
  assert.ok(typeof bridge.work === "string" || bridge.work === null, "great work must be a string or null");
  const again = proClockFor("misthalin", NOON);
  assert.equal(bridge.workshop.name, again.workshop.name, "bridge must be stable per kingdom/day");
  assert.equal(proClockFor("", NOON), null, "empty kingdom -> null");
  console.log("pro clock bridge: PASS");
}

// --- spot assignment: kingdom-preferred, stable per day ---
{
  const rec = { username: "SpotTime", role: "commoner", kingdomId: "kandarin" };
  const s1 = spotFor(rec, BELL_TENDER, NOON);
  const s2 = spotFor(rec, BELL_TENDER, NOON);
  assert.equal(s1.name, s2.name, "spot stable per day");
  assert.equal(s1.kingdom, "kandarin", "kingdom-preferred spot");
  const k = spotFor(rec, KNOCKER_UPPER, NOON);
  assert.ok(ROUNDS.includes(k), "knocker-uppers get rounds");
  const g = spotFor(rec, SANDGLASS_MINDER, NOON);
  assert.ok(GLASSES.includes(g), "sandglass-minders get glasses");
  assert.ok(spotFor(null, HOUR_CALLER), "null record still yields a spot (anon fallback)");
  console.log("spot assignment: PASS");
}

// --- set-pieces: deterministic per kingdom/day, within the ~6-8% band ---
{
  const kid = "keldagrim";
  const d1 = new Date(2026, 9, 8, 12, 0).getTime();
  assert.equal(ropeSnapFor(kid, d1), ropeSnapFor(kid, d1), "rope snap deterministic");
  assert.equal(hoarseFor(kid, d1), hoarseFor(kid, d1), "hoarse deterministic");
  assert.equal(cloggedFor(kid, d1), cloggedFor(kid, d1), "clog deterministic");
  // frequency over 365 days x 6 kingdoms
  const kids = ["misthalin", "asgarnia", "kandarin", "keldagrim", "morytania", "kharidian"];
  let snaps = 0, hoarses = 0, clogs = 0, trials = 0;
  for (const k of kids) {
    for (let d = 0; d < 365; d++) {
      const t = d1 + d * 86400000;
      trials++;
      if (ropeSnapFor(k, t)) snaps++;
      if (hoarseFor(k, t)) hoarses++;
      if (cloggedFor(k, t)) clogs++;
    }
  }
  assert.ok(snaps / trials > 0.03 && snaps / trials < 0.12, `rope snap band, got ${snaps / trials}`);
  assert.ok(hoarses / trials > 0.04 && hoarses / trials < 0.14, `hoarse band, got ${hoarses / trials}`);
  assert.ok(clogs / trials > 0.03 && clogs / trials < 0.13, `clog band, got ${clogs / trials}`);
  assert.equal(ropeSnapFor("", d1), false, "empty kingdom -> false");
  console.log(`set-pieces: PASS (snap ${(snaps / trials * 100).toFixed(1)}% / hoarse ${(hoarses / trials * 100).toFixed(1)}% / clog ${(clogs / trials * 100).toFixed(1)}%)`);
}

// --- wake-up ledger ---
{
  mod._resetState();
  // book for 6am from 2am: next occurrence is today 6am
  const w = requestWakeup("Jon", "KnockerNed", 6, TWO_AM);
  assert.ok(w, "requestWakeup returns a wakeup");
  assert.equal(w.hour, 6);
  assert.equal(w.wakeTime, new Date(2026, 9, 8, 6, 0).getTime(), "next occurrence");
  assert.equal(wakeupFor("Jon", TWO_AM).hour, 6, "wakeup retrievable");
  assert.equal(wakeupFor("Nobody", TWO_AM), null, "unknown player -> null");
  // past the hour + grace: expired
  const late = w.wakeTime + WAKEUP_GRACE_MS + 1000;
  assert.equal(wakeupFor("Jon", late), null, "wakeup expires after grace");
  // booking an hour that already passed today -> next day
  const w2 = requestWakeup("Jon", "KnockerNed", 6, NOON);
  assert.equal(w2.wakeTime, new Date(2026, 9, 9, 6, 0).getTime(), "rolls to next day");
  // cancel
  assert.equal(cancelWakeup("Jon", NOON), true, "cancel returns true");
  assert.equal(wakeupFor("Jon", NOON), null, "cancelled wakeup gone");
  assert.equal(cancelWakeup("Nobody", NOON), false, "cancel unknown -> false");
  // invalid inputs
  assert.equal(requestWakeup("", "Ned", 6, NOON), null);
  assert.equal(requestWakeup("Jon", "", 6, NOON), null);
  mod._resetState();
  console.log("wake-up ledger: PASS");
}

// --- work hours: 04:00-21:00 local ---
{
  assert.equal(isWorkHour(FOUR_AM), true, "04:30 in hours");
  assert.equal(isWorkHour(NOON), true, "noon in hours");
  assert.equal(isWorkHour(NINE_PM), false, "21:00 out of hours");
  assert.equal(isWorkHour(TWO_AM), false, "02:00 out of hours");
  assert.equal(WORK_START_HOUR, 4);
  assert.equal(WORK_END_HOUR, 21);
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
  // find a timefolk username
  let citizenName = null;
  for (let i = 0; i < 3000 && !citizenName; i++) {
    const u = "TickTime" + i;
    if (timefolkTypeOf({ username: u, role: "commoner" })) citizenName = u;
  }
  assert.ok(citizenName, "found a timefolk citizen");

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
    tickTimefolk(director, t);
    assert.ok(said.length > 0, "fires with a real player near during work hours");
    const saidAgain = said.length;
    // second tick immediately: cooldown blocks
    tickTimefolk(director, t + 1000);
    assert.equal(said.length, saidAgain, "cooldown blocks repeat firing");

    // outside work hours: no fire (fresh state via _resetState)
    mod._resetState();
    said.length = 0;
    tickTimefolk(director, TWO_AM);
    assert.equal(said.length, 0, "no firing outside work hours");

    // no real player near: no fire
    mod._resetState();
    said.length = 0;
    director.onlinePlayers = () => [
      { isPlayerBot: () => true, getHostAddress: () => "bot", getUsername: () => "BotOne",
        getLocation: () => ({ getX: () => 101, getY: () => 100, getZ: () => 0 }) },
    ];
    tickTimefolk(director, NOON);
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
  assert.doesNotThrow(() => tickTimefolk({}, NOON));
  assert.doesNotThrow(() => tickTimefolk({ roster: new Map() }, NOON));
  assert.doesNotThrow(() => tickTimefolk(null, NOON));
  assert.doesNotThrow(() => tickTimefolk({ roster: null }, NOON));
  console.log("never-throws: PASS");
}

// --- wake priority: due wake-up naming this timefolk names the player ---
{
  mod._resetState();
  // find a knocker-upper
  let knocker = null;
  for (let i = 0; i < 6000 && !knocker; i++) {
    const u = "WakeTime" + i;
    if (timefolkTypeOf({ username: u, role: "commoner" }) === KNOCKER_UPPER) knocker = u;
  }
  assert.ok(knocker, "found a knocker-upper");
  const tname = normalizeName(knocker);

  const said = [];
  const citizen = {
    forceChat: (line) => said.push(line),
    getLocation: () => ({ getX: () => 100, getY: () => 100, getZ: () => 0 }),
  };
  const player = {
    getUsername: () => "Jon",
    getHostAddress: () => "1.2.3.4",
    getLocation: () => ({ getX: () => 105, getY: () => 100, getZ: () => 0 }),
  };
  const director = {
    roster: new Map([[knocker, { username: knocker, role: "commoner", kingdom: "misthalin" }]]),
    playerFor: () => citizen,
    onlinePlayers: () => [player],
  };
  // book a wake-up for the CURRENT hour from two hours ago, so it is due right now
  const nowHour = new Date(NOON).getHours();
  const w = requestWakeup("Jon", knocker, nowHour, NOON - 2 * 3600 * 1000);
  assert.ok(w, "wakeup booked");
  const due = nearbyDueWakeup(director, citizen, tname, NOON);
  assert.ok(due, "due wake-up found for this timefolk");
  assert.equal(due.player, normalizeName("Jon"));
  // a wake-up naming someone else is NOT picked up
  const other = nearbyDueWakeup(director, citizen, "someone-else", NOON);
  assert.equal(other, null, "other timefolk's wake-up ignored");

  // full tick path: the callout names the player
  const origRandom = Math.random;
  Math.random = () => 0;
  try {
    tickTimefolk(director, NOON);
  } finally {
    Math.random = origRandom;
  }
  assert.ok(said.some((s) => s.toLowerCase().includes("jon")), "wake-up callout names the player");
  mod._resetState();
  console.log("wake priority: PASS");
}

// --- pure helpers ---
{
  assert.equal(typeof pickOne(() => 0.1, ["a", "b"]), "string");
  assert.equal(pickOne(() => 0.9, ["a", "b"]), "b");
  const r1 = seededRng(42), r2 = seededRng(42);
  assert.equal(r1(), r2(), "seeded rng deterministic");
  assert.equal(dayNumber(0), 0);
  assert.equal(dayNumber(86400000), 1);
  assert.equal(taskForToday("SomeName", BELL_TENDER, NOON), taskForToday("SomeName", BELL_TENDER, NOON),
    "daily task stable");
  assert.ok(TIMEFOLK_TYPES.includes(HOUR_CALLER));
  assert.ok(ROUNDS.length >= 10 && BELLS.length >= 10 && SQUARES.length >= 10 && GLASSES.length >= 10);
  console.log("pure helpers: PASS");
}

// --- tuning constants pinned ---
{
  assert.equal(TIMEFOLK_SHARE, 40);
  assert.equal(TIMEFOLK_RADIUS, 14);
  assert.equal(TIMEFOLK_CHANCE, 0.15);
  assert.equal(WAKEUP_GRACE_MS, 3 * 3600 * 1000);
  console.log("tuning constants: PASS");
}

console.log("ALL CITIZENCLOCKMAKERS2 TESTS PASSED");
