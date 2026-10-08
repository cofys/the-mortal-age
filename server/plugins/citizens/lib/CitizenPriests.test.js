// CitizenPriests unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const P = require("./CitizenPriests");

// Deterministic LCG — coverage is exact, not luck-based.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Mock player: bot or real human, at a location, capturing forceChat.
function mockPlayer(username, x, y, isBot = false) {
  return {
    said: null,
    getUsername: () => username,
    isPlayerBot: () => isBot,
    getHostAddress: () => (isBot ? "bot" : "1.2.3.4"),
    getLocation: () => ({
      getX: () => x,
      getY: () => y,
      getZ: () => 0,
    }),
    forceChat(line) {
      this.said = line;
    },
  };
}

function mockDirector(records, bots, players) {
  const roster = new Map(records.map((r) => [r.username, r]));
  return {
    roster,
    playerFor: (rec) => bots[rec.username] ?? null,
    onlinePlayers: () => players,
  };
}

// Find a username that is a priest of a given type (deterministic search).
function findPriestOf(type) {
  for (let i = 0; i < 5000; i++) {
    const u = `priestsearch${i}`;
    if (P.priestTypeFor(u) === type) return u;
  }
  throw new Error(`no ${type} found in search space`);
}
function findNonPriest() {
  for (let i = 0; i < 5000; i++) {
    const u = `nonpriestsearch${i}`;
    if (P.priestTypeFor(u) === null) return u;
  }
  throw new Error("no non-priest found");
}

const NOW = new Date("2026-10-08T12:10:00").getTime(); // noon, in service window
const EVENING = new Date("2026-10-08T20:10:00").getTime();
const MORNING = new Date("2026-10-08T09:10:00").getTime();

// --- 1. hash helpers are deterministic ---
assert.equal(P.hashStr("abc"), P.hashStr("abc"));
assert.notEqual(P.hashStr("abc"), P.hashStr("abd"));
assert.ok(P.hashChance("x") >= 0 && P.hashChance("x") < 1);

// --- 2. priest type assignment is deterministic and stable ---
const hp = findPriestOf("high-priest");
assert.equal(P.priestTypeFor(hp), "high-priest");
assert.equal(P.priestTypeFor(hp), P.priestTypeFor(hp));
assert.ok(P.PRIEST_TYPES.includes(P.priestTypeFor(hp)));

// --- 3. ~6% of citizens are priests (primary-profession partition) ---
let priestCount = 0;
const N = 2000;
for (let i = 0; i < N; i++) {
  if (P.priestTypeFor(`dist${i}`)) priestCount++;
}
const ratio = priestCount / N;
assert.ok(ratio > 0.03 && ratio < 0.10, `priest ratio ${ratio} out of band`);

// --- 4. non-priests return null ---
assert.equal(P.priestTypeFor(findNonPriest()), null);

// --- 5. temple assignment prefers the citizen's kingdom ---
const temple = P.templeFor("someuser", "varrock");
assert.equal(temple.kingdom, "varrock");
const temple2 = P.templeFor("someuser", "keldagrim");
assert.equal(temple2.kingdom, "keldagrim");
assert.equal(P.templeFor("someuser", "varrock").name, P.templeFor("someuser", "varrock").name);

// --- 6. faith lookup works ---
assert.ok(P.faithOf(temple).epithet.length > 0);
assert.ok(P.faithOf(temple).blessing.length > 0);
assert.equal(P.FAITHS.saradomin.blessing, "Saradomin's light");

// --- 7. service schedule ---
assert.ok(P.inService(NOW), "12:10 should be in service");
assert.ok(!P.inService(MORNING), "09:10 should not be in service");
assert.equal(P.nextServiceHour(MORNING), 12);
assert.equal(P.nextServiceHour(new Date("2026-10-08T19:00:00").getTime()), 6);

// --- 8. congregation is derived and stable per day ---
const c1 = P.congregationFor(temple, NOW);
const c2 = P.congregationFor(temple, NOW + 1000);
assert.deepEqual(c1, c2);
assert.ok(c1.size >= 8 && c1.size < 50);

// --- 9. prophecy is deterministic per day, changes across days ---
const ou = findPriestOf("oracle");
const p1 = P.prophecyFor(ou, NOW);
const p2 = P.prophecyFor(ou, NOW);
assert.equal(p1, p2);
assert.ok(p1.length > 10);
// different day almost surely differs (at least across a sweep)
let changed = false;
for (let d = 1; d <= 10; d++) {
  if (P.prophecyFor(ou, NOW + d * 86400000) !== p1) {
    changed = true;
    break;
  }
}
assert.ok(changed, "prophecy should vary across days");

// --- 10. blessing ledger round-trip ---
P.resetForTests();
const b = P.blessPlayer("TestPlayer", temple.name, NOW);
assert.equal(b.temple, temple.name);
assert.ok(P.blessingFor("TestPlayer", NOW));
assert.equal(P.blessingFor("TestPlayer", NOW).temple, temple.name);
// expired after TTL
assert.equal(P.blessingFor("TestPlayer", NOW + 25 * 3600 * 1000), null);
// re-blessing an unexpired player returns the existing one
P.blessPlayer("TestPlayer2", temple.name, NOW);
const b2 = P.blessPlayer("TestPlayer2", temple2.name, NOW + 1000);
assert.equal(b2.temple, temple.name, "existing blessing should win");

