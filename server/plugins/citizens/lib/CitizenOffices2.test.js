// CitizenOffices2 unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const M = require("./CitizenOffices2");
const ProOffices = require("./CitizenOffices");

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
  ProOffices._resetForTests(); // clears in-memory bindings + the save file
}

reset();

// --- 1. hashStr is deterministic ---
assert.equal(M.hashStr("abc"), M.hashStr("abc"));
assert.notEqual(M.hashStr("abc"), M.hashStr("abd"));

// --- 2. clerkfolkTypeOf: ~30% nominal share (no office-holders seated) ---
// With no bindings in the offices tier, the pro-office exclusion fires
// for nobody and the measured share is the nominal one.
// Bounds 0.25-0.35 document the measured ~30% rather than a guess.
let folk = 0;
const typeHits = new Set();
const NN = 20000;
for (let i = 0; i < NN; i++) {
  const name = "clerkfolk" + i;
  const t = M.clerkfolkTypeOf({ username: name, role: "commoner" });
  if (t) {
    folk++;
    typeHits.add(t);
  }
}
const share = folk / NN;
assert.ok(share > 0.25 && share < 0.35, `post-exclusion share ~30%, got ${share.toFixed(3)}`);
assert.equal(typeHits.size, 4, "all 4 clerkfolk types reachable");
// stability spot-check: same exact username always gets the same type.
for (let i = 0; i < 50; i++) {
  const name = "clerkfolk" + i;
  const a = M.clerkfolkTypeOf({ username: name, role: "commoner" });
  const b = M.clerkfolkTypeOf({ username: name, role: "commoner" });
  assert.equal(a, b, "per-name stability");
}
assert.deepEqual(M.clerkfolkTypeOf(null), null);
assert.equal(M.clerkfolkTypeOf({ username: null, role: "commoner" }), null);
// a missing/unknown role falls through to the hash gate — the claim fn
// just never throws; either null or a type string is acceptable.
assert.ok(["string", "object"].includes(typeof M.clerkfolkTypeOf({ username: "x", role: null })));

// --- 3. role gate: non-commoners are never clerkfolk ---
assert.equal(M.clerkfolkTypeOf({ username: "SomeFolk", role: "merchant" }), null);
assert.equal(M.clerkfolkTypeOf({ username: "SomeFolk", role: "guard" }), null);
assert.equal(M.clerkfolkTypeOf({ username: "SomeFolk", attributes: { role: "banker" } }), null);

// --- 4. office-holder exclusion: sealed citizens are never clerkfolk ---
// The module wires the offices tier's REAL exported claim predicate —
// CitizenOffices.officeOfCitizen (CitizenOffices.js:495), the same
// persisted-bindings lookup the tickOffices sweep itself uses. We seat
// real bindings through the tier's own bindCitizen and verify the
// exclusion wins against the share roll.
// names judge-claimed by CitizenJudges are never seated by CitizenOffices
// (its own non-overlap rule) — skip those when picking seating targets.
let Judges2 = null;
try { Judges2 = require("./CitizenJudges"); } catch { Judges2 = null; }
const judgeClaimed = (n) => {
  try { return !!(Judges2 && Judges2.isJudge && Judges2.isJudge(n)); } catch { return false; }
};
let seated = 0;
for (let i = 0; i < 20000 && seated < 20; i++) {
  const name = "officeholder" + i;
  // only seat names that would otherwise be clerkfolk (exclusion must win)
  if (!M.clerkfolkTypeOf({ username: name, role: "commoner" })) continue;
  if (judgeClaimed(name)) continue; // the tier's own rule: judges never hold offices
  const seatDir = {
    roster: {
      values: () => [{ username: name, kingdomId: "misthalin", role: "commoner" }],
    },
  };
  const b = ProOffices.bindCitizen(seatDir, "misthalin:marshal", "misthalin", "marshal", "Marshal", { quiet: true });
  assert.ok(b && b.citizenName === name, "seated a real binding");
  assert.ok(M.isProOfficeHolder({ username: name, role: "commoner" }), `seated citizen ${name} is a pro office-holder`);
  assert.equal(M.clerkfolkTypeOf({ username: name, role: "commoner" }), null, `office-holder ${name} must be excluded`);
  ProOffices._resetForTests();
  seated++;
}
assert.ok(seated >= 20, `seated ${seated} office-holders to verify exclusion`);
// an unseated commoner is NOT a pro office-holder — exclusion is exact.
assert.equal(M.isProOfficeHolder({ username: "freefolk99", role: "commoner" }), false, "unseated is not pro");
reset();

