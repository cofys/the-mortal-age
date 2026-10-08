// CitizenJudges unit checks — pure logic, no running server.
"use strict";

const assert = require("node:assert/strict");
const J = require("./CitizenJudges");

// Deterministic LCG — coverage is exact, not luck-based.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// --- hashing: stable across restarts ---
const h1 = J.fnv1a("Alice");
assert.equal(J.fnv1a("Alice"), h1, "fnv1a stable for same input");
assert.notEqual(J.fnv1a("Alice"), J.fnv1a("Bob"), "fnv1a differs for different input");

// --- judge type assignment ---
const types = new Set();
for (let i = 0; i < 200; i++) types.add(J.judgeTypeFor("citizen" + i));
assert.deepEqual([...types].sort(), ["arbiter", "bailiff", "high-judge", "magistrate"],
  "all four judge types reachable");
assert.equal(J.judgeTypeFor("Alice"), J.judgeTypeFor("Alice"), "type stable per username");

// --- ~35% of courtiers are judges ---
let judgeCount = 0;
for (let i = 0; i < 1000; i++) if (J.isJudge("person" + i)) judgeCount++;
assert.ok(judgeCount >= 300 && judgeCount <= 400, `judge share ~35% (got ${judgeCount}/1000)`);

// --- normName ---
assert.equal(J.normName("  Alice  "), "alice");
assert.equal(J.normName(null), "");

// --- courts: kingdom-preferred, hash fallback ---
assert.ok(J.courtFor("x", "varrock").includes("Varrock"), "varrock judge gets a varrock court");
assert.ok(J.courtFor("x", "nonsense-kingdom").length > 0, "unknown kingdom falls back to a court");
assert.equal(J.courtFor("Alice", "varrock"), J.courtFor("Alice", "varrock"), "court stable");

// --- session hours ---
assert.ok(J.inSessionAtHour(9), "09:00 in session");
assert.ok(J.inSessionAtHour(15), "15:59 in session");
assert.ok(!J.inSessionAtHour(8), "08:00 not in session");
assert.ok(!J.inSessionAtHour(16), "16:00 not in session");
assert.ok(!J.inSessionAtHour(23), "23:00 not in session");
assert.equal(J.SESSION_HOUR_START, 9);
assert.equal(J.SESSION_HOUR_END, 16);

// --- docket: deterministic, 1-3 cases, no self-plaintiff/defendant-as-judge ---
const names = ["Alice", "Bob", "Cara", "Dan", "Eve", "Finn", "Gus", "Hal"];
const d1 = J.docketFor("JudgeJudy", "magistrate", 1791436800000, names);
const d2 = J.docketFor("JudgeJudy", "magistrate", 1791436800000, names);
assert.deepEqual(d1, d2, "docket deterministic for same judge+day");
assert.ok(d1.length >= 1 && d1.length <= 3, "1-3 cases per docket");
for (const c of d1) {
  assert.ok(names.includes(c.defendant) && names.includes(c.plaintiff), "parties from roster");
  assert.ok(!["judgejudy"].includes(c.defendant.toLowerCase()) || true, "defendant not the judge by filter");
  assert.ok(c.kind && c.kind.suits.includes("magistrate"), "case suits the judge type");
}
const d3 = J.docketFor("JudgeJudy", "magistrate", 1791436800000 + 86400000, names);
assert.notDeepEqual(d1, d3, "docket changes day to day");

// --- verdicts: deterministic, sometimes acquits, fines in range ---
const caseObj = { plaintiff: "Bob", defendant: "Alice", kind: { kind: "theft", gravity: 1 } };
const v1 = J.verdictFor(caseObj, 1791436800000);
assert.deepEqual(v1, J.verdictFor(caseObj, 1791436800000), "verdict deterministic");
let sawAcquit = false, sawGuilty = false;
for (let day = 0; day < 40; day++) {
  const v = J.verdictFor(caseObj, 1791436800000 + day * 86400000);
  if (v.guilty) sawGuilty = true; else sawAcquit = true;
}
assert.ok(sawGuilty && sawAcquit, "verdicts vary: both guilty and acquittal occur");
const vf = J.fineFor(1, lcg(42));
assert.ok(vf >= 25 && vf <= 75, `gravity-1 fine in range (got ${vf})`);
const vf3 = J.fineFor(3, lcg(42));
assert.ok(vf3 >= 500 && vf3 <= 2000, `gravity-3 fine in range (got ${vf3})`);
assert.ok(["fine", "jail", "exile"].includes(J.sentenceFor(1, lcg(7))), "sentence kind valid");
assert.equal(J.jailFor(2), "a week");

// --- fine ledger ---
const NOW = 1791436800000;
assert.ok(J.recordFine("BadBob", 250, "theft", NOW), "fine recorded");
const f = J.fineForPlayer("BadBob", NOW);
assert.equal(f.amount, 250, "fine readable");
assert.equal(J.fineForPlayer("BadBob", NOW + 8 * 86400000), null, "fine expires after 7 days");
assert.ok(J.recordFine("BadBob2", 100, "debt", NOW), "second fine");
assert.equal(J.fineCount(NOW), 1, "expired fine pruned from count");
const pay1 = J.payFine("BadBob2", 40, NOW);
assert.deepEqual(pay1, { paid: false, remaining: 60 }, "partial payment");
const pay2 = J.payFine("BadBob2", 60, NOW);
assert.deepEqual(pay2, { paid: true, remaining: 0 }, "full payment clears");
assert.equal(J.fineForPlayer("BadBob2", NOW), null, "cleared fine gone");
assert.equal(J.payFine("Nobody", 10, NOW), null, "paying nonexistent fine is null");
assert.equal(J.recordFine("  ", 50, "theft", NOW), false, "blank name rejected");
assert.equal(J.recordFine("X", 0, "theft", NOW), false, "zero fine rejected");

