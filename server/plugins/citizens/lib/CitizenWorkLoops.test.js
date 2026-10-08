// CitizenWorkLoops unit checks — pure logic + fakes, no running server.
// From server/plugins/citizens: node lib/CitizenWorkLoops.test.js (plain node)
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  LOOP_MS,
  COOLDOWN_MS,
  MAX_PER_STATION,
  STATION_DEFS,
  STATION_KEYS,
  TRADE_LINES,
  stationTile,
  stationsForKingdom,
  tierForLevel,
  workLine,
  eligibleForLoop,
  tickWorkLoops,
  startLoop,
  stationOccupancy,
  setLevelProvider,
  _loops,
  _cooldowns,
} = require("./CitizenWorkLoops");
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
  _loops.clear();
  _cooldowns.clear();
  setLevelProvider(null);
  try {
    getJournal().resetForTests();
  } catch {
    // Non-fatal.
  }
}

// --- fakes ---------------------------------------------------------------------

function tile(x, y) {
  return { getX: () => x, getY: () => y, getZ: () => 0 };
}

function fakeBot(x, y, localPlayers = []) {
  return {
    getLocation: () => tile(x, y),
    getLocalPlayers: () => localPlayers,
    isPlayerBot: () => true,
    getMovementQueue: () => ({ size: () => 0 }),
    getForceMovement: () => null,
    faced: null,
    anims: [],
    chats: [],
    face(fx, fy) {
      this.faced = [fx, fy];
    },
    performAnimation(a) {
      this.anims.push(a);
    },
    forceChat(line) {
      this.chats.push(line);
    },
  };
}

function fakeRealPlayer(x, y) {
  return { isPlayerBot: () => false, getLocation: () => tile(x, y) };
}

function fakeDirector(entries, online = true) {
  const roster = new Map();
  const bots = {};
  for (const [record, bot] of entries) {
    roster.set(record.username, record);
    bots[record.username] = bot;
  }
  return {
    roster,
    isOnline: () => online,
    getBot: (record) => bots[record.username] ?? null,
    api: {
      core: {
        Animation: class {
          constructor(id) {
            this.id = id;
          }
        },
      },
    },
  };
}

// --- station lookup --------------------------------------------------------------

test("stationTile: unknown station key returns null, never throws", () => {
  assert.equal(stationTile("asgarnia", "portal"), null);
  assert.equal(stationTile("asgarnia", ""), null);
  assert.equal(stationTile("asgarnia", null), null);
});

test("stationTile: unknown kingdom falls back to default sites, no crash", () => {
  // asgarnia square (2965,3378) + default forge offset [4,-3].
  assert.deepEqual(stationTile("atlantis", "forge"), { x: 2969, y: 3375, z: 0 });
  assert.deepEqual(stationTile(undefined, "stall"), { x: 2945, y: 3369, z: 0 });
});

test("stationTile: known kingdom/station resolves the exact derived tile", () => {
  // keldagrim square (2860,10210) + forge offset [3,4].
  assert.deepEqual(stationTile("keldagrim", "forge"), {
    x: 2863,
    y: 10214,
    z: 0,
  });
  // asgarnia market (2945,3369) + stall offset [0,0].
  assert.deepEqual(stationTile("asgarnia", "stall"), { x: 2945, y: 3369, z: 0 });
});

test("stationsForKingdom: five stations for every known kingdom and unknowns", () => {
  for (const k of ["asgarnia", "kandarin", "keldagrim", "misthalin", "morytania", "nope"]) {
    const stations = stationsForKingdom(k);
    assert.equal(stations.length, 5, k);
    assert.deepEqual(
      stations.map((s) => s.key).sort(),
      [...STATION_KEYS].sort()
    );
  }
});

// --- level tiers -------------------------------------------------------------------

test("tierForLevel: novice / seasoned / master boundaries", () => {
  assert.equal(tierForLevel(1), "novice");
  assert.equal(tierForLevel(5), "novice");
  assert.equal(tierForLevel(9), "novice");
  assert.equal(tierForLevel(10), "seasoned");
  assert.equal(tierForLevel(25), "seasoned");
  assert.equal(tierForLevel(39), "seasoned");
  assert.equal(tierForLevel(40), "master");
  assert.equal(tierForLevel(99), "master");
});

test("workLine: tiered by injected level; null for unknown trade", () => {
  const record = { username: "Smithy Sam", role: "commoner" };
  setLevelProvider(() => 45);
  assert.ok(TRADE_LINES.smith.master.includes(workLine(record, "smith", lcg(1))));
  setLevelProvider(() => 3);
  assert.ok(TRADE_LINES.smith.novice.includes(workLine(record, "smith", lcg(2))));
  setLevelProvider(() => 20);
  assert.ok(TRADE_LINES.cook.seasoned.includes(workLine(record, "cook", lcg(3))));
  assert.equal(workLine(record, "alchemist", lcg(4)), null);
  setLevelProvider(null);
});

// --- eligibility ---------------------------------------------------------------------

test("eligibleForLoop: merchants, guards and offline citizens never qualify", () => {
  const now = Date.now();
  const director = fakeDirector([]);
  assert.equal(
    eligibleForLoop({ username: "M", role: "merchant", kingdomId: "asgarnia" }, director, now),
    false
  );
  assert.equal(
    eligibleForLoop({ username: "G", role: "guard", kingdomId: "asgarnia" }, director, now),
    false
  );
  const offline = fakeDirector([], false);
  assert.equal(
    eligibleForLoop({ username: "C", role: "commoner", kingdomId: "asgarnia" }, offline, now),
    false
  );
});

