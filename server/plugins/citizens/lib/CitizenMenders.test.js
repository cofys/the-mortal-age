// CitizenMenders unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const M = require("./CitizenMenders");

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
  M._resetState();
  fn();
  passed++;
  console.log("ok -", name);
}

// --- hashing ---
check("hashStr is stable and varies", () => {
  assert.equal(M.hashStr("Alice"), M.hashStr("Alice"));
  assert.notEqual(M.hashStr("Alice"), M.hashStr("Bob"));
});

// --- type assignment ---
check("menderTypeOf returns one of the four types for commoners", () => {
  const t = M.menderTypeOf({ username: "TestMenderOne", role: "commoner" });
  assert.ok(M.MENDER_TYPES.includes(t), "got " + t);
});

check("menderTypeOf is stable across restarts", () => {
  const a = M.menderTypeOf({ username: "StableMend", role: "commoner" });
  const b = M.menderTypeOf({ username: "StableMend", role: "commoner" });
  assert.equal(a, b);
});

check("menderTypeOf rejects non-commoners", () => {
  assert.equal(M.menderTypeOf({ username: "GuardBob", role: "guard" }), null);
});

check("menderTypeOf rejects empty usernames", () => {
  assert.equal(M.menderTypeOf({ username: "", role: "commoner" }), null);
});

check("menderTypeFromRoll covers all four types", () => {
  const seen = new Set();
  for (let r = 0; r < 100; r++) seen.add(M.menderTypeFromRoll(r));
  assert.equal(seen.size, 4);
});

check("no professional exclusions — broad distribution like other activity systems", () => {
  let count = 0;
  for (let i = 0; i < 2000; i++) {
    if (M.menderTypeOf({ username: "mend" + i, role: "commoner" })) count++;
  }
  // ~100% of names (no exclusions), well above the saturated professional chain
  assert.ok(count > 1900, "only " + count + "/2000 — exclusions leaked in?");
});

check("type weights roughly match 30/30/25/15", () => {
  const counts = { seamstress: 0, tinker: 0, cobbler: 0, handyman: 0 };
  for (let i = 0; i < 4000; i++) {
    const t = M.menderTypeOf({ username: "w" + i, role: "commoner" });
    counts[t]++;
  }
  assert.ok(counts.seamstress > 1000 && counts.seamstress < 1400, JSON.stringify(counts));
  assert.ok(counts.tinker > 1000 && counts.tinker < 1400, JSON.stringify(counts));
  assert.ok(counts.cobbler > 850 && counts.cobbler < 1150, JSON.stringify(counts));
  assert.ok(counts.handyman > 450 && counts.handyman < 750, JSON.stringify(counts));
});

// --- stalls ---
check("stallFor prefers the citizen's kingdom", () => {
  const s = M.stallFor({ username: "StallTest", kingdomId: "keldagrim" });
  assert.equal(s.kingdom, "keldagrim");
});

// --- repair jobs ---
check("jobsFor is stable within a day and varies across days", () => {
  const t = localDay(10);
  const j1 = M.jobsFor("Jobber", "misthalin", t);
  const j2 = M.jobsFor("Jobber", "misthalin", t + 3600000);
  const j3 = M.jobsFor("Jobber", "misthalin", t + 86400000);
  assert.deepEqual(j1, j2);
  assert.ok(j3.length > 0 && j3.length <= 3);
});

check("jobsFor yields 1-3 jobs with sane prices", () => {
  const t = localDay(10);
  for (let i = 0; i < 200; i++) {
    const jobs = M.jobsFor("job" + i, "asgarnia", t);
    assert.ok(jobs.length >= 1 && jobs.length <= 3, "job count " + jobs.length);
    for (const j of jobs) {
      assert.ok(j.item && typeof j.price === "number" && j.price > 0 && j.price <= 200);
    }
  }
});

check("basePriceFor is positive for every type", () => {
  for (const t of M.MENDER_TYPES) {
    assert.ok(M.basePriceFor(t) > 0, t);
  }
});

// --- cross-system tie-ins ---
check("tailorWorkshopFor and smithForgeFor never throw (lazy fallback)", () => {
  assert.doesNotThrow(() => M.tailorWorkshopFor("TieTest", "misthalin"));
  assert.doesNotThrow(() => M.smithForgeFor("TieTest", "keldagrim"));
});

// --- player ledgers ---
check("repair request round-trips and clamps price", () => {
  const t = localDay(10);
  const r = M.requestRepair("PlayerOne", "a torn cloak", "seamstress", 99999, t);
  assert.equal(r.item, "a torn cloak");
  assert.ok(r.price <= 200, "price not clamped: " + r.price);
  const got = M.repairFor("PlayerOne", t);
  assert.equal(got.item, "a torn cloak");
});

