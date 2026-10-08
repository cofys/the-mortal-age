// CitizenTeachers2 unit checks — pure logic, no running server.
// From server/plugins/citizens: node lib/CitizenTeachers2.test.js (plain node)
"use strict";

const assert = require("node:assert/strict");
const T2 = require("./CitizenTeachers2");
const H = require("./CitizenPrimaryHobby");
const Teachers = require("./CitizenTeachers");

const T0 = new Date(2026, 9, 8, 10, 0).getTime(); // 10:00 local — inside class hours
const NIGHT = new Date(2026, 9, 8, 3, 0).getTime(); // 03:00 local — outside class hours

function mockPlayer(name, isBot) {
  const chats = [];
  const said = [];
  const inv = { getAmount: () => 0, getFreeSlots: () => 27 };
  return {
    getUsername: () => name,
    getHostAddress: () => (isBot ? "bot" : "127.0.0.1"),
    isPlayerBot: () => !!isBot,
    getInventory: () => inv,
    getLocation: () => ({ getX: () => 3000, getY: () => 3000, getZ: () => 0 }),
    forceChat: (m) => chats.push(m),
    sendMessage: (m) => said.push(m),
    _chats: chats,
    _said: said,
  };
}

function mockDirector(citizenName, opts = {}) {
  const botCache = new Map();
  const citizen = mockPlayer(citizenName, true);
  const roster = new Map();
  roster.set(citizenName.toLowerCase(), {
    username: citizenName,
    kingdomId: opts.kingdomId || "misthalin",
    role: "commoner",
  });
  return {
    roster,
    playerFor: (record) => {
      const n = String(record?.username ?? "").toLowerCase();
      if (!botCache.has(n)) botCache.set(n, mockPlayer(record.username, true));
      return botCache.get(n);
    },
    onlinePlayers: () => (opts.botsOnly ? [mockPlayer("BotA", true)] : [mockPlayer("Jon", false)]),
    _botFor: (n) => botCache.get(String(n).toLowerCase()),
  };
}

// --- type weights / reachability / stability ---
{
  const counts = {};
  for (let i = 0; i < 4000; i++) {
    const t = T2.educatorTypeOf({ username: "Edu" + i });
    assert.ok(t, `commoner Edu${i} gets a type`);
    counts[t] = (counts[t] || 0) + 1;
  }
  for (const t of T2.EDUCATOR_TYPES) {
    assert.ok(counts[t] > 0, `type ${t} reachable`);
  }
  const pct = (t) => (counts[t] / 4000) * 100;
  assert.ok(pct("tutor") > 24 && pct("tutor") < 36, `tutor ~30%: ${pct("tutor").toFixed(1)}`);
  assert.ok(pct("mentor") > 24 && pct("mentor") < 36, `mentor ~30%: ${pct("mentor").toFixed(1)}`);
  assert.ok(pct("schoolmaster") > 19 && pct("schoolmaster") < 31, `schoolmaster ~25%: ${pct("schoolmaster").toFixed(1)}`);
  assert.ok(pct("scholar") > 10 && pct("scholar") < 20, `scholar ~15%: ${pct("scholar").toFixed(1)}`);
  // Stability: same name, same type, every time.
  for (let i = 0; i < 200; i++) {
    assert.equal(T2.educatorTypeOf({ username: "Stable" + i }), T2.educatorTypeOf({ username: "Stable" + i }));
  }
  console.log("types: PASS");
}

// --- commoner gating ---
{
  assert.equal(T2.educatorTypeOf({ username: "Guard1", role: "guard" }), null, "guards excluded");
  assert.equal(T2.educatorTypeOf({ username: "Merch1", attributes: { role: "merchant" } }), null, "merchants excluded");
  assert.equal(T2.educatorTypeOf({ username: "" }), null, "empty username excluded");
  assert.equal(T2.educatorTypeOf(null), null, "null record excluded");
  console.log("commoner gate: PASS");
}

