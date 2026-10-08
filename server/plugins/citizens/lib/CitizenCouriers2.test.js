// CitizenCouriers2 unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const mod = require("./CitizenCouriers2");

const {
  hashStr,
  pickOne,
  fill,
  errandTypeFromRoll,
  errandTypeOf,
  beatFor,
  feeForToday,
  errandJobForToday,
  basketForToday,
  wellForToday,
  taskForToday,
  marketRushFor,
  spilledBasketFor,
  courierCorners,
  hiredDeliveryStatus,
  requestFetch,
  fetchFor,
  fetchReady,
  completeFetch,
  sendShortNote,
  shortNoteFor,
  noteDelivered,
  collectNote,
  tickErrandfolk,
  isWorkHour,
  dayNumber,
  chance,
  seededRng,
  normalizeName,
  isRealPlayer,
  withinTiles,
  ERRAND_TYPES,
  ERRAND_RUNNER,
  GROCERY_CARRIER,
  WATER_FETCHER,
  NOTE_LAD,
  ERRAND_BEATS,
  ERRAND_SHARE,
  WORK_START_HOUR,
  WORK_END_HOUR,
  WELLS,
  BASKET_GOODS,
} = mod;

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// local-time constructors (never Date.UTC — the PC runs on EDT)
const NOON = new Date(2026, 9, 8, 12, 0).getTime(); // October, mid-day
const MIDNIGHT = new Date(2026, 9, 8, 2, 0).getTime();
const NEXTNIGHT = new Date(2026, 9, 9, 2, 0).getTime(); // Oct 9 02:00 — past the 3h cooldown
const EARLY = new Date(2026, 9, 8, 5, 30).getTime(); // before street hours
const EVENING = new Date(2026, 9, 8, 21, 30).getTime(); // after street hours

function rec(username, role = "commoner", kingdomId = "misthalin") {
  return { username, role, kingdomId };
}

function makeLoc(x, y, z = 0) {
  return { getX: () => x, getY: () => y, getZ: () => z };
}
function makeCitizen(x, y, username = "ErrandSam") {
  const said = [];
  return {
    said,
    isPlayerBot: () => true,
    getHostAddress: () => "bot",
    getUsername: () => username,
    getLocation: () => makeLoc(x, y),
    forceChat: (t) => said.push(String(t)),
  };
}
function makePlayer(x, y, username = "TestPlayer") {
  return {
    isPlayerBot: () => false,
    getHostAddress: () => "127.0.0.1",
    getUsername: () => username,
    getLocation: () => makeLoc(x, y),
    sendMessage: () => {},
  };
}

// --- pure helpers ---

