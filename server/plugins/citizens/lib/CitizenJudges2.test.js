// CitizenJudges2 unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const M = require("./CitizenJudges2");
const ProJudges = require("./CitizenJudges");

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

// --- 2. justicefolkTypeOf: ~30% nominal share ---
// Commoners are never claimed by the court tier (its claim needs role
// "courtier"), so the measured share is the nominal one. Bounds
// 0.25-0.35 document the measured ~30% rather than a guess.
let folk = 0;
const typeHits = new Set();
const NN = 20000;
for (let i = 0; i < NN; i++) {
  const name = "justicefolk" + i;
  const t = M.justicefolkTypeOf({ username: name, role: "commoner" });
  if (t) {
    folk++;
    typeHits.add(t);
  }
}
const share = folk / NN;
assert.ok(share > 0.25 && share < 0.35, `post-exclusion share ~30%, got ${share.toFixed(3)}`);
assert.equal(typeHits.size, 4, "all 4 justicefolk types reachable");
// stability spot-check: same exact username always gets the same type.
for (let i = 0; i < 50; i++) {
  const name = "justicefolk" + i;
  const a = M.justicefolkTypeOf({ username: name, role: "commoner" });
  const b = M.justicefolkTypeOf({ username: name, role: "commoner" });
  assert.equal(a, b, "per-name stability");
}
assert.deepEqual(M.justicefolkTypeOf(null), null);
assert.equal(M.justicefolkTypeOf({ username: null, role: "commoner" }), null);

// --- 3. role gate: non-commoners are never justicefolk ---
assert.equal(M.justicefolkTypeOf({ username: "SomeFolk", role: "merchant" }), null);
assert.equal(M.justicefolkTypeOf({ username: "SomeFolk", role: "guard" }), null);
assert.equal(M.justicefolkTypeOf({ username: "SomeFolk", attributes: { role: "banker" } }), null);

// --- 4. court exclusion: the court tier's REAL claim, before the share roll ---
// The master tick drafts judges with record.role === "courtier" &&
// isJudge(username) (CitizenJudges.js: the role/isJudge gate in
// tickJudges). This module wires that exact claim via the real exported
// isJudge — verified against the master module itself.
let judgeNames = [];
for (let i = 0; i < 20000 && judgeNames.length < 20; i++) {
  const n = "projudge" + i;
  if (ProJudges.isJudge(n)) judgeNames.push(n);
}
assert.ok(judgeNames.length >= 20, `found ${judgeNames.length} real judge usernames`);
for (const n of judgeNames) {
  const rec = { username: n, role: "courtier" };
  assert.equal(M.isProJudge(rec), true, `${n} is claimed by the court tier`);
  // exclusion wins against the share roll: never justicefolk, even when
  // the hash draw would otherwise include them.
  assert.equal(M.justicefolkTypeOf(rec), null, `claimed judge ${n} must be excluded`);
}
// a courtier who is NOT a judge is not claimed by the court tier...
let freeCourtier = null;
for (let i = 0; i < 20000 && !freeCourtier; i++) {
  const n = "freecourtier" + i;
  if (!ProJudges.isJudge(n)) freeCourtier = n;
}
assert.ok(freeCourtier, "found a non-judge courtier");
assert.equal(M.isProJudge({ username: freeCourtier, role: "courtier" }), false);
// ...and a commoner with a judge username is not claimed either — the
// master's real claim requires the courtier role.
assert.equal(M.isProJudge({ username: judgeNames[0], role: "commoner" }), false);
// fail-open / never throws on hostile input
assert.equal(M.isProJudge(null), false);
assert.equal(M.isProJudge({}), false);
assert.equal(M.isProJudge({ username: null, role: "courtier" }), false);

// --- 5. weighted type rolls cover all types ---
const seen = new Set();
for (let r = 0; r < 100; r++) seen.add(M.folkTypeFromRoll(r));
assert.deepEqual([...seen].sort(), [...typeHits].sort(), "type roll weights cover all types");

// --- 6. fill slots ---
assert.equal(M.fill("A {x} and {x}", { x: "gear" }), "A gear and gear");

// --- 7. hours gates ---
const atHour = (h) => new Date(2026, 9, 8, h, 0, 0).getTime();
assert.ok(M.isWorkHour(atHour(8)), "08:00 is work hour");
assert.ok(M.isWorkHour(atHour(12)), "12:00 is work hour");
assert.ok(M.isWorkHour(atHour(18)), "18:00 is work hour");
assert.ok(!M.isWorkHour(atHour(19)), "19:00 is not work hour");
assert.ok(!M.isWorkHour(atHour(3)), "03:00 is not work hour");

