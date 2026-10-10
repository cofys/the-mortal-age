// CitizenNewspaper2 unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const M = require("./CitizenNewspaper2");
const ProNewspaper = require("./CitizenNewspaper");
const CitizenJournal = require("./CitizenJournal");

const NOW = 1791436800000; // fixed "now" for determinism
const DAY = 86400000;

function reset() {
  M._resetState();
}

reset();

// --- 1. hashStr is deterministic ---
assert.equal(M.hashStr("abc"), M.hashStr("abc"));
assert.notEqual(M.hashStr("abc"), M.hashStr("abd"));

// --- 2. pamphleteerfolkTypeOf: ~30% nominal share (no criers excluded) ---
// Bounds 0.25-0.35 document the measured ~30% rather than a guess.
let folk = 0;
const typeHits = new Set();
const NN = 20000;
for (let i = 0; i < NN; i++) {
  const name = "pamphletfolk" + i;
  const t = M.pamphleteerfolkTypeOf({ username: name, role: "commoner" }, new Set());
  if (t) {
    folk++;
    typeHits.add(t);
  }
}
const share = folk / NN;
assert.ok(share > 0.25 && share < 0.35, `post-exclusion share ~30%, got ${share.toFixed(3)}`);
assert.equal(typeHits.size, 3, "all 3 pamphletfolk types reachable");
// stability spot-check: same exact username always gets the same type.
for (let i = 0; i < 50; i++) {
  const name = "pamphletfolk" + i;
  const a = M.pamphleteerfolkTypeOf({ username: name, role: "commoner" }, new Set());
  const b = M.pamphleteerfolkTypeOf({ username: name, role: "commoner" }, new Set());
  assert.equal(a, b, "per-name stability");
}
assert.deepEqual(M.pamphleteerfolkTypeOf(null, new Set()), null);
assert.equal(M.pamphleteerfolkTypeOf({ username: null, role: "commoner" }, new Set()), null);
// a missing/unknown role falls through to the hash gate — the claim fn
// just never throws; either null or a type string is acceptable.
assert.ok(["string", "object"].includes(typeof M.pamphleteerfolkTypeOf({ username: "x", role: null }, new Set())));

// --- 3. role gate: non-commoners are never pamphletfolk ---
assert.equal(M.pamphleteerfolkTypeOf({ username: "SomeFolk", role: "merchant" }, new Set()), null);
assert.equal(M.pamphleteerfolkTypeOf({ username: "SomeFolk", role: "guard" }, new Set()), null);
assert.equal(M.pamphleteerfolkTypeOf({ username: "SomeFolk", attributes: { role: "banker" } }, new Set()), null);

// --- 4. crier exclusion: the master tier's REAL claim predicate ---
// The module wires CitizenNewspaper.crierFor(kingdomId, records,
// editionIdFor(nowMs)) — the same function the crier tick picks its town
// criers with: deterministic per kingdom + week, one crier per kingdom.
// A single-record roster means the master MUST claim that record.
{
  const lone = { username: "lonecrier2", role: "commoner", kingdom: "misthalin" };
  const records = [lone];
  const realCrier = ProNewspaper.crierFor("misthalin", records, ProNewspaper.editionIdFor(NOW));
  assert.equal(realCrier.username, "lonecrier2", "master claims the only candidate");
  assert.equal(M.isProCrier(lone, records, NOW), true, "isProCrier wires the real predicate");
  const criers = M.proCriersFor(records, NOW);
  assert.ok(criers.has("lonecrier2"), "proCriersFor reads the real predicate");
  assert.equal(M.pamphleteerfolkTypeOf(lone, criers), null, "claimed crier is never pamphletfolk");
}
// A bigger roster: exactly the record the real predicate picks is excluded,
// and nobody else is.
{
  const records = [];
  for (let i = 0; i < 12; i++) {
    records.push({ username: "crierpool" + i, role: "commoner", kingdom: "kandarin" });
  }
  records.push({ username: "crierpool-merchant", role: "merchant", kingdom: "kandarin" });
  const editionId = ProNewspaper.editionIdFor(NOW);
  const realCrier = ProNewspaper.crierFor("kandarin", records, editionId);
  assert.ok(realCrier, "master picks a crier from the pool");
  const criers = M.proCriersFor(records, NOW);
  assert.equal(criers.size, 1, "one crier per kingdom per week");
  for (const rec of records) {
    const claimed = rec.username === realCrier.username;
    assert.equal(M.isProCrier(rec, records, NOW), claimed, `isProCrier exact for ${rec.username}`);
  }
  // the exclusion wins against the share roll: excluded even if the hash gate fires
  let wouldBeFolk = null;
  for (let i = 0; i < 5000 && !wouldBeFolk; i++) {
    const n = "exclusionwins" + i;
    if (M.pamphleteerfolkTypeOf({ username: n, role: "commoner" }, new Set())) wouldBeFolk = n;
  }
  assert.ok(wouldBeFolk, "found a would-be pamphletfolk name");
  const rec = { username: wouldBeFolk, role: "commoner", kingdom: "misthalin" };
  assert.equal(
    M.pamphleteerfolkTypeOf(rec, new Set([wouldBeFolk])),
    null,
    "crier exclusion beats the share roll"
  );
}
// fail-open: no kingdom, empty records, or hostile input => not a crier.
assert.equal(M.isProCrier({ username: "x", role: "commoner" }, [], NOW), false);
assert.equal(M.isProCrier({ username: "x", role: "commoner" }, null, NOW), false);
assert.equal(M.isProCrier(null, [], NOW), false);
assert.equal(M.isProCrier({ username: null, role: "commoner" }, [], NOW), false);

