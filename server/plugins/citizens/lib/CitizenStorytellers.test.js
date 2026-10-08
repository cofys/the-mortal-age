"use strict";
// CitizenStorytellers unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const S = require("./CitizenStorytellers");

let passed = 0;
function check(name, fn) {
  try {
    S._resetState();
    fn();
    passed++;
    console.log("ok - " + name);
  } catch (e) {
    console.error("FAIL - " + name);
    console.error(e);
    process.exitCode = 1;
  }
}

function localDay(y, m, d, h = 12, min = 0) {
  return new Date(y, m - 1, d, h, min, 0, 0).getTime();
}

// --- hashing / type assignment ---
check("storytellerTypeFromRoll covers all types", () => {
  assert.equal(S.storytellerTypeFromRoll(0), S.STORYTELLER_ELDER);
  assert.equal(S.storytellerTypeFromRoll(29), S.STORYTELLER_ELDER);
  assert.equal(S.storytellerTypeFromRoll(30), S.STORYTELLER_TRAVELER);
  assert.equal(S.storytellerTypeFromRoll(55), S.STORYTELLER_GRANDPARENT);
  assert.equal(S.storytellerTypeFromRoll(80), S.STORYTELLER_EPIC);
  assert.equal(S.storytellerTypeFromRoll(99), S.STORYTELLER_EPIC);
});

check("type assignment is stable across calls", () => {
  const a = S.storytellerTypeOf({ username: "TaleBob", kingdomId: "misthalin" });
  const b = S.storytellerTypeOf({ username: "TaleBob", kingdomId: "misthalin" });
  assert.equal(a, b);
  assert.ok(S.STORYTELLER_TYPES.includes(a));
});

check("all four types are reachable across many names", () => {
  const seen = new Set();
  for (let i = 0; i < 400; i++) seen.add(S.storytellerTypeOf({ username: "taleuser" + i }));
  for (const t of S.STORYTELLER_TYPES) assert.ok(seen.has(t), "missing " + t);
});

check("non-commoners are never storytellers", () => {
  assert.equal(S.storytellerTypeOf({ username: "GuardA", role: "guard" }), null);
  assert.equal(S.storytellerTypeOf({ username: "CourtB", attributes: { role: "courtier" } }), null);
});

check("empty username returns null", () => {
  assert.equal(S.storytellerTypeOf({ username: "" }), null);
  assert.equal(S.storytellerTypeOf({}), null);
});

// --- activity system: no professional exclusions, broad distribution ---
check("activity system: most commoners qualify (no exclusions)", () => {
  let hits = 0;
  for (let i = 0; i < 1000; i++) if (S.storytellerTypeOf({ username: "free" + i })) hits++;
  assert.ok(hits > 900, "got " + hits);
});

// --- gathering assignment ---
check("gatheringFor prefers the record kingdom", () => {
  const g = S.gatheringFor({ username: "x", kingdomId: "misthalin" });
  assert.equal(g.kingdom, "misthalin");
});

check("gatheringFor is stable across calls", () => {
  const a = S.gatheringFor({ username: "TaleBob", kingdomId: "misthalin" });
  const b = S.gatheringFor({ username: "TaleBob", kingdomId: "misthalin" });
  assert.equal(a.name, b.name);
});

// --- tale of the day ---
check("taleFor is deterministic per day", () => {
  const day = localDay(2026, 9, 8);
  const a = S.taleFor("TaleBob", "misthalin", day);
  const b = S.taleFor("TaleBob", "misthalin", day + 3600000);
  assert.equal(a.tale, b.tale);
});

check("taleFor varies across days", () => {
  const seen = new Set();
  for (let d = 0; d < 10; d++) {
    seen.add(S.taleFor("TaleBob", "misthalin", localDay(2026, 9, 1 + d)).tale);
  }
  assert.ok(seen.size > 1, "tales never change");
});

check("taleFor tales render with no unfilled slots", () => {
  const t = S.taleFor("TaleBob", "misthalin", localDay(2026, 9, 8));
  assert.ok(!/\{.*\}/.test(t.tale), "unfilled slot in " + t.tale);
  assert.ok(t.gathering.length > 0);
});

// --- legends ---
check("legendFor returns a verse and event", () => {
  const l = S.legendFor({ name: "the Varrock tavern corner" }, localDay(2026, 9, 8));
  assert.ok(l.verse.length > 10);
  assert.ok(l.event.length > 0);
  assert.ok(!/\{.*\}/.test(l.verse), "unfilled slot in " + l.verse);
});

check("recentLegends returns three verses", () => {
  const legends = S.recentLegends({ name: "the Varrock tavern corner" }, localDay(2026, 9, 8));
  assert.equal(legends.length, 3);
});

check("legendEventFor never throws without journal", () => {
  assert.doesNotThrow(() => S.legendEventFor());
});

// --- oral tales / librarian tie-in ---
check("oralTaleForToday returns a string without throwing", () => {
  const t = S.oralTaleForToday(localDay(2026, 9, 8));
  assert.equal(typeof t, "string");
  assert.ok(t.length > 0);
});

// --- player ledgers ---
check("requestStory / requestFor round-trip", () => {
  const now = localDay(2026, 9, 8);
  S.requestStory("PlayerOne", "history", now);
  assert.equal(S.requestFor("PlayerOne", now + 1000), "history");
});