// --- 5. real office state reads: held and vacant offices ---
// Seat one holder in misthalin; the other three seals must read vacant.
const seatDir2 = {
  roster: {
    values: () => [{ username: "Aeliana", kingdomId: "misthalin", role: "merchant" }],
  },
};
ProOffices.bindCitizen(seatDir2, "misthalin:quartermaster", "misthalin", "quartermaster", "Quartermaster", { quiet: true });
const held = M.heldOfficesOf("misthalin");
assert.equal(held.length, 1, "one office held in misthalin");
assert.equal(held[0].citizenName, "Aeliana", "held office names the real holder");
assert.equal(held[0].title, "Quartermaster", "held office names the real title");
const vacant = M.vacantOfficesOf("misthalin");
assert.deepEqual(
  vacant.map((o) => o.office).sort(),
  ["marshal", "spymaster", "steward"],
  "the other three seals read vacant — never invented"
);
// an empty kingdom: no holders, all four seals vacant.
assert.deepEqual(M.heldOfficesOf("asgarnia"), [], "empty kingdom holds nothing");
assert.equal(M.vacantOfficesOf("asgarnia").length, 4, "empty kingdom: all four vacant");
reset();

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

// --- 9. line pools render clean ---
const VARS = { place: "p", title: "t", holder: "h", trade: "t2" };
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
checkPool(M.NOTICE_LINES, "notice");
checkPool(M.VACANCY_LINES, "vacancy");
checkPool(M.PETITION_LINES, "petition");
checkPool(M.GOSSIP_LINES, "gossip");
checkPool(M.OFFICE_TALK_LINES, "office-talk");

// --- 10. the office small-talk bridge names the real criterion ---
// Clerkfolk never claim to seat, hold seals, issue decrees or answer
// seeks-holder — the seating is the offices' doing.
for (const line of [...M.OFFICE_TALK_LINES, ...M.NOTICE_LINES, ...M.PETITION_LINES]) {
  const rendered = M.fill(line, { title: "Quartermaster", holder: "Aeliana" });
  assert.ok(
    !/i (will |)seat|i hold the seal|i issue|i('ll| will) decree|seeks-holder/i.test(rendered),
    `no authority claims: ${line}`
  );
}
// vacancy lines only name seals that really are vacant (templates, filled
// only from vacantOfficesOf at speak time).
for (const line of M.VACANCY_LINES) {
  assert.ok(/\{title\}/.test(line), `vacancy line templates the title slot: ${line}`);
}

// --- 11. STANDARD_OFFICES: exactly the four offices the kingdoms plugin defines ---
assert.deepEqual(
  M.STANDARD_OFFICES.map((o) => o.office),
  ["quartermaster", "marshal", "spymaster", "steward"],
  "four standard offices"
);

// --- 12. isRealPlayer / withinTiles basics ---
assert.equal(M.isRealPlayer(null), false);
assert.equal(M.isRealPlayer({}), false);
assert.equal(M.isRealPlayer({ getUsername: () => "x" }), true);
assert.equal(M.isRealPlayer({ isPlayerBot: () => true, getUsername: () => "x" }), false);
function fakeAt(x, y, z) {
  return { getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => z }) };
}
assert.ok(M.withinTiles(fakeAt(0, 0, 0), fakeAt(10, 10, 0), 14), "within 14");
assert.ok(!M.withinTiles(fakeAt(0, 0, 0), fakeAt(50, 0, 0), 40), "not within 40");
assert.ok(!M.withinTiles(fakeAt(0, 0, 0), fakeAt(0, 0, 1), 14), "plane mismatch");

