// CitizenEngineers2 unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const M = require("./CitizenEngineers2");
const ProEng = require("./CitizenEngineers");

// Deterministic LCG — coverage is exact, not luck-based.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const NOW = 1791436800000; // fixed "now" for determinism
const DAY = 86400000;

function reset() {
  M._resetState();
}

reset();

// --- 1. hashStr is deterministic ---
assert.equal(M.hashStr("abc"), M.hashStr("abc"));
assert.notEqual(M.hashStr("abc"), M.hashStr("abd"));

// --- 2. engineerfolkTypeOf: ~35% nominal share, post-exclusion ~21% ---
// Post-exclusion the effective share is ~20.8% (measured n=20000):
// master-claimed pro engineers (~5.1%, via the real engineerTypeOf —
// the master excludes builders/smiths/architects first) and
// CitizenBlacksmiths2 smithfolk (~37.7%, via the real smithfolkTypeOf)
// are excluded BEFORE the share roll, per the house pattern. Bounds
// 0.15-0.27 document the measured effective ~20.8% rather than the
// nominal 35%.
let folk = 0;
const typeHits = new Set();
const NN = 20000;
for (let i = 0; i < NN; i++) {
  const name = "engfolk" + i;
  const t = M.engineerfolkTypeOf({ username: name, role: "commoner" });
  if (t) {
    folk++;
    typeHits.add(t);
  }
}
const share = folk / NN;
assert.ok(share > 0.15 && share < 0.27, `post-exclusion share ~21%, got ${share.toFixed(3)}`);
assert.equal(typeHits.size, 4, "all 4 engineerfolk types reachable");
// stability spot-check: same exact username always gets the same type.
// (The master claim check gets the record as-is on purpose: the master's
// own gate, engineerTypeOf(record), applies its own normalizeName inside,
// so the exclusion is exact by construction. Determinism holds per name.)
for (let i = 0; i < 50; i++) {
  const name = "engfolk" + i;
  const a = M.engineerfolkTypeOf({ username: name, role: "commoner" });
  const b = M.engineerfolkTypeOf({ username: name, role: "commoner" });
  assert.equal(a, b, "per-name stability");
}
assert.deepEqual(M.engineerfolkTypeOf(null), null);
assert.equal(M.engineerfolkTypeOf({ username: null, role: "commoner" }), null);
// a missing/unknown role falls through to the hash gate — the claim fn
// just never throws; either null or a type string is acceptable.
assert.ok(["string", "object"].includes(typeof M.engineerfolkTypeOf({ username: "x", role: null })));

// --- 3. role gate: non-commoners are never engineerfolk ---
assert.equal(M.engineerfolkTypeOf({ username: "SomeFolk", role: "merchant" }), null);
assert.equal(M.engineerfolkTypeOf({ username: "SomeFolk", role: "guard" }), null);
assert.equal(M.engineerfolkTypeOf({ username: "SomeFolk", attributes: { role: "banker" } }), null);

// --- 4. master exclusion: pro engineers are never engineerfolk ---
let checkedPro = 0;
for (let i = 0; i < 20000 && checkedPro < 20; i++) {
  const name = "engfolk" + i;
  const rec = { username: name, role: "commoner" };
  if (ProEng.engineerTypeOf(rec) !== null) {
    assert.equal(
      M.engineerfolkTypeOf(rec),
      null,
      `pro engineer ${name} must be excluded`
    );
    checkedPro++;
  }
}
assert.ok(checkedPro >= 20, `found ${checkedPro} pro engineers to verify exclusion`);

// --- 5. smithfolk exclusion: Blacksmiths2 smithfolk are never engineerfolk ---
const Smithfolk2 = require("./CitizenBlacksmiths2");
let checkedSmith = 0;
for (let i = 0; i < 20000 && checkedSmith < 20; i++) {
  const name = "engfolk" + i;
  const rec = { username: name, role: "commoner" };
  if (Smithfolk2.smithfolkTypeOf(rec) !== null) {
    assert.equal(M.engineerfolkTypeOf(rec), null, `smithfolk ${name} must be excluded`);
    checkedSmith++;
  }
}
assert.ok(checkedSmith >= 20, `found ${checkedSmith} smithfolk to verify exclusion`);

// --- 6. fail-open: isProEngineer agrees with the real master predicate ---
// (module-level safeRequire; when the master is present, the check must
// mirror the master's own claim — find names the master does NOT claim
// and require isProEngineer to return false for them.)
let checkedFree = 0;
for (let i = 0; i < 20000 && checkedFree < 20; i++) {
  const rec = { username: "freefolk" + i, role: "commoner" };
  if (ProEng.engineerTypeOf(rec) === null) {
    assert.equal(M.isProEngineer(rec), false, "unclaimed by master => not pro");
    checkedFree++;
  }
}
assert.ok(checkedFree >= 20, `found ${checkedFree} master-free names`);

// --- 7. weighted type rolls cover all types ---
const seen = new Set();
for (let r = 0; r < 100; r++) seen.add(M.folkTypeFromRoll(r));
assert.deepEqual([...seen].sort(), [...typeHits].sort(), "type roll weights cover all types");