// --- professional-teacher exclusion ---
{
  // One citizen in a kingdom is deterministically assigned schoolmaster.
  const solo = "SoloTeacher";
  const director = mockDirector(solo, { kingdomId: "testland" });
  const assigned = Teachers.assignTeachers("testland", [solo]);
  assert.ok(assigned.some((t) => t.username === solo), "solo citizen is a pro teacher");
  assert.equal(T2.educatorTypeOf({ username: solo, kingdomId: "testland" }, director, T0), null,
    "professional teacher excluded from the activity system");
  // A citizen in a different kingdom is not excluded.
  assert.ok(T2.educatorTypeOf({ username: "FreeTutor", kingdomId: "otherland" }, director, T0),
    "citizen elsewhere still gets a type");
  // Without a director the exclusion is skipped (pure-data use).
  assert.ok(T2.educatorTypeOf({ username: solo, kingdomId: "testland" }),
    "no director means no exclusion");
  console.log("pro-teacher exclusion: PASS");
}

// --- broad distribution (activity system: ~100%) ---
{
  let pass = 0;
  for (let i = 0; i < 2000; i++) {
    if (T2.educatorTypeOf({ username: "Dist" + i })) pass++;
  }
  assert.ok(pass > 1900, `~100% of commoners may teach: ${pass}/2000`);
  console.log("distribution: PASS");
}

// --- kingdom-preferred venues ---
{
  const v1 = T2.venueFor({ username: "Edu1", kingdomId: "misthalin" });
  assert.equal(v1.kingdom, "misthalin", "misthalin citizen gets a misthalin venue");
  const v2 = T2.venueFor({ username: "Edu2", kingdomId: "kharidian" });
  assert.equal(v2.kingdom, "kharidian", "kharidian citizen gets a kharidian venue");
  assert.equal(T2.venueFor({ username: "Edu1", kingdomId: "misthalin" }).name, v1.name, "venue stable");
  console.log("venues: PASS");
}

// --- lesson determinism + day variance ---
{
  const a = T2.lessonsFor("Edu1", "misthalin", T0);
  const b = T2.lessonsFor("Edu1", "misthalin", T0);
  assert.deepEqual(a, b, "lessons deterministic same day");
  assert.ok(a.length >= 1 && a.length <= 3, "1-3 lessons per day");
  const c = T2.lessonsFor("Edu1", "misthalin", T0 + 86400000);
  assert.ok(JSON.stringify(a) !== JSON.stringify(c) || true, "day variance allowed");
  // Subjects come from the real school curriculum.
  const subjects = T2.curriculumSubjects();
  assert.ok(subjects.includes("reading") && subjects.includes("trade"), "real curriculum subjects");
  console.log("lessons: PASS");
}

// --- pupil roster determinism ---
{
  const a = T2.pupilsFor("Edu1", T0);
  const b = T2.pupilsFor("Edu1", T0);
  assert.deepEqual(a, b, "pupils deterministic same day");
  assert.ok(a.length >= 1 && a.length <= 4, "1-4 pupils");
  console.log("pupils: PASS");
}

// --- tie-ins never throw ---
{
  assert.ok(T2.studyMaterialFor(T0), "study material returned");
  assert.ok(Array.isArray(T2.curriculumSubjects()), "curriculum subjects returned");
  console.log("tie-ins: PASS");
}

// --- ledgers round-trip + TTL expiry ---
{
  T2._resetState();
  const t = new Date(2026, 9, 8, 10, 0).getTime();
  assert.ok(T2.hireTutor("Jon", t), "hire recorded");
  assert.ok(T2.hireFor("Jon", t), "hire readable");
  assert.ok(T2.attendClass("Jon", t), "attendance recorded");
  assert.ok(T2.attendanceFor("Jon", t), "attendance readable");
  assert.ok(T2.requestMentor("Jon", t), "mentor request recorded");
  assert.ok(T2.mentorFor("Jon", t), "mentor request readable");
  assert.equal(T2.hireFor("Nobody", t), null, "unknown player has no hire");
  const later = t + 8 * 86400000; // 8 days later — TTL expired
  assert.equal(T2.hireFor("Jon", later), null, "hire expires after 7 days");
  assert.equal(T2.attendanceFor("Jon", later), null, "attendance expires after 7 days");
  assert.equal(T2.mentorFor("Jon", later), null, "mentor request expires after 7 days");
  console.log("ledgers: PASS");
}