// --- 5. weighted type rolls cover all types ---
const seen = new Set();
for (let r = 0; r < 100; r++) seen.add(M.folkTypeFromRoll(r));
assert.deepEqual([...seen].sort(), [...typeHits].sort(), "type roll weights cover all types");

// --- 6. fill slots ---
assert.equal(M.fill("A {x} and {x}", { x: "gear" }), "A gear and gear");

// --- 7. hours gates ---
const atHour = (h) => new Date(2026, 9, 8, h, 0, 0).getTime();
assert.ok(M.isWorkHour(atHour(7)), "07:00 is work hour");
assert.ok(M.isWorkHour(atHour(12)), "12:00 is work hour");
assert.ok(!M.isWorkHour(atHour(21)), "21:00 is not work hour");
assert.ok(!M.isWorkHour(atHour(3)), "03:00 is not work hour");
assert.ok(!M.isWorkHour(atHour(6)), "06:00 is not work hour");

// --- 8. cornerFor: kingdom-preferred, stable per day ---
const corner = M.cornerFor({ username: "pamphletfolk7", kingdomId: "misthalin" }, NOW);
assert.equal(corner.kingdom, "misthalin", "misthalin citizen gets a misthalin corner");
assert.equal(
  M.cornerFor({ username: "pamphletfolk7", kingdomId: "misthalin" }, NOW).name,
  corner.name,
  "corner stable per day"
);

// --- 9. retell reads REAL journal events, never invents ---
const j = CitizenJournal.getJournal();
j.log("retellvictim", "kill", "fells a fearsome foe at the crossroads", { at: NOW - 1000 });
const events = M.recentEvents(50);
const mine = events.find((e) => e.who && String(e.text).includes("fells a fearsome foe"));
assert.ok(mine, "real journal event is readable");
assert.equal(mine.kind, "kill", "real kind preserved");
assert.ok(String(mine.text).includes("fells a fearsome foe"), "real text preserved");
const retold = M.retellFrame(mine);
assert.ok(retold.length <= 120, "retell line <= 120 chars");
assert.ok(retold.includes("fells a fearsome foe"), "retell repeats the REAL text");
assert.ok(!/\[fake\]|invented|placeholder/i.test(retold), "retell invents nothing");
// pickEventFor is seeded per day and reads real state.
const picked = M.pickEventFor("pamphletfolk7", NOW);
assert.ok(picked && picked.text, "pickEventFor returns a real event");
assert.equal(M.pickEventFor("pamphletfolk7", NOW).text, picked.text, "event pick stable per day");

// --- 10. paperShoutLine fills from a REAL edition shape ---
const fakeEdition = {
  paper: "The Varrock Voice",
  headlines: ["A citizen fells a fearsome foe — fells a fearsome foe at the crossroads"],
};
const shout = M.paperShoutLine(fakeEdition, M.PAPER_FRAME);
assert.ok(shout.includes("The Varrock Voice"), "real paper name");
assert.ok(shout.includes("fells a fearsome foe"), "real headline");
assert.ok(shout.length <= 120, "shout <= 120 chars");
const posterShout = M.paperShoutLine(fakeEdition, M.POSTER_FRAME);
assert.ok(posterShout.includes("The Varrock Voice"), "poster names the real paper");
assert.ok(posterShout.length <= 120, "poster line <= 120 chars");
assert.equal(typeof M.paperShoutLine(null, M.PAPER_FRAME), "string", "null edition is graceful");

// --- 11. line pools render clean ---
const VARS = { place: "p", paper: "paper", top: "top", who: "w", text: "t" };
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
checkPool(M.HAWK_LINES, "hawk");
checkPool(M.GOSSIP_QUIET_LINES, "gossip-quiet");
checkPool(M.POSTER_LINES, "poster");
for (const frame of [M.GOSSIP_FRAME, M.PAPER_FRAME, M.POSTER_FRAME]) {
  assert.ok(typeof frame === "string" && frame.length > 0, "frame non-empty");
  assert.ok(!/\{[a-z0-9]+\}/.test(M.fill(frame, VARS)), `frame slots fillable: ${frame}`);
}

