// CitizenDiplomats2 unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const M = require("./CitizenDiplomats2");
const ProDiplomats = require("./CitizenDiplomats");

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

// --- 2. envoyfolkTypeOf: ~30% nominal share (no diplomats among commoners) ---
// The professional tier drafts courtiers only, so the exclusion fires for
// no commoner and the measured share is the nominal one. Bounds 0.25-0.35
// document the measured ~30% rather than a guess.
let folk = 0;
const typeHits = new Set();
const NN = 20000;
for (let i = 0; i < NN; i++) {
  const name = "envoyfolk" + i;
  const t = M.envoyfolkTypeOf({ username: name, role: "commoner" });
  if (t) {
    folk++;
    typeHits.add(t);
  }
}
const share = folk / NN;
assert.ok(share > 0.25 && share < 0.35, `post-exclusion share ~30%, got ${share.toFixed(3)}`);
assert.equal(typeHits.size, 4, "all 4 envoyfolk types reachable");
// stability spot-check: same exact username always gets the same type.
for (let i = 0; i < 50; i++) {
  const name = "envoyfolk" + i;
  const a = M.envoyfolkTypeOf({ username: name, role: "commoner" });
  const b = M.envoyfolkTypeOf({ username: name, role: "commoner" });
  assert.equal(a, b, "per-name stability");
}
assert.deepEqual(M.envoyfolkTypeOf(null), null);
assert.equal(M.envoyfolkTypeOf({ username: null, role: "commoner" }), null);
// a missing/unknown role falls through to the hash gate — the claim fn
// just never throws; either null or a type string is acceptable.
assert.ok(["string", "object"].includes(typeof M.envoyfolkTypeOf({ username: "x", role: null })));

// --- 3. role gate: non-commoners are never envoyfolk ---
assert.equal(M.envoyfolkTypeOf({ username: "SomeFolk", role: "merchant" }), null);
assert.equal(M.envoyfolkTypeOf({ username: "SomeFolk", role: "courtier" }), null);
assert.equal(M.envoyfolkTypeOf({ username: "SomeFolk", attributes: { role: "guard" } }), null);

// --- 4. diplomat exclusion: the professional tier's REAL claim predicate ---
// The module wires CitizenDiplomats.isDiplomat (CitizenDiplomats.js:234),
// the same predicate the professional draft uses in courtiersOf
// (CitizenDiplomats.js:454: role === ROLE_COURTIER && isDiplomat). A
// courtier the professional tier may draft is never envoyfolk.
// "bob7" is not judge-claimed (verified against the real module), so a
// courtier by that name is draft-eligible and must be excluded.
assert.equal(ProDiplomats.isDiplomat("bob7"), true, "bob7 really is draft-eligible");
assert.equal(M.isProDiplomat({ username: "bob7", role: "courtier" }), true, "draft-eligible courtier is pro");
assert.equal(
  M.envoyfolkTypeOf({ username: "bob7", role: "courtier" }),
  null,
  "pro diplomat courtier must be excluded"
);
// exclusion mirrors the predicate across a sample of names
let matched = 0;
for (let i = 0; i < 500 && matched < 20; i++) {
  const name = "draftcheck" + i;
  const expected = ProDiplomats.isDiplomat(name) === true;
  assert.equal(M.isProDiplomat({ username: name, role: "courtier" }), expected, `exclusion mirrors isDiplomat for ${name}`);
  if (expected) matched++;
}
assert.ok(matched >= 20, `mirrored ${matched} draft-eligible courtiers`);
// commoners are never in the professional draft pool (courtiersOf takes
// courtiers only), so the exclusion never fires for them.
assert.equal(M.isProDiplomat({ username: "bob7", role: "commoner" }), false, "commoner is never pro");
// judge-claimed citizens fail the professional predicate (fail-closed for
// them at the pro tier) and stay out of envoyfolk via the role gate, not
// by being secretly claimable.
assert.equal(ProDiplomats.isDiplomat("alice"), false, "alice really is judge-claimed");
assert.equal(M.isProDiplomat({ username: "alice", role: "courtier" }), false, "judge-claimed courtier not pro-diplomat");