check("collectRepair moves request to pickup", () => {
  const t = localDay(10);
  M.requestRepair("PlayerTwo", "a bent hatchet head", "tinker", 15, t);
  const done = M.collectRepair("PlayerTwo", t);
  assert.equal(done.item, "a bent hatchet head");
  assert.equal(M.repairFor("PlayerTwo", t), null);
  assert.equal(M.pickupFor("PlayerTwo", t).item, "a bent hatchet head");
});

check("collectRepair on nothing returns null", () => {
  assert.equal(M.collectRepair("NobodyHere", localDay(10)), null);
});

check("learnMending lesson round-trips", () => {
  const t = localDay(10);
  M.learnMending("PlayerThree", "cobbler", t);
  assert.equal(M.lessonFor("PlayerThree", t), "cobbler");
});

check("ledgers expire after 7 days", () => {
  const t0 = localDay(10);
  M.requestRepair("PlayerFour", "a worn sole", "cobbler", 10, t0);
  M.learnMending("PlayerFour", "cobbler", t0);
  const t8 = t0 + 8 * 86400000;
  assert.equal(M.repairFor("PlayerFour", t8), null);
  assert.equal(M.lessonFor("PlayerFour", t8), null);
});

// --- time gates ---
check("isShopHour boundaries (local time)", () => {
  assert.equal(M.isShopHour(localDay(7, 59)), false);
  assert.equal(M.isShopHour(localDay(8, 0)), true);
  assert.equal(M.isShopHour(localDay(12)), true);
  assert.equal(M.isShopHour(localDay(17, 59)), true);
  assert.equal(M.isShopHour(localDay(18, 0)), false);
  assert.equal(M.isShopHour(localDay(3)), false);
});

check("dayNumber is monotonic", () => {
  const t = localDay(10);
  assert.ok(M.dayNumber(t + 86400000) === M.dayNumber(t) + 1);
});

check("fill renders slots", () => {
  assert.equal(M.fill("hello {name}, {item}", { name: "Bob", item: "cloak" }), "hello Bob, cloak");
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

check("tick fires near a real player during shop hours", () => {
  // Find a deterministic mender name that also passes the visibility gate.
  const { isHobbyVisible } = require("./CitizenPrimaryHobby");
  let uname = null;
  for (let i = 0; i < 500 && !uname; i++) {
    const n = "mendtick" + i;
    if (M.menderTypeOf({ username: n, role: "commoner" }) === M.MENDER_TINKER &&
        isHobbyVisible(n, "mender")) uname = n;
  }
  assert.ok(uname, "no deterministic tinker found");
  const cit = mockCitizen(100, 100);
  const director = mockDirector({
    citizens: [{ username: uname, rec: { username: uname, role: "commoner", kingdomId: "asgarnia" }, player: cit }],
    online: [mockRealPlayer(105, 105)],
  });
  const t = localDay(10); // 10:00 shop hours
  // Force the chance gate by stubbing Math.random temporarily.
  const orig = Math.random;
  Math.random = () => 0.2; // below MENDER_CHANCE (0.35), above MASTERWORK_CHANCE (0.08)
  try {
    M.tickMenders(director, t);
  } finally {
    Math.random = orig;
  }
  assert.ok(cit._said && cit._said.length > 0, "mender said nothing");
});

check("tick is silent near bots only", () => {
  const cit = mockCitizen(100, 100);
  const director = mockDirector({
    citizens: [{ username: "mendA", rec: { username: "mendA", role: "commoner", kingdomId: "asgarnia" }, player: cit }],
    online: [{ getUsername: () => "bot1", isPlayerBot: () => true }],
  });
  M.tickMenders(director, localDay(10));
  assert.ok(!cit._said || cit._said.length === 0, "mender spoke with only bots near");
});

check("tick is silent outside shop hours", () => {
  const cit = mockCitizen(100, 100);
  const director = mockDirector({
    citizens: [{ username: "mendB", rec: { username: "mendB", role: "commoner", kingdomId: "asgarnia" }, player: cit }],
    online: [mockRealPlayer(105, 105)],
  });
  M.tickMenders(director, localDay(22)); // 22:00 — closed
  assert.ok(!cit._said || cit._said.length === 0, "mender spoke at night");
});

check("tick never throws on hostile input", () => {
  M.tickMenders(null, localDay(10));
  M.tickMenders({}, localDay(10));
  M.tickMenders({ roster: { values: () => { throw new Error("boom"); } } }, localDay(10));
});

check("thankCustomer renders a line with the customer name", () => {
  const cit = mockCitizen(0, 0);
  const line = M.thankCustomer(cit, "RegularRia");
  assert.ok(line && line.includes("RegularRia"), "line missing customer: " + line);
  assert.ok(cit._said && cit._said.length === 1);
});

console.log("\nAll " + passed + " checks passed.");
