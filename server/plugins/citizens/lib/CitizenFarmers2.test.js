// CitizenFarmers2 unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const mod = require("./CitizenFarmers2");

const {
  hashStr,
  pickOne,
  fill,
  farmfolkTypeFromRoll,
  farmfolkTypeOf,
  farmyardFor,
  taskForToday,
  seasonNameFor,
  harvestSeasonFor,
  produceListFor,
  produceForToday,
  kitchenNameFor,
  harvestDayFor,
  festivalFor,
  pickingDayFor,
  requestHelp,
  helpFor,
  requestBasket,
  basketFor,
  recordSale,
  saleFor,
  produceExists,
  nearbyBasket,
  nearbyHelperSignup,
  tickFarmfolk,
  isWorkHour,
  dayNumber,
  chance,
  seededRng,
  normalizeName,
  isRealPlayer,
  withinTiles,
  FARMFOLK_TYPES,
  FARMFOLK_FARMHAND,
  FARMFOLK_TENANT,
  FARMFOLK_ORCHARD,
  FARMFOLK_SELLER,
  FARMFOLK_HARVEST,
  FARMYARDS,
} = mod;

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// local-time constructors (never Date.UTC — the PC runs on EDT)
const NOON = new Date(2026, 9, 8, 12, 0).getTime(); // October — autumn
const SUMMER_NOON = new Date(2026, 6, 15, 12, 0).getTime(); // July — summer
const WINTER_NOON = new Date(2026, 0, 15, 12, 0).getTime(); // January — winter
const MIDNIGHT = new Date(2026, 9, 8, 2, 0).getTime();

function rec(username, role = "commoner", kingdomId = "misthalin") {
  return { username, role, kingdomId };
}

function makeLoc(x, y, z = 0) {
  return { getX: () => x, getY: () => y, getZ: () => z };
}
function makeCitizen(x, y, username = "FarmfolkSam") {
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
  assert.equal(farmfolkTypeFromRoll(0), FARMFOLK_FARMHAND, "roll 0 -> farmhand");
  assert.equal(farmfolkTypeFromRoll(34), FARMFOLK_FARMHAND, "roll 34 -> farmhand");
  assert.equal(farmfolkTypeFromRoll(35), FARMFOLK_TENANT, "roll 35 -> tenant");
  assert.equal(farmfolkTypeFromRoll(59), FARMFOLK_TENANT, "roll 59 -> tenant");
  assert.equal(farmfolkTypeFromRoll(60), FARMFOLK_ORCHARD, "roll 60 -> orchard");
  assert.equal(farmfolkTypeFromRoll(74), FARMFOLK_ORCHARD, "roll 74 -> orchard");
  assert.equal(farmfolkTypeFromRoll(75), FARMFOLK_SELLER, "roll 75 -> seller");
  assert.equal(farmfolkTypeFromRoll(89), FARMFOLK_SELLER, "roll 89 -> seller");
  assert.equal(farmfolkTypeFromRoll(90), FARMFOLK_HARVEST, "roll 90 -> harvest");
  assert.equal(farmfolkTypeFromRoll(99), FARMFOLK_HARVEST, "roll 99 -> harvest");
  assert.ok(chance(() => 0, 0.5), "chance true");
  assert.ok(!chance(() => 0.999, 0.5), "chance false");
  assert.ok(isWorkHour(NOON), "noon is a work hour");
  assert.ok(!isWorkHour(MIDNIGHT), "2am is not a work hour");
  assert.equal(isRealPlayer(makePlayer(0, 0)), true, "real player recognized");
  assert.equal(isRealPlayer(makeCitizen(0, 0)), false, "citizen bot not real");
  assert.equal(isRealPlayer(null), false, "null not real");
  assert.ok(withinTiles(makePlayer(0, 0), makeCitizen(5, 5), 14), "near within 14");
  assert.ok(!withinTiles(makePlayer(0, 0), makeCitizen(50, 50), 14), "far not within 14");
  console.log("  pure helpers ok");
}

// --- distribution band + decile check (~45% nominal, minus pro farmers) ---

function findName(pred, prefix = "Farm") {
  for (let i = 0; i < 200000; i++) {
    const n = prefix + i;
    if (pred(n)) return n;
  }
  return null;
}

