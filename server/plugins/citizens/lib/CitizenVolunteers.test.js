// CitizenVolunteers unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const V = require("./CitizenVolunteers");

// Deterministic LCG — coverage is exact, not luck-based.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Local-time constructor per the timezone rule (PC runs on EDT, UTC-4).
function localDay(hour = 12, min = 0) {
  return new Date(2026, 9, 8, hour, min).getTime();
}

let passed = 0;
function check(name, fn) {
  V._resetState();
  fn();
  passed++;
  console.log("ok -", name);
}

// --- hashing ---
check("hashStr is stable and varies", () => {
  assert.equal(V.hashStr("Alice"), V.hashStr("Alice"));
  assert.notEqual(V.hashStr("Alice"), V.hashStr("Bob"));
});

// --- type assignment ---
check("volunteerTypeOf returns one of the four types for commoners", () => {
  const t = V.volunteerTypeOf({ username: "TestVolunteerOne", role: "commoner" });
  assert.ok(V.VOLUNTEER_TYPES.includes(t), "got " + t);
});

check("volunteerTypeOf is stable across restarts", () => {
  const a = V.volunteerTypeOf({ username: "StableName", role: "commoner" });
  const b = V.volunteerTypeOf({ username: "StableName", role: "commoner" });
  assert.equal(a, b);
});

check("volunteerTypeOf rejects non-commoners", () => {
  assert.equal(V.volunteerTypeOf({ username: "GuardBob", role: "guard" }), null);
});

check("volunteerTypeOf rejects empty usernames", () => {
  assert.equal(V.volunteerTypeOf({ username: "", role: "commoner" }), null);
});

check("volunteerTypeFromRoll covers all four types", () => {
  const seen = new Set();
  for (let r = 0; r < 100; r++) seen.add(V.volunteerTypeFromRoll(r));
  assert.equal(seen.size, 4);
});

check("no professional exclusions — broad distribution like other activity systems", () => {
  let count = 0;
  for (let i = 0; i < 2000; i++) {
    if (V.volunteerTypeOf({ username: "citizen" + i, role: "commoner" })) count++;
  }
  // ~100% of names (no exclusions), well above the saturated professional chain
  assert.ok(count > 1900, "only " + count + "/2000 — exclusions leaked in?");
});

// --- service areas ---
check("areaFor prefers the citizen's kingdom", () => {
  const a = V.areaFor({ username: "AreaTest", kingdomId: "misthalin" });
  assert.equal(a.kingdom, "misthalin");
});

// --- charity drives ---
check("driveForKingdom is stable within a week", () => {
  const t1 = localDay(10);
  const d1 = V.driveForKingdom("misthalin", t1);
  const d2 = V.driveForKingdom("misthalin", t1 + 2 * 86400000);
  assert.deepEqual(d1, d2);
});

check("driveForKingdom returns a known drive kind or null", () => {
  const d = V.driveForKingdom("asgarnia", localDay(10));
  if (d) {
    assert.ok(V.DRIVE_KINDS.some((k) => k.id === d.id), "unknown drive " + d.id);
    assert.ok(d.label && d.need);
  }
});

// --- shifts ---
check("shiftFor is deterministic per day", () => {
  const s1 = V.shiftFor("ShiftName", "misthalin", localDay(9));
  const s2 = V.shiftFor("ShiftName", "misthalin", localDay(14));
  assert.deepEqual(s1, s2);
  assert.ok(s1.area && s1.task && s1.type);
});

// --- good deeds ---
check("deedFor is stable within a day", () => {
  const t = localDay(10);
  assert.equal(V.deedFor("DeedName", t), V.deedFor("DeedName", t + 3600000));
});

check("deedFor rejects empty usernames", () => {
  assert.equal(V.deedFor("", localDay(10)), null);
});

// --- service hours (local-time constructors per timezone rule) ---
check("isServiceHour true midday, false at night", () => {
  assert.equal(V.isServiceHour(localDay(10)), true);
  assert.equal(V.isServiceHour(localDay(22)), false);
  assert.equal(V.isServiceHour(localDay(3)), false);
});

// --- ledgers ---
check("signUpFor / signupFor round-trip", () => {
  const t = localDay(10);
  assert.equal(V.signupFor("PlayerOne", t), null);
  V.signUpFor("PlayerOne", "the Varrock market square", t);
  assert.equal(V.signupFor("PlayerOne", t), "the Varrock market square");
});

check("donateTo / donationFor round-trip", () => {
  const t = localDay(10);
  assert.equal(V.donationFor("PlayerTwo", t), null);
  V.donateTo("PlayerTwo", "food-drive", 500, t);
  assert.deepEqual(V.donationFor("PlayerTwo", t), { kind: "food-drive", amount: 500 });
});

check("organizeDrive / driveFor round-trip", () => {
  const t = localDay(10);
  assert.equal(V.driveFor("PlayerThree", t), null);
  V.organizeDrive("PlayerThree", "book drive", "the Lumbridge riverside", t);
  assert.deepEqual(V.driveFor("PlayerThree", t), {
    drive: "book drive",
    area: "the Lumbridge riverside",
  });
});

