// CitizenHealers2 unit checks — pure logic, no running server.
// From server/plugins/citizens: node lib/CitizenHealers2.test.js (plain node)
"use strict";

const assert = require("node:assert/strict");
const H2 = require("./CitizenHealers2");
const HealersPro = require("./CitizenHealers");
const HerbalistsPro = require("./CitizenHerbalists");

const T0 = new Date(2026, 9, 8, 12, 0).getTime(); // local noon, inside care hours

function withFixedRandom(value, fn) {
  const orig = Math.random;
  Math.random = () => value;
  try {
    return fn();
  } finally {
    Math.random = orig;
  }
}

// Find a username satisfying a predicate (dynamic search, not hardcoded).
function findName(pred, prefix) {
  for (let i = 0; i < 5000; i++) {
    const n = `${prefix}${i}`;
    if (pred(n)) return n;
  }
  throw new Error("no name found for " + prefix);
}

function loc(x, y, z = 0) {
  return { getX: () => x, getY: () => y, getZ: () => z };
}
function mockPlayer(name, x = 3000, y = 3000, bot = false) {
  const chats = [];
  return {
    getUsername: () => name,
    isPlayerBot: () => bot,
    getHostAddress: () => (bot ? "bot" : "127.0.0.1"),
    getLocation: () => loc(x, y),
    forceChat: (m) => chats.push(m),
    _chats: chats,
  };
}
function mockDirector(names, opts = {}) {
  const roster = new Map(names.map((n) => [n.toLowerCase(), { username: n, role: "commoner", kingdomId: "misthalin" }]));
  const citizens = new Map();
  return {
    roster,
    playerFor: (record) => {
      const key = String(record.username).toLowerCase();
      if (!citizens.has(key)) citizens.set(key, mockPlayer(record.username, 3000, 3000, true));
      return citizens.get(key);
    },
    onlinePlayers: () => opts.players ?? [],
  };
}

// --- type weights / reachability / stability ---
{
  H2._resetState();
  const counts = { neighbor: 0, bonesetter: 0, midwife: 0, "remedy-brewer": 0 };
  let nulls = 0;
  for (let i = 0; i < 2000; i++) {
    const t = H2.caregiverTypeOf({ username: `Care${i}`, role: "commoner" });
    if (!t) nulls++;
    else counts[t]++;
  }
  for (const t of H2.CAREGIVER_TYPES) assert.ok(counts[t] > 50, `${t} reachable (${counts[t]})`);
  // 30/25/25/20 weights — rough bands
  assert.ok(counts.neighbor > counts["remedy-brewer"], "neighbor most common");
  assert.ok(nulls < 2000 * 0.45, `exclusions sane (${nulls} nulls)`);
  const a = H2.caregiverTypeOf({ username: "Care77", role: "commoner" });
  const b = H2.caregiverTypeOf({ username: "Care77", role: "commoner" });
  assert.equal(a, b, "type stable across calls");
  console.log("types: PASS", JSON.stringify(counts), `nulls=${nulls}`);
}

// --- caregiverTypeFromRoll boundaries ---
{
  assert.equal(H2.caregiverTypeFromRoll(0), "neighbor");
  assert.equal(H2.caregiverTypeFromRoll(29), "neighbor");
  assert.equal(H2.caregiverTypeFromRoll(30), "bonesetter");
  assert.equal(H2.caregiverTypeFromRoll(54), "bonesetter");
  assert.equal(H2.caregiverTypeFromRoll(55), "midwife");
  assert.equal(H2.caregiverTypeFromRoll(79), "midwife");
  assert.equal(H2.caregiverTypeFromRoll(80), "remedy-brewer");
  assert.equal(H2.caregiverTypeFromRoll(99), "remedy-brewer");
  console.log("roll boundaries: PASS");
}

// --- commoner gating ---
{
  assert.equal(H2.caregiverTypeOf({ username: "Care1", role: "guard" }), null, "guards excluded");
  assert.equal(H2.caregiverTypeOf({ username: "Care1", role: "merchant" }), null, "merchants excluded");
  assert.equal(H2.caregiverTypeOf({ username: "", role: "commoner" }), null, "empty name excluded");
  assert.equal(H2.caregiverTypeOf(null), null, "null record excluded");
  console.log("commoner gating: PASS");
}

// --- professional healer exclusion (verified against the real module) ---
{
  const proHealer = findName((n) => HealersPro.isHealer({ username: n }), "ProH");
  assert.equal(
    H2.caregiverTypeOf({ username: proHealer, role: "commoner" }),
    null,
    `${proHealer} is a pro healer and must not be a community caregiver`
  );
  console.log("pro-healer exclusion: PASS", `(${proHealer})`);
}

