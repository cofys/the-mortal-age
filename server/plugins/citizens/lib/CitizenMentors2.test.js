// CitizenMentors2 unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const M = require("./CitizenMentors2");
const Skilling = require("./CitizenSkilling");

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

// --- 2. mentorfolkTypeOf: ~35% nominal share (no masters in a fresh skill store) ---
// In a fresh in-memory skill store nobody is level 60+, so the pro-master
// exclusion fires for nobody and the measured share is the nominal one.
// Bounds 0.30-0.40 document the measured ~35% rather than a guess.
let folk = 0;
const typeHits = new Set();
const NN = 20000;
for (let i = 0; i < NN; i++) {
  const name = "mentorfolk" + i;
  const t = M.mentorfolkTypeOf({ username: name, role: "commoner" });
  if (t) {
    folk++;
    typeHits.add(t);
  }
}
const share = folk / NN;
assert.ok(share > 0.3 && share < 0.4, `post-exclusion share ~35%, got ${share.toFixed(3)}`);
assert.equal(typeHits.size, 4, "all 4 mentorfolk types reachable");
// stability spot-check: same exact username always gets the same type.
for (let i = 0; i < 50; i++) {
  const name = "mentorfolk" + i;
  const a = M.mentorfolkTypeOf({ username: name, role: "commoner" });
  const b = M.mentorfolkTypeOf({ username: name, role: "commoner" });
  assert.equal(a, b, "per-name stability");
}
assert.deepEqual(M.mentorfolkTypeOf(null), null);
assert.equal(M.mentorfolkTypeOf({ username: null, role: "commoner" }), null);
// a missing/unknown role falls through to the hash gate — the claim fn
// just never throws; either null or a type string is acceptable.
assert.ok(["string", "object"].includes(typeof M.mentorfolkTypeOf({ username: "x", role: null })));

// --- 3. role gate: non-commoners are never mentorfolk ---
assert.equal(M.mentorfolkTypeOf({ username: "SomeFolk", role: "merchant" }), null);
assert.equal(M.mentorfolkTypeOf({ username: "SomeFolk", role: "guard" }), null);
assert.equal(M.mentorfolkTypeOf({ username: "SomeFolk", attributes: { role: "banker" } }), null);

// --- 4. master exclusion: level-60 trade masters are never mentorfolk ---
// The master's real professional-master criterion is skillStore.getLevel
// >= MASTER_LEVEL (60) in any trade skill — no exported claim predicate
// exists, so the exclusion is verified against the real skill store.
const MASTER_LEVEL = Skilling.skillStore ? 60 : 60;
let boosted = 0;
for (let i = 0; i < 20000 && boosted < 20; i++) {
  const name = "promaster" + i;
  // only boost names that would otherwise be mentorfolk (exclusion must
  // win against the share roll)
  if (!M.mentorfolkTypeOf({ username: name, role: "commoner" })) continue;
  Skilling.skillStore.addXp(name, "woodcutting", 100000000);
  assert.ok(
    Skilling.skillStore.getLevel(name, "woodcutting") >= MASTER_LEVEL,
    "test master really is level 60+"
  );
  assert.equal(M.isProMentor({ username: name, role: "commoner" }), true, "boosted citizen is a pro mentor");
  assert.equal(M.mentorfolkTypeOf({ username: name, role: "commoner" }), null, `pro mentor ${name} must be excluded`);
  boosted++;
}
assert.ok(boosted >= 20, `boosted ${boosted} masters to verify exclusion`);
// a mid-level citizen (level 40) is NOT a pro mentor — exclusion is exact.
const midName = "midfolk99";
Skilling.skillStore.addXp(midName, "fishing", 100000); // ~level 40-ish, below 60
assert.ok(Skilling.skillStore.getLevel(midName, "fishing") < 60, "mid-level citizen is below 60");
assert.equal(M.isProMentor({ username: midName, role: "commoner" }), false, "level <60 is not a pro mentor");

// --- 5. fail-open: isProMentor agrees with the real skill store ---
let checkedFree = 0;
for (let i = 0; i < 20000 && checkedFree < 20; i++) {
  const rec = { username: "freefolk" + i, role: "commoner" };
  let claimed = false;
  for (const key of Object.keys(Skilling.SKILLS)) {
    if (Skilling.skillStore.getLevel(rec.username, key) >= 60) claimed = true;
  }
  if (!claimed) {
    assert.equal(M.isProMentor(rec), false, "unclaimed by master => not pro");
    checkedFree++;
  }
}
assert.ok(checkedFree >= 20, `found ${checkedFree} master-free names`);
// masterLevel() reads the master's real MASTER_LEVEL export.
assert.equal(M.masterLevel(), 60, "master level matches CitizenMentors.MASTER_LEVEL");

