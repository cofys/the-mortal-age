// CitizenElection unit checks — pure logic + fakes, no running server.
// From server/plugins/citizens: node lib/CitizenElection.test.js (plain node)
const assert = require("node:assert/strict");

const {
  POSITIONS,
  POSITION_KEYS,
  raceKey,
  hash01,
  platformFor,
  candidateFit,
  pickCandidates,
  voterScore,
  tallyVotes,
  newRace,
  advanceRace,
  handleEndorsement,
  NOMINATIONS_MS,
  CAMPAIGN_MS,
  VOTING_MS,
  RESULTS_MS,
  TERM_MS,
  _races,
} = require("./CitizenElection");
const { getJournal } = require("./CitizenJournal");

// Tiny deterministic LCG so coverage is exact, not luck-based.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

function cleanup() {
  _races.clear();
  try {
    getJournal().resetForTests();
  } catch { /* non-fatal */ }
}

// --- fakes ---------------------------------------------------------------------

function fakeRecord(username, kingdomId, role, traits) {
  return {
    username,
    kingdomId,
    role,
    personality: { traits },
  };
}

function fakeDirector(records) {
  const roster = new Map();
  for (const r of records) roster.set(r.username.toLowerCase(), r);
  return {
    roster,
    playerFor: () => null,
    onlinePlayers: () => [],
  };
}

// --- platform -------------------------------------------------------------------

test("platformFor: greedy merchant leans pro-trade mayor", () => {
  assert.equal(platformFor(["greedy", "ambitious"], "mayor"), "pro-trade");
});

test("platformFor: devout citizen leans pro-tradition mayor", () => {
  assert.equal(platformFor(["devout", "dutiful"], "mayor"), "pro-tradition");
});

test("platformFor: dutiful guard leans strict sheriff", () => {
  assert.equal(platformFor(["dutiful", "gruff"], "sheriff"), "strict");
});

test("platformFor: warm citizen leans lenient sheriff", () => {
  assert.equal(platformFor(["warm", "merciful"], "sheriff"), "lenient");
});

test("platformFor: curious merchant leans innovator guildmaster", () => {
  assert.equal(platformFor(["curious", "ambitious"], "guildmaster"), "innovator");
});

test("platformFor: unknown position returns null", () => {
  assert.equal(platformFor(["greedy"], "king"), null);
});

test("platformFor: no traits picks first stance deterministically", () => {
  assert.equal(platformFor([], "mayor"), "pro-trade");
  assert.equal(platformFor(undefined, "sheriff"), "strict");
});

// --- candidate fit ----------------------------------------------------------------

test("candidateFit: guards fit sheriff better than merchants", () => {
  const guard = fakeRecord("G1", "asgarnia", "guard", ["dutiful"]);
  const merch = fakeRecord("M1", "asgarnia", "merchant", ["dutiful"]);
  assert.ok(candidateFit(guard, "sheriff", null) > candidateFit(merch, "sheriff", null));
});

test("candidateFit: incumbent gets bonus", () => {
  const r = fakeRecord("Inc", "asgarnia", "guard", ["dutiful"]);
  const withInc = candidateFit(r, "sheriff", { holder: "Inc", history: [] });
  const without = candidateFit(r, "sheriff", { holder: "Other", history: [] });
  assert.ok(withInc > without);
});

test("candidateFit: past losers get sympathy weight", () => {
  const r = fakeRecord("Loser", "asgarnia", "commoner", ["dutiful"]);
  const race = { holder: null, history: [{ winner: "X", runnerUp: "Loser", at: 1 }] };
  assert.ok(candidateFit(r, "mayor", race) > candidateFit(r, "mayor", { holder: null, history: [] }));
});

test("pickCandidates: returns at most 3 eligible records", () => {
  const rng = lcg(42);
  const elig = [
    fakeRecord("A", "asgarnia", "merchant", ["greedy"]),
    fakeRecord("B", "asgarnia", "commoner", ["devout"]),
    fakeRecord("C", "asgarnia", "guard", ["dutiful"]),
    fakeRecord("D", "asgarnia", "courtier", ["proud"]),
    fakeRecord("E", "asgarnia", "refugee", ["timid"]), // ineligible role
  ];
  const picked = pickCandidates(rng, elig, "mayor", null);
  assert.ok(picked.length <= 3 && picked.length >= 1);
  assert.ok(picked.every((p) => ["merchant", "commoner", "courtier", "guard"].includes(p.role)));
  assert.ok(!picked.some((p) => p.username === "E"));
});

// --- voting -----------------------------------------------------------------------

test("voterScore: endorsement adds weight", () => {
  const voter = fakeRecord("V", "asgarnia", "commoner", []);
  const cand = { username: "C", position: "mayor" };
  const base = voterScore(voter, cand, "pro-trade", [], []);
  const endorsed = voterScore(voter, cand, "pro-trade",
    [{ playerName: "P", candidate: "C" }], []);
  assert.ok(endorsed > base);
});

