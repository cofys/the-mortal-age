// CitizenHerbalists unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const {
  hashStr,
  typeFor,
  isHerbalist,
  groundFor,
  herbsFor,
  herbOfTheDay,
  seasonFor,
  hawkLine,
  rareFindLine,
  shouldFire,
  isRealPlayer,
  withinTiles,
  HERBALIST_RADIUS,
  _playAnim,
} = require("./CitizenHerbalists");

// Deterministic LCG — coverage is exact, not luck-based.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

let n = 0;
function check(name, fn) {
  fn();
  n++;
  console.log(`ok ${n} - ${name}`);
}

// 1. hashStr is stable and well-distributed
check("hashStr stable", () => {
  assert.equal(hashStr("Ada"), hashStr("Ada"));
  assert.notEqual(hashStr("Ada"), hashStr("Bob"));
});

// 2. typeFor returns one of the four types, stable per username
check("typeFor stable and known", () => {
  const ids = ["wildcrafter", "gardener", "botanist", "supplier"];
  for (const name of ["Ada", "Bob", "Cora", "Dane", "Eve"]) {
    assert.ok(ids.includes(typeFor(name).id), typeFor(name).id);
    assert.equal(typeFor(name).id, typeFor(name).id);
  }
});

// 3. isHerbalist excludes guards and merchants
check("isHerbalist excludes guards/merchants", () => {
  assert.equal(isHerbalist({ username: "x", role: "guard" }), false);
  assert.equal(isHerbalist({ username: "x", role: "merchant" }), false);
});

// 4. isHerbalist selects roughly ~35% of commoners
check("isHerbalist share ~35%", () => {
  let yes = 0;
  for (let i = 0; i < 200; i++) yes += isHerbalist({ username: "commoner" + i, role: "commoner" }) ? 1 : 0;
  assert.ok(yes >= 50 && yes <= 90, `share ${yes}/200`);
});

// 5. groundFor prefers the citizen's kingdom
check("groundFor kingdom preference", () => {
  const g = groundFor("Ada", "asgarnia");
  assert.equal(g.kingdom, "asgarnia");
  // unknown kingdom falls back to any ground
  const any = groundFor("Ada", "nosuchkingdom");
  assert.ok(typeof any.name === "string");
});

// 6. seasonFor never throws and returns a season name
check("seasonFor returns season", () => {
  const s = seasonFor(Date.UTC(2026, 6, 1));
  assert.ok(["spring", "summer", "autumn", "winter"].includes(s), s);
});

// 7. herbsFor respects seasonal tiers (winter has no exotic)
check("herbsFor seasonal tiers", () => {
  // summer (July) includes exotic; winter (Jan) does not
  const summer = herbsFor("Ada", "asgarnia", Date.UTC(2026, 6, 15));
  const winter = herbsFor("Ada", "asgarnia", Date.UTC(2026, 0, 15));
  assert.ok(summer.some((h) => h.rarity === "exotic"), "summer has exotic");
  assert.ok(!winter.some((h) => h.rarity === "exotic"), "winter has no exotic");
});

// 8. herbsFor is deterministic per day
check("herbsFor deterministic", () => {
  const a = herbsFor("Ada", "asgarnia", Date.UTC(2026, 6, 15));
  const b = herbsFor("Ada", "asgarnia", Date.UTC(2026, 6, 15));
  assert.deepEqual(a, b);
});

// 9. herbOfTheDay is stable within a day, from available herbs
check("herbOfTheDay stable", () => {
  const t = Date.UTC(2026, 6, 15, 12);
  const a = herbOfTheDay("Ada", "asgarnia", t);
  const b = herbOfTheDay("Ada", "asgarnia", t + 3600000);
  assert.deepEqual(a, b);
  assert.ok(["common", "uncommon", "rare", "exotic"].includes(a.rarity));
});

// 10. hawkLine and rareFindLine return strings mentioning the herb
check("lines mention herb", () => {
  const h = hawkLine(typeFor("Ada"), "ranarr weed");
  assert.ok(h.includes("ranarr weed"), h);
  const r = rareFindLine("torstol");
  assert.ok(Array.isArray(r) && r.length > 0 && r.every((x) => x.includes("torstol")));
});

// 11. shouldFire respects cooldown
check("shouldFire cooldown", () => {
  const rng = lcg(1);
  const now = 1000000;
  assert.equal(shouldFire(rng, now - 1000, now), false); // fired 1s ago
});

// 12. shouldFire chance gate works
check("shouldFire chance", () => {
  const now = 1000000;
  const old = now - 2 * 3600 * 1000;
  const rng = lcg(42);
  let fired = 0;
  for (let i = 0; i < 200; i++) if (shouldFire(rng, old, now)) fired++;
  assert.ok(fired > 30 && fired < 110, `fired ${fired}/200`);
});