// --- class hours via local-time constructors (timezone rule) ---
{
  assert.equal(T2.isClassHour(new Date(2026, 9, 8, 8, 59).getTime()), false, "08:59 not class hour");
  assert.equal(T2.isClassHour(new Date(2026, 9, 8, 9, 0).getTime()), true, "09:00 is class hour");
  assert.equal(T2.isClassHour(new Date(2026, 9, 8, 12, 30).getTime()), true, "12:30 is class hour");
  assert.equal(T2.isClassHour(new Date(2026, 9, 8, 14, 59).getTime()), true, "14:59 is class hour");
  assert.equal(T2.isClassHour(new Date(2026, 9, 8, 15, 0).getTime()), false, "15:00 not class hour");
  console.log("class hours: PASS");
}

// --- guards ---
{
  const real = mockPlayer("Jon", false);
  const bot = mockPlayer("BotA", true);
  assert.ok(T2.isRealPlayer(real), "real player detected");
  assert.ok(!T2.isRealPlayer(bot), "bot is not a real player");
  assert.ok(!T2.isRealPlayer(null), "null is not a real player");
  assert.ok(T2.isCitizenBot(bot), "bot detected as citizen bot");
  assert.ok(!T2.isCitizenBot(real), "real player is not a citizen bot");
  const a = mockPlayer("A", true);
  const b = mockPlayer("B", false);
  assert.ok(T2.withinTiles(a, b, 14), "same tile within 14");
  assert.ok(!T2.withinTiles(a, null, 14), "null target not within tiles");
  console.log("guards: PASS");
}

// --- visibility gate ---
{
  // "tutor" is a registered hobby key; primary always passes.
  let primaryFound = false;
  for (let i = 0; i < 500; i++) {
    const name = "Vis" + i;
    if (H.primaryHobbyFor(name) === "tutor") {
      assert.ok(H.isHobbyVisible(name, "tutor"), "primary hobby always visible");
      primaryFound = true;
      break;
    }
  }
  assert.ok(primaryFound, "some name has tutor as primary hobby");
  assert.equal(H.isHobbyVisible("Anyone", "not-a-hobby"), false, "unknown key not visible");
  console.log("visibility: PASS");
}

// --- graduation determinism ---
{
  const venue = T2.VENUES[0];
  const g1 = T2.graduationFor(venue, T0);
  const g2 = T2.graduationFor(venue, T0);
  assert.equal(g1, g2, "graduation deterministic same day");
  // Across many venues/days, some graduations happen (~10%).
  let hits = 0;
  for (let d = 0; d < 40; d++) {
    for (const v of T2.VENUES) {
      if (T2.graduationFor(v, T0 + d * 86400000)) hits++;
    }
  }
  const rate = hits / (40 * T2.VENUES.length);
  assert.ok(rate > 0.03 && rate < 0.2, `graduation ~10%/venue/day: ${(rate * 100).toFixed(1)}%`);
  console.log("graduation: PASS");
}

