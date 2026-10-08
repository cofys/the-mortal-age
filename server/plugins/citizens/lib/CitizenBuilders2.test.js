// CitizenBuilders2 unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const mod = require("./CitizenBuilders2");

const {
  hashStr,
  pickOne,
  fill,
  laborfolkTypeFromRoll,
  laborfolkTypeOf,
  siteFor,
  taskForToday,
  materialForToday,
  toppingOutFor,
  scaffoldSlipFor,
  supplyDelayFor,
  proProjectFor,
  hireLaborer,
  hireFor,
  releaseLaborer,
  tickLaborfolk,
  isWorkHour,
  dayNumber,
  chance,
  seededRng,
  normalizeName,
  isRealPlayer,
  withinTiles,
  LABORFOLK_TYPES,
  HOD_CARRIER,
  MORTAR_MIXER,
  SCAFFOLD_MATE,
  DAY_LABORER,
  RUBBLE_CLEARER,
  SITES,
  MATERIALS,
  LABORFOLK_SHARE,
  WORK_START_HOUR,
  WORK_END_HOUR,
  LABORFOLK_RADIUS,
  LABORFOLK_CHANCE,
  HIRE_TTL_MS,
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
assert.equal(fill("Hello {name}, {mat}!", { name: "Jon", mat: "brick" }), "Hello Jon, brick!");
assert.equal(fill("no slots", {}), "no slots");
assert.equal(fill("{a}{a}", { a: "x" }), "xx");

// --- laborfolkTypeFromRoll: weights 25/25/20/15/15 ---
assert.equal(laborfolkTypeFromRoll(0), HOD_CARRIER);
assert.equal(laborfolkTypeFromRoll(24), HOD_CARRIER);
assert.equal(laborfolkTypeFromRoll(25), MORTAR_MIXER);
assert.equal(laborfolkTypeFromRoll(49), MORTAR_MIXER);
assert.equal(laborfolkTypeFromRoll(50), SCAFFOLD_MATE);
assert.equal(laborfolkTypeFromRoll(69), SCAFFOLD_MATE);
assert.equal(laborfolkTypeFromRoll(70), DAY_LABORER);
assert.equal(laborfolkTypeFromRoll(84), DAY_LABORER);
assert.equal(laborfolkTypeFromRoll(85), RUBBLE_CLEARER);
assert.equal(laborfolkTypeFromRoll(99), RUBBLE_CLEARER);

// --- distribution sanity: all types reachable, ~share of names qualify ---
{
  mod._resetState();
  const seen = new Set();
  let qualified = 0;
  for (let i = 0; i < 2000; i++) {
    const t = laborfolkTypeOf({ username: "LaborfolkTest" + i, role: "commoner" });
    if (t) {
      qualified++;
      seen.add(t);
    }
  }
  assert.deepEqual([...seen].sort(), [...LABORFOLK_TYPES].sort(), "all five types reachable");
  const pct = qualified / 2000;
  // ~40% nominal share of commoners
  assert.ok(pct > 0.2 && pct < 0.6, `qualify share ${pct} within sane bounds`);
  console.log(`distribution: PASS (${(pct * 100).toFixed(1)}%)`);
}

// --- type stability across calls ---
{
  mod._resetState();
  for (let i = 0; i < 50; i++) {
    const a = laborfolkTypeOf({ username: "stable" + i, role: "commoner" });
    const b = laborfolkTypeOf({ username: "stable" + i, role: "commoner" });
    assert.equal(a, b, "type stable across calls");
  }
  console.log("type stability: PASS");
}

// --- guards merchants/guards, anonymous names ---
assert.equal(laborfolkTypeOf({ username: "x", role: "guard" }), null);
assert.equal(laborfolkTypeOf({ username: "x", role: "merchant" }), null);
assert.equal(laborfolkTypeOf({ username: "x", role: "courier" }), null);
assert.equal(laborfolkTypeOf({ username: "" }), null);
assert.equal(laborfolkTypeOf(null), null);
console.log("commoner gating: PASS");

// --- no overlap: a claimed pro builder is never laborfolk ---
// Run the REAL pro slow tick on a mock director to populate its private
// roster, then use the real getBuilderInfo null path to find every claimed
// name and verify the laborfolk gate excludes them all.
{
  mod._resetState();
  const Pro = require("./CitizenBuilders");
  const kingdoms = ["misthalin", "asgarnia", "kandarin", "keldagrim", "morytania", "kharidian"];
  const records = [];
  let n = 0;
  for (const kid of kingdoms) {
    for (let i = 0; i < 40; i++) {
      records.push({ username: "OverlapLabor" + (n++), role: "commoner", kingdomId: kid });
    }
  }
  const mockDirector = { roster: new Map(records.map((r) => [r.username, r])) };
  Pro.tickBuilders(mockDirector, NOON);
  const claimed = records
    .map((r) => normalizeName(r.username))
    .filter((nm) => Pro.getBuilderInfo(nm));
  assert.ok(claimed.length >= 20, `enough claimed builders in sample (${claimed.length})`);
  const violations = claimed.filter((nm) => laborfolkTypeOf({ username: nm, role: "commoner" }) !== null);
  assert.equal(violations.length, 0, "claimed pro builders must never be laborfolk");
  console.log(`pro-builder exclusion: PASS (${claimed.length} claimed builders all excluded)`);
}

// --- pro project bridge: names come from the real pro name pools, never throws ---
{
  const p = proProjectFor("misthalin", NOON);
  // The exclusion test above populated nothing about projects, but the
  // bridge reads exported constants — deterministic, always returns.
  assert.ok(p && p.name && p.phase, "bridge returns today's master project");
  assert.equal(proProjectFor("misthalin", NOON).name, p.name, "bridge deterministic same day");
  assert.equal(proProjectFor(null, NOON), null, "null kingdom -> null");
  assert.equal(proProjectFor("nosuchkingdom", NOON) !== null, true, "unknown kingdom still deterministic (name pools are global)");
  assert.doesNotThrow(() => proProjectFor(undefined, NOON), "undefined kingdom never throws");
  // The name really comes from the pro module's pools.
  const Pro = require("./CitizenBuilders");
  const allNames = Object.values(Pro.PROJECT_TYPES).flatMap((d) => d.names ?? []);
  assert.ok(allNames.includes(p.name), "project name from the pro pools");
  assert.ok((Pro.PROJECT_PHASES ?? []).includes(p.phase), "phase from the pro phases");
  assert.notEqual(p.phase, "complete", "bridge never claims a completed project");
  console.log("pro project bridge: PASS");
}

// --- siteFor: kingdom-preferred, stable ---
{
  const s = siteFor({ username: "suser", kingdomId: "asgarnia" });
  assert.equal(s.kingdom, "asgarnia", "kingdom-preferred site");
  assert.equal(siteFor({ username: "suser", kingdomId: "asgarnia" }).name, s.name, "stable");
  const s2 = siteFor({ username: "suser2", kingdomId: "nosuchkingdom" });
  assert.ok(s2 && s2.name, "falls back to full pool");
  console.log("site assignment: PASS");
}

// --- daily pools: tasks / materials deterministic per day, vary by day ---
{
  const m = materialForToday(SITES[0], NOON);
  assert.ok(MATERIALS.includes(m), `material ${m}`);
  assert.equal(materialForToday(SITES[0], NOON), m, "material deterministic same day");
  const t1 = taskForToday("taskuser", HOD_CARRIER, NOON);
  const t2 = taskForToday("taskuser", HOD_CARRIER, NOON);
  assert.equal(t1, t2, "task deterministic same day");
  const seenDays = new Set();
  for (let d = 0; d < 12; d++) {
    seenDays.add(taskForToday("taskuser", HOD_CARRIER, NOON + d * 86400000));
  }
  assert.ok(seenDays.size > 1, "tasks vary across days");
  console.log("daily pools: PASS");
}

// --- set-pieces: deterministic, ~rates ---
{
  const s0 = SITES[0];
  const a = toppingOutFor(s0, NOON);
  assert.deepEqual(toppingOutFor(s0, NOON), a, "topping-out deterministic");
  let th = 0;
  for (let d = 0; d < 400; d++) {
    if (toppingOutFor(s0, NOON + d * 86400000)) th++;
  }
  assert.ok(th / 400 > 0.02 && th / 400 < 0.2, `topping-out rate ${(th / 400).toFixed(3)} sane`);
  let sh = 0;
  for (let d = 0; d < 500; d++) {
    if (scaffoldSlipFor(s0, NOON + d * 86400000)) sh++;
  }
  assert.ok(sh / 500 > 0.01 && sh / 500 < 0.15, `slip rate ${(sh / 500).toFixed(3)} sane`);
  assert.equal(scaffoldSlipFor(s0, NOON), scaffoldSlipFor(s0, NOON), "slip deterministic");
  let dh = 0;
  for (let d = 0; d < 400; d++) {
    if (supplyDelayFor("misthalin", NOON + d * 86400000)) dh++;
  }
  assert.ok(dh / 400 > 0.02 && dh / 400 < 0.2, `supply delay rate ${(dh / 400).toFixed(3)} sane`);
  assert.equal(supplyDelayFor(null, NOON), null, "null kingdom -> null");
  console.log("set-pieces: PASS");
}

// --- hire ledger: hire -> hireFor -> release -> TTL ---
{
  mod._resetState();
  const h = hireLaborer("Jon", "hod-hank", NOON);
  assert.ok(h, "hire recorded");
  assert.equal(h.laborer, "hod-hank");
  assert.ok(h.until > h.hiredAt && h.until <= h.hiredAt + HIRE_TTL_MS, "24h hire window");
  const again = hireFor("Jon", NOON + 1000);
  assert.ok(again && again.laborer === "hod-hank", "hire retrievable");
  assert.equal(releaseLaborer("Jon", NOON + 2000), true, "release deletes");
  assert.equal(hireFor("Jon", NOON + 2000), null, "gone after release");
  // TTL expiry
  hireLaborer("Jon", "mortar-moe", NOON);
  assert.equal(hireFor("Jon", NOON + HIRE_TTL_MS + 1000), null, "hire expires after TTL");
  // null guards
  assert.equal(hireLaborer(null, "x", NOON), null);
  assert.equal(hireLaborer("Jon", null, NOON), null);
  assert.equal(hireFor(null, NOON), null);
  assert.equal(releaseLaborer(null, NOON), false);
  console.log("hire ledger: PASS");
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
  // find a laborfolk username
  let citizenName = null;
  for (let i = 0; i < 3000 && !citizenName; i++) {
    const u = "TickLabor" + i;
    if (laborfolkTypeOf({ username: u, role: "commoner" })) citizenName = u;
  }
  assert.ok(citizenName, "found a laborfolk citizen");

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
    tickLaborfolk(director, t);
    assert.ok(said.length > 0, "fires with a real player near during work hours");
    const saidAgain = said.length;
    // second tick immediately: cooldown blocks
    tickLaborfolk(director, t + 1000);
    assert.equal(said.length, saidAgain, "cooldown blocks repeat firing");

    // outside work hours: no fire (fresh state via _resetState)
    mod._resetState();
    said.length = 0;
    t = MIDNIGHT;
    tickLaborfolk(director, t);
    assert.equal(said.length, 0, "no firing outside work hours");

    // no real player near: no fire
    mod._resetState();
    said.length = 0;
    director.onlinePlayers = () => [
      { isPlayerBot: () => true, getHostAddress: () => "bot", getUsername: () => "BotOne",
        getLocation: () => ({ getX: () => 101, getY: () => 100, getZ: () => 0 }) },
    ];
    tickLaborfolk(director, NOON);
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
  assert.doesNotThrow(() => tickLaborfolk({}, NOON));
  assert.doesNotThrow(() => tickLaborfolk({ roster: new Map() }, NOON));
  assert.doesNotThrow(() => tickLaborfolk(null, NOON));
  assert.doesNotThrow(() => tickLaborfolk({ roster: null }, NOON));
  console.log("never-throws: PASS");
}

// --- claimed pro builder skipped at the type gate before materialization ---
{
  mod._resetState();
  const Pro = require("./CitizenBuilders");
  // Reuse the claimed set: any name the pro null path recognizes.
  const records = [];
  for (let i = 0; i < 300; i++) records.push({ username: "SkipLabor" + i, role: "commoner", kingdomId: "kandarin" });
  Pro.tickBuilders({ roster: new Map(records.map((r) => [r.username, r])) }, NOON);
  const claimedName = records.map((r) => normalizeName(r.username)).find((nm) => Pro.getBuilderInfo(nm));
  assert.ok(claimedName, "a claimed builder exists in this sample");
  let materialized = false;
  const dir = {
    roster: new Map([[claimedName, { username: claimedName, role: "commoner", kingdomId: "kandarin" }]]),
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
    tickLaborfolk(dir, NOON);
  } finally {
    Math.random = origRandom;
  }
  assert.ok(!materialized, "claimed builder never materialized (type gate first)");
  console.log("pro gate ordering: PASS");
}

// --- boss priority: a hired laborer names the waiting player ---
{
  mod._resetState();
  // find a laborfolk citizen
  let citizenName = null;
  for (let i = 0; i < 5000 && !citizenName; i++) {
    const u = "BossLabor" + i;
    if (laborfolkTypeOf({ username: u, role: "commoner" })) citizenName = u;
  }
  assert.ok(citizenName, "found a laborfolk citizen");
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
  // Jon hired this laborer for the day.
  hireLaborer("Jon", citizenName, NOON - 3600 * 1000);
  const origRandom = Math.random;
  Math.random = () => 0;
  try {
    tickLaborfolk(director, NOON);
  } finally {
    Math.random = origRandom;
  }
  assert.ok(said.some((l) => l.includes("Jon")), "hired laborer names the boss");
  mod._resetState();
  console.log("boss priority: PASS");
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
  assert.equal(LABORFOLK_SHARE, 40);
  assert.equal(LABORFOLK_RADIUS, 14);
  assert.equal(LABORFOLK_CHANCE, 0.15);
  assert.equal(LABORFOLK_TYPES.length, 5);
  assert.equal(SITES.length, 12);
  assert.equal(MATERIALS.length, 8);
  console.log("tuning constants: PASS");
}

console.log("ALL CITIZENBUILDERS2 TESTS PASSED");
