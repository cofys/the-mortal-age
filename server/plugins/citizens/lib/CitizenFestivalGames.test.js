// CitizenFestivalGames unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const {
  tickFestivalGames,
  enterGame,
  entryFor,
  placeBet,
  betFor,
  gamesForDay,
  competitorsFor,
  winnerFor,
  festivalToday,
  venueFor,
  kingdomName,
  hashStr,
  pickOne,
  fill,
  seededRng,
  dayNumber,
  chance,
  isRealPlayer,
  withinTiles,
  GAME_TYPES,
  GAME_WRESTLING,
  GAME_ARCHERY,
  GAME_PIE_EATING,
  GAME_DANCE,
  GAME_NAMES,
  _resetState,
} = require("./CitizenFestivalGames");

// Deterministic LCG — coverage is exact, not luck-based.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    console.error("FAIL:", name, "-", e.message);
    process.exitCode = 1;
  }
}

// === Hashing ===
check("hashStr is deterministic", () => {
  assert.equal(hashStr("test"), hashStr("test"));
  assert.notEqual(hashStr("a"), hashStr("b"));
});

check("hashStr handles empty/null", () => {
  assert.equal(typeof hashStr(""), "number");
  assert.equal(typeof hashStr(null), "number");
});

// === Game types ===
check("all four game types defined", () => {
  assert.deepEqual(GAME_TYPES, [GAME_WRESTLING, GAME_ARCHERY, GAME_PIE_EATING, GAME_DANCE]);
});

check("every game type has a name", () => {
  for (const g of GAME_TYPES) {
    assert.ok(GAME_NAMES[g], `missing name for ${g}`);
  }
});

// === Pure helpers ===
check("pickOne is deterministic with seeded rng", () => {
  const arr = ["a", "b", "c", "d"];
  assert.equal(pickOne(lcg(42), arr), pickOne(lcg(42), arr));
});

check("fill replaces all slots", () => {
  assert.equal(fill("Hello {name}!", { name: "Bob" }), "Hello Bob!");
  assert.equal(fill("{a} and {a}", { a: "x" }), "x and x");
  assert.equal(fill("no slots", {}), "no slots");
});

check("dayNumber is stable within a day", () => {
  const t = new Date(2026, 9, 8, 12, 0).getTime();
  assert.equal(dayNumber(t), dayNumber(t + 3600 * 1000));
  assert.notEqual(dayNumber(t), dayNumber(t + 25 * 3600 * 1000));
});

check("chance respects probability bounds", () => {
  assert.equal(chance(() => 0.0, 0.5), true);
  assert.equal(chance(() => 0.99, 0.5), false);
});

check("seededRng is deterministic", () => {
  const r1 = seededRng(123);
  const r2 = seededRng(123);
  assert.equal(r1(), r2());
  assert.equal(r1(), r2());
});

// === Festival calendar ===
check("festivalToday returns null outside festivals", () => {
  // Feb 1 is not a festival (festivals: Jan 15, Apr 20, Jul 1, Oct 7, Dec 21)
  const t = new Date(2026, 1, 1, 12, 0).getTime();
  assert.equal(festivalToday(t), null);
});

check("festivalToday finds Founding Day (Jan 15-17)", () => {
  const t = new Date(2026, 0, 16, 12, 0).getTime();
  const f = festivalToday(t);
  assert.ok(f, "should find a festival on Jan 16");
  assert.equal(f.id, "founding-day");
});

check("festivalToday finds Midsummer Revel (Jul 1-3)", () => {
  const t = new Date(2026, 6, 2, 12, 0).getTime();
  const f = festivalToday(t);
  assert.ok(f, "should find a festival on Jul 2");
  assert.equal(f.id, "midsummer");
});

// === Daily games ===
check("gamesForDay returns 2-3 games", () => {
  const t = new Date(2026, 6, 2, 12, 0).getTime();
  for (let i = 0; i < 20; i++) {
    const games = gamesForDay("misthalin", t + i * 86400000);
    assert.ok(games.length >= 2 && games.length <= 3, `got ${games.length}`);
    for (const g of games) assert.ok(GAME_TYPES.includes(g));
  }
});

check("gamesForDay is deterministic per day", () => {
  const t = new Date(2026, 6, 2, 12, 0).getTime();
  assert.deepEqual(gamesForDay("misthalin", t), gamesForDay("misthalin", t));
});

check("gamesForDay varies across days", () => {
  const t = new Date(2026, 6, 2, 12, 0).getTime();
  let varied = false;
  const first = JSON.stringify(gamesForDay("misthalin", t));
  for (let i = 1; i < 10; i++) {
    if (JSON.stringify(gamesForDay("misthalin", t + i * 86400000)) !== first) {
      varied = true;
      break;
    }
  }
  assert.ok(varied, "games should vary across days");
});