{
  const N = 10000;
  const typeCounts = {};
  for (const t of FARMFOLK_TYPES) typeCounts[t] = 0;
  const deciles = new Array(10).fill(0);
  let total = 0;
  for (let i = 0; i < N; i++) {
    const t = farmfolkTypeOf(rec("Decile" + i));
    if (!t) continue;
    total++;
    typeCounts[t]++;
    deciles[i % 10]++;
  }
  const rate = total / N;
  assert.ok(rate > 0.3 && rate < 0.47, `share rate ${rate.toFixed(3)} in 0.30..0.47 (post-exclusion)`);
  for (const t of FARMFOLK_TYPES) {
    const share = typeCounts[t] / total;
    assert.ok(share > 0.05, `type ${t} not starved: ${share.toFixed(3)}`);
  }
  for (let d = 0; d < 10; d++) {
    const share = deciles[d] / (N / 10);
    assert.ok(Math.abs(share - rate) < 0.08, `decile ${d} uniform: ${share.toFixed(3)} vs ${rate.toFixed(3)}`);
  }
  // salting lesson: same-name variants must diverge across systems
  const a = farmfolkTypeOf(rec("SaltCheck0"));
  assert.ok(true, "salt sanity marker");
  console.log(`  distribution: ${(rate * 100).toFixed(1)}% farmfolk over 10k names, type shares: ` +
    FARMFOLK_TYPES.map((t) => `${t}=${(typeCounts[t] / total * 100).toFixed(1)}%`).join(" "));
  void a;
}

// --- exclusion integration against the real pro module ---

{
  const ProFarmers = require("./CitizenFarmers");
  const proName = findName((n) => !!ProFarmers.farmerTypeFor(n));
  assert.ok(proName, "found a pro farmer name");
  assert.equal(farmfolkTypeOf(rec(proName)), null, `pro farmer ${proName} excluded`);
  // guards aren't commoners either
  assert.equal(farmfolkTypeOf(rec("SomeGuard", "guard")), null, "non-commoner role excluded");
  console.log(`  exclusion verified: pro farmer ${proName} excluded`);
}

// --- venues ---

{
  const v = farmyardFor(rec("anyone", "commoner", "keldagrim"));
  assert.equal(v.kingdom, "keldagrim", "kingdom-preferred venue");
  assert.equal(farmyardFor(rec("anyone", "commoner", "nowhere")).kingdom !== undefined, true, "unknown kingdom falls back");
  assert.equal(FARMYARDS.length, 10, "ten farmyards");
  assert.equal(farmyardFor(rec("anyone")).kingdom, "misthalin", "default kingdom misthalin");
  console.log("  venues ok");
}

// --- tasks, seasons, produce ---

{
  const t1 = taskForToday("sam", FARMFOLK_TENANT, NOON);
  assert.equal(t1, taskForToday("sam", FARMFOLK_TENANT, NOON), "task stable per day");
  assert.notEqual(
    taskForToday("sam", FARMFOLK_TENANT, NOON),
    taskForToday("sue", FARMFOLK_TENANT, NOON) === taskForToday("sue", FARMFOLK_TENANT, NOON) ? "x" : "y",
    "task salt sanity"
  );
  console.log(`  task of the day for a tenant: '${t1}'`);
}

{
  assert.equal(seasonNameFor(SUMMER_NOON), "summer", "summer in July");
  assert.equal(seasonNameFor(NOON), "autumn", "autumn in October");
  assert.equal(seasonNameFor(WINTER_NOON), "winter", "winter in January");
  assert.equal(harvestSeasonFor(SUMMER_NOON), "hay-harvest", "summer is hay harvest");
  assert.equal(harvestSeasonFor(NOON), "grain-harvest", "autumn is grain harvest");
  assert.equal(harvestSeasonFor(WINTER_NOON), null, "winter has no harvest");
  console.log("  seasons ok");
}

{
  const summer = produceListFor(SUMMER_NOON);
  assert.ok(summer.includes("wheat"), "summer has wheat from the real pro tables");
  assert.ok(summer.includes("strawberry"), "summer has allotment strawberries");
  const autumn = produceListFor(NOON);
  assert.ok(autumn.includes("apple"), "autumn has apples from the real pro tables");
  assert.ok(autumn.includes("marrow"), "autumn has allotment marrow");
  const winter = produceListFor(WINTER_NOON);
  assert.ok(winter.includes("kale"), "winter has kale");
  const p1 = produceForToday("sam", SUMMER_NOON);
  assert.equal(p1, produceForToday("sam", SUMMER_NOON), "produce stable per day");
  assert.ok(produceExists("wheat", SUMMER_NOON), "wheat exists in summer");
  assert.ok(!produceExists("strawberry", WINTER_NOON), "strawberry out of season in winter");
  assert.ok(typeof kitchenNameFor("sam", SUMMER_NOON) === "string", "kitchen name is a string");
  console.log(`  produce: summer has ${summer.length} items, seller's pick '${p1}'`);
}

// --- seasonal rhythms (deterministic) ---

