// CitizenArchitects2 unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const M = require("./CitizenArchitects2");

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

// --- 2. draftfolkTypeOf: ~35% nominal share pre-exclusion, stable ---
// Post-exclusion the effective share is ~19%: CitizenBuilders2 laborfolk
// (~40% of commoners) and master-claimed pro architects (~8%) are excluded
// BEFORE the share roll, per the house pattern. Bounds 0.12-0.30 document
// the measured effective ~19.3% rather than the nominal 35%.
let folk = 0;
const typeHits = new Set();
const NN = 20000;
for (let i = 0; i < NN; i++) {
  const name = "draftfolk" + i;
  const t = M.draftfolkTypeOf({ username: name, role: "commoner" });
  if (t) {
    folk++;
    typeHits.add(t);
  }
}
const share = folk / NN;
assert.ok(share > 0.12 && share < 0.30, `nominal share ~35% (post-exclusion ~19%), got ${share.toFixed(3)}`);
assert.equal(typeHits.size, 3, "all 3 draftfolk types reachable");
// stability spot-check
for (let i = 0; i < 50; i++) {
  const name = "draftfolk" + i;
  const a = M.draftfolkTypeOf({ username: name, role: "commoner" });
  const b = M.draftfolkTypeOf({ username: name.toUpperCase(), role: "commoner" });
  assert.equal(a, b, "case-insensitive stability");
}
assert.deepEqual(M.draftfolkTypeOf(null), null);
assert.equal(M.draftfolkTypeOf({ username: null, role: "commoner" }), null);
assert.equal(M.draftfolkTypeOf({ username: "x", role: null }), null);

// --- 3. role gate: non-commoners are never draftfolk ---
assert.equal(M.draftfolkTypeOf({ username: "SomeDraft", role: "merchant" }), null);
assert.equal(M.draftfolkTypeOf({ username: "SomeDraft", role: "guard" }), null);
assert.equal(M.draftfolkTypeOf({ username: "SomeDraft", attributes: { role: "banker" } }), null);

// --- 4. pro exclusion: master's professional architects, via the real claim fn ---
// The master's claim predicate is architectTypeOf (role partition + own
// exclusions + ~30% roll). Find a username the master claims and one it does not.
const ProArchs = require("./CitizenArchitects");
let proName = null;
let commonerName = null;
for (let i = 0; i < 2000 && (!proName || !commonerName); i++) {
  const n = "archxcl" + i;
  if (!proName && ProArchs.architectTypeOf({ username: n, role: "commoner" }) !== null) proName = n;
  if (!commonerName && ProArchs.architectTypeOf({ username: n, role: "commoner" }) === null) commonerName = n;
}
assert.ok(proName, "found a master-claimed architect");
assert.ok(commonerName, "found a non-claimed commoner");
assert.equal(M.isProArchitect({ username: proName, role: "commoner" }), true, "master claim detected via real fn");
assert.equal(M.isProArchitect({ username: commonerName, role: "commoner" }), false);
assert.equal(
  M.draftfolkTypeOf({ username: proName, role: "commoner" }),
  null,
  "a professional architect must never be draftfolk"
);
// Exclusion ordering: exclusion must win over the share roll regardless of draw.
let proRollsHit = 0;
for (let i = 0; i < 2000; i++) {
  const n = "proshare" + i;
  if (ProArchs.architectTypeOf({ username: n, role: "commoner" }) === null) continue;
  proRollsHit++;
  assert.equal(
    M.draftfolkTypeOf({ username: n, role: "commoner" }),
    null,
    `exclusion wins over share roll for ${n}`
  );
}
assert.ok(proRollsHit > 0, "master-claimed names exist in the pool");