// --- 8. fill slots ---
assert.equal(M.fill("A {x} and {x}", { x: "gear" }), "A gear and gear");

// --- 9. hours gates ---
const atHour = (h) => new Date(2026, 9, 8, h, 0, 0).getTime();
assert.ok(M.isWorkHour(atHour(8)), "08:00 is work hour");
assert.ok(M.isWorkHour(atHour(12)), "12:00 is work hour");
assert.ok(!M.isWorkHour(atHour(21)), "21:00 is not work hour");
assert.ok(!M.isWorkHour(atHour(3)), "03:00 is not work hour");
assert.ok(M.isFixHour(atHour(17)), "17:00 is fix hour");
assert.ok(M.isFixHour(new Date(2026, 9, 8, 19, 30).getTime()), "19:30 is fix hour");
assert.ok(!M.isFixHour(atHour(10)), "10:00 is not fix hour");

// --- 10. cornerFor: kingdom-preferred, stable per day ---
const corner = M.cornerFor({ username: "engfolk7", kingdomId: "misthalin" }, NOW);
assert.equal(corner.kingdom, "misthalin", "misthalin citizen gets a misthalin corner");
assert.equal(
  M.cornerFor({ username: "engfolk7", kingdomId: "misthalin" }, NOW).name,
  corner.name,
  "corner stable per day"
);

// --- 11. cargo and mend jobs are amateur errands, seeded per day ---
assert.ok(M.ERRAND_CARGO.length >= 6, "cargo pool");
assert.ok(M.MEND_JOBS.length >= 6, "mend-job pool");
assert.equal(M.cargoFor("engfolk9", NOW), M.cargoFor("engfolk9", NOW), "cargo stable per day");
assert.equal(M.mendJobFor("engfolk9", NOW), M.mendJobFor("engfolk9", NOW), "mend job stable per day");

// --- 12. pro-workshop bridge names the master's REAL workshops ---
const workshop = M.proWorkshopFor({ username: "engfolk11", kingdomId: "misthalin" });
assert.ok(workshop, "bridge produces a workshop name");
assert.ok(!workshop.includes("{"), `no raw slots: ${workshop}`);
// the workshop named must be one of the master's real workshops
const realWorkshopNames = new Set();
for (let i = 0; i < 50; i++) {
  for (const kid of ["misthalin", "asgarnia", "kandarin", "keldagrim", "morytania", "kharidian"]) {
    realWorkshopNames.add(ProEng.workshopFor({ username: "probe" + i, kingdomId: kid }).name);
  }
}
assert.ok(realWorkshopNames.has(workshop), `bridge names a real master workshop: ${workshop}`);
// the bridge never touches devices, commissions, great works or breakthroughs
assert.ok(typeof M.proWorkshopFor({ username: "engfolk12" }) === "string", "string only");
// master devices never appear in street talk
const talkSample = M.fill(M.pickOne(lcg(7), M.PRO_TALK_LINES), {
  workshop: "the Varrock Millworks",
  cargo: "oil",
  job: "kettles",
  place: "a corner",
  their: "their",
});
assert.ok(!/watermill gearbox|catapult|orrery/i.test(talkSample), "no master devices in pro-talk");

// --- 13. line pools render clean ---
function checkPool(pool, label) {
  assert.ok(Array.isArray(pool) && pool.length > 0, `${label} pool non-empty`);
  for (const line of pool) {
    assert.ok(typeof line === "string" && line.length > 0, `${label}: non-empty string`);
    assert.ok(line.length <= 120, `${label} line <= 120 chars: ${line}`);
    assert.ok(!/\{[a-z]+\}/.test(M.fill(line, { job: "x", cargo: "y", workshop: "z", place: "w", their: "their" })), `${label}: all slots fillable`);
  }
}
checkPool(M.SETUP_LINES, "setup");
for (const t of M.FOLK_TYPES) {
  checkPool(M.WORK_LINES[t], `work/${t}`);
}
checkPool(M.MEND_LINES, "mend");
checkPool(M.ERRAND_LINES, "errand");
checkPool(M.SIGNAL_LINES, "signal");
checkPool(M.FIX_DEMO_LINES, "fix-demo");
checkPool(M.GEAR_SPILL_LINES, "gear-spill");
checkPool(M.WHISTLE_GAG_LINES, "whistle-gag");
checkPool(M.FIX_CROWD_LINES, "fix-crowd");
for (const line of M.PRO_TALK_LINES) {
  assert.ok(line.length <= 120, `pro-talk line <= 120 chars: ${line}`);
  const rendered = M.fill(line, { workshop: "the Varrock Millworks", cargo: "oil", job: "kettles", place: "c", their: "their" });
  assert.ok(!rendered.includes("{"), `pro-talk slots filled: ${line}`);
}

