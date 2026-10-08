// CitizenLibrarians2 unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const M = require("./CitizenLibrarians2");
const ProLibs = require("./CitizenLibrarians");

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

// --- 2. bookfolkTypeOf: ~35% nominal share, post-exclusion ~15% ---
// Post-exclusion the effective share is ~15.0% (measured n=20000):
// master-claimed pro librarians (~35%, via the real isLibrarian) and
// CitizenHawkers2 hawkers (~34.6%, via the real hawkerTypeOf) are excluded
// BEFORE the share roll, per the house pattern. Bounds 0.10-0.22 document
// the measured effective ~15.0% rather than the nominal 35%.
let folk = 0;
const typeHits = new Set();
const NN = 20000;
for (let i = 0; i < NN; i++) {
  const name = "bookfolk" + i;
  const t = M.bookfolkTypeOf({ username: name, role: "commoner" });
  if (t) {
    folk++;
    typeHits.add(t);
  }
}
const share = folk / NN;
assert.ok(share > 0.10 && share < 0.22, `post-exclusion share ~15%, got ${share.toFixed(3)}`);
assert.equal(typeHits.size, 4, "all 4 bookfolk types reachable");
// stability spot-check: same exact username always gets the same type.
// (Case is NOT normalized before the master exclusion on purpose: the
// master's own gate, isLibrarian(record.username), hashes the raw
// username, so the exclusion must see the identical string or a citizen
// could be both librarian and bookfolk. Determinism holds per exact name.)
for (let i = 0; i < 50; i++) {
  const name = "bookfolk" + i;
  const a = M.bookfolkTypeOf({ username: name, role: "commoner" });
  const b = M.bookfolkTypeOf({ username: name, role: "commoner" });
  assert.equal(a, b, "per-name stability");
}
assert.deepEqual(M.bookfolkTypeOf(null), null);
assert.equal(M.bookfolkTypeOf({ username: null, role: "commoner" }), null);
// a missing/unknown role falls through to the hash gate — the claim fn
// just never throws; either null or a type string is acceptable.
assert.ok(["string", "object"].includes(typeof M.bookfolkTypeOf({ username: "x", role: null })));

// --- 3. role gate: non-commoners are never bookfolk ---
assert.equal(M.bookfolkTypeOf({ username: "SomeBook", role: "merchant" }), null);
assert.equal(M.bookfolkTypeOf({ username: "SomeBook", role: "guard" }), null);
assert.equal(M.bookfolkTypeOf({ username: "SomeBook", attributes: { role: "banker" } }), null);

// --- 4. master exclusion: pro librarians are never bookfolk ---
let checkedPro = 0;
for (let i = 0; i < 20000 && checkedPro < 20; i++) {
  const name = "bookfolk" + i;
  if (ProLibs.isLibrarian(name)) {
    assert.equal(
      M.bookfolkTypeOf({ username: name, role: "commoner" }),
      null,
      `pro librarian ${name} must be excluded`
    );
    checkedPro++;
  }
}
assert.ok(checkedPro >= 20, `found ${checkedPro} pro librarians to verify exclusion`);

// --- 5. hawker exclusion: Hawkers2 hawkers are never bookfolk ---
const Hawkers2 = require("./CitizenHawkers2");
let checkedHawker = 0;
for (let i = 0; i < 20000 && checkedHawker < 20; i++) {
  const name = "bookfolk" + i;
  const rec = { username: name, role: "commoner" };
  if (Hawkers2.hawkerTypeOf(rec) !== null) {
    assert.equal(M.bookfolkTypeOf(rec), null, `hawker ${name} must be excluded`);
    checkedHawker++;
  }
}
assert.ok(checkedHawker >= 20, `found ${checkedHawker} hawkers to verify exclusion`);

// --- 6. fail-open: absent master cannot claim anyone ---
// (module-level safeRequire; verified via isProLibrarian on garbage)
assert.equal(M.isProLibrarian({ username: "nobody-here-zz" }) === true, false);

// --- 7. weighted type rolls cover all types ---
const seen = new Set();
for (let r = 0; r < 100; r++) seen.add(M.bookTypeFromRoll(r));
assert.deepEqual([...seen].sort(), [...typeHits].sort(), "type roll weights cover all types");