test("voterScore: trait alignment beats no alignment", () => {
  const aligned = fakeRecord("V1", "asgarnia", "commoner", ["greedy", "ambitious"]);
  const plain = fakeRecord("V2", "asgarnia", "commoner", ["timid"]);
  const cand = { username: "C", position: "mayor" };
  assert.ok(
    voterScore(aligned, cand, "pro-trade", [], []) >
    voterScore(plain, cand, "pro-trade", [], []));
});

test("tallyVotes: clear favorite wins deterministically", () => {
  const rng = lcg(7);
  const voters = [
    fakeRecord("V1", "asgarnia", "commoner", ["greedy"]),
    fakeRecord("V2", "asgarnia", "commoner", ["greedy", "ambitious"]),
    fakeRecord("V3", "asgarnia", "commoner", ["greedy"]),
  ];
  const cands = [
    { username: "Pro", position: "mayor", stance: "pro-trade" },
    { username: "Trad", position: "mayor", stance: "pro-tradition" },
  ];
  const { votes, winner } = tallyVotes(rng, voters, cands, [], []);
  assert.equal(winner, "Pro");
  assert.equal(votes.Pro + votes.Trad, 3);
});

// --- race lifecycle -----------------------------------------------------------------

function raceAt(phase, nowMs, overrides = {}) {
  return Object.assign({
    kingdomId: "asgarnia",
    position: "mayor",
    phase,
    phaseEndsAt: nowMs - 1, // due
    termEndsAt: nowMs - 1,
    holder: null,
    policy: null,
    candidates: [],
    votes: {},
    endorsements: [],
    history: [],
  }, overrides);
}

test("newRace: starts idle with staggered delay", () => {
  const now = 1_000_000;
  const r = newRace("asgarnia", "mayor", now);
  assert.equal(r.phase, "idle");
  assert.ok(r.phaseEndsAt >= now && r.phaseEndsAt <= now + 14 * 24 * 3600 * 1000);
});

test("newRace: different races stagger differently", () => {
  const now = 1_000_000;
  const delays = new Set(
    ["asgarnia", "kandarin", "morytania"].map((k) => newRace(k, "mayor", now).phaseEndsAt));
  assert.ok(delays.size > 1);
});

test("advanceRace: idle -> nominations when due", () => {
  const now = 5_000_000;
  const director = fakeDirector([fakeRecord("A", "asgarnia", "commoner", [])]);
  const race = raceAt("idle", now);
  const ann = advanceRace(lcg(1), director, race, now);
  assert.equal(race.phase, "nominations");
  assert.equal(race.phaseEndsAt, now + NOMINATIONS_MS);
  assert.ok(ann.some((a) => a.kind === "nominations"));
});

test("advanceRace: idle not due stays idle", () => {
  const now = 5_000_000;
  const director = fakeDirector([]);
  const race = raceAt("idle", now, { phaseEndsAt: now + 99999 });
  const ann = advanceRace(lcg(1), director, race, now);
  assert.equal(race.phase, "idle");
  assert.equal(ann.length, 0);
});

test("advanceRace: nominations -> campaigning picks candidates with platforms", () => {
  const now = 5_000_000;
  const director = fakeDirector([
    fakeRecord("A", "asgarnia", "merchant", ["greedy"]),
    fakeRecord("B", "asgarnia", "commoner", ["devout"]),
    fakeRecord("C", "asgarnia", "guard", ["dutiful"]),
    fakeRecord("D", "asgarnia", "courtier", ["proud"]),
  ]);
  const race = raceAt("nominations", now);
  advanceRace(lcg(3), director, race, now);
  assert.equal(race.phase, "campaigning");
  assert.equal(race.phaseEndsAt, now + CAMPAIGN_MS);
  assert.ok(race.candidates.length >= 1 && race.candidates.length <= 3);
  assert.ok(race.candidates.every((c) => POSITIONS.mayor.stances.includes(c.stance)));
});

test("advanceRace: campaigning -> voting", () => {
  const now = 5_000_000;
  const director = fakeDirector([]);
  const race = raceAt("campaigning", now, {
    candidates: [{ username: "A", position: "mayor", stance: "pro-trade" }],
  });
  advanceRace(lcg(1), director, race, now);
  assert.equal(race.phase, "voting");
  assert.equal(race.phaseEndsAt, now + VOTING_MS);
});

test("advanceRace: voting -> results declares winner and journals", () => {
  const now = 5_000_000;
  const director = fakeDirector([
    fakeRecord("Pro", "asgarnia", "merchant", ["greedy"]),
    fakeRecord("Trad", "asgarnia", "commoner", ["devout"]),
    fakeRecord("V1", "asgarnia", "commoner", ["greedy", "ambitious"]),
    fakeRecord("V2", "asgarnia", "commoner", ["greedy"]),
  ]);
  const race = raceAt("voting", now, {
    candidates: [
      { username: "Pro", position: "mayor", stance: "pro-trade" },
      { username: "Trad", position: "mayor", stance: "pro-tradition" },
    ],
  });
  const ann = advanceRace(lcg(9), director, race, now);
  assert.equal(race.phase, "results");
  assert.equal(race.phaseEndsAt, now + RESULTS_MS);
  assert.ok(race.winner);
  assert.equal(race.history.length, 1);
  assert.equal(race.history[0].winner, race.winner);
  assert.ok(ann.some((a) => a.kind === "results"));
});