check("requestFor returns null when empty", () => {
  assert.equal(S.requestFor("NobodyEver", localDay(2026, 9, 8)), null);
});

check("shareStory / storyFor round-trip", () => {
  const now = localDay(2026, 9, 8);
  S.shareStory("PlayerTwo", "Once upon a time...", now);
  assert.equal(S.storyFor("PlayerTwo", now + 1000), "Once upon a time...");
});

check("ledgers expire after TTL", () => {
  const now = localDay(2026, 9, 8);
  S.requestStory("PlayerOld", "epic", now);
  S.shareStory("PlayerOld", "An old tale", now);
  assert.equal(S.requestFor("PlayerOld", now + 8 * 86400000), null);
  assert.equal(S.storyFor("PlayerOld", now + 8 * 86400000), null);
});

check("shareStory rejects empty input", () => {
  assert.equal(S.shareStory("", "x"), null);
  assert.equal(S.shareStory("P", ""), null);
});

// --- hours gate ---
check("isGatherHour: inside and outside hours", () => {
  assert.ok(S.isGatherHour(localDay(2026, 9, 8, 12)));
  assert.ok(S.isGatherHour(localDay(2026, 9, 8, 21, 59)));
  assert.ok(!S.isGatherHour(localDay(2026, 9, 8, 9, 59)));
  assert.ok(!S.isGatherHour(localDay(2026, 9, 8, 22)));
  assert.ok(!S.isGatherHour(localDay(2026, 9, 8, 3)));
});

// --- guards ---
check("isRealPlayer / withinTiles guards", () => {
  assert.equal(S.isRealPlayer(null), false);
  assert.equal(S.isRealPlayer({ isPlayerBot: () => true }), false);
  assert.equal(S.isRealPlayer({ getUsername: () => "x" }), true);
  assert.equal(S.withinTiles(null, null, 14), false);
});

// --- tick behavior ---
function fakeDirector(records, online) {
  const roster = new Map();
  for (const r of records) roster.set(r.username.toLowerCase(), r);
  return {
    roster,
    playerFor: (r) => ({ username: r.username }),
    onlinePlayers: () => online,
  };
}
function realPlayerAt(x, y) {
  return {
    getUsername: () => "HumanPlayer",
    getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => 0 }),
  };
}

check("tick fires near a real player during gather hours", () => {
  const now = localDay(2026, 9, 8, 14);
  const records = [];
  for (let i = 0; i < 60; i++) {
    const u = "storyfire" + i;
    const type = S.storytellerTypeOf({ username: u });
    if (type) records.push({ username: u, kingdomId: "misthalin" });
  }
  assert.ok(records.length > 0, "no storytellers found in sample");
  const d = fakeDirector(records, [realPlayerAt(0, 0)]);
  // citizens materialize at (0,0) too so they're near the player
  d.playerFor = (r) => ({ getUsername: () => r.username, getLocation: () => ({ getX: () => 1, getY: () => 1, getZ: () => 0 }) });
  let count = 0;
  const origRandom = Math.random;
  Math.random = () => 0.0; // pass chance gate, roll work emote
  try {
    // wrap citizen objects with forceChat
    d.playerFor = (r) => ({
      getUsername: () => r.username,
      forceChat: () => { count++; },
      getLocation: () => ({ getX: () => 1, getY: () => 1, getZ: () => 0 }),
    });
    S.tickStorytellers(d, now);
  } finally {
    Math.random = origRandom;
  }
  assert.ok(count > 0, "nothing fired");
});

check("tick is silent near bots only", () => {
  const now = localDay(2026, 9, 8, 14);
  let count = 0;
  const d = fakeDirector([{ username: "storyfire0", kingdomId: "misthalin" }], [
    { isPlayerBot: () => true, getHostAddress: () => "bot" },
  ]);
  d.playerFor = (r) => ({
    getUsername: () => r.username,
    forceChat: () => { count++; },
    getLocation: () => ({ getX: () => 1, getY: () => 1, getZ: () => 0 }),
  });
  const origRandom = Math.random;
  Math.random = () => 0.0;
  try { S.tickStorytellers(d, now); } finally { Math.random = origRandom; }
  assert.equal(count, 0);
});

check("tick is silent outside gather hours", () => {
  const now = localDay(2026, 9, 8, 3); // 03:00
  let count = 0;
  const d = fakeDirector([{ username: "storyfire0", kingdomId: "misthalin" }], [realPlayerAt(0, 0)]);
  d.playerFor = (r) => ({
    getUsername: () => r.username,
    forceChat: () => { count++; },
    getLocation: () => ({ getX: () => 1, getY: () => 1, getZ: () => 0 }),
  });
  const origRandom = Math.random;
  Math.random = () => 0.0;
  try { S.tickStorytellers(d, now); } finally { Math.random = origRandom; }
  assert.equal(count, 0);
});

check("tick never throws on hostile input", () => {
  assert.doesNotThrow(() => S.tickStorytellers(null, Date.now()));
  assert.doesNotThrow(() => S.tickStorytellers({}, Date.now()));
  assert.doesNotThrow(() => S.tickStorytellers({ roster: new Map() }, Date.now()));
});

console.log("\n" + passed + " checks passed");