// 13. isRealPlayer rejects bots and non-players
check("isRealPlayer gates", () => {
  assert.equal(isRealPlayer(null), false);
  assert.equal(isRealPlayer({ isPlayerBot: () => true, getUsername: () => "x" }), false);
  assert.equal(isRealPlayer({ getHostAddress: () => "bot", getUsername: () => "x" }), false);
  assert.equal(isRealPlayer({ getHostAddress: () => "1.2.3.4", getUsername: () => "Jon" }), true);
});

// 14. withinTiles Chebyshev + plane check
check("withinTiles distance", () => {
  const mk = (x, y, z) => ({ getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => z }) });
  assert.equal(withinTiles(mk(0, 0, 0), mk(14, 14, 0), HERBALIST_RADIUS), true);
  assert.equal(withinTiles(mk(0, 0, 0), mk(15, 0, 0), HERBALIST_RADIUS), false);
  assert.equal(withinTiles(mk(0, 0, 0), mk(0, 0, 1), HERBALIST_RADIUS), false);
});

// 15. tick never throws on hostile input
check("tickHerbalists never throws", () => {
  const { tickHerbalists } = require("./CitizenHerbalists");
  assert.doesNotThrow(() => tickHerbalists(null, Date.now()));
  assert.doesNotThrow(() => tickHerbalists({}, Date.now()));
  assert.doesNotThrow(() => tickHerbalists({ roster: "nope" }, Date.now()));
});

// 16. tick fires near a real player (scripted, zero LLM)
check("tick fires near real player", () => {
  const { tickHerbalists } = require("./CitizenHerbalists");
  const mkLoc = (x, y, z) => ({ getX: () => x, getY: () => y, getZ: () => z });
  // Find a username that hashes as herbalist and pick a type deterministically.
  let uname = null;
  for (let i = 0; i < 500 && !uname; i++) {
    const cand = "ticktest" + i;
    if (isHerbalist({ username: cand, role: "commoner" })) uname = cand;
  }
  assert.ok(uname, "found herbalist username");
  const chats = [];
  // Canonical journal check: the module writes via the real CitizenJournal
  // singleton (getJournal().log), not director.journal.addEntry (dead API).
  const { getJournal } = require("./CitizenJournal");
  getJournal().resetForTests();
  const citizen = {
    getLocation: () => mkLoc(3000, 3000, 0),
    forceChat: (line) => chats.push(line),
    performAnimation: () => {},
  };
  const human = {
    getLocation: () => mkLoc(3005, 3005, 0),
    getHostAddress: () => "1.2.3.4",
    getUsername: () => "Jon",
  };
  const director = {
    roster: new Map([[uname, { username: uname, role: "commoner", kingdom: "asgarnia" }]]),
    isOnline: () => true,
    getBot: () => citizen,
    playerFor: () => citizen,
    world: { getPlayers: () => [citizen, human] },
  };
  // Chance gate is hash-based; sweep candidate times until one fires.
  let fired = false;
  for (let i = 0; i < 20 && !fired; i++) {
    tickHerbalists(director, Date.now() + 400000000000 + i * 3599999, undefined);
    if (chats.length > 0) fired = true;
  }
  assert.ok(fired, "citizen chatted near a real player");
  const entries = getJournal().recent(uname, 10);
  assert.ok(entries.some((e) => e.kind === "work"), "work was journaled");
});

console.log(`\n${n}/18 checks passed`);

// 17-18. 2026-10-08 playtest crash regression: playAnim must pass a real
// engine Animation (getId AND getDelay), never a partial duck-type, because
// PlayerSession.createActorUpdates reads both in the player-view update path.
check("playAnim passes a real Animation object", () => {
  class FakeAnim {
    constructor(id) { this.id = id; }
    getId() { return this.id; }
    getDelay() { return 0; }
    getPriority() { return 0; }
  }
  const director = { api: { core: { Animation: FakeAnim } } };
  let received = null;
  const citizen = { performAnimation: (a) => { received = a; } };
  const ok = _playAnim(director, citizen, 363);
  assert.equal(ok, true);
  assert.equal(typeof received.getId, "function");
  assert.equal(typeof received.getDelay, "function");
  assert.equal(received.getId(), 363);
  assert.doesNotThrow(() => ({ id: received.getId(), delay: received.getDelay() }));
});

check("playAnim is a no-op without the engine Animation class", () => {
  let called = false;
  const citizen = { performAnimation: () => { called = true; } };
  const ok = _playAnim({ api: { core: {} } }, citizen, 363);
  assert.equal(ok, false);
  assert.equal(called, false);
});