// --- 8. the real-state bridge: session hours come from the master ---
const hours = M.sessionHours();
assert.equal(hours.start, ProJudges.SESSION_HOUR_START, "start hour reads the master's constant");
assert.equal(hours.end, ProJudges.SESSION_HOUR_END, "end hour reads the master's constant");
for (let h = 0; h < 24; h++) {
  assert.equal(
    M.inSessionNow(atHour(h)),
    ProJudges.inSessionAtHour(h),
    `session state agrees at hour ${h}`
  );
}
// courtNameFor reads the master's real courtFor
assert.equal(
  M.courtNameFor({ username: "courtx", kingdomId: "varrock" }),
  ProJudges.courtFor("courtx", "varrock"),
  "court name reads the master's real courtFor"
);

// --- 9. ledgerSummaryFor: real fines, real appeals, nothing invented ---
reset();
const empty = M.ledgerSummaryFor("nobodyhasfines", NOW);
assert.equal(empty.fine, 0, "no fine when the ledger is empty");
assert.equal(empty.appeal, false, "no appeal when the ledger is empty");
assert.equal(empty.fineKind, null, "no kind when the ledger is empty");
ProJudges.recordFine("judges2ledgeruser", 150, "debt", NOW);
let sum = M.ledgerSummaryFor("judges2ledgeruser", NOW);
assert.equal(sum.fine, 150, "summary reports the real recorded fine");
assert.equal(sum.fineKind, "debt", "summary reports the real recorded kind");
assert.ok(sum.fineCount >= 1, "real outstanding fine count");
ProJudges.requestAppeal("judges2ledgeruser", NOW);
sum = M.ledgerSummaryFor("judges2ledgeruser", NOW);
assert.equal(sum.appeal, true, "summary reports the real pending appeal");
// clean up: pay off and resolve, ledger reads empty again
ProJudges.payFine("judges2ledgeruser", 150, NOW);
ProJudges.resolveAppeal("judges2ledgeruser");
sum = M.ledgerSummaryFor("judges2ledgeruser", NOW);
assert.equal(sum.fine, 0, "fine gone after real payoff");
assert.equal(sum.appeal, false, "appeal gone after real resolve");

// --- 10. beatFor: kingdom-preferred, stable per day, on real court kingdoms ---
assert.equal(M.BEATS.length, 10, "10 street beats");
const courtKingdoms = new Set(ProJudges.COURTS.map((c) => String(c.kingdom).toLowerCase()));
for (const b of M.BEATS) {
  assert.ok(
    courtKingdoms.has(String(b.kingdom).toLowerCase()),
    `beat kingdom ${b.kingdom} is a real court kingdom`
  );
}
const beat = M.beatFor({ username: "justicefolk7", kingdomId: "varrock" }, NOW);
assert.equal(beat.kingdom, "varrock", "varrock citizen gets a varrock beat");
assert.equal(
  M.beatFor({ username: "justicefolk7", kingdomId: "varrock" }, NOW).name,
  beat.name,
  "beat stable per day"
);

// --- 11. line pools render clean ---
const VARS = { place: "p", court: "c", start: 9, end: 16, n: 3, name: "n", fine: 150, kind: "k" };
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
checkPool(M.MEDIATOR_LINES, "mediator");
checkPool(M.MEDIATOR_COURT_LINES, "mediator-court");
checkPool(M.USHER_SESSION_LINES, "usher-session");
checkPool(M.USHER_HOURS_LINES, "usher-hours");
checkPool(M.CLERK_COPY_LINES, "clerk-copy");
checkPool(M.CLERK_LEDGER_LINES, "clerk-ledger");
checkPool(M.CLERK_FINE_LINES, "clerk-fine");
checkPool(M.CLERK_APPEAL_LINES, "clerk-appeal");
checkPool(M.GAWKER_CROWD_LINES, "gawker-crowd");
checkPool(M.GAWKER_FINE_LINES, "gawker-fine");
checkPool(M.GAWKER_IDLE_LINES, "gawker-idle");

// --- 12. fine-bearing lines are only fillable from real ledger state ---
// Every line that names a fine amount carries the {fine} slot — it can
// only render with a real amount from the master's fine ledger.
for (const line of [...M.CLERK_FINE_LINES, ...M.GAWKER_FINE_LINES]) {
  assert.ok(line.includes("{fine}"), `fine line reads a real amount: ${line}`);
  const rendered = M.fill(line, { name: "Bob", fine: 150, kind: "debt" });
  assert.ok(rendered.includes("150"), `rendered fine line carries the real amount: ${rendered}`);
}
// generic flavor lines never hand down verdicts or invent sentences
for (const line of [
  ...M.SETUP_LINES, ...M.MEDIATOR_LINES, ...M.CLERK_COPY_LINES, ...M.GAWKER_IDLE_LINES,
  ...Object.values(M.WORK_LINES).flat(),
]) {
  assert.ok(
    !/guilty|acquit|sentence|verdict|exile|jailed|i sentence/i.test(line),
    `no invented verdicts in flavor: ${line}`
  );
}
// mediators never claim authority
for (const line of M.MEDIATOR_LINES) {
  assert.ok(/no gavel|cheaper than|before the court|talk/i.test(line), `mediator disclaims the gavel: ${line}`);
}