// --- professional herbalist exclusion (verified against the real module) ---
{
  const proHerb = findName(
    (n) => HerbalistsPro.isHerbalist({ username: n }) && !HealersPro.isHealer({ username: n }),
    "ProB"
  );
  assert.equal(
    H2.caregiverTypeOf({ username: proHerb, role: "commoner" }),
    null,
    `${proHerb} is a pro herbalist and must not be a community caregiver`
  );
  console.log("pro-herbalist exclusion: PASS", `(${proHerb})`);
}

// --- care houses: kingdom-preferred, stable ---
{
  const h1 = H2.careHouseFor({ username: "Care1", kingdomId: "asgarnia" });
  const h2 = H2.careHouseFor({ username: "Care1", kingdomId: "asgarnia" });
  assert.equal(h1.name, h2.name, "house stable");
  assert.equal(h1.kingdom, "asgarnia", "kingdom-preferred");
  console.log("care houses: PASS", `(${h1.name})`);
}

// --- rounds determinism + day variance ---
{
  const name = findName(
    (n) => H2.caregiverTypeOf({ username: n, role: "commoner" }) !== null,
    "Round"
  );
  const d1 = new Date(2026, 9, 8, 12, 0).getTime();
  const d2 = new Date(2026, 9, 9, 12, 0).getTime();
  const r1 = H2.roundsFor(name, "misthalin", d1);
  const r1b = H2.roundsFor(name, "misthalin", d1);
  const r2 = H2.roundsFor(name, "misthalin", d2);
  assert.deepEqual(r1, r1b, "rounds deterministic per day");
  assert.ok(r1.length >= 1 && r1.length <= 3, "1-3 rounds");
  assert.ok(r1.every((r) => r.patient && r.kind && r.type), "round shape");
  // Non-caregivers get no rounds
  const proHealer = findName((n) => HealersPro.isHealer({ username: n }), "ProH2");
  assert.deepEqual(H2.roundsFor(proHealer, "misthalin", d1), [], "pro healer has no rounds");
  console.log("rounds: PASS", `(${r1.length} rounds, day2 differs: ${JSON.stringify(r1) !== JSON.stringify(r2)})`);
}

// --- real-patient tie-in never throws ---
{
  const patients = H2.realPatientsFor("misthalin", T0);
  assert.ok(Array.isArray(patients), "returns an array");
  // Seed a fake ailment through the real module's seam and re-read
  const ailments = HealersPro._ailments;
  ailments.set("testpatient", { kind: "sick", since: T0, kingdomId: "misthalin" });
  try {
    const found = H2.realPatientsFor("misthalin", T0);
    assert.ok(found.some((p) => p.patient === "testpatient"), "real patient visible");
    const other = H2.realPatientsFor("asgarnia", T0);
    assert.ok(!other.some((p) => p.patient === "testpatient"), "kingdom filter works");
  } finally {
    ailments.delete("testpatient");
  }
  console.log("real-patient tie-in: PASS");
}

// --- remedy herb tie-in never throws ---
{
  const herb = H2.herbOfTheDay(T0);
  assert.ok(typeof herb === "string" && herb.length > 0, "herb name returned");
  const remedies = H2.remediesFor("Care1", T0);
  assert.equal(remedies.length, 2, "2 remedies");
  assert.ok(remedies.every((r) => r.includes(herb)), "remedies use herb of the day");
  const r2 = H2.remediesFor("Care1", T0);
  assert.deepEqual(remedies, r2, "remedies deterministic");
  const potion = H2.potionNameForSmallTalk("Care1", T0);
  assert.ok(typeof potion === "string" && potion.length > 0, "potion name for small talk");
  console.log("remedy tie-ins: PASS", `(${herb})`);
}

// --- recovery determinism ---
{
  const d1 = new Date(2026, 9, 8, 12, 0).getTime();
  const a = H2.recoveryFor("misthalin", d1);
  const b = H2.recoveryFor("misthalin", d1);
  assert.equal(a, b, "recovery deterministic per kingdom+day");
  console.log("recovery: PASS", `(today: ${a ?? "none"})`);
}

// --- ledgers: round-trip + TTL expiry ---
{
  H2._resetState();
  const now = T0;
  H2.requestCare("Jon", "a bad cough", now);
  assert.equal(H2.careFor("Jon", now), "a bad cough", "care request round-trips");
  H2.buyRemedy("Jon", "fever tea with chamomile", now);
  assert.equal(H2.remedyFor("Jon", now), "fever tea with chamomile", "remedy purchase round-trips");
  H2.learnFirstAid("Jon", now);
  assert.equal(H2.firstAidFor("Jon", now), true, "first-aid lesson recorded");
  assert.equal(H2.careFor("Nobody", now), null, "unknown player -> null");
  assert.equal(H2.requestCare("", "x", now), null, "empty name rejected");
  // TTL expiry
  const later = now + 8 * 24 * 3600 * 1000;
  assert.equal(H2.careFor("Jon", later), null, "care request expires");
  assert.equal(H2.remedyFor("Jon", later), null, "remedy purchase expires");
  assert.equal(H2.firstAidFor("Jon", later), false, "lesson expires");
  console.log("ledgers: PASS");
}