// --- 5. fail-open: isProDiplomat never throws, never claims on hostile input ---
assert.equal(M.isProDiplomat(null), false);
assert.equal(M.isProDiplomat({}), false);
assert.equal(M.isProDiplomat({ username: null, role: "courtier" }), false);

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
assert.ok(M.isWishHour(atHour(17)), "17:00 is wish hour");
assert.ok(M.isWishHour(new Date(2026, 9, 8, 19, 30).getTime()), "19:30 is wish hour");
assert.ok(!M.isWishHour(atHour(10)), "10:00 is not wish hour");

// --- 9. spotFor: kingdom-preferred, stable per day ---
const spot = M.spotFor({ username: "envoyfolk7", kingdomId: "misthalin" }, NOW);
assert.equal(spot.kingdom, "misthalin", "misthalin citizen gets a misthalin spot");
assert.equal(
  M.spotFor({ username: "envoyfolk7", kingdomId: "misthalin" }, NOW).name,
  spot.name,
  "spot stable per day"
);
assert.equal(M.cityFor("misthalin"), "Varrock", "city mirrors the diplomat tier fallback");
assert.equal(M.cityFor("kharidian"), "the city", "unknown kingdom degrades gracefully");

// --- 10. the real-news bridge: parseMissionStatus / newsFor / departingMission ---
// diplomatStatus() line format (CitizenDiplomats.js): "<name> (<role>) of
// <home>: <phase> — <label> with <target>." — every slot is real state.
const sampleLine = "Bob7 (envoy) of Varrock: departing — trade agreement with Ardougne.";
const parsed = M.parseMissionStatus(sampleLine);
assert.deepEqual(
  parsed,
  { name: "Bob7", role: "envoy", home: "Varrock", phase: "departing", label: "trade agreement", target: "Ardougne" },
  "status line parses into real-state slots"
);
assert.equal(M.parseMissionStatus("not a status line"), null, "garbage does not parse");
assert.equal(M.parseMissionStatus(null), null, "null does not parse");
// newsFor: seeded per day from real lines, null when nothing is running.
const lines = [
  "Bob7 (envoy) of Varrock: departing — trade agreement with Ardougne.",
  "Zed (negotiator) of Falador: negotiating — peace treaty with Keldagrim.",
];
const n1 = M.newsFor("envoyfolk9", NOW, lines);
const n2 = M.newsFor("envoyfolk9", NOW, lines);
assert.deepEqual(n1, n2, "news stable per day");
assert.ok([lines[0], lines[1]].some((l) => M.parseMissionStatus(l).name === n1.name), "news quotes a real line");
assert.equal(M.newsFor("envoyfolk9", NOW, []), null, "no missions => no news");
assert.equal(M.newsFor("envoyfolk9", NOW, null), null, "null status => no news");
// departingMission: only real departing phases qualify.
assert.equal(M.departingMission(lines).name, "Bob7", "finds the departing mission");
assert.equal(M.departingMission(["Zed (negotiator) of Falador: negotiating — peace treaty with Keldagrim."]), null, "non-departing is not returned");
assert.equal(M.departingMission([]), null, "no lines => null");
// liveMissions: the real tier reports no missions right now (empty map).
assert.deepEqual(M.liveMissions(), [], "no running missions => empty list");

// --- 11. line pools render clean ---
const VARS = { place: "p", city: "c", name: "n", home: "h", label: "l", target: "t", their: "their" };
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
checkPool(M.NEWS_LINES, "news");
checkPool(M.NO_NEWS_LINES, "no-news");
checkPool(M.DEPARTING_LINES, "departing");
checkPool(M.WISH_LINES, "wish");
checkPool(M.BANNER_LINES, "banner");
checkPool(M.GUEST_LINES, "guest");
checkPool(M.DIPLOMAT_TALK_LINES, "diplomat-talk");