check("gamesForDay has no duplicates", () => {
  const t = new Date(2026, 6, 2, 12, 0).getTime();
  for (let i = 0; i < 10; i++) {
    const games = gamesForDay("kandarin", t + i * 86400000);
    assert.equal(new Set(games).size, games.length, "duplicate game in day");
  }
});

// === Competitors and winners ===
const NAMES = ["Alice", "Bob", "Carol", "Dave", "Eve", "Frank", "Grace", "Heidi"];

check("competitorsFor returns 3-5 names", () => {
  const t = new Date(2026, 6, 2, 12, 0).getTime();
  for (let i = 0; i < 10; i++) {
    const comps = competitorsFor(GAME_WRESTLING, "misthalin", t + i * 86400000, NAMES);
    assert.ok(comps.length >= 3 && comps.length <= 5, `got ${comps.length}`);
  }
});

check("competitorsFor is deterministic", () => {
  const t = new Date(2026, 6, 2, 12, 0).getTime();
  assert.deepEqual(
    competitorsFor(GAME_ARCHERY, "asgarnia", t, NAMES),
    competitorsFor(GAME_ARCHERY, "asgarnia", t, NAMES)
  );
});

check("competitorsFor handles small rosters", () => {
  const t = new Date(2026, 6, 2, 12, 0).getTime();
  const comps = competitorsFor(GAME_DANCE, "keldagrim", t, ["Solo"]);
  assert.equal(comps.length, 1);
  assert.deepEqual(comps, ["Solo"]);
});

check("competitorsFor handles empty roster", () => {
  const t = new Date(2026, 6, 2, 12, 0).getTime();
  assert.deepEqual(competitorsFor(GAME_DANCE, "keldagrim", t, []), []);
});

check("winnerFor picks from competitors", () => {
  const t = new Date(2026, 6, 2, 12, 0).getTime();
  for (let i = 0; i < 10; i++) {
    const day = t + i * 86400000;
    const comps = competitorsFor(GAME_PIE_EATING, "morytania", day, NAMES);
    const winner = winnerFor(GAME_PIE_EATING, "morytania", day, NAMES);
    assert.ok(comps.includes(winner), `${winner} not in ${comps}`);
  }
});

check("winnerFor is deterministic", () => {
  const t = new Date(2026, 6, 2, 12, 0).getTime();
  assert.equal(
    winnerFor(GAME_WRESTLING, "kharidian", t, NAMES),
    winnerFor(GAME_WRESTLING, "kharidian", t, NAMES)
  );
});

check("winnerFor returns null for empty roster", () => {
  const t = new Date(2026, 6, 2, 12, 0).getTime();
  assert.equal(winnerFor(GAME_WRESTLING, "kharidian", t, []), null);
});

// === Venues and kingdoms ===
check("venueFor returns a venue for every game", () => {
  for (const g of GAME_TYPES) {
    const v = venueFor(g, "misthalin");
    assert.ok(v && v.length > 0, `no venue for ${g}`);
  }
});

check("kingdomName resolves known kingdoms", () => {
  assert.equal(kingdomName("misthalin"), "Misthalin");
  assert.equal(kingdomName("asgarnia"), "Asgarnia");
  assert.ok(kingdomName("unknown").length > 0);
});

// === Player ledgers ===
check("enterGame/entryFor round-trip", () => {
  _resetState();
  const now = Date.now();
  enterGame("TestPlayer", GAME_ARCHERY, "misthalin", now);
  assert.equal(entryFor("TestPlayer", now), GAME_ARCHERY);
});

check("enterGame rejects invalid game", () => {
  _resetState();
  const now = Date.now();
  assert.equal(enterGame("TestPlayer", "jousting", "misthalin", now), null);
  assert.equal(entryFor("TestPlayer", now), null);
});

check("entryFor is case-insensitive", () => {
  _resetState();
  const now = Date.now();
  enterGame("TestPlayer", GAME_DANCE, "kandarin", now);
  assert.equal(entryFor("testplayer", now), GAME_DANCE);
});

check("placeBet/betFor round-trip", () => {
  _resetState();
  const now = Date.now();
  placeBet("TestPlayer", "Alice", 100, now);
  const bet = betFor("TestPlayer", now);
  assert.ok(bet);
  assert.equal(bet.amount, 100);
});

check("placeBet caps at 25000", () => {
  _resetState();
  const now = Date.now();
  placeBet("TestPlayer", "Bob", 999999, now);
  assert.equal(betFor("TestPlayer", now).amount, 25000);
});