{
  assert.equal(hashStr("abc"), hashStr("abc"), "hashStr deterministic");
  assert.notEqual(hashStr("abc"), hashStr("abd"), "hashStr distinguishes");
  assert.ok(typeof hashStr("x") === "number" && hashStr("x") > 0, "hashStr unsigned");
  const r = lcg(42);
  assert.equal(pickOne(r, ["only"]), "only", "pickOne single");
  assert.equal(fill("hello {name}", { name: "world" }), "hello world", "fill slots");
  assert.equal(fill("{a} {b}", { a: 1, b: 2 }), "1 2", "fill numbers");
  // weights: runner 30 / carrier 30 / fetcher 25 / lad 15
  assert.equal(errandTypeFromRoll(0), ERRAND_RUNNER, "roll 0 -> runner");
  assert.equal(errandTypeFromRoll(29), ERRAND_RUNNER, "roll 29 -> runner");
  assert.equal(errandTypeFromRoll(30), GROCERY_CARRIER, "roll 30 -> carrier");
  assert.equal(errandTypeFromRoll(59), GROCERY_CARRIER, "roll 59 -> carrier");
  assert.equal(errandTypeFromRoll(60), WATER_FETCHER, "roll 60 -> fetcher");
  assert.equal(errandTypeFromRoll(84), WATER_FETCHER, "roll 84 -> fetcher");
  assert.equal(errandTypeFromRoll(85), NOTE_LAD, "roll 85 -> lad");
  assert.equal(errandTypeFromRoll(99), NOTE_LAD, "roll 99 -> lad");
  assert.ok(chance(() => 0, 0.5), "chance true");
  assert.ok(!chance(() => 0.999, 0.5), "chance false");
  assert.equal(WORK_START_HOUR, 6, "street hours start 06:00");
  assert.equal(WORK_END_HOUR, 20, "street hours end 20:00");
  assert.ok(isWorkHour(NOON), "noon is a work hour");
  assert.ok(!isWorkHour(MIDNIGHT), "2am is not a work hour");
  assert.ok(!isWorkHour(EARLY), "05:30 is not a work hour");
  assert.ok(!isWorkHour(EVENING), "21:30 is not a work hour");
  assert.equal(isRealPlayer(makePlayer(0, 0)), true, "real player recognized");
  assert.equal(isRealPlayer(makeCitizen(0, 0)), false, "citizen bot not real");
  assert.equal(isRealPlayer(null), false, "null not real");
  assert.ok(withinTiles(makePlayer(0, 0), makeCitizen(5, 5), 14), "near within 14");
  assert.ok(!withinTiles(makePlayer(0, 0), makeCitizen(50, 50), 14), "far not within 14");
  console.log("  pure helpers ok");
}

// --- distribution band + decile check (~45% nominal, minus pro couriers) ---

function findName(pred, prefix = "Errand") {
  for (let i = 0; i < 200000; i++) {
    const n = prefix + i;
    if (pred(n)) return n;
  }
  return null;
}

{
  const N = 10000;
  const typeCounts = {};
  for (const t of ERRAND_TYPES) typeCounts[t] = 0;
  const deciles = new Array(10).fill(0);
  let total = 0;
  for (let i = 0; i < N; i++) {
    const t = errandTypeOf(rec("Decile" + i));
    if (!t) continue;
    total++;
    typeCounts[t]++;
    deciles[i % 10]++;
  }
  const rate = total / N;
  assert.ok(rate > 0.28 && rate < 0.45, `share rate ${rate.toFixed(3)} in 0.28..0.45 (post-exclusion)`);
  // weight check: runner ~30%, carrier ~30%, fetcher ~25%, lad ~15%
  const expect = { [ERRAND_RUNNER]: 0.30, [GROCERY_CARRIER]: 0.30, [WATER_FETCHER]: 0.25, [NOTE_LAD]: 0.15 };
  for (const t of ERRAND_TYPES) {
    const share = typeCounts[t] / total;
    assert.ok(Math.abs(share - expect[t]) < 0.06, `type ${t} share ${share.toFixed(3)} within 0.06 of ${expect[t]}`);
  }
  for (let d = 0; d < 10; d++) {
    const share = deciles[d] / (N / 10);
    assert.ok(Math.abs(share - rate) < 0.08, `decile ${d} uniform: ${share.toFixed(3)} vs ${rate.toFixed(3)}`);
  }
  console.log(`  distribution: ${(rate * 100).toFixed(1)}% errand-runners over 10k names, type shares: ` +
    ERRAND_TYPES.map((t) => `${t}=${(typeCounts[t] / total * 100).toFixed(1)}%`).join(" "));
}

// --- exclusion integration against the real pro module ---