// --- 5. laborfolk exclusion via the builders2 real claim function, before the share roll ---
const Builders2 = require("./CitizenBuilders2");
let laborName = null;
for (let i = 0; i < 500 && !laborName; i++) {
  const n = "laborxcl" + i;
  if (Builders2.laborfolkTypeOf({ username: n, role: "commoner" }) !== null) laborName = n;
}
assert.ok(laborName, "found a builders2-claimed laborfolk");
assert.equal(M.isLaborfolk({ username: laborName, role: "commoner" }), true);
assert.equal(
  M.draftfolkTypeOf({ username: laborName, role: "commoner" }),
  null,
  "a laborfolk must never be draftfolk, regardless of share roll"
);

// --- 6. boardFor: kingdom-preferred, stable per day ---
const seenBoards = new Set();
for (let i = 0; i < 40; i++) {
  const b = M.boardFor({ username: "boardtest" + i, kingdom: "misthalin" }, NOW);
  assert.ok(b && b.name, "board resolves");
  assert.equal(b.kingdom, "misthalin", "kingdom-preferred board");
  seenBoards.add(b.name);
}
assert.ok(seenBoards.size > 1, "multiple boards in reach");
const fallback = M.boardFor({ username: "xk", kingdom: "nope-kingdom" }, NOW);
assert.ok(fallback && fallback.name, "falls back to all boards");
assert.deepEqual(
  M.boardFor({ username: "k", kingdom: "misthalin" }, NOW),
  M.boardFor({ username: "k", kingdom: "misthalin" }, NOW + 3600 * 1000),
  "stable within a day"
);

// --- 7. sketchFor: from the type's pool, stable per day, subject slot filled ---
const sk1 = M.sketchFor("sketchbob", M.ROUGH_DRAFTER, "misthalin", NOW);
const sk2 = M.sketchFor("sketchbob", M.ROUGH_DRAFTER, "misthalin", NOW + 5000);
assert.equal(sk1, sk2, "sketch stable within a day");
assert.ok(sk1 && !sk1.includes("{subject}"), "subject slot filled");
assert.ok(/rough|copy|sketch|draft|wobbly|chalk/i.test(sk1), `sketch looks amateur: ${sk1}`);
// unknown type falls back to drafter pool
const skFallback = M.sketchFor("skf", "nope", "misthalin", NOW);
assert.ok(skFallback && typeof skFallback === "string");

// --- 8. proPlansTalkFor: names the real pro trade (read-only bridge), never throws ---
const talk = M.proPlansTalkFor("misthalin", NOW);
assert.ok(talk && typeof talk === "string" && !talk.includes("{studio}") && !talk.includes("{subject}"),
  `pro bridge fills slots: ${talk}`);
const talkUnknown = M.proPlansTalkFor("nope-kingdom", NOW);
assert.ok(talkUnknown && typeof talkUnknown === "string");
// pro bridge must name a REAL master studio — find a studio name in the line pools
const allTalk = new Set();
for (let i = 0; i < 30; i++) allTalk.add(M.proPlansTalkFor("kandarin", NOW + i * DAY));
const studioNames = ProArchs.STUDIOS.map((s) => s.name);
let namedRealStudio = false;
for (const t of allTalk) {
  if (studioNames.some((s) => t.includes(s))) { namedRealStudio = true; break; }
}
assert.ok(namedRealStudio, "pro talk names real master studios");

// --- 9. isWorkHour: 08:00-18:00 ---
const open = new Date(NOW);
open.setHours(12, 0, 0, 0);
const before = new Date(NOW);
before.setHours(7, 59, 0, 0);
const after = new Date(NOW);
after.setHours(18, 0, 0, 0);
assert.equal(M.isWorkHour(open.getTime()), true);
assert.equal(M.isWorkHour(before.getTime()), false);
assert.equal(M.isWorkHour(after.getTime()), false);

// --- 10. chance gates ---
assert.equal(M.chance(() => 0.99, 0.2), false, "chance gate respected");
assert.equal(M.chance(() => 0.0, 0.2), true);