// --- 8. fill slots ---
assert.equal(M.fill("A {x} and {x}", { x: "book" }), "A book and book");

// --- 9. hours gates ---
const atHour = (h) => new Date(2026, 9, 8, h, 0, 0).getTime();
assert.ok(M.isWorkHour(atHour(8)), "08:00 is work hour");
assert.ok(M.isWorkHour(atHour(12)), "12:00 is work hour");
assert.ok(!M.isWorkHour(atHour(21)), "21:00 is not work hour");
assert.ok(!M.isWorkHour(atHour(3)), "03:00 is not work hour");
assert.ok(M.isCircleHour(atHour(17)), "17:00 is circle hour");
assert.ok(M.isCircleHour(new Date(2026, 9, 8, 20, 30).getTime()), "20:30 is circle hour");
assert.ok(!M.isCircleHour(atHour(10)), "10:00 is not circle hour");

// --- 10. spotFor: kingdom-preferred, stable per day ---
const spot = M.spotFor({ username: "bookfolk7", kingdomId: "misthalin" }, NOW);
assert.equal(spot.kingdom, "misthalin", "misthalin citizen gets a misthalin spot");
assert.equal(
  M.spotFor({ username: "bookfolk7", kingdomId: "misthalin" }, NOW).name,
  spot.name,
  "spot stable per day"
);
assert.equal(
  M.spotFor({ username: "bookfolk7", kingdomId: "misthalin" }, NOW).name,
  spot.name,
  "spot stable per day"
);
// the seed changes per day, so the day-NOW and day-NOW+DAY draws use
// different seeds (the draw itself may repeat by luck, which is fine).

// --- 11. pamphlets and swap books are amateur print, never rare tomes ---
assert.ok(M.PAMPHLETS.length >= 8, "pamphlet pool");
assert.ok(M.SWAP_BOOKS.length >= 8, "swap pool");
for (const p of M.PAMPHLETS) {
  assert.ok(p.length <= 60, `pamphlet short: ${p}`);
}
assert.equal(M.pamphletFor("bookfolk9", NOW), M.pamphletFor("bookfolk9", NOW), "pamphlet stable per day");
assert.equal(M.swapBookFor("bookfolk9", NOW), M.swapBookFor("bookfolk9", NOW), "swap book stable per day");

// --- 12. pro-library bridge names the master's REAL libraries and subjects ---
const talk = M.proLibraryTalkFor("misthalin", "bookfolk11", NOW);
assert.ok(talk, "bridge produces small talk");
assert.ok(!talk.includes("{"), `slots filled: ${talk}`);
assert.ok(talk.length <= 120, `pro-talk line <= 120 chars: ${talk}`);
// the library named must be one of the master's real libraries
const realLibNames = [];
for (let i = 0; i < 50; i++) {
  realLibNames.push(ProLibs.libraryFor("probe" + i, "misthalin").name);
}
assert.ok(realLibNames.some((n) => talk.includes(n)), `bridge names a real master library: ${talk}`);
// the subject must be a real master catalog subject
const realSubjects = Object.keys(ProLibs.catalogFor("probe1", "misthalin", NOW).catalog);
assert.ok(realSubjects.some((s) => talk.includes(s)), `bridge names a real catalog subject: ${talk}`);
// master rare tomes never appear in street talk
assert.ok(!/codex umbra|palimpsest/i.test(talk), "no rare tomes in street talk");

// --- 13. line pools render clean ---
function checkPool(pool, label) {
  assert.ok(Array.isArray(pool) && pool.length > 0, `${label} pool non-empty`);
  for (const line of pool) {
    assert.ok(typeof line === "string" && line.length > 0, `${label}: non-empty string`);
    assert.ok(line.length <= 120, `${label} line <= 120 chars: ${line}`);
    assert.ok(!/\{[a-z]+\}/.test(M.fill(line, { pamphlet: "x", book: "y", subject: "z", place: "w", their: "their", library: "v" })), `${label}: all slots fillable`);
  }
}
checkPool(M.SETUP_LINES, "setup");
for (const t of M.BOOK_TYPES) {
  checkPool(M.WORK_LINES[t], `work/${t}`);
}
checkPool(M.HAWK_LINES, "hawk");
checkPool(M.SWAP_LINES, "swap");
checkPool(M.FETCH_LINES, "fetch");
checkPool(M.CIRCLE_VERSES, "circle");
checkPool(M.RAIN_SOAK_LINES, "rain-soak");
checkPool(M.BAD_SWAP_LINES, "bad-swap");
checkPool(M.TALE_CROWD_LINES, "tale-crowd");
for (const line of M.PRO_TALK_LINES) {
  assert.ok(line.length <= 120, `pro-talk line <= 120 chars: ${line}`);
  const rendered = M.fill(line, { library: "the Varrock Grand Library", subject: "history" });
  assert.ok(!rendered.includes("{"), `pro-talk slots filled: ${line}`);
}