check("ledger entries expire after TTL", () => {
  const t = localDay(10);
  V.signUpFor("PlayerTTL", "somewhere", t);
  // TTL is 7 days; 8 days later it must be gone (prune also rate-limited, so
  // bump lastLedgerPrune via _resetState semantics: use a far-future time).
  assert.equal(V.signupFor("PlayerTTL", t + 8 * 86400000), null);
});

// --- festival tie-in ---
check("isFestivalNow returns a boolean and never throws", () => {
  const r = V.isFestivalNow(localDay(10));
  assert.equal(typeof r, "boolean");
});

// --- helpers ---
check("fill replaces all slots", () => {
  assert.equal(V.fill("{a} and {a} plus {b}", { a: "x", b: "y" }), "x and x plus y");
});

check("pickOne is deterministic with injected rng", () => {
  const arr = ["a", "b", "c"];
  assert.equal(V.pickOne(lcg(42), arr), V.pickOne(lcg(42), arr));
});

check("isRealPlayer / isCitizenBot / withinTiles guards", () => {
  const real = { getUsername: () => "Jon", getHostAddress: () => "1.2.3.4" };
  const bot = { getUsername: () => "bot1", isPlayerBot: () => true };
  assert.equal(V.isRealPlayer(real), true);
  assert.equal(V.isRealPlayer(bot), false);
  assert.equal(V.isRealPlayer(null), false);
  assert.equal(V.isCitizenBot(bot), true);
  assert.equal(V.isCitizenBot(real), false);
  const mk = (x, y, z) => ({
    getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => z }),
  });
  assert.equal(V.withinTiles(mk(0, 0, 0), mk(10, 10, 0), 14), true);
  assert.equal(V.withinTiles(mk(0, 0, 0), mk(20, 0, 0), 14), false);
  assert.equal(V.withinTiles(mk(0, 0, 0), mk(0, 0, 1), 14), false);
});

check("dayNumber / weekNumber are monotonic", () => {
  const t = localDay(10);
  assert.ok(V.dayNumber(t + 86400000) === V.dayNumber(t) + 1);
  assert.ok(V.weekNumber(t + 7 * 86400000) === V.weekNumber(t) + 1);
});

// --- tick behavior ---
function mockDirector({ citizens = [], online = [] } = {}) {
  const roster = new Map();
  const players = new Map();
  for (const c of citizens) {
    roster.set(c.username, c.rec);
    players.set(c.username, c.player);
  }
  return {
    roster,
    playerFor: (rec) => players.get(rec.username) ?? null,
    onlinePlayers: () => online,
  };
}

function mockCitizen(x, y) {
  return {
    getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => 0 }),
    forceChat: function (line) {
      this._said = this._said || [];
      this._said.push(line);
    },
  };
}

function mockRealPlayer(x, y) {
  return {
    getUsername: () => "RealJon",
    getHostAddress: () => "9.9.9.9",
    getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => 0 }),
  };
}

check("tick fires near a real player during service hours", () => {
  // Find a deterministic volunteer name.
  let uname = null;
  for (let i = 0; i < 500 && !uname; i++) {
    const n = "vol" + i;
    if (V.volunteerTypeOf({ username: n, role: "commoner" }) === V.VOLUNTEER_CLEANER) uname = n;
  }
  assert.ok(uname, "no deterministic cleaner found");
  const cit = mockCitizen(100, 100);
  const director = mockDirector({
    citizens: [{ username: uname, rec: { username: uname, role: "commoner", kingdomId: "misthalin" }, player: cit }],
    online: [mockRealPlayer(105, 105)],
  });
  const t = localDay(10); // 10:00 service hours
  // Force the chance gate by stubbing Math.random temporarily.
  const orig = Math.random;
  Math.random = () => 0.01;
  try {
    V.tickVolunteers(director, t);
  } finally {
    Math.random = orig;
  }
  assert.ok(cit._said && cit._said.length > 0, "volunteer said nothing");
});

check("tick is silent near bots only", () => {
  const cit = mockCitizen(100, 100);
  const director = mockDirector({
    citizens: [{ username: "volA", rec: { username: "volA", role: "commoner", kingdomId: "misthalin" }, player: cit }],
    online: [{ getUsername: () => "bot1", isPlayerBot: () => true }],
  });
  V.tickVolunteers(director, localDay(10));
  assert.ok(!cit._said || cit._said.length === 0, "volunteer spoke with only bots near");
});

check("tick is silent outside service hours", () => {
  const cit = mockCitizen(100, 100);
  const director = mockDirector({
    citizens: [{ username: "volB", rec: { username: "volB", role: "commoner", kingdomId: "misthalin" }, player: cit }],
    online: [mockRealPlayer(105, 105)],
  });
  V.tickVolunteers(director, localDay(23)); // 23:00 — closed
  assert.ok(!cit._said || cit._said.length === 0, "volunteer spoke at night");
});

check("tick never throws on hostile input", () => {
  V.tickVolunteers(null, localDay(10));
  V.tickVolunteers({}, localDay(10));
  V.tickVolunteers({ roster: { values: () => { throw new Error("boom"); } } }, localDay(10));
});

check("thankDonor renders a line with the donor name", () => {
  const cit = mockCitizen(0, 0);
  const line = V.thankDonor(cit, "GenerousGus");
  assert.ok(line && line.includes("GenerousGus"), "line missing donor: " + line);
  assert.ok(cit._said && cit._said.length === 1);
});

console.log("\nAll " + passed + " checks passed.");