check("placeBet rejects zero/negative", () => {
  _resetState();
  const now = Date.now();
  assert.equal(placeBet("TestPlayer", "Bob", 0, now), null);
  assert.equal(placeBet("TestPlayer", "Bob", -5, now), null);
});

// === Guards ===
check("isRealPlayer rejects bots", () => {
  assert.equal(isRealPlayer(null), false);
  assert.equal(isRealPlayer({}), false);
  assert.equal(isRealPlayer({ isPlayerBot: () => true }), false);
  assert.equal(isRealPlayer({ getHostAddress: () => "bot" }), false);
});

check("isRealPlayer accepts real players", () => {
  assert.equal(isRealPlayer({ getUsername: () => "Bob" }), true);
});

check("withinTiles handles same-plane distance", () => {
  const mk = (x, y, z) => ({
    getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => z }),
  });
  assert.equal(withinTiles(mk(0, 0, 0), mk(10, 10, 0), 14), true);
  assert.equal(withinTiles(mk(0, 0, 0), mk(20, 0, 0), 14), false);
  assert.equal(withinTiles(mk(0, 0, 0), mk(5, 5, 1), 14), false); // different plane
});

// === Tick behavior ===
function mockDirector(records, onlinePlayers = []) {
  const citizens = new Map();
  return {
    roster: new Map(records.map((r) => [r.username.toLowerCase(), r])),
    playerFor: (record) => citizens.get(record.username.toLowerCase()) ?? null,
    onlinePlayers: () => onlinePlayers,
    _citizens: citizens,
  };
}

function mockCitizen(username, x = 100, y = 100) {
  const lines = [];
  return {
    getUsername: () => username,
    getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => 0 }),
    forceChat: (line) => lines.push(line),
    _lines: lines,
  };
}

function mockPlayer(username, x = 105, y = 105) {
  return {
    getUsername: () => username,
    getHostAddress: () => "1.2.3.4",
    isPlayerBot: () => false,
    getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => 0 }),
  };
}

check("tick does nothing outside festivals", () => {
  _resetState();
  const t = new Date(2026, 1, 1, 12, 0).getTime(); // Feb 1, no festival
  const director = mockDirector([{ username: "Alice", kingdomId: "misthalin" }]);
  const citizen = mockCitizen("Alice");
  director._citizens.set("alice", citizen);
  director.onlinePlayers = () => [mockPlayer("Bob")];
  tickFestivalGames(director, t);
  assert.equal(citizen._lines.length, 0, "should be silent outside festivals");
});

check("tick never throws on hostile input", () => {
  _resetState();
  const t = new Date(2026, 6, 2, 12, 0).getTime();
  tickFestivalGames(null, t);
  tickFestivalGames({}, t);
  tickFestivalGames({ roster: null }, t);
});

check("tick fires near real players during festivals", () => {
  _resetState();
  // Use a festival day
  const t = new Date(2026, 6, 2, 12, 0).getTime();
  assert.ok(festivalToday(t), "test day must be a festival");
  // Many citizens to beat the chance gate
  const records = [];
  for (let i = 0; i < 40; i++) {
    records.push({ username: "Citizen" + i, kingdomId: "misthalin" });
  }
  const director = mockDirector(records);
  for (let i = 0; i < 40; i++) {
    director._citizens.set(("citizen" + i).toLowerCase(), mockCitizen("Citizen" + i));
  }
  director.onlinePlayers = () => [mockPlayer("RealPlayer")];
  tickFestivalGames(director, t);
  let total = 0;
  for (const c of director._citizens.values()) total += c._lines.length;
  assert.ok(total > 0, "at least one citizen should fire near a real player");
});

check("tick is silent with bots only", () => {
  _resetState();
  const t = new Date(2026, 6, 2, 12, 0).getTime();
  const records = [];
  for (let i = 0; i < 20; i++) {
    records.push({ username: "Citizen" + i, kingdomId: "misthalin" });
  }
  const director = mockDirector(records);
  for (let i = 0; i < 20; i++) {
    director._citizens.set(("citizen" + i).toLowerCase(), mockCitizen("Citizen" + i));
  }
  const bot = mockPlayer("BotPlayer");
  bot.isPlayerBot = () => true;
  bot.getHostAddress = () => "bot";
  director.onlinePlayers = () => [bot];
  tickFestivalGames(director, t);
  let total = 0;
  for (const c of director._citizens.values()) total += c._lines.length;
  assert.equal(total, 0, "should be silent with only bots nearby");
});

console.log(`\n${passed} checks passed.`);