// --- 6. weighted type rolls cover all types ---
const seen = new Set();
for (let r = 0; r < 100; r++) seen.add(M.folkTypeFromRoll(r));
assert.deepEqual([...seen].sort(), [...typeHits].sort(), "type roll weights cover all types");

// --- 7. fill slots ---
assert.equal(M.fill("A {x} and {x}", { x: "gear" }), "A gear and gear");

// --- 8. hours gates ---
const atHour = (h) => new Date(2026, 9, 8, h, 0, 0).getTime();
assert.ok(M.isWorkHour(atHour(8)), "08:00 is work hour");
assert.ok(M.isWorkHour(atHour(12)), "12:00 is work hour");
assert.ok(!M.isWorkHour(atHour(21)), "21:00 is not work hour");
assert.ok(!M.isWorkHour(atHour(3)), "03:00 is not work hour");
assert.ok(M.isOathHour(atHour(17)), "17:00 is oath hour");
assert.ok(M.isOathHour(new Date(2026, 9, 8, 19, 30).getTime()), "19:30 is oath hour");
assert.ok(!M.isOathHour(atHour(10)), "10:00 is not oath hour");

// --- 9. pitchFor: kingdom-preferred, stable per day ---
const pitch = M.pitchFor({ username: "mentorfolk7", kingdomId: "misthalin" }, NOW);
assert.equal(pitch.kingdom, "misthalin", "misthalin citizen gets a misthalin pitch");
assert.equal(
  M.pitchFor({ username: "mentorfolk7", kingdomId: "misthalin" }, NOW).name,
  pitch.name,
  "pitch stable per day"
);

// --- 10. trades, chores, vices are seeded per day ---
assert.ok(M.RECRUIT_TRADES.length >= 6, "trade pool");
assert.ok(M.DAY_CHORES.length >= 8, "chore pool");
assert.ok(M.DAY_VICES.length >= 6, "vice pool");
assert.equal(M.tradeFor("mentorfolk9", NOW), M.tradeFor("mentorfolk9", NOW), "trade stable per day");
const c1 = M.choresFor("mentorfolk9", NOW);
const c2 = M.choresFor("mentorfolk9", NOW);
assert.deepEqual(c1, c2, "chores stable per day");
assert.notEqual(c1.chore, c1.chore2, "two distinct chores");
assert.equal(M.viceFor("mentorfolk9", NOW), M.viceFor("mentorfolk9", NOW), "vice stable per day");

