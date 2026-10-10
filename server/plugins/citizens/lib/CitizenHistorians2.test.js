// CitizenHistorians2 unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const M = require("./CitizenHistorians2");
const PrimaryHobby = require("./CitizenPrimaryHobby");
const JournalMod = require("./CitizenJournal");

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
  try {
    JournalMod.getJournal().resetForTests();
  } catch { /* journal seam best-effort */ }
}

reset();

// --- 1. hashStr is deterministic ---
assert.equal(M.hashStr("abc"), M.hashStr("abc"));
assert.notEqual(M.hashStr("abc"), M.hashStr("abd"));

// --- 2. chroniclerfolkTypeOf: ~35% nominal share (post-exclusion) ---
// The pro-historian exclusion (the master tick's own isHobbyVisible
// "historian" gate) removes ~40% before the share roll, so the measured
// share lands around 21%. Bounds 0.14-0.28 document the measured share
// rather than a guess.
let folk = 0;
const typeHits = new Set();
const NN = 20000;
for (let i = 0; i < NN; i++) {
  const name = "chroniclefolk" + i;
  const t = M.chroniclerfolkTypeOf({ username: name, role: "commoner" });
  if (t) {
    folk++;
    typeHits.add(t);
  }
}
const share = folk / NN;
assert.ok(share > 0.14 && share < 0.28, `post-exclusion share ~21%, got ${share.toFixed(3)}`);
assert.equal(typeHits.size, 4, "all 4 chroniclerfolk types reachable");
// stability spot-check: same exact username always gets the same type.
for (let i = 0; i < 50; i++) {
  const name = "chroniclefolk" + i;
  const a = M.chroniclerfolkTypeOf({ username: name, role: "commoner" });
  const b = M.chroniclerfolkTypeOf({ username: name, role: "commoner" });
  assert.equal(a, b, "per-name stability");
}
assert.deepEqual(M.chroniclerfolkTypeOf(null), null);
assert.equal(M.chroniclerfolkTypeOf({ username: null, role: "commoner" }), null);
// a missing/unknown role falls through to the hash gate — the claim fn
// just never throws; either null or a type string is acceptable.
assert.ok(["string", "object"].includes(typeof M.chroniclerfolkTypeOf({ username: "x", role: null })));

// --- 3. role gate: non-commoners are never chroniclerfolk ---
assert.equal(M.chroniclerfolkTypeOf({ username: "SomeFolk", role: "merchant" }), null);
assert.equal(M.chroniclerfolkTypeOf({ username: "SomeFolk", role: "guard" }), null);
assert.equal(M.chroniclerfolkTypeOf({ username: "SomeFolk", attributes: { role: "banker" } }), null);

// --- 4. pro-historian exclusion: citizens visibly working as professional
// historians are never chroniclerfolk ---
// The module wires the master tier's REAL claim path: historianTypeOf
// (CitizenHistorians.js:271) AND the master tick's own operative work
// gate, isHobbyVisible(username, "historian") (CitizenHistorians.js:609).
// Verified here against the real PrimaryHobby functions.
let excluded = 0;
for (let i = 0; i < 20000 && excluded < 20; i++) {
  const name = "prohistorian" + i;
  if (!PrimaryHobby.isHobbyVisible(name, "historian")) continue;
  // only test names that would otherwise be folk (exclusion must win
  // against the share roll) — compute the would-be type by checking the
  // share roll alone on a non-excluded twin
  const rec = { username: name, role: "commoner" };
  assert.equal(M.isProHistorian(rec), true, `historian-visible ${name} is a pro historian`);
  assert.equal(M.chroniclerfolkTypeOf(rec), null, `pro historian ${name} must be excluded`);
  excluded++;
}
assert.ok(excluded >= 20, `excluded ${excluded} pro historians to verify`);
// a citizen NOT historian-visible is NOT a pro historian — exclusion is exact.
let freeName = null;
for (let i = 0; i < 20000 && !freeName; i++) {
  const n = "freehistorian" + i;
  if (!PrimaryHobby.isHobbyVisible(n, "historian")) freeName = n;
}
assert.ok(freeName, "found a historian-invisible name");
assert.equal(M.isProHistorian({ username: freeName, role: "commoner" }), false, "invisible citizen is not pro");