test("eligibleForLoop: idle online commoner qualifies; cooldown blocks repeats", () => {
  const now = Date.now();
  const record = { username: "Idle Ian", role: "commoner", kingdomId: "asgarnia" };
  const director = fakeDirector([]);
  assert.equal(eligibleForLoop(record, director, now), true);
  _cooldowns.set("idle ian", now);
  assert.equal(eligibleForLoop(record, director, now + 60 * 1000), false);
  assert.equal(eligibleForLoop(record, director, now + COOLDOWN_MS + 1000), true);
  cleanup();
});

// --- loop lifecycle --------------------------------------------------------------------

test("startLoop: journals once, registers loop + cooldown, faces and animates", () => {
  cleanup();
  const record = { username: "Loop Tester", role: "commoner", kingdomId: "asgarnia" };
  const station = stationsForKingdom("asgarnia").find((s) => s.key === "forge");
  const bot = fakeBot(station.tile.x, station.tile.y);
  const director = fakeDirector([[record, bot]]);
  const now = Date.now();

  startLoop(director, record, bot, station, now);

  assert.ok(_loops.has("loop tester"));
  assert.equal(_cooldowns.get("loop tester"), now);
  assert.deepEqual(bot.faced, [station.tile.x, station.tile.y]);
  assert.equal(bot.anims.length, 1);
  assert.equal(bot.anims[0].id, STATION_DEFS.forge.anim);
  const recent = getJournal().recent("Loop Tester", 3);
  assert.equal(recent.length, 1);
  assert.ok(recent[0].text.includes("forge"), recent[0].text);
  assert.equal(recent[0].kind, "work");
  cleanup();
});

test("tickWorkLoops: proximity gate — no real players, no loop starts", () => {
  cleanup();
  const station = stationTile("asgarnia", "forge");
  const record = { username: "Proximity Pete", role: "commoner", kingdomId: "asgarnia" };
  const bot = fakeBot(station.x, station.y, []); // empty world
  const director = fakeDirector([[record, bot]]);
  for (let i = 0; i < 20; i++) {
    tickWorkLoops(director, Date.now() + i * 10000);
  }
  assert.equal(_loops.size, 0);
  cleanup();
});

test("tickWorkLoops: real player near → loop starts; cooldown blocks a second loop", () => {
  cleanup();
  const station = stationTile("asgarnia", "forge");
  const record = { username: "Watched Wendy", role: "commoner", kingdomId: "asgarnia" };
  const watcher = fakeRealPlayer(station.x + 10, station.y); // 10 tiles: within 40
  const bot = fakeBot(station.x, station.y, [watcher]);
  const director = fakeDirector([[record, bot]]);
  const base = Date.now();
  let started = false;
  for (let i = 0; i < 60 && !started; i++) {
    tickWorkLoops(director, base + i * 10000);
    started = _loops.has("watched wendy");
  }
  assert.ok(started, "a loop should start while a real player watches");
  assert.equal(_loops.size, 1);
  // Same citizen is now on cooldown: no second loop.
  assert.equal(eligibleForLoop(record, director, base + 60 * 1000), false);
  cleanup();
});

test("tickWorkLoops: max 2 loopers per station is enforced", () => {
  cleanup();
  const now = Date.now();
  const seed = (name) =>
    _loops.set(name, {
      stationKey: "forge",
      trade: "smith",
      anim: 899,
      tile: stationTile("asgarnia", "forge"),
      kingdomId: "asgarnia",
      startedAt: now,
    });
  seed("looper one");
  seed("looper two");
  assert.equal(stationOccupancy("asgarnia", "forge"), 2);
  assert.equal(stationOccupancy("asgarnia", "anvil"), 0);

  const station = stationTile("asgarnia", "forge");
  const record = { username: "Third Theo", role: "commoner", kingdomId: "asgarnia" };
  const watcher = fakeRealPlayer(station.x + 5, station.y);
  const bot = fakeBot(station.x, station.y, [watcher]);
  const director = fakeDirector([[record, bot]]);
  for (let i = 0; i < 30; i++) {
    tickWorkLoops(director, now + i * 10000);
  }
  assert.equal(_loops.has("third theo"), false);
  assert.equal(_loops.size, 2);
  cleanup();
});

test("tickWorkLoops: expired loops end on tick", () => {
  cleanup();
  const now = Date.now();
  const record = { username: "Old Oliver", role: "commoner", kingdomId: "asgarnia" };
  const bot = fakeBot(2969, 3375, []);
  const director = fakeDirector([[record, bot]]);
  _loops.set("old oliver", {
    stationKey: "forge",
    trade: "smith",
    anim: 899,
    tile: stationTile("asgarnia", "forge"),
    kingdomId: "asgarnia",
    startedAt: now - LOOP_MS - 1000,
  });
  tickWorkLoops(director, now);
  assert.equal(_loops.has("old oliver"), false);
  cleanup();
});

test("tick path is data-tier: no LLM/provider references outside comments", () => {
  const src = fs.readFileSync(
    path.join(__dirname, "CitizenWorkLoops.js"),
    "utf8"
  );
  const codeLines = src
    .split("\n")
    .filter((line) => {
      const t = line.trimStart();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .join("\n");
  assert.ok(
    !/\b(openai|anthropic|gemini|groq|cerebras|chatgpt|cohere)\b/i.test(codeLines),
    "no LLM provider references in code"
  );
  assert.ok(
    !/\bllm\b/i.test(codeLines),
    "no bare llm references in code"
  );
  assert.ok(!/\bfetch\s*\(/.test(codeLines), "no network fetch in the tick path");
});

// --- run -----------------------------------------------------------------------------------

let failures = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures++;
    console.log(`FAIL - ${name}: ${error.message}`);
  }
}
cleanup();
console.log(`${tests.length - failures}/${tests.length} passed`);
process.exit(failures === 0 ? 0 : 1);