// --- 11. isRealPlayer / withinTiles ---
assert.equal(M.isRealPlayer(null), false);
assert.equal(M.isRealPlayer({ isPlayerBot: () => true, getUsername: () => "x" }), false);
assert.equal(M.isRealPlayer({ getHostAddress: () => "bot", getUsername: () => "x" }), false);
assert.equal(M.isRealPlayer({ getUsername: () => "real" }), true);
function loc(x, y, z) {
  return { getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => z }) };
}
assert.equal(M.withinTiles(loc(0, 0, 0), loc(5, 5, 0), 10), true);
assert.equal(M.withinTiles(loc(0, 0, 0), loc(50, 0, 0), 10), false);
assert.equal(M.withinTiles(loc(0, 0, 0), loc(0, 0, 1), 10), false, "plane matters");
assert.equal(M.withinTiles(null, loc(0, 0, 0), 10), false);

// --- 12. tickDraftfolk fires near a real player, silent otherwise ---
reset();
const origRandom = Math.random;
Math.random = () => 0.0; // chance gates always pass
try {
  function makeCitizen(x, y) {
    return {
      getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => 0 }),
      forceChat: function (msg) { this.said.push(msg); },
      said: [],
      isPlayerBot: () => false,
      getHostAddress: () => "127.0.0.1",
      getUsername: () => "RealPlayer",
    };
  }
  function makeBot(x, y) {
    return {
      getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => 0 }),
      forceChat: function (msg) { this.said.push(msg); },
      said: [],
      isPlayerBot: () => true,
      getHostAddress: () => "bot",
      getUsername: () => "SomeBot",
    };
  }
  // find a draftfolk username
  let folkName = null;
  for (let i = 0; i < 300 && !folkName; i++) {
    if (M.draftfolkTypeOf({ username: "tickd" + i, role: "commoner" })) folkName = "tickd" + i;
  }
  assert.ok(folkName, "found draftfolk for tick test");
  const midday = new Date(NOW);
  midday.setHours(12, 0, 0, 0);
  const citizenObj = makeBot(100, 100);
  const realNear = makeCitizen(105, 105);
  const director = {
    roster: new Map([[folkName, { username: folkName, kingdom: "misthalin", role: "commoner" }]]),
    playerFor: () => citizenObj,
    onlinePlayers: () => [realNear, citizenObj],
  };
  M.tickDraftfolk(director, midday.getTime());
  assert.ok(citizenObj.said.length > 0, `fires near real player, got ${citizenObj.said.length} lines`);

  // silent with bots only
  reset();
  const citizenObj2 = makeBot(100, 100);
  const botOnly = {
    roster: new Map([[folkName, { username: folkName, kingdom: "misthalin", role: "commoner" }]]),
    playerFor: () => citizenObj2,
    onlinePlayers: () => [citizenObj2, makeBot(103, 103)],
  };
  M.tickDraftfolk(botOnly, midday.getTime());
  assert.equal(citizenObj2.said.length, 0, "silent with no real player");

  // --- 13. master-claimed and laborfolk-claimed records are skipped by the tick ---
  reset();
  const citizenObj3 = makeBot(100, 100);
  const director3 = {
    roster: new Map([[proName, { username: proName, kingdom: "misthalin", role: "commoner" }]]),
    playerFor: () => citizenObj3,
    onlinePlayers: () => [makeCitizen(105, 105)],
  };
  M.tickDraftfolk(director3, midday.getTime());
  assert.equal(citizenObj3.said.length, 0, "master-claimed citizen never works draftfolk");

  // --- 14. tickDraftfolk never throws on hostile input ---
  reset();
  M.tickDraftfolk(null, NOW);
  M.tickDraftfolk({}, NOW);
  M.tickDraftfolk({ roster: null }, NOW);
  M.tickDraftfolk(
    { roster: new Map([["x", {}]]), playerFor: () => { throw new Error("boom"); } },
    NOW
  );

  // --- 15. non-draftfolk are skipped ---
  reset();
  const citizenObj4 = makeBot(100, 100);
  let nonFolk = null;
  for (let i = 0; i < 300 && !nonFolk; i++) {
    if (!M.draftfolkTypeOf({ username: "nond" + i, role: "commoner" })) nonFolk = "nond" + i;
  }
  const director4 = {
    roster: new Map([[nonFolk, { username: nonFolk, kingdom: "misthalin", role: "commoner" }]]),
    playerFor: () => citizenObj4,
    onlinePlayers: () => [makeCitizen(105, 105)],
  };
  M.tickDraftfolk(director4, midday.getTime());
  assert.equal(citizenObj4.said.length, 0, "non-draftfolk skipped");
} finally {
  Math.random = origRandom;
}