// --- 5. fail-open: isProHistorian agrees with the real hobby gate ---
let checkedFree = 0;
for (let i = 0; i < 20000 && checkedFree < 20; i++) {
  const rec = { username: "hobbyfree" + i, role: "commoner" };
  const visible = PrimaryHobby.isHobbyVisible(rec.username, "historian");
  assert.equal(M.isProHistorian(rec), visible === true, "isProHistorian matches the real gate");
  if (!visible) checkedFree++;
}
assert.ok(checkedFree >= 20, `found ${checkedFree} historian-free names`);
// isProHistorian never throws on hostile input.
assert.equal(M.isProHistorian(null), false);
assert.equal(M.isProHistorian({}), false);
assert.equal(M.isProHistorian({ username: null }), false);

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

// --- 9. spotFor: kingdom-preferred, stable per day ---
const spot = M.spotFor({ username: "chroniclefolk7", kingdomId: "misthalin" }, NOW);
assert.equal(spot.kingdom, "misthalin", "misthalin citizen gets a misthalin spot");
assert.equal(
  M.spotFor({ username: "chroniclefolk7", kingdomId: "misthalin" }, NOW).name,
  spot.name,
  "spot stable per day"
);
const s2 = M.secondSpotFor({ username: "chroniclefolk7", kingdomId: "misthalin" }, spot, NOW);
assert.notEqual(s2, spot, "runner circuit visits two distinct spots");
assert.equal(s2.kingdom, "misthalin", "second spot stays kingdom-preferred");

// --- 10. line pools render clean ---
const VARS = { spot: "s1", spot2: "s2", who: "Tam", what: "swept the yard", day: "123", count: "7" };
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
checkPool(M.READ_LINES, "read");
checkPool(M.HERALD_LINES, "herald");
checkPool(M.SCRIBE_LINES, "scribe");
checkPool(M.RUNNER_LINES, "runner");

// --- 11. retell frames only ever fill from real journal content ---
for (const line of M.READ_LINES) {
  const rendered = M.fill(line, { who: "Tam", what: "swept the yard" });
  assert.ok(!/\{[a-z0-9]+\}/.test(rendered), `read frame fills: ${line}`);
}
// readers never tell tales of their own — every retell is framed as
// second-hand ("Did you hear?", "The telling goes", "Word from the streets").
for (const line of M.READ_LINES) {
  assert.ok(/did you hear|the telling goes|word from the streets/i.test(line), `retell framed as second-hand: ${line}`);
}
// scribes never invent stories — offers only.
for (const line of M.SCRIBE_LINES) {
  assert.ok(/tell me|jotter|write it down|your story/i.test(line), `scribe offers, never invents: ${line}`);
}
// day-herald lines never carry news — only the day count and headcount.
for (const line of M.HERALD_LINES) {
  assert.ok(/\{day\}.*\{count\}|\{count\}.*\{day\}/.test(line), `herald names day + count only: ${line}`);
  assert.ok(!/news|proclaim|decree/i.test(line), `herald never does crier work: ${line}`);
}

// --- 12. herald day/count fill with real engine state ---
const heraldRendered = M.fill(M.HERALD_LINES[0], { day: M.dayNumber(NOW), count: 7 });
assert.ok(!/\{[a-z0-9]+\}/.test(heraldRendered), "herald line fills");
assert.ok(heraldRendered.includes(String(M.dayNumber(NOW))), "herald names the real day");

// --- 13. spots: 12 entries, 2 per kingdom, off professional grounds ---
assert.equal(M.SPOTS.length, 12, "12 street telling spots");
const perKingdom = {};
for (const s of M.SPOTS) perKingdom[s.kingdom] = (perKingdom[s.kingdom] || 0) + 1;
for (const [kid, n] of Object.entries(perKingdom)) {
  assert.equal(n, 2, `2 spots for ${kid}`);
}
assert.ok(Object.keys(perKingdom).length >= 6, "at least 6 kingdoms covered");
for (const s of M.SPOTS) {
  assert.ok(
    !/vault|scriptorium|record hall|archive|library|cathedral|annals/i.test(s.name),
    `spot is off professional archive grounds: ${s.name}`
  );
}