// --- 13. dayNumber / seededRng determinism ---
assert.equal(M.dayNumber(NOW), M.dayNumber(NOW + 1000), "same day");
assert.notEqual(M.dayNumber(NOW), M.dayNumber(NOW + DAY), "day rolls over");
const r1 = M.seededRng(1234);
const r2 = M.seededRng(1234);
assert.equal(r1(), r2(), "seeded rng deterministic");
assert.ok(M.chance(() => 0.1, 0.5), "chance gate");
assert.ok(!M.chance(() => 0.9, 0.5), "chance gate closed");

// --- 14. normalizeName never throws on hostile input ---
assert.equal(typeof M.normalizeName(undefined), "string");
assert.equal(typeof M.normalizeName(12345), "string");

// --- 15. pickOne determinism spot check ---
const rng = lcg(42);
assert.ok(["a", "b", "c"].includes(M.pickOne(rng, ["a", "b", "c"])), "pickOne");

// --- 16. tickClerkfolk never throws on hostile director input ---
assert.doesNotThrow(() => M.tickClerkfolk(null, NOW));
assert.doesNotThrow(() => M.tickClerkfolk({}, NOW));
assert.doesNotThrow(() =>
  M.tickClerkfolk(
    { roster: { values: () => [null, { username: null }] } },
    NOW
  )
);
// per-citizen guard: a record whose claim check throws still can't crash
assert.doesNotThrow(() =>
  M.tickClerkfolk(
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
    },
    NOW
  )
);

// --- 17. tickClerkfolk: fires a scripted line for an eligible citizen ---
// NOTE: the tick mock uses the REAL call shape — director.isOnline(record)
// / director.getBot(record) — with a real player record in the roster
// (isPlayerBot false, getUsername present). The dead playerFor/
// onlinePlayers mocks are never called by this module.
reset();
// seat a real office-holder in misthalin so stateful lines have real
// material to name.
const tickSeatDir = {
  roster: {
    values: () => [
      { username: "Aeliana", kingdomId: "misthalin", role: "merchant" },
    ],
  },
};
ProOffices.bindCitizen(tickSeatDir, "misthalin:quartermaster", "misthalin", "quartermaster", "Quartermaster", { quiet: true });
const said = [];
const hourNoon = new Date(2026, 9, 8, 12, 0, 0).getTime();
// find a clerkfolk citizen deterministically (skip names seated above)
let folkName = null;
for (let i = 0; i < 5000 && !folkName; i++) {
  const n = "tickclerkfolk" + i;
  if (M.clerkfolkTypeOf({ username: n, role: "commoner" })) folkName = n;
}
assert.ok(folkName, "found a clerkfolk citizen for the tick test");
const fakeCitizen = {
  forceChat: (line) => said.push(line),
  getAttribute: () => undefined,
  getLocation: () => ({ getX: () => 3200, getY: () => 3200, getZ: () => 0 }),
};
const fakePlayer = {
  getUsername: () => "RealPlayer",
  isPlayerBot: () => false,
  getLocation: () => ({ getX: () => 3205, getY: () => 3205, getZ: () => 0 }),
};
const rosterRecs = [
  { username: folkName, role: "commoner", kingdomId: "misthalin" },
  { username: "RealPlayer", role: "commoner", kingdomId: "misthalin", isPlayerBot: false },
];
const bots = new Map([
  [folkName, fakeCitizen],
  ["RealPlayer", fakePlayer],
]);
const director = {
  roster: { values: () => rosterRecs },
  isOnline: (rec) => bots.has(rec?.username),
  getBot: (rec) => bots.get(rec?.username) ?? null,
};
// force the chance gate: Math.random patch scoped to the call
const origRandom = Math.random;
Math.random = () => 0.05; // below FOLK_CHANCE; noon -> work path
try {
  M.tickClerkfolk(director, hourNoon, { tick: 0 });
} finally {
  Math.random = origRandom;
}
assert.ok(said.length > 0, `citizen said something: ${JSON.stringify(said)}`);
assert.ok(said[0].length <= 120, "line length cap");
console.log("sample tick line:", said[0]);
reset();

console.log("ALL CITIZENOFFICES2 TESTS PASSED");