{
  const ProCouriers = require("./CitizenCouriers");
  const proName = findName((n) => !!ProCouriers.courierTypeFor(n), "CourierPro");
  assert.ok(proName, "found a pro courier name");
  assert.equal(errandTypeOf(rec(proName)), null, `pro courier ${proName} excluded`);
  assert.equal(errandTypeOf(rec("SomeGuard", "guard")), null, "non-commoner role excluded");
  // messengers own the official post — excluded from errand running
  const Professions = require("./CitizenPrimaryProfession");
  const msgName = findName((n) => Professions.primaryProfessionFor(n) === "messenger", "Messenger");
  if (msgName) {
    // only assert when the name is not already a pro courier (messengers
    // return null from the pro path, so this tests OUR extra gate)
    assert.ok(!ProCouriers.courierTypeFor(msgName), "messenger not a pro courier");
    assert.equal(errandTypeOf(rec(msgName)), null, `messenger ${msgName} excluded`);
    console.log(`  exclusion verified: pro courier ${proName} and messenger ${msgName} excluded`);
  } else {
    console.log(`  exclusion verified: pro courier ${proName} excluded (no messenger name found in scan)`);
  }
  // name-first salts: the errand salt differs from the pro courier salt
  assert.notEqual(hashStr("x|errandfolk"), hashStr("x"), "salt changes the roll");
}

// --- venues ---

{
  const v = beatFor(rec("anyone", "commoner", "keldagrim"));
  assert.equal(v.kingdom, "keldagrim", "kingdom-preferred beat");
  assert.equal(beatFor(rec("anyone", "commoner", "nowhere")).kingdom !== undefined, true, "unknown kingdom falls back");
  assert.equal(ERRAND_BEATS.length, 10, "ten beats");
  assert.equal(beatFor(rec("anyone")).kingdom, "misthalin", "default kingdom misthalin");
  console.log("  venues ok");
}

// --- fees, jobs, baskets, wells, tasks (all deterministic per day) ---

{
  const f1 = feeForToday("sam", NOON);
  assert.equal(f1, feeForToday("sam", NOON), "fee stable per day");
  assert.ok(/coppers? a run$/.test(f1), `fee format: ${f1}`);
  const job = errandJobForToday("sam", NOON);
  assert.equal(job, errandJobForToday("sam", NOON), "errand job stable per day");
  const basket = basketForToday("sam", NOON);
  assert.equal(basket, basketForToday("sam", NOON), "basket stable per day");
  assert.ok(BASKET_GOODS.includes(basket), `basket known: ${basket}`);
  const well = wellForToday("sam", NOON);
  assert.equal(well, wellForToday("sam", NOON), "well stable per day");
  assert.ok(WELLS.includes(well), `well known: ${well}`);
  const t1 = taskForToday("sam", ERRAND_RUNNER, NOON);
  assert.equal(t1, taskForToday("sam", ERRAND_RUNNER, NOON), "task stable per day");
  console.log(`  fee/job/basket/well/task all deterministic (fee: ${f1})`);
}

// --- real-data bridges to the pro courier module ---

{
  const corners = courierCorners();
  assert.ok(Array.isArray(corners) && corners.length >= 1, "courier corners non-empty");
  const ProCouriers = require("./CitizenCouriers");
  assert.deepEqual(corners, ProCouriers.PICKUP_POINTS.slice(), "corners ARE the pro pickup points");
  // hired-delivery status bridge: null with no hire...
  assert.equal(hiredDeliveryStatus("NoHirePlayer", NOON), null, "no hire -> null");
  // ...and a real status once the pro trade has a hire
  ProCouriers.hireCourier("BridgePlayer", "BridgeCourier", "parcel", "test note", NOON);
  const st = hiredDeliveryStatus("BridgePlayer", NOON);
  assert.ok(st, "hire status returned");
  assert.equal(st.courier, "BridgeCourier", "courier name passes through");
  assert.equal(st.kind, "parcel", "kind passes through");
  assert.ok(["booked", "picked up", "en route", "delivered"].includes(st.status), `status known: ${st.status}`);
  console.log(`  pro-courier bridges ok (status: ${st.status})`);
}

// --- rhythms (deterministic) ---