// --- 12. generic lines never claim invented news ---
for (const line of [...M.HAWK_LINES, ...M.WORK_LINES[M.NEWS_GOSSIP], ...M.WORK_LINES[M.PAMPHLET_SELLER]]) {
  assert.ok(!/extra! extra|breaking:|sources say|rumor has it/i.test(line), `no invented news claims: ${line}`);
}

// --- 13. corners: 12 entries, 2 per kingdom, off professional grounds ---
assert.equal(M.CORNERS.length, 12, "12 poster corners");
const perKingdom = {};
for (const s of M.CORNERS) perKingdom[s.kingdom] = (perKingdom[s.kingdom] || 0) + 1;
for (const [kid, n] of Object.entries(perKingdom)) {
  assert.equal(n, 2, `2 corners for ${kid}`);
}
assert.ok(Object.keys(perKingdom).length >= 6, "at least 6 kingdoms covered");
for (const s of M.CORNERS) {
  assert.ok(
    !/school|academy|temple|workshop|millworks|library|cathedral/i.test(s.name),
    `corner is off professional grounds: ${s.name}`
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

// --- 17. tickPamphleteers never throws on hostile director input ---
assert.doesNotThrow(() => M.tickPamphleteers(null, NOW));
assert.doesNotThrow(() => M.tickPamphleteers({}, NOW));
assert.doesNotThrow(() =>
  M.tickPamphleteers(
    { roster: { values: () => [null, { username: null }] }, isOnline: () => false, getBot: () => null },
    NOW
  )
);
// per-citizen guard: a record whose claim check throws still can't crash
assert.doesNotThrow(() =>
  M.tickPamphleteers(
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
      isOnline: () => true,
      getBot: () => null,
    },
    NOW
  )
);

// --- 18. tickPamphleteers: fires a scripted line for an eligible citizen ---
// The fake director mocks the REAL materialization calls:
// director.isOnline(record)/director.getBot(record), and puts a REAL
// player record in the roster (isPlayerBot false, getUsername present).
reset();
const said = [];
const hourNoon = new Date(2026, 9, 8, 12, 0, 0).getTime();
// find a pamphletfolk citizen deterministically (no kingdom => no crier claim)
let folkName = null;
for (let i = 0; i < 5000 && !folkName; i++) {
  const n = "tickpamphlet" + i;
  if (M.pamphleteerfolkTypeOf({ username: n, role: "commoner" }, new Set())) folkName = n;
}
assert.ok(folkName, "found a pamphletfolk citizen for the tick test");
const folkRec = { username: folkName, role: "commoner" }; // no kingdom: master claims nobody
const playerRec = { username: "RealPlayer", role: "commoner" };
const fakeCitizen = {
  // no getUsername => not a real player; the bot the citizen materializes as
  forceChat: (line) => said.push(line),
  getLocation: () => ({ getX: () => 3200, getY: () => 3200, getZ: () => 0 }),
};
const fakePlayer = {
  isPlayerBot: () => false,
  getUsername: () => "RealPlayer",
  getLocation: () => ({ getX: () => 3205, getY: () => 3205, getZ: () => 0 }),
};
const director = {
  roster: { values: () => [folkRec, playerRec] },
  isOnline: (rec) => rec === folkRec || rec === playerRec,
  getBot: (rec) => (rec === folkRec ? fakeCitizen : rec === playerRec ? fakePlayer : null),
  aiTickCount: 0,
};
// force the chance gate: Math.random patch scoped to the call
const origRandom = Math.random;
Math.random = () => 0.05; // below FOLK_CHANCE; noon -> work path
try {
  M.tickPamphleteers(director, hourNoon, { tick: 0 });
} finally {
  Math.random = origRandom;
}
assert.ok(said.length > 0, `citizen said something: ${JSON.stringify(said)}`);
assert.ok(said[0].length <= 120, "line length cap");
console.log("sample tick line:", said[0]);

// --- 19. cooldown: the same citizen cannot fire twice within 3h ---
const saidCount = said.length;
Math.random = () => 0.05;
try {
  M.tickPamphleteers(director, hourNoon + 60 * 1000, { tick: 0 });
} finally {
  Math.random = origRandom;
}
assert.equal(said.length, saidCount, "cooldown holds within 3h");
// ...but fires again after the cooldown passes.
Math.random = () => 0.05;
try {
  M.tickPamphleteers(director, hourNoon + 4 * 3600 * 1000, { tick: 0 });
} finally {
  Math.random = origRandom;
}
assert.ok(said.length > saidCount, "fires again after cooldown");

console.log("ALL CITIZENNEWSPAPER2 TESTS PASSED");