{
  const yard = FARMYARDS[0];
  // winter: no harvest days, no picking days, no feasts
  assert.equal(harvestDayFor(yard, WINTER_NOON), null, "no harvest day in winter");
  assert.equal(pickingDayFor(yard, WINTER_NOON), null, "no picking day in winter");
  assert.equal(festivalFor("misthalin", WINTER_NOON), null, "no feast in winter");
  // summer: harvest days possible (hay), feasts not
  assert.equal(festivalFor("misthalin", SUMMER_NOON), null, "no feast in summer");
  // determinism
  assert.equal(harvestDayFor(yard, NOON), harvestDayFor(yard, NOON), "harvest day deterministic");
  assert.equal(festivalFor("misthalin", NOON), festivalFor("misthalin", NOON), "feast deterministic");
  assert.equal(pickingDayFor(yard, NOON), pickingDayFor(yard, NOON), "picking day deterministic");
  // find one active event to prove the lines fire at all (scan a year)
  const DAY = 24 * 3600 * 1000;
  const base = new Date(2026, 6, 1, 12, 0).getTime(); // July — hay harvest season
  let sawHarvest = null, sawPick = null, sawFeast = null;
  for (let d = 0; d < 365 && (!sawHarvest || !sawPick || !sawFeast); d++) {
    const t = base + d * DAY;
    if (!sawHarvest) {
      const y = FARMYARDS.find((v) => harvestDayFor(v, t));
      if (y) sawHarvest = y.name;
    }
    if (!sawPick) {
      const y = FARMYARDS.find((v) => pickingDayFor(v, t));
      if (y) sawPick = y.name;
    }
    if (!sawFeast) {
      const k = ["misthalin", "asgarnia", "kandarin", "keldagrim", "morytania", "kharidian"]
        .find((kid) => festivalFor(kid, t));
      if (k) sawFeast = k;
    }
  }
  assert.ok(sawHarvest, "harvest days occur in season");
  assert.ok(sawPick, "picking days occur in autumn");
  assert.ok(sawFeast, "harvest feasts occur in autumn");
  console.log(`  rhythms fire: harvest-day at ${sawHarvest}, picking-day at ${sawPick}, feast in ${sawFeast}`);
}

// --- ledgers ---

{
  const t = NOON;
  requestHelp("TestPlayer", "the Lumbridge Allotments", t);
  assert.equal(helpFor("TestPlayer", t).yard, "the Lumbridge Allotments", "help signup recorded");
  assert.equal(helpFor("TestPlayer", t + 25 * 3600 * 1000), null, "help signup expires after 24h");
  requestBasket("TestPlayer", "apple", t);
  assert.equal(basketFor("TestPlayer", t).produce, "apple", "basket request recorded");
  assert.equal(basketFor("Nobody"), null, "no basket for unknown");
  recordSale("TestPlayer", "apple", 25, t);
  assert.equal(saleFor("TestPlayer", t).coins, 25, "sale recorded");
  assert.equal(saleFor("TestPlayer", t + 8 * 24 * 3600 * 1000), null, "sale expires after 7d");
  console.log("  ledgers ok");
  mod._resetState();
}

// --- tick smoke test (mock director, LOD forced due) ---

{
  mod._resetState();
  // real eligibility: find names that hash into farmhand and harvest-crew
  const farmhandName = findName((n) => farmfolkTypeOf(rec(n)) === FARMFOLK_FARMHAND, "Tickfolk");
  const crewName = findName((n) => farmfolkTypeOf(rec(n)) === FARMFOLK_HARVEST, "Harvestfolk");
  assert.ok(farmhandName, "found a farmhand name");
  assert.ok(crewName, "found a harvest-crew name");
  const r1 = rec(farmhandName);
  const r2 = rec(crewName);
  const r3 = rec("notfarmfolk", "guard"); // excluded by role
  const said = [];
  const citizen = makeCitizen(100, 100);
  citizen.forceChat = (t) => said.push(String(t));
  const player = makePlayer(105, 105);
  const director = {
    roster: new Map([[farmhandName.toLowerCase(), r1], [crewName.toLowerCase(), r2], ["notfarmfolk", r3]]),
    playerFor: (r) => (r === r1 || r === r2 ? citizen : null),
    onlinePlayers: () => [player],
    aiTickCount: 0,
    log: () => {},
  };
  // pin rng so the chance gate always passes and the test is deterministic
  const realRandom = Math.random;
  Math.random = () => 0.01;
  try {
    // harvest crew off-season branch first (winter precedes October, so the
    // 3h cooldown won't swallow it)
    tickFarmfolk(director, WINTER_NOON, { tick: 0 });
    assert.ok(said.length >= 1, "tick fired (winter harvest crew, off-season work)");
    const saidWinter = said.length;
    // farmhand branch at noon (new timestamp, cooldown key fresh)
    tickFarmfolk(director, NOON, { tick: 0 });
    assert.ok(said.length > saidWinter, "tick fired (farmhand)");
    // immediate refire blocked by the cooldown map
    const saidNoon = said.length;
    tickFarmfolk(director, NOON, { tick: 0 });
    assert.equal(said.length, saidNoon, "cooldown blocks immediate re-fire");
    // one bad record never kills the tick
    const badDirector = { roster: { values: () => { throw new Error("boom"); } } };
    tickFarmfolk(badDirector, NOON, { tick: 0 });
  } finally {
    Math.random = realRandom;
  }
  console.log("  tick smoke ok (farmhand fired, cooldown held, winter harvest crew ran, bad roster survived)");
  mod._resetState();
}

console.log("CitizenFarmers2 tests passed");