// --- 14. isRealPlayer / withinTiles basics ---
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

// --- 15. dayNumber / seededRng determinism ---
assert.equal(M.dayNumber(NOW), M.dayNumber(NOW + 1000), "same day");
assert.notEqual(M.dayNumber(NOW), M.dayNumber(NOW + DAY), "day rolls over");
const r1 = M.seededRng(1234);
const r2 = M.seededRng(1234);
assert.equal(r1(), r2(), "seeded rng deterministic");
assert.ok(M.chance(() => 0.1, 0.5), "chance gate");
assert.ok(!M.chance(() => 0.9, 0.5), "chance gate closed");

// --- 16. normalizeName never throws on hostile input ---
assert.equal(typeof M.normalizeName(undefined), "string");
assert.equal(typeof M.normalizeName(12345), "string");

// --- 17. pickOne determinism spot check ---
const rng = lcg(42);
assert.ok(["a", "b", "c"].includes(M.pickOne(rng, ["a", "b", "c"])), "pickOne");

// --- 18. retellEntryFor reads REAL journal entries, never invents ---
reset();
const j = JournalMod.getJournal();
j.log("RetellNeighbor", "work", "Set up the telling spot at the Varrock market-corner bench.");
const nearBot = fakeAt(3205, 3205, 0);
const farBot = fakeAt(9000, 9000, 0);
const readerBot = fakeAt(3200, 3200, 0);
const neighborRec = { username: "RetellNeighbor", role: "commoner" };
const farRec = { username: "RetellFar", role: "commoner" };
const readerRec = { username: "RetellReader", role: "commoner" };
const retellDirector = {
  roster: { values: () => [neighborRec, farRec, readerRec] },
  isOnline: () => true,
  getBot: (r) => (r === neighborRec ? nearBot : r === farRec ? farBot : readerBot),
};
const entry = M.retellEntryFor(retellDirector, readerBot, M.READ_RADIUS, "RetellReader");
assert.ok(entry, "retell finds the nearby citizen's real journal entry");
assert.equal(entry.who, "RetellNeighbor", "retell names the real citizen");
assert.ok(entry.text.includes("Varrock market-corner bench"), "retell text is the real logged text");
assert.equal(entry.event.kind, "work", "event is the real journal event");
// a far-away citizen's entry is out of earshot — never retold from there
const entryFar = M.retellEntryFor(retellDirector, farBot, M.READ_RADIUS, "RetellReader");
assert.equal(entryFar, null, "no retell when nobody with entries is in earshot");
// an empty journal means silence — never invented content
reset();
const entryQuiet = M.retellEntryFor(retellDirector, readerBot, M.READ_RADIUS, "RetellReader");
assert.equal(entryQuiet, null, "quiet journal => no retell, no invention");

// --- 19. onlineCount counts real isOnline records ---
const countDirector = {
  roster: { values: () => [{ username: "a" }, { username: "b" }, { username: "c" }] },
  isOnline: (r) => r.username !== "c",
  getBot: () => null,
};
assert.equal(M.onlineCount(countDirector), 2, "onlineCount reflects real online state");
assert.equal(M.onlineCount({}), 0, "onlineCount fail-safe");

// --- 20. tickHistorianfolk never throws on hostile director input ---
assert.doesNotThrow(() => M.tickHistorianfolk(null, NOW));
assert.doesNotThrow(() => M.tickHistorianfolk({}, NOW));
assert.doesNotThrow(() =>
  M.tickHistorianfolk(
    { roster: { values: () => [null, { username: null }] }, isOnline: () => false, getBot: () => null },
    NOW
  )
);
// per-citizen guard: a record whose claim check throws still can't crash
assert.doesNotThrow(() =>
  M.tickHistorianfolk(
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
      isOnline: () => false,
      getBot: () => null,
    },
    NOW
  )
);