// --- care hours via local-time constructors (timezone rule) ---
{
  const morning = new Date(2026, 9, 8, 7, 59).getTime();
  const open = new Date(2026, 9, 8, 8, 0).getTime();
  const evening = new Date(2026, 9, 8, 19, 59).getTime();
  const night = new Date(2026, 9, 8, 20, 0).getTime();
  assert.equal(H2.isCareHour(morning), false, "07:59 closed");
  assert.equal(H2.isCareHour(open), true, "08:00 open");
  assert.equal(H2.isCareHour(evening), true, "19:59 open");
  assert.equal(H2.isCareHour(night), false, "20:00 closed");
  console.log("care hours: PASS");
}

// --- guards: isRealPlayer / isCitizenBot / withinTiles ---
{
  const real = mockPlayer("Jon", 3000, 3000, false);
  const bot = mockPlayer("Bot1", 3000, 3000, true);
  assert.equal(H2.isRealPlayer(real), true);
  assert.equal(H2.isRealPlayer(bot), false);
  assert.equal(H2.isRealPlayer(null), false);
  assert.equal(H2.isCitizenBot(bot), true);
  assert.equal(H2.isCitizenBot(real), false);
  assert.equal(H2.withinTiles(real, mockPlayer("X", 3005, 3005, false), 14), true);
  assert.equal(H2.withinTiles(real, mockPlayer("X", 3100, 3100, false), 14), false);
  console.log("guards: PASS");
}

// --- tick: fires near a real player, silent otherwise ---
{
  H2._resetState();
  const name = findName(
    (n) =>
      H2.caregiverTypeOf({ username: n, role: "commoner" }) !== null &&
      !HealersPro.isHealer({ username: n }) &&
      !HerbalistsPro.isHerbalist({ username: n }),
    "Tick"
  );
  const real = mockPlayer("Jon", 3002, 3002, false); // within 14 tiles of citizen at 3000,3000
  const noon = new Date(2026, 9, 8, 12, 0).getTime();

  // Fires near a real player
  const d1 = mockDirector([name], { players: [real] });
  withFixedRandom(0.05, () => H2.tickCaregivers(d1, noon)); // 0.05 < CARE_CHANCE 0.15
  const citizen = d1.playerFor({ username: name });
  assert.ok(citizen._chats.length >= 1, "caregiver speaks near a real player");

  // Silent near bots only
  H2._resetState();
  const botOnly = mockPlayer("Bot2", 3002, 3002, true);
  const d2 = mockDirector([name], { players: [botOnly] });
  withFixedRandom(0.05, () => H2.tickCaregivers(d2, noon));
  assert.equal(d2.playerFor({ username: name })._chats.length, 0, "silent near bots only");

  // Silent outside care hours
  H2._resetState();
  const night = new Date(2026, 9, 8, 3, 0).getTime();
  const d3 = mockDirector([name], { players: [real] });
  withFixedRandom(0.05, () => H2.tickCaregivers(d3, night));
  assert.equal(d3.playerFor({ username: name })._chats.length, 0, "silent at 03:00");

  // Non-caregivers are skipped
  H2._resetState();
  const proHealer = findName((n) => HealersPro.isHealer({ username: n }), "ProH3");
  const d4 = mockDirector([proHealer], { players: [real] });
  withFixedRandom(0.05, () => H2.tickCaregivers(d4, noon));
  assert.equal(d4.playerFor({ username: proHealer })._chats.length, 0, "pro healer skipped");
  console.log("tick gating: PASS");
}

// --- never throws on hostile input ---
{
  H2._resetState();
  assert.doesNotThrow(() => H2.tickCaregivers(null, T0), "null director");
  assert.doesNotThrow(() => H2.tickCaregivers({}, T0), "empty director");
  assert.doesNotThrow(() => H2.caregiverTypeOf(undefined), "undefined record");
  assert.doesNotThrow(() => H2.roundsFor(null, null, NaN), "bad rounds input");
  console.log("never-throws: PASS");
}

// --- fill / hash helpers ---
{
  assert.equal(H2.fill("Hello {name}, take this {item}.", { name: "Jon", item: "tea" }), "Hello Jon, take this tea.");
  assert.equal(H2.fill("No slots.", {}), "No slots.");
  assert.equal(H2.hashStr("abc"), H2.hashStr("abc"), "hash stable");
  console.log("helpers: PASS");
}

console.log("ALL CITIZENHEALERS2 TESTS PASSED");
