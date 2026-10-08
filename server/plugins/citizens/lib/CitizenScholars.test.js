// CitizenScholars unit checks — pure logic, no running server.
// Run: node lib/CitizenScholars.test.js (from server/plugins/citizens)
const assert = require("node:assert/strict");
const {
  isScholar,
  scholarTypeFor,
  pickTopic,
  researchGain,
  discoveryLine,
  lectureLine,
  studyLine,
  isRealPlayer,
  withinTiles,
  getLibrary,
  librarySize,
  tickResearch,
  tickLectures,
  SCHOLAR_TYPES,
  RESEARCH_TOPICS,
  SCHOLAR_HISTORIAN,
} = require("./CitizenScholars");

// Deterministic LCG — coverage is exact, not luck-based.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// --- scholar gating ---
{
  // Deterministic: same username always the same answer.
  assert.equal(isScholar("Ada Lovelace"), isScholar("ada lovelace"));
  assert.equal(isScholar("Ada Lovelace"), isScholar("Ada Lovelace"));
  // Case-insensitive stability.
  assert.equal(scholarTypeFor("Ada"), scholarTypeFor("ADA"));
  // Types always valid.
  for (const name of ["Ada", "Bob", "Zed", "Q"]) {
    assert.ok(SCHOLAR_TYPES.includes(scholarTypeFor(name)));
  }
  // Roughly 1 in 12 of a synthetic roster are scholars.
  let n = 0;
  for (let i = 0; i < 1200; i++) if (isScholar("citizen" + i)) n++;
  assert.ok(n > 50 && n < 160, `scholar count ${n} should be ~100 of 1200`);
}

// --- topic pools ---
{
  for (const type of SCHOLAR_TYPES) {
    const topics = RESEARCH_TOPICS[type];
    assert.ok(Array.isArray(topics) && topics.length >= 3, type);
    for (let i = 0; i < 20; i++) {
      const t = pickTopic(lcg(i), type);
      assert.ok(topics.includes(t));
    }
  }
  // Unknown type falls back to historian pool.
  assert.ok(RESEARCH_TOPICS[SCHOLAR_HISTORIAN].includes(pickTopic(lcg(1), "nope")));
}

// --- research gain bounds ---
{
  for (let i = 0; i < 50; i++) {
    const g = researchGain(lcg(i));
    assert.ok(g >= 8 && g <= 25, `gain ${g} in [8,25]`);
  }
}

// --- line rendering ---
{
  const d = discoveryLine(SCHOLAR_HISTORIAN, "the fall of the old kingdoms", lcg(7));
  assert.ok(d.includes("the fall of the old kingdoms"));
  assert.ok(!d.includes("{topic}"));
  const l = lectureLine("Ada", "wyvern migration", lcg(3));
  assert.ok(l.includes("Ada") && l.toLowerCase().includes("wyvern migration"));
  const s = studyLine("wyvern migration", lcg(9));
  assert.ok(s.includes("wyvern migration") && !s.includes("{topic}"));
}

// --- isRealPlayer / withinTiles ---
{
  assert.equal(isRealPlayer(null), false);
  assert.equal(isRealPlayer({}), false);
  assert.equal(isRealPlayer({ getUsername: () => "x" }), true);
  assert.equal(isRealPlayer({ getUsername: () => "x", isPlayerBot: () => true }), false);
  assert.equal(isRealPlayer({ getUsername: () => "x", getHostAddress: () => "bot" }), false);
  const at = (x, y, z = 0) => ({
    getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => z }),
  });
  assert.equal(withinTiles(at(0, 0), at(10, 10), 14), true);
  assert.equal(withinTiles(at(0, 0), at(15, 0), 14), false);
  assert.equal(withinTiles(at(0, 0, 0), at(1, 1, 1), 14), false); // different plane
}