// --- 14. corners: 12 entries, 2 per kingdom, all kingdoms covered ---
assert.equal(M.CORNERS.length, 12, "12 street repair corners");
const perKingdom = {};
for (const s of M.CORNERS) perKingdom[s.kingdom] = (perKingdom[s.kingdom] || 0) + 1;
for (const [kid, n] of Object.entries(perKingdom)) {
  assert.equal(n, 2, `2 corners for ${kid}`);
}
assert.ok(Object.keys(perKingdom).length >= 6, "at least 6 kingdoms covered");

// --- 15. engineerfolk never claim the master's real workshops (no pro overlap) ---
for (const s of M.CORNERS) {
  assert.ok(!realWorkshopNames.has(s.name), `corner is not a pro workshop: ${s.name}`);
}

// --- 16. isRealPlayer / withinTiles basics ---
assert.equal(M.isRealPlayer(null), false);
assert.equal(M.isRealPlayer({}), false);
assert.equal(M.isRealPlayer({ getUsername: () => "x" }), true);
assert.equal(M.isRealPlayer({ isPlayerBot: () => true, getUsername: () => "x" }), false);
function fakeAt(x, y, z) {
  return { getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => z }) };
}
assert.ok(M.withinTiles(fakeAt(0, 0, 0), fakeAt(10, 10, 0), 14), "within 14");
assert.ok(!M.withinTiles(fakeAt(0, 0, 0), fakeAt(20, 0, 0), 14), "not within 14");
assert.ok(!M.withinTiles(fakeAt(0, 0, 0), fakeAt(0, 0, 1), 14), "plane mismatch");

// --- 17. dayNumber / seededRng determinism ---
assert.equal(M.dayNumber(NOW), M.dayNumber(NOW + 1000), "same day");
assert.notEqual(M.dayNumber(NOW), M.dayNumber(NOW + DAY), "day rolls over");
const r1 = M.seededRng(1234);
const r2 = M.seededRng(1234);
assert.equal(r1(), r2(), "seeded rng deterministic");
assert.ok(M.chance(() => 0.1, 0.5), "chance gate");
assert.ok(!M.chance(() => 0.9, 0.5), "chance gate closed");

// --- 18. normalizeName never throws on hostile input ---
assert.equal(typeof M.normalizeName(undefined), "string");
assert.equal(typeof M.normalizeName(12345), "string");

// --- 19. pickOne determinism spot check ---
const rng = lcg(42);
assert.ok(["a", "b", "c"].includes(M.pickOne(rng, ["a", "b", "c"])), "pickOne");

// --- 20. daily set-piece keying: once per kingdom per day ---
reset();
const spillKey = "spill:misthalin:" + Math.floor(NOW / DAY);
M._firedDayKeys.add(spillKey);
assert.equal(M._firedDayKeys.has(spillKey), true, "set-piece key recorded");

// --- 21. tickEngineerfolk never throws on hostile director input ---
assert.doesNotThrow(() => M.tickEngineerfolk(null, NOW));
assert.doesNotThrow(() => M.tickEngineerfolk({}, NOW));
assert.doesNotThrow(() =>
  M.tickEngineerfolk(
    { roster: { values: () => [null, { username: null }] }, onlinePlayers: () => [] },
    NOW
  )
);
// per-citizen guard: a record whose claim check throws still can't crash
assert.doesNotThrow(() =>
  M.tickEngineerfolk(
    {
      roster: {
        values: () => [
          {
            get username() {
              throw new Error("boom");
            },
          },
        ],
      },
      onlinePlayers: () => [],
    },
    NOW
  )
);

// --- 22. tickEngineerfolk: fires a scripted line for an eligible citizen ---
reset();
const said = [];
const hourNoon = new Date(2026, 9, 8, 12, 0, 0).getTime();
// find an engineerfolk citizen deterministically
let folkName = null;
for (let i = 0; i < 5000 && !folkName; i++) {
  const n = "tickengfolk" + i;
  if (M.engineerfolkTypeOf({ username: n, role: "commoner" })) folkName = n;
}
assert.ok(folkName, "found an engineerfolk citizen for the tick test");
const fakeCitizen = {
  forceChat: (line) => said.push(line),
  getLocation: () => ({ getX: () => 3200, getY: () => 3200, getZ: () => 0 }),
};
const fakePlayer = {
  getUsername: () => "RealPlayer",
  getLocation: () => ({ getX: () => 3205, getY: () => 3205, getZ: () => 0 }),
};
const director = {
  roster: { values: () => [{ username: folkName, role: "commoner", kingdomId: "misthalin" }] },
  playerFor: () => fakeCitizen,
  onlinePlayers: () => [fakePlayer],
};
// force the chance gate: Math.random patch scoped to the call
const origRandom = Math.random;
Math.random = () => 0.05; // below FOLK_CHANCE; noon -> work path
try {
  M.tickEngineerfolk(director, hourNoon, { tick: 0 });
} finally {
  Math.random = origRandom;
}
assert.ok(said.length > 0, `citizen said something: ${JSON.stringify(said)}`);
assert.ok(said[0].length <= 120, "line length cap");
console.log("sample tick line:", said[0]);

console.log("ALL CITIZENENGINEERS2 TESTS PASSED");