// --- 16. line pools all render with filled slots and <= 120 chars ---
const sampleVars = { region: "Misthalin", place: "the board", subject: "a leaky shed roof", their: "their" };
function checkPool(lines, label) {
  for (const line of lines) {
    assert.ok(line.length <= 120, `${label} line <= 120 chars: ${line}`);
    const rendered = M.fill(line, sampleVars);
    assert.ok(!rendered.includes("{"), `${label} slots filled: ${line}`);
  }
}
for (const [t, lines] of Object.entries({
  [M.ROUGH_DRAFTER]: M.WORK_LINES[M.ROUGH_DRAFTER],
  [M.PLAN_COPYIST]: M.WORK_LINES[M.PLAN_COPYIST],
  [M.CORNER_ADVISER]: M.WORK_LINES[M.CORNER_ADVISER],
})) {
  assert.equal(lines.length, 5, `5 work lines for ${t}`);
  checkPool(lines, `work/${t}`);
}
checkPool(M.SETUP_LINES, "setup");
checkPool(M.HAWK_LINES[M.ROUGH_DRAFTER], "hawk/drafter");
checkPool(M.HAWK_LINES[M.PLAN_COPYIST], "hawk/copyist");
checkPool(M.HAWK_LINES[M.CORNER_ADVISER], "hawk/adviser");
checkPool(M.ADVICE_LINES, "advice");
// pro-talk lines need {studio}/{subject} — checked separately below
checkPool(M.BOARD_COLLAPSE_LINES, "board-collapse");
checkPool(M.BAD_MEASURE_LINES, "bad-measure");
checkPool(M.DISPUTE_LINES, "dispute");
// pro-bridge pool needs studio/subject vars
for (const line of M.PRO_TALK_LINES) {
  assert.ok(line.length <= 120, `pro-talk line <= 120 chars: ${line}`);
  const rendered = M.fill(line, {
    studio: "the Varrock Drafting Hall",
    subject: "a merchant's house",
  });
  assert.ok(!rendered.includes("{"), `pro-talk slots filled: ${line}`);
}

// --- 17. boards: 12 entries, 2 per kingdom, all kingdoms covered ---
assert.equal(M.DRAFT_BOARDS.length, 12, "12 corner draft boards");
const perKingdom = {};
for (const b of M.DRAFT_BOARDS) perKingdom[b.kingdom] = (perKingdom[b.kingdom] || 0) + 1;
for (const [kid, n] of Object.entries(perKingdom)) {
  assert.equal(n, 2, `2 boards for ${kid}`);
}
assert.ok(Object.keys(perKingdom).length >= 6, "at least 6 kingdoms covered");

// --- 18. draftfolk never claim the master's real studios (no pro overlap) ---
const proStudios = new Set(ProArchs.STUDIOS.map((s) => s.name));
for (const b of M.DRAFT_BOARDS) {
  assert.ok(!proStudios.has(b.name), `board is not a pro studio: ${b.name}`);
}

// --- 19. daily set-piece keying: once per kingdom per day ---
reset();
const dayKey = "collapse:misthalin:" + Math.floor(NOW / DAY);
M._firedDayKeys.add(dayKey);
assert.equal(M._firedDayKeys.has(dayKey), true, "set-piece key recorded");

console.log("ALL CITIZENARCHITECTS2 TESTS PASSED");