// --- tickResearch: non-scholars skipped, scholars advance, discoveries publish ---
{
  const events = [];
  const journalLog = [];
  const roster = new Map();
  // Find scholar usernames deterministically.
  const scholars = [];
  for (let i = 0; i < 500 && scholars.length < 3; i++) {
    if (isScholar("r" + i)) scholars.push("r" + i);
  }
  assert.ok(scholars.length === 3);
  roster.set("plain", { username: "plain", kingdomId: "k1" });
  for (const s of scholars) roster.set(s, { username: s, kingdomId: "k1" });

  const director = {
    roster,
    api: { emitCustomEvent: (name, payload) => events.push({ name, payload }) },
  };
  // Stub the journal via require cache: CitizenScholars requires ./CitizenJournal.
  // Instead of stubbing, tickResearch uses the real singleton — safe, in-memory.
  const published = tickResearch(director, lcg(42), Date.now());
  assert.equal(typeof published, "number");
  assert.equal(journalLog.length, 0); // unused, kept for clarity

  // Force a publication: tick many times until each scholar publishes once.
  let total = 0;
  for (let i = 0; i < 30; i++) total += tickResearch(director, lcg(100 + i), Date.now());
  assert.ok(total >= 3, `expected >=3 publications, got ${total}`);
  assert.ok(
    events.every((e) => e.name === "scholars:discovery"),
    "all events are scholars:discovery"
  );
  assert.ok(events[0].payload.author && events[0].payload.topic);
  assert.ok(librarySize() >= 3, "library accumulated works");
  const lib = getLibrary("k1");
  assert.ok(lib.length >= 3);
  assert.ok(lib.every((w) => w.author && w.topic && w.type));
}

// --- tickLectures: no players -> silent; players -> lectures/studies gated ---
{
  const roster = new Map();
  let scholarName = null;
  for (let i = 0; i < 500; i++) {
    if (isScholar("lec" + i)) {
      scholarName = "lec" + i;
      break;
    }
  }
  assert.ok(scholarName);
  const spoken = [];
  const bot = {
    forceChat: (line) => spoken.push(line),
    getLocation: () => ({ getX: () => 0, getY: () => 0, getZ: () => 0 }),
  };
  roster.set(scholarName, { username: scholarName, kingdomId: "k2" });

  // No real players: silent.
  tickLectures({ roster, playerFor: () => bot, onlinePlayers: () => [] });
  assert.equal(spoken.length, 0, "no players -> no lines");

  // Real player near: lecture or study fires (lecture cooldown fresh).
  const player = {
    getUsername: () => "human",
    getLocation: () => ({ getX: () => 5, getY: () => 5, getZ: () => 0 }),
  };
  tickLectures({
    roster,
    playerFor: () => bot,
    onlinePlayers: () => [player],
  });
  assert.equal(spoken.length, 1, "lecture should fire once");
  assert.ok(spoken[0].length > 10);

  // Immediate re-tick: lecture is on cooldown, so the ambient study line fires.
  tickLectures({
    roster,
    playerFor: () => bot,
    onlinePlayers: () => [player],
  });
  assert.equal(spoken.length, 2, "study line fires after lecture cooldown");
  assert.ok(spoken[1].startsWith("*"), "study line is an emote");

  // Third immediate tick: both gates now on cooldown -> silence.
  tickLectures({
    roster,
    playerFor: () => bot,
    onlinePlayers: () => [player],
  });
  assert.equal(spoken.length, 2, "cooldowns suppress repeat lines");

  // Non-scholar never speaks.
  const spoken2 = [];
  const bot2 = {
    forceChat: (line) => spoken2.push(line),
    getLocation: () => ({ getX: () => 0, getY: () => 0, getZ: () => 0 }),
  };
  const r2 = new Map();
  r2.set("plain2", { username: "plain2", kingdomId: "k2" });
  tickLectures({ roster: r2, playerFor: () => bot2, onlinePlayers: () => [player] });
  assert.equal(spoken2.length, 0, "non-scholar stays silent");

  // Never throws with a hostile director.
  tickLectures(null);
  tickLectures({ roster: null });
}

// --- desync slot compatibility ---
{
  const spoken = [];
  const roster = new Map();
  let name = null;
  for (let i = 0; i < 2000; i++) {
    if (isScholar("d" + i)) {
      name = "d" + i;
      break;
    }
  }
  roster.set(name, { username: name, kingdomId: "k3" });
  const bot = {
    forceChat: (line) => spoken.push(line),
    getLocation: () => ({ getX: () => 0, getY: () => 0, getZ: () => 0 }),
  };
  const player = {
    getUsername: () => "human",
    getLocation: () => ({ getX: () => 1, getY: () => 1, getZ: () => 0 }),
  };
  const d = { roster, playerFor: () => bot, onlinePlayers: () => [player] };
  // A spread larger than the population means most ticks skip: no crash either way.
  tickLectures(d, Date.now(), { tick: 3, spread: 10 });
  assert.ok(true, "desync arg accepted without throw");
}

console.log("CitizenScholars: all tests passed");