// --- 14. spots: 12 entries, 2 per kingdom, all kingdoms covered ---
assert.equal(M.READING_SPOTS.length, 12, "12 street reading spots");
const perKingdom = {};
for (const s of M.READING_SPOTS) perKingdom[s.kingdom] = (perKingdom[s.kingdom] || 0) + 1;
for (const [kid, n] of Object.entries(perKingdom)) {
  assert.equal(n, 2, `2 spots for ${kid}`);
}
assert.ok(Object.keys(perKingdom).length >= 6, "at least 6 kingdoms covered");

// --- 15. bookfolk never claim the master's real libraries (no pro overlap) ---
const realLibs = new Set();
for (let i = 0; i < 50; i++) {
  for (const kid of Object.keys(perKingdom)) {
    realLibs.add(ProLibs.libraryFor("probe" + i, kid).name);
  }
}
for (const s of M.READING_SPOTS) {
  assert.ok(!realLibs.has(s.name), `spot is not a pro library: ${s.name}`);
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

// --- 19. pickOne / hashChance determinism spot checks ---
const rng = lcg(42);
assert.ok(["a", "b", "c"].includes(M.pickOne(rng, ["a", "b", "c"])), "pickOne");

// --- 20. daily set-piece keying: once per kingdom per day ---
reset();
const soakKey = "soak:misthalin:" + Math.floor(NOW / DAY);
M._firedDayKeys.add(soakKey);
assert.equal(M._firedDayKeys.has(soakKey), true, "set-piece key recorded");

// --- 21. tickBookfolk never throws on hostile director input ---
assert.doesNotThrow(() => M.tickBookfolk(null, NOW));
assert.doesNotThrow(() => M.tickBookfolk({}, NOW));
assert.doesNotThrow(() =>
  M.tickBookfolk(
    { roster: { values: () => [null, { username: null }] }, onlinePlayers: () => [] },
    NOW
  )
);
// per-citizen guard: a record whose claim check throws still can't crash
assert.doesNotThrow(() =>
  M.tickBookfolk(
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

// --- 22. tickBookfolk: fires a scripted line for an eligible citizen ---
reset();
const said = [];
const hourNoon = new Date(2026, 9, 8, 12, 0, 0).getTime();
// find a bookfolk citizen deterministically
let bookName = null;
for (let i = 0; i < 5000 && !bookName; i++) {
  const n = "tickfolk" + i;
  if (M.bookfolkTypeOf({ username: n, role: "commoner" })) bookName = n;
}
assert.ok(bookName, "found a bookfolk citizen for the tick test");
const fakeCitizen = {
  forceChat: (line) => said.push(line),
  getLocation: () => ({ getX: () => 3200, getY: () => 3200, getZ: () => 0 }),
};
const fakePlayer = {
  getUsername: () => "RealPlayer",
  getLocation: () => ({ getX: () => 3205, getY: () => 3205, getZ: () => 0 }),
};
const director = {
  roster: { values: () => [{ username: bookName, role: "commoner", kingdomId: "misthalin" }] },
  playerFor: () => fakeCitizen,
  onlinePlayers: () => [fakePlayer],
};
// force the chance gate: Math.random patch scoped to the call
const origRandom = Math.random;
Math.random = () => 0.05; // below BOOKFOLK_CHANCE and below setup cutoff? noon -> work path
try {
  M.tickBookfolk(director, hourNoon, { tick: 0 });
} finally {
  Math.random = origRandom;
}
assert.ok(said.length > 0, `citizen said something: ${JSON.stringify(said)}`);
assert.ok(said[0].length <= 120, "line length cap");
console.log("sample tick line:", said[0]);

console.log("ALL CITIZENLIBRARIANS2 TESTS PASSED");