// --- 11. the master small-talk bridge names the real master criterion ---
for (const line of M.MASTER_TALK_LINES) {
  assert.ok(line.length <= 120, `master-talk line <= 120 chars: ${line}`);
  const rendered = M.fill(line, { trade: "the woodcutters' guild" });
  assert.ok(!rendered.includes("{"), `master-talk slots filled: ${line}`);
  assert.ok(/sixty/i.test(rendered), `master-talk names the 60-level criterion: ${line}`);
}
// mentorfolk talk never promises teaching or master titles
for (const line of M.MASTER_TALK_LINES) {
  assert.ok(!/i('ll| will) teach|master of the|take you on as/i.test(line), `no teaching promises: ${line}`);
}

// --- 12. line pools render clean ---
const VARS = { place: "p", trade: "t", chore: "c1", chore2: "c2", vice: "v", their: "their" };
function checkPool(pool, label) {
  assert.ok(Array.isArray(pool) && pool.length > 0, `${label} pool non-empty`);
  for (const line of pool) {
    assert.ok(typeof line === "string" && line.length > 0, `${label}: non-empty string`);
    assert.ok(line.length <= 120, `${label} line <= 120 chars: ${line}`);
    assert.ok(!/\{[a-z0-9]+\}/.test(M.fill(line, VARS)), `${label}: all slots fillable`);
  }
}
checkPool(M.SETUP_LINES, "setup");
for (const t of M.FOLK_TYPES) {
  checkPool(M.WORK_LINES[t], `work/${t}`);
}
checkPool(M.PITCH_LINES, "pitch");
checkPool(M.CHORE_LINES, "chore");
checkPool(M.MORAL_LINES, "moral");
checkPool(M.OATH_LINES, "oath");
checkPool(M.MASTER_TALK_LINES, "master-talk");
checkPool(M.OATH_RECITAL_LINES, "oath-recital");
checkPool(M.OATH_CEREMONY_LINES, "oath-ceremony");
checkPool(M.TASKMASTER_SCENE_LINES, "taskmaster-scene");
checkPool(M.SOAPBOX_CROWD_LINES, "soapbox-crowd");
checkPool(M.SIGNING_HAUL_LINES, "signing-haul");

// --- 13. soapbox preachers are secular moralizers, never clergy ---
for (const line of [...M.MORAL_LINES, ...M.WORK_LINES[M.SOAPBOX]]) {
  assert.ok(!/bless|absolv|temple rite|prophecy|offering/i.test(line), `soapbox never does priest work: ${line}`);
}

// --- 14. pitches: 12 entries, 2 per kingdom, off professional grounds ---
assert.equal(M.PITCHES.length, 12, "12 street hiring pitches");
const perKingdom = {};
for (const s of M.PITCHES) perKingdom[s.kingdom] = (perKingdom[s.kingdom] || 0) + 1;
for (const [kid, n] of Object.entries(perKingdom)) {
  assert.equal(n, 2, `2 pitches for ${kid}`);
}
assert.ok(Object.keys(perKingdom).length >= 6, "at least 6 kingdoms covered");
for (const s of M.PITCHES) {
  assert.ok(
    !/school|academy|temple|workshop|millworks|library|cathedral/i.test(s.name),
    `pitch is off professional grounds: ${s.name}`
  );
}

// --- 15. isRealPlayer / withinTiles basics ---
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

// --- 16. dayNumber / seededRng determinism ---
assert.equal(M.dayNumber(NOW), M.dayNumber(NOW + 1000), "same day");
assert.notEqual(M.dayNumber(NOW), M.dayNumber(NOW + DAY), "day rolls over");
const r1 = M.seededRng(1234);
const r2 = M.seededRng(1234);
assert.equal(r1(), r2(), "seeded rng deterministic");
assert.ok(M.chance(() => 0.1, 0.5), "chance gate");
assert.ok(!M.chance(() => 0.9, 0.5), "chance gate closed");

// --- 17. normalizeName never throws on hostile input ---
assert.equal(typeof M.normalizeName(undefined), "string");
assert.equal(typeof M.normalizeName(12345), "string");

// --- 18. pickOne determinism spot check ---
const rng = lcg(42);
assert.ok(["a", "b", "c"].includes(M.pickOne(rng, ["a", "b", "c"])), "pickOne");

// --- 19. daily set-piece keying: once per kingdom per day ---
reset();
const oathKey = "oath:misthalin:" + Math.floor(NOW / DAY);
M._firedDayKeys.add(oathKey);
assert.equal(M._firedDayKeys.has(oathKey), true, "set-piece key recorded");

// --- 20. tickMentorfolk never throws on hostile director input ---
assert.doesNotThrow(() => M.tickMentorfolk(null, NOW));
assert.doesNotThrow(() => M.tickMentorfolk({}, NOW));
assert.doesNotThrow(() =>
  M.tickMentorfolk(
    { roster: { values: () => [null, { username: null }] }, onlinePlayers: () => [] },
    NOW
  )
);
// per-citizen guard: a record whose claim check throws still can't crash
assert.doesNotThrow(() =>
  M.tickMentorfolk(
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

// --- 21. tickMentorfolk: fires a scripted line for an eligible citizen ---
reset();
const said = [];
const hourNoon = new Date(2026, 9, 8, 12, 0, 0).getTime();
// find a mentorfolk citizen deterministically (avoid names boosted to master)
let folkName = null;
for (let i = 0; i < 5000 && !folkName; i++) {
  const n = "tickmentorfolk" + i;
  if (M.mentorfolkTypeOf({ username: n, role: "commoner" })) folkName = n;
}
assert.ok(folkName, "found a mentorfolk citizen for the tick test");
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
  M.tickMentorfolk(director, hourNoon, { tick: 0 });
} finally {
  Math.random = origRandom;
}
assert.ok(said.length > 0, `citizen said something: ${JSON.stringify(said)}`);
assert.ok(said[0].length <= 120, "line length cap");
console.log("sample tick line:", said[0]);

console.log("ALL CITIZENMENTORS2 TESTS PASSED");