// --- 11. confession counts ---
P.resetForTests();
assert.equal(P.hearConfession("Someone", temple.name, NOW), 1);
assert.equal(P.hearConfession("SomeoneElse", temple.name, NOW), 2);

// --- 12. line pools are non-empty and render without leftover slots ---
const rng = lcg(42);
const faith = P.faithOf(temple);
for (const fn of [
  () => P.sermonLine(rng, faith),
  () => P.serviceLine(rng, temple),
  () => P.blessLine(rng, faith),
  () => P.confessionLine(rng, faith),
  () => P.absolutionLine(rng, faith),
  () => P.monkLine(rng),
  () => P.oracleLine(rng),
  () => P.riteLine(rng, faith, "Old Tom"),
  () => P.officiantLine(rng, temple, faith),
  () => P.eveningLine(rng, temple),
]) {
  const line = fn();
  assert.ok(line.length > 5, `line too short: ${line}`);
  assert.ok(!/\{\w+\}/.test(line), `unfilled slot in: ${line}`);
  assert.ok(line.length <= 120, `line over 120 chars: ${line}`);
}

// --- 13. shouldFire gate logic ---
assert.ok(!P.shouldFire(() => 0.01, NOW - 1000, NOW), "cooldown must block");
assert.ok(P.shouldFire(() => 0.01, 0, NOW), "fresh citizen with good rng fires");
assert.ok(!P.shouldFire(() => 0.99, 0, NOW), "bad rng does not fire");

// --- 14. isRealPlayer / withinTiles ---
const real = mockPlayer("Human", 0, 0, false);
const bot = mockPlayer("Bot", 0, 0, true);
assert.ok(P.isRealPlayer(real));
assert.ok(!P.isRealPlayer(bot));
assert.ok(!P.isRealPlayer(null));
const near = mockPlayer("Near", 5, 5, false);
const far = mockPlayer("Far", 100, 100, false);
assert.ok(P.withinTiles(real, near, 14));
assert.ok(!P.withinTiles(real, far, 14));

// --- 15. tickPriests never throws on hostile input ---
P.resetForTests();
assert.doesNotThrow(() => P.tickPriests(null, NOW));
assert.doesNotThrow(() => P.tickPriests({}, NOW));
assert.doesNotThrow(() => P.tickPriests({ roster: null }, NOW));

// --- 16. tickPriests fires near a real player ---
P.resetForTests();
const priestName = findPriestOf("high-priest");
const citizenBot = mockPlayer(priestName, 0, 0, true);
const human = mockPlayer("Visitor", 3, 3, false);
const d = mockDirector([{ username: priestName, kingdom: "varrock" }], { [priestName]: citizenBot }, [human]);
const origRandom = Math.random;
Math.random = () => 0.01; // always pass the chance gate
try {
  P.tickPriests(d, NOW);
} finally {
  Math.random = origRandom;
}
assert.ok(citizenBot.said && citizenBot.said.length > 0, "priest should have spoken near a real player");

// --- 17. tickPriests stays silent with only bots around ---
P.resetForTests();
const priestName2 = findPriestOf("chaplain");
const citizenBot2 = mockPlayer(priestName2, 0, 0, true);
const onlyBot = mockPlayer("OtherBot", 3, 3, true);
const d2 = mockDirector([{ username: priestName2, kingdom: "varrock" }], { [priestName2]: citizenBot2 }, [onlyBot]);
Math.random = () => 0.01;
try {
  P.tickPriests(d2, NOW);
} finally {
  Math.random = origRandom;
}
assert.equal(citizenBot2.said, null, "priest must stay silent with no real player near");

// --- 18. tickPriests skips non-priests ---
P.resetForTests();
const nonPriest = findNonPriest();
const npBot = mockPlayer(nonPriest, 0, 0, true);
const d3 = mockDirector([{ username: nonPriest, kingdom: "varrock" }], { [nonPriest]: npBot }, [human]);
Math.random = () => 0.01;
try {
  P.tickPriests(d3, NOW);
} finally {
  Math.random = origRandom;
}
assert.equal(npBot.said, null, "non-priest must not speak");

// --- 19. oracle gives prophecies in the evening ---
P.resetForTests();
const oracleName = findPriestOf("oracle");
const oracleBot = mockPlayer(oracleName, 0, 0, true);
const d4 = mockDirector([{ username: oracleName, kingdom: "kandarin" }], { [oracleName]: oracleBot }, [human]);
Math.random = () => 0.01;
try {
  P.tickPriests(d4, EVENING);
} finally {
  Math.random = origRandom;
}
assert.ok(oracleBot.said && oracleBot.said.length > 0, "oracle should speak in the evening");

console.log("CitizenPriests: all checks passed.");