{
  const beat = ERRAND_BEATS[0];
  assert.equal(marketRushFor(beat, NOON), marketRushFor(beat, NOON), "market rush deterministic");
  assert.equal(JSON.stringify(spilledBasketFor("misthalin", NOON)), JSON.stringify(spilledBasketFor("misthalin", NOON)), "spill deterministic");
  // scan a year to prove both fire
  const DAY = 24 * 3600 * 1000;
  const base = new Date(2026, 6, 1, 12, 0).getTime();
  let sawRush = null, sawSpill = null;
  for (let d = 0; d < 365 && (!sawRush || !sawSpill); d++) {
    const t = base + d * DAY;
    if (!sawRush) {
      const b = ERRAND_BEATS.find((v) => marketRushFor(v, t));
      if (b) sawRush = b.name;
    }
    if (!sawSpill) {
      const k = ["misthalin", "asgarnia", "kandarin", "keldagrim", "morytania", "kharidian"]
        .find((kid) => spilledBasketFor(kid, t));
      if (k) sawSpill = k;
    }
  }
  assert.ok(sawRush, "market rushes occur");
  assert.ok(sawSpill, "spilled baskets occur");
  console.log(`  rhythms fire: market rush at ${sawRush}, spilled basket in ${sawSpill}`);
}

// --- fetch-request ledger ---

{
  mod._resetState();
  const f = requestFetch("TestPlayer", "ErrandBoy", "a parcel of mending", NOON);
  assert.ok(f, "fetch request recorded");
  assert.equal(f.item, "a parcel of mending", "item recorded");
  assert.ok(f.durationMs >= 3600 * 1000 && f.durationMs <= 3 * 3600 * 1000, `duration 1-3h: ${f.durationMs}`);
  assert.equal(fetchFor("TestPlayer", NOON).runner, "ErrandBoy", "fetch readable");
  assert.ok(!fetchReady(fetchFor("TestPlayer", NOON), NOON), "not ready on request");
  assert.ok(fetchReady(fetchFor("TestPlayer", NOON), NOON + f.durationMs), "ready after duration");
  assert.ok(completeFetch("TestPlayer", NOON), "collection deletes the record");
  assert.equal(fetchFor("TestPlayer", NOON), null, "fetch gone after collection");
  requestFetch("Expiry", "E", "a basket of eggs", NOON);
  assert.equal(fetchFor("Expiry", NOON + 25 * 3600 * 1000), null, "fetch record expires after 24h TTL");
  console.log("  fetch ledger ok");
  mod._resetState();
}

// --- short-note ledger ---

{
  mod._resetState();
  const n = sendShortNote("TestPlayer", "NoteLad", "the Widow Penn", "supper at six", NOON);
  assert.ok(n, "short note recorded");
  assert.equal(n.to, "the Widow Penn", "recipient recorded");
  assert.ok(n.durationMs >= 30 * 60 * 1000 && n.durationMs <= 90 * 60 * 1000, `duration 30-90min: ${n.durationMs}`);
  assert.equal(shortNoteFor("TestPlayer", NOON).runner, "NoteLad", "note readable");
  assert.ok(!noteDelivered(shortNoteFor("TestPlayer", NOON), NOON), "not delivered on sending");
  assert.ok(noteDelivered(shortNoteFor("TestPlayer", NOON), NOON + n.durationMs), "delivered after duration");
  assert.ok(collectNote("TestPlayer", NOON), "acknowledgement deletes the record");
  assert.equal(shortNoteFor("TestPlayer", NOON), null, "note gone after acknowledgement");
  sendShortNote("Gone", "L", "a neighbor", "hi", NOON);
  assert.equal(shortNoteFor("Gone", NOON + 8 * 24 * 3600 * 1000), null, "note expires after 7d TTL");
  console.log("  short-note ledger ok");
  mod._resetState();
}

// --- tick smoke test (mock director, real hash eligibility) ---