// --- 12. news lines quote real state only — never invented treaties ---
for (const line of M.NEWS_LINES) {
  // every slot in the rendered line comes from parseMissionStatus output
  const rendered = M.fill(line, { name: "X", home: "Y", label: "peace treaty", target: "Z" });
  assert.ok(!rendered.includes("{"), `news slots filled: ${line}`);
}
// the talk bridge names the real claim (courtiers, hand-picked) and never
// promises treaties, missions, escorts or kingdom authority
for (const line of M.DIPLOMAT_TALK_LINES) {
  assert.ok(line.length <= 120, `talk line <= 120 chars: ${line}`);
  const rendered = M.fill(line, VARS);
  assert.ok(!rendered.includes("{"), `talk slots filled: ${line}`);
  assert.ok(/courtier|envoy/i.test(rendered), `talk names the professional tier/claim: ${line}`);
  assert.ok(
    !/i('ll| will) negotiate|treaty is signed|escort you|on behalf of the crown/i.test(line),
    `no treaty/escort promises: ${line}`
  );
}
// envoyfolk never do clergy/song/tale/crier work
for (const line of [...M.GUEST_LINES, ...M.WORK_LINES[M.GUEST_SCRIBE]]) {
  assert.ok(!/bless|prophecy|sing|tale|proclamation/i.test(line), `guest-scribe stays in the ledger: ${line}`);
}

// --- 13. court spots: 10 entries, 2 per kingdom, public fringe only ---
assert.equal(M.COURT_SPOTS.length, 10, "10 court-fringe spots");
const perKingdom = {};
for (const s of M.COURT_SPOTS) perKingdom[s.kingdom] = (perKingdom[s.kingdom] || 0) + 1;
for (const [kid, n] of Object.entries(perKingdom)) {
  assert.equal(n, 2, `2 spots for ${kid}`);
}
assert.equal(Object.keys(perKingdom).length, 5, "the 5 diplomat-tier kingdoms covered");
for (const s of M.COURT_SPOTS) {
  assert.ok(
    !/throne|inner sanctum|war room|treaty hall|ambassador's quarters/i.test(s.name),
    `spot is public fringe, not the professional court: ${s.name}`
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

// --- 18. tickEnvoyfolk never throws on hostile director input ---
assert.doesNotThrow(() => M.tickEnvoyfolk(null, NOW));
assert.doesNotThrow(() => M.tickEnvoyfolk({}, NOW));
assert.doesNotThrow(() =>
  M.tickEnvoyfolk(
    { roster: { values: () => [null, { username: null }] }, isOnline: () => false },
    NOW
  )
);
// per-citizen guard: a record whose claim check throws still can't crash
assert.doesNotThrow(() =>
  M.tickEnvoyfolk(
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
    },
    NOW
  )
);

// --- 19. tickEnvoyfolk: fires a scripted line for an eligible citizen ---
reset();
const said = [];
const hourNoon = new Date(2026, 9, 8, 12, 0, 0).getTime();
// find an envoyfolk citizen deterministically
let folkName = null;
for (let i = 0; i < 5000 && !folkName; i++) {
  const n = "tickenvoyfolk" + i;
  if (M.envoyfolkTypeOf({ username: n, role: "commoner" })) folkName = n;
}
assert.ok(folkName, "found an envoyfolk citizen for the tick test");
const folkRecord = { username: folkName, role: "commoner", kingdomId: "misthalin" };
const fakeCitizen = {
  forceChat: (line) => said.push(line),
  getLocation: () => ({ getX: () => 3222, getY: () => 3474, getZ: () => 0 }),
};
const playerRecord = { username: "RealPlayer", role: "commoner" };
const fakePlayer = {
  isPlayerBot: () => false,
  getUsername: () => "RealPlayer",
  getLocation: () => ({ getX: () => 3227, getY: () => 3479, getZ: () => 0 }),
};
const director = {
  roster: { values: () => [folkRecord, playerRecord] },
  isOnline: () => true,
  getBot: (record) => (record === playerRecord ? fakePlayer : fakeCitizen),
};
// force the chance gate: Math.random patch scoped to the call
const origRandom = Math.random;
Math.random = () => 0.05; // below FOLK_CHANCE; noon -> work path
try {
  M.tickEnvoyfolk(director, hourNoon, { tick: 0 });
} finally {
  Math.random = origRandom;
}
assert.ok(said.length > 0, `citizen said something: ${JSON.stringify(said)}`);
assert.ok(said[0].length <= 120, "line length cap");
console.log("sample tick line:", said[0]);

console.log("ALL CITIZENDIPLOMATS2 TESTS PASSED");