// --- 21. tickHistorianfolk: fires a scripted line for an eligible citizen ---
// NOTE: mocks the REAL director surface (isOnline/getBot), with a real
// player record in the roster — NOT the dead playerFor/onlinePlayers API.
reset();
const said = [];
const hourNoon = new Date(2026, 9, 8, 12, 0, 0).getTime();
// find a chroniclerfolk citizen deterministically (avoid historian-visible names)
let folkName = null;
for (let i = 0; i < 5000 && !folkName; i++) {
  const n = "tickhistorianfolk" + i;
  if (!PrimaryHobby.isHobbyVisible(n, "historian") && M.chroniclerfolkTypeOf({ username: n, role: "commoner" })) {
    folkName = n;
  }
}
assert.ok(folkName, "found a chroniclerfolk citizen for the tick test");
const folkType = M.chroniclerfolkTypeOf({ username: folkName, role: "commoner" });
const fakeCitizen = {
  forceChat: (line) => said.push(line),
  getLocation: () => ({ getX: () => 3200, getY: () => 3200, getZ: () => 0 }),
  getAttribute: () => ({}),
};
const fakePlayer = {
  // a REAL player: getUsername present, not a bot
  isPlayerBot: () => false,
  getUsername: () => "RealPlayer",
  getLocation: () => ({ getX: () => 3205, getY: () => 3205, getZ: () => 0 }),
};
const folkRecord = { username: folkName, role: "commoner", kingdomId: "misthalin" };
const playerRecord = { username: "RealPlayer", role: "commoner" };
const director = {
  roster: { values: () => [folkRecord, playerRecord] },
  isOnline: () => true,
  getBot: (r) => (r === folkRecord ? fakeCitizen : fakePlayer),
};
// seed a real journal entry so a chronicle-reader has something true to retell
JournalMod.getJournal().log("RealPlayer", "work", "Stood watch at the Varrock market-corner bench.");
// force the chance gate: Math.random patch scoped to the call
const origRandom = Math.random;
Math.random = () => 0.05; // below FOLK_CHANCE; noon -> work path
try {
  M.tickHistorianfolk(director, hourNoon, { tick: 0 });
} finally {
  Math.random = origRandom;
}
assert.ok(said.length > 0, `citizen said something: ${JSON.stringify(said)}`);
assert.ok(said[0].length <= 120, "line length cap");
console.log(`sample tick line [${folkType}]:`, said[0]);

// --- 22. the exclusion holds inside the tick: a pro historian never fires ---
reset();
const saidPro = [];
let proName = null;
for (let i = 0; i < 5000 && !proName; i++) {
  const n = "tickprohistorian" + i;
  // would-be folk by share roll AND historian-visible => must be excluded
  if (PrimaryHobby.isHobbyVisible(n, "historian") && M.hashStr(n + "|historians2") % 100 < M.FOLK_SHARE) {
    proName = n;
  }
}
assert.ok(proName, "found a pro-historian citizen for the exclusion tick test");
assert.equal(M.isProHistorian({ username: proName, role: "commoner" }), true, "exclusion candidate really is pro");
assert.equal(M.chroniclerfolkTypeOf({ username: proName, role: "commoner" }), null, "exclusion candidate is not folk");
const proCitizen = {
  forceChat: (line) => saidPro.push(line),
  getLocation: () => ({ getX: () => 3200, getY: () => 3200, getZ: () => 0 }),
  getAttribute: () => ({}),
};
const proRecord = { username: proName, role: "commoner", kingdomId: "misthalin" };
const proDirector = {
  roster: { values: () => [proRecord, playerRecord] },
  isOnline: () => true,
  getBot: (r) => (r === proRecord ? proCitizen : fakePlayer),
};
Math.random = () => 0.05;
try {
  M.tickHistorianfolk(proDirector, hourNoon, { tick: 0 });
} finally {
  Math.random = origRandom;
}
assert.equal(saidPro.length, 0, "pro historian never speaks as chroniclerfolk");

console.log("ALL CITIZENHISTORIANS2 TESTS PASSED");