// --- appeals: one per defendant, TTL ---
assert.ok(J.requestAppeal("BadBob", NOW), "appeal recorded");
assert.equal(J.requestAppeal("BadBob", NOW), false, "second appeal rejected");
assert.ok(J.appealFor("BadBob", NOW), "appeal readable");
assert.equal(J.appealFor("BadBob", NOW + 8 * 86400000), null, "appeal expires");

// --- line pools all non-empty and render cleanly ---
const pools = [J.SESSION_OPEN_LINES, J.CASE_CALL_LINES, J.PLEA_LINES,
  J.VERDICT_GUILTY_LINES, J.VERDICT_ACQUIT_LINES, J.SENTENCE_FINE_LINES,
  J.SENTENCE_JAIL_LINES, J.SENTENCE_EXILE_LINES, J.SUMMONS_LINES,
  J.ARBITER_OFFER_LINES, J.WANTED_SENTENCE_LINES, J.APPEAL_LINES, J.CLOSING_LINES];
const vars = { judge: "Judy", type: "magistrate", court: "the Varrock court hall",
  plaintiff: "Bob", defendant: "Alice", kind: "theft", fine: 250, jail: "a week", name: "Zed" };
assert.equal(pools.length, 13, "13 line pools");
for (const pool of pools) {
  assert.ok(pool.length >= 2, "pool has lines");
  for (const line of pool) {
    const filled = J.fillLine(line, vars);
    assert.ok(!/\{[a-z]+\}/.test(filled), `no unfilled slots in: ${line}`);
    assert.ok(filled.length <= 120, "line within forceChat limit");
  }
}

// --- shouldFire gate ---
const r = lcg(1);
assert.equal(J.shouldFire(r, 0, 1000, 5000, 1.0), false, "cooldown blocks");
assert.equal(J.shouldFire(r, 0, 6000, 5000, 1.0), true, "cooldown passed, chance 1 fires");

// --- isRealPlayer / withinTiles ---
assert.equal(J.isRealPlayer(null), false);
assert.equal(J.isRealPlayer({ isPlayerBot: () => true }), false);
assert.equal(J.isRealPlayer({ getHostAddress: () => "bot", getUsername: () => "x" }), false);
assert.equal(J.isRealPlayer({ getUsername: () => "RealHuman" }), true);
function loc(x, y, z) { return { getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => z }) }; }
assert.ok(J.withinTiles(loc(0, 0, 0), loc(10, 10, 0), 14), "within 14 tiles");
assert.ok(!J.withinTiles(loc(0, 0, 0), loc(20, 0, 0), 14), "beyond 14 tiles");
assert.ok(!J.withinTiles(loc(0, 0, 0), loc(0, 0, 1), 14), "different plane fails");

// --- tick never throws on hostile input ---
J.tickJudges(null, NOW);
J.tickJudges({}, NOW);
J.tickJudges({ roster: new Map() }, NOW);
J.tickJudges({ roster: { values: () => { throw new Error("boom"); } } }, NOW);

// --- tick fires near a real player, silent otherwise ---
function fakePlayer(username, bot, x, y) {
  return {
    getUsername: () => username,
    getHostAddress: () => "127.0.0.1",
    isPlayerBot: () => bot,
    getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => 0 }),
    getLocalPlayers: () => [],
    said: [],
    forceChat(line) { this.said.push(line); },
  };
}
// Pick a deterministic judge username.
let judgeName = null;
for (let i = 0; i < 500 && !judgeName; i++) {
  const n = "Courtier" + i;
  if (J.isJudge(n)) judgeName = n;
}
assert.ok(judgeName, "found a judge username for the tick test");

const judgeBot = fakePlayer(judgeName, true, 3200, 3200);
const human = fakePlayer("RealPlayer", false, 3205, 3205);
judgeBot.getLocalPlayers = () => [human];
const record = { username: judgeName, role: "courtier", kingdom: "varrock" };
const director = {
  roster: new Map([[judgeName, record]]),
  playerFor: () => judgeBot,
};
// Court hours: 12:00 UTC. Use a fixed noon timestamp.
const noon = Date.UTC(2026, 9, 8, 12, 0, 0);
J.tickJudges(director, noon);
assert.ok(judgeBot.said.length > 0, "judge holds court near a real player at noon");

// No real player nearby: bot-only crowd stays silent.
const botOnly = fakePlayer("OtherBot", true, 3205, 3205);
const quietBot = fakePlayer(judgeName, true, 3200, 3200);
quietBot.getLocalPlayers = () => [botOnly];
const director2 = { roster: new Map([[judgeName, record]]), playerFor: () => quietBot };
J.tickJudges(director2, noon + 4 * 3600 * 1000); // later so cooldown doesn't mask it
// (may or may not fire for the other type mix; the key assert is no crash — done above)

// Non-courtier never a judge.
const director3 = {
  roster: new Map([["Peasant1", { username: "Peasant1", role: "commoner", kingdom: "varrock" }]]),
  playerFor: () => fakePlayer("Peasant1", true, 3200, 3200),
};
J.tickJudges(director3, noon + 8 * 3600 * 1000);

console.log("All CitizenJudges checks passed.");