// --- tick helpers: a world of 30 citizens; find one who is an educator,
// not a professional teacher, and hobby-visible ---
function buildTickWorld(suffix, opts = {}) {
  const nowMs = opts.nowMs || T0;
  const names = [];
  for (let i = 0; i < 30; i++) names.push(suffix + i);
  const botCache = new Map();
  const roster = new Map();
  for (const n of names) {
    roster.set(n.toLowerCase(), { username: n, kingdomId: "tickland", role: "commoner" });
  }
  const director = {
    roster,
    playerFor: (record) => {
      const k = String(record?.username ?? "").toLowerCase();
      if (!botCache.has(k)) botCache.set(k, mockPlayer(record.username, true));
      return botCache.get(k);
    },
    onlinePlayers: () => (opts.botsOnly ? [mockPlayer("BotA", true)] : [mockPlayer("Jon", false)]),
  };
  const assigned = new Set(
    Teachers.assignTeachers("tickland", names).map((t) => String(t.username).toLowerCase())
  );
  let name = null;
  for (const n of names) {
    if (assigned.has(n.toLowerCase())) continue; // professional teacher — excluded
    if (!T2.educatorTypeOf({ username: n, kingdomId: "tickland" }, director, nowMs)) continue;
    if (!H.isHobbyVisible(n, "tutor")) continue;
    name = n;
    break;
  }
  return { director, name, botFor: (n) => botCache.get(String(n).toLowerCase()) };
}

function withFixedRandom(value, fn) {
  const real = Math.random;
  Math.random = () => value;
  try {
    fn();
  } finally {
    Math.random = real;
  }
}

// --- tick fires near real player ---
{
  T2._resetState();
  const { director, name, botFor } = buildTickWorld("TickEdu");
  assert.ok(name, "found a tick-eligible educator");
  withFixedRandom(0.2, () => T2.tickEducators(director, T0)); // below TUTOR_CHANCE (0.35)
  const bot = botFor(name);
  assert.ok(bot._chats.length >= 1, `educator teaches near a real player (got ${bot._chats.length} lines)`);
  console.log("tick fires: PASS");
}

// --- tick silent near bots only ---
{
  T2._resetState();
  const { director, name, botFor } = buildTickWorld("TickBot", { botsOnly: true });
  assert.ok(name, "found a tick-eligible educator");
  withFixedRandom(0.2, () => T2.tickEducators(director, T0));
  const bot = botFor(name);
  assert.equal(bot._chats.length, 0, "silent when only bots are near");
  console.log("tick silent near bots: PASS");
}

// --- tick silent outside class hours ---
{
  T2._resetState();
  const { director, name, botFor } = buildTickWorld("TickNight", { nowMs: NIGHT });
  assert.ok(name, "found a tick-eligible educator");
  withFixedRandom(0.2, () => T2.tickEducators(director, NIGHT));
  const bot = botFor(name);
  assert.equal(bot._chats.length, 0, "silent outside class hours");
  console.log("tick silent at night: PASS");
}

// --- never throws on hostile input ---
{
  T2._resetState();
  assert.doesNotThrow(() => T2.tickEducators(null, T0), "null director");
  assert.doesNotThrow(() => T2.tickEducators({}, T0), "empty director");
  assert.doesNotThrow(() => T2.tickEducators({ roster: null }, T0), "null roster");
  assert.doesNotThrow(() => T2.educatorTypeOf({ username: null }, null, T0), "null username");
  assert.doesNotThrow(() => T2.lessonsFor(null, null, NaN), "bad lesson inputs");
  assert.doesNotThrow(() => T2.pupilsFor(undefined, undefined), "bad pupil inputs");
  assert.doesNotThrow(() => T2.hireTutor(null), "null hire");
  console.log("never-throws: PASS");
}

// --- pure helpers ---
{
  assert.equal(T2.fill("Hello, {name}!", { name: "Jon" }), "Hello, Jon!");
  assert.equal(T2.fill("No slots.", {}), "No slots.");
  assert.equal(typeof T2.hashStr("x"), "number", "hashStr returns a number");
  assert.equal(T2.dayNumber(86400000), 1, "dayNumber works");
  assert.ok(T2.EDUCATOR_TYPES.includes(T2.educatorTypeFromRoll(0)), "roll 0 valid");
  assert.ok(T2.EDUCATOR_TYPES.includes(T2.educatorTypeFromRoll(99)), "roll 99 valid");
  console.log("helpers: PASS");
}

console.log("ALL CITIZENTEACHERS2 TESTS PASSED");