test("advanceRace: results -> idle seats holder with policy", () => {
  const now = 5_000_000;
  const director = fakeDirector([]);
  const race = raceAt("results", now, {
    winner: "Pro",
    candidates: [{ username: "Pro", position: "sheriff", stance: "strict" }],
    position: "sheriff",
  });
  const ann = advanceRace(lcg(1), director, race, now);
  assert.equal(race.phase, "idle");
  assert.equal(race.holder, "Pro");
  assert.equal(race.policy, POSITIONS.sheriff.policies.strict);
  assert.equal(race.phaseEndsAt, now + TERM_MS);
  assert.ok(ann.some((a) => a.kind === "inauguration"));
});

test("advanceRace: full cycle ends with holder in office", () => {
  const now = 10_000_000;
  const mk = (u, role, traits) => fakeRecord(u, "kandarin", role, traits);
  const director = fakeDirector([
    mk("A", "merchant", ["greedy"]),
    mk("B", "commoner", ["devout"]),
    mk("C", "guard", ["dutiful"]),
    mk("D", "courtier", ["proud"]),
    mk("E", "commoner", ["greedy", "ambitious"]),
  ]);
  const race = raceAt("idle", now, { kingdomId: "kandarin" });
  let t = now;
  const expected = ["nominations", "campaigning", "voting", "results", "idle"];
  for (const want of expected) {
    t = race.phaseEndsAt + 1;
    advanceRace(lcg(11), director, race, t);
    assert.equal(race.phase, want);
  }
  assert.ok(race.holder);
  assert.ok(race.policy);
  assert.equal(race.history.length, 1);
});

// --- endorsements ---------------------------------------------------------------------

test("handleEndorsement: records endorsement during campaigning", () => {
  const director = fakeDirector([]);
  _races.set("asgarnia:mayor", raceAt("campaigning", Date.now(), {
    candidates: [{ username: "A", position: "mayor", stance: "pro-trade" }],
  }));
  const ok = handleEndorsement(director, {
    kingdomId: "asgarnia", position: "mayor", playerName: "Hero", candidate: "A",
  });
  assert.equal(ok, true);
  assert.equal(_races.get("asgarnia:mayor").endorsements.length, 1);
});

test("handleEndorsement: rejects duplicates", () => {
  const director = fakeDirector([]);
  _races.set("asgarnia:mayor", raceAt("campaigning", Date.now(), {
    candidates: [{ username: "A", position: "mayor", stance: "pro-trade" }],
    endorsements: [{ playerName: "Hero", candidate: "A", at: 1 }],
  }));
  const ok = handleEndorsement(director, {
    kingdomId: "asgarnia", position: "mayor", playerName: "hero", candidate: "a",
  });
  assert.equal(ok, false);
});

test("handleEndorsement: rejected outside campaign window", () => {
  const director = fakeDirector([]);
  _races.set("asgarnia:mayor", raceAt("idle", Date.now()));
  const ok = handleEndorsement(director, {
    kingdomId: "asgarnia", position: "mayor", playerName: "Hero", candidate: "A",
  });
  assert.equal(ok, false);
});

test("handleEndorsement: rejected for unknown position", () => {
  const director = fakeDirector([]);
  const ok = handleEndorsement(director, {
    kingdomId: "asgarnia", position: "king", playerName: "Hero", candidate: "A",
  });
  assert.equal(ok, false);
});

// --- misc -------------------------------------------------------------------------------

test("raceKey: kingdom:position format", () => {
  assert.equal(raceKey("asgarnia", "mayor"), "asgarnia:mayor");
});

test("hash01: deterministic in [0,1)", () => {
  const a = hash01("asgarnia:mayor");
  assert.equal(a, hash01("asgarnia:mayor"));
  assert.ok(a >= 0 && a < 1);
  assert.notEqual(a, hash01("kandarin:mayor"));
});

test("POSITION_KEYS: mayor, sheriff, guildmaster", () => {
  assert.deepEqual([...POSITION_KEYS].sort(), ["guildmaster", "mayor", "sheriff"]);
});

// --- runner -------------------------------------------------------------------------------

let passed = 0;
let failed = 0;
for (const [name, fn] of tests) {
  cleanup();
  try {
    fn();
    passed += 1;
  } catch (e) {
    failed += 1;
    console.error(`FAIL: ${name}\n  ${e.message}`);
  }
}
cleanup();
console.log(`${passed}/${tests.length} passed`);
if (failed) process.exit(1);