// --- 13. isRealPlayer / withinTiles basics ---
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

// --- 14. dayNumber / seededRng determinism ---
assert.equal(M.dayNumber(NOW), M.dayNumber(NOW + 1000), "same day");
assert.notEqual(M.dayNumber(NOW), M.dayNumber(NOW + DAY), "day rolls over");
const r1 = M.seededRng(1234);
const r2 = M.seededRng(1234);
assert.equal(r1(), r2(), "seeded rng deterministic");
assert.ok(M.chance(() => 0.1, 0.5), "chance gate");
assert.ok(!M.chance(() => 0.9, 0.5), "chance gate closed");

// --- 15. normalizeName never throws on hostile input ---
assert.equal(typeof M.normalizeName(undefined), "string");
assert.equal(typeof M.normalizeName(12345), "string");

// --- 16. pickOne determinism spot check ---
const rng = lcg(42);
assert.ok(["a", "b", "c"].includes(M.pickOne(rng, ["a", "b", "c"])), "pickOne");

// --- 17. tickJusticefolk never throws on hostile director input ---
assert.doesNotThrow(() => M.tickJusticefolk(null, NOW));
assert.doesNotThrow(() => M.tickJusticefolk({}, NOW));
assert.doesNotThrow(() =>
  M.tickJusticefolk(
    { roster: { values: () => [null, { username: null }] }, onlinePlayers: () => [] },
    NOW
  )
);
// director without isOnline/getBot must not crash either
assert.doesNotThrow(() =>
  M.tickJusticefolk({ roster: { values: () => [{ username: "justicefolk3", role: "commoner" }] } }, NOW)
);
// per-citizen guard: a record whose claim check throws still can't crash
assert.doesNotThrow(() =>
  M.tickJusticefolk(
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

// --- 18. tickJusticefolk: a law-clerk reads the REAL ledger in the tick ---
reset();
// find a clerk citizen deterministically
let clerkName = null;
for (let i = 0; i < 20000 && !clerkName; i++) {
  const n = "tickclerk" + i;
  if (M.justicefolkTypeOf({ username: n, role: "commoner" }) === M.CLERK) clerkName = n;
}
assert.ok(clerkName, "found a clerk citizen for the tick test");
// a real outstanding fine on the master's REAL ledger for the nearby player
ProJudges.recordFine("TickFinedPlayer", 150, "debt", NOW);
const said = [];
const hourNoon = new Date(2026, 9, 8, 12, 0, 0).getTime();
const fakeCitizen = {
  forceChat: (line) => said.push(line),
  getLocation: () => ({ getX: () => 3200, getY: () => 3200, getZ: () => 0 }),
};
const fakePlayer = {
  getUsername: () => "TickFinedPlayer",
  getLocation: () => ({ getX: () => 3205, getY: () => 3205, getZ: () => 0 }),
};
const bots = new Map([[clerkName, fakeCitizen], ["TickFinedPlayer", fakePlayer]]);
const director = {
  roster: {
    values: () => [
      { username: clerkName, role: "commoner", kingdomId: "varrock" },
      { username: "TickFinedPlayer", role: "commoner", kingdomId: "varrock" },
    ],
  },
  isOnline: () => true,
  getBot: (r) => bots.get(r.username) ?? null,
};
// force the chance gate: Math.random patch scoped to the call
const origRandom = Math.random;
Math.random = () => 0.05; // below FOLK_CHANCE; noon -> work path
try {
  M.tickJusticefolk(director, hourNoon, { tick: 0 });
} finally {
  Math.random = origRandom;
}
assert.ok(said.length > 0, `citizen said something: ${JSON.stringify(said)}`);
assert.ok(said[0].length <= 120, "line length cap");
// the clerk's line names the REAL fine: the real amount, the real player,
// the real kind — nothing invented.
assert.ok(said[0].includes("150"), `line carries the real fine amount: ${said[0]}`);
assert.ok(said[0].includes("TickFinedPlayer"), `line names the real fined player: ${said[0]}`);
assert.ok(said[0].includes("debt"), `line names the real recorded kind: ${said[0]}`);
console.log("sample tick line:", said[0]);
// clean up the real ledger
ProJudges.payFine("TickFinedPlayer", 150, NOW);
assert.equal(M.ledgerSummaryFor("TickFinedPlayer", NOW).fine, 0, "ledger cleaned");

console.log("ALL CITIZENJUDGES2 TESTS PASSED");