{
  mod._resetState();
  // real eligibility: find names that hash into runner and note-lad
  const runnerName = findName((n) => errandTypeOf(rec(n)) === ERRAND_RUNNER, "Runnerfolk");
  const ladName = findName((n) => errandTypeOf(rec(n)) === NOTE_LAD, "NoteLad");
  assert.ok(runnerName, "found a runner name");
  assert.ok(ladName, "found a note-lad name");
  const r1 = rec(runnerName);
  const r2 = rec(ladName);
  const r3 = rec("noterrand", "guard"); // excluded by role
  const said = [];
  const citizen = makeCitizen(100, 100);
  citizen.forceChat = (t) => said.push(String(t));
  const player = makePlayer(105, 105);
  const director = {
    roster: new Map([[runnerName.toLowerCase(), r1], [ladName.toLowerCase(), r2], ["noterrand", r3]]),
    playerFor: (r) => (r === r1 || r === r2 ? citizen : null),
    onlinePlayers: () => [player],
    aiTickCount: 0,
    log: () => {},
  };
  // pin rng so the chance gate always passes and the test is deterministic
  const realRandom = Math.random;
  Math.random = () => 0.01;
  try {
    // runner branch at noon
    tickErrandfolk(director, NOON, { tick: 0 });
    assert.ok(said.length >= 1, "tick fired (runner)");
    const saidNoon = said.length;
    // immediate refire blocked by the cooldown map
    tickErrandfolk(director, NOON, { tick: 0 });
    assert.equal(said.length, saidNoon, "cooldown blocks immediate re-fire");
    // priority branch: seed a READY fetch for the nearby player, then tick
    // at a fresh timestamp (3h cooldown keyed by username)
    const fr = requestFetch("TestPlayer", "ErrandBoy", "a copper kettle", NOON - 4 * 3600 * 1000);
    assert.ok(fetchReady(fetchFor("TestPlayer", NOON + 4 * 3600 * 1000), NOON + 4 * 3600 * 1000), "fetch is ready");
    tickErrandfolk(director, NOON + 4 * 3600 * 1000, { tick: 0 });
    assert.ok(said.length > saidNoon, "tick fired (runner, ready-fetch callout)");
    const newLines = said.slice(saidNoon);
    assert.ok(newLines.some((l) => l.includes("TestPlayer") && l.includes("a copper kettle")), `callout names player and item: ${newLines.join(" | ")}`);
    // note-lad branch: seed a delivered note for the nearby player, then tick
    // at 19:00 — inside work hours (06:00-20:00) and exactly past the 3h
    // cooldown from the 16:00 tick
    const nr = sendShortNote("TestPlayer", "NoteLad", "the chandler", "hello", NOON - 4 * 3600 * 1000);
    assert.ok(nr, "short note recorded");
    tickErrandfolk(director, NOON + 7 * 3600 * 1000, { tick: 0 });
    const saidNoonPlus4 = said.length;
    assert.ok(saidNoonPlus4 > saidNoon + 1, "tick fired (note-lad, delivered-note callout)");
    const newNoteLines = said.slice(saidNoonPlus4 - 2);
    assert.ok(newNoteLines.some((l) => l.includes("TestPlayer") && l.includes("the chandler")), `note callout names player and recipient: ${newNoteLines.join(" | ")}`);
    // night hours: no work fires (fresh timestamp, past the 3h cooldown)
    const saidDay = said.length;
    tickErrandfolk(director, NEXTNIGHT, { tick: 0 });
    assert.equal(said.length, saidDay, "no work outside street hours");
    // one bad record never kills the tick
    const badDirector = { roster: { values: () => { throw new Error("boom"); } } };
    tickErrandfolk(badDirector, NOON, { tick: 0 });
  } finally {
    Math.random = realRandom;
  }
  console.log("  tick smoke ok (runner fired, cooldown held, ready-fetch + delivered-note callouts fired, night quiet, bad roster survived)");
  mod._resetState();
}

console.log("CitizenCouriers2 tests passed");
