// CitizenLibrarians unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const lib = require("./CitizenLibrarians");

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

// 1. hashStr is deterministic and non-empty.
check("hashStr deterministic", () => {
  assert.equal(lib.hashStr("alice"), lib.hashStr("alice"));
  assert.ok(lib.hashStr("alice").length > 0);
  assert.notEqual(lib.hashStr("alice"), lib.hashStr("bob"));
});

// 2. hashChance is in [0,1) and deterministic.
check("hashChance range + deterministic", () => {
  for (let i = 0; i < 50; i++) {
    const v = lib.hashChance("seed", "user" + i);
    assert.ok(v >= 0 && v < 1, `out of range: ${v}`);
  }
  assert.equal(lib.hashChance("a", "b"), lib.hashChance("a", "b"));
});

// 3. isLibrarian is stable across calls.
check("isLibrarian stable", () => {
  for (let i = 0; i < 30; i++) {
    const u = "citizen" + i;
    assert.equal(lib.isLibrarian(u), lib.isLibrarian(u));
  }
});

// 4. ~35% of a sample are librarians (loose band, deterministic).
check("librarian fraction roughly 35%", () => {
  let n = 0;
  const total = 400;
  for (let i = 0; i < total; i++) if (lib.isLibrarian("libfrac" + i)) n++;
  const frac = n / total;
  assert.ok(frac > 0.2 && frac < 0.5, `fraction ${frac}`);
});

// 5. librarianTypeFor is stable and one of the four types.
check("librarianTypeFor stable + valid", () => {
  const valid = new Set(["archivist", "researcher", "scribe", "storyteller"]);
  const seen = new Set();
  for (let i = 0; i < 100; i++) {
    const u = "ltype" + i;
    const t = lib.librarianTypeFor(u);
    assert.equal(t, lib.librarianTypeFor(u));
    assert.ok(valid.has(t), `bad type ${t}`);
    seen.add(t);
  }
  assert.ok(seen.size === 4, `expected all 4 types, saw ${[...seen]}`);
});

// 6. libraryFor prefers the citizen's kingdom.
check("libraryFor kingdom preference", () => {
  let match = 0;
  for (let i = 0; i < 60; i++) {
    const libInfo = lib.libraryFor("libpref" + i, "keldagrim");
    if (/keldagrim|dwarven/i.test(libInfo.name)) match++;
  }
  assert.ok(match > 40, `only ${match}/60 matched keldagrim`);
});

// 7. libraryFor is stable and falls back for unknown kingdoms.
check("libraryFor stable + fallback", () => {
  const a = lib.libraryFor("someone", "varrock");
  const b = lib.libraryFor("someone", "varrock");
  assert.equal(a.name, b.name);
  const c = lib.libraryFor("someone", "not-a-kingdom");
  assert.ok(c.name.length > 0);
});

// 8. catalogFor returns all 10 subjects with 1-3 titles each.
check("catalogFor shape", () => {
  const cat = lib.catalogFor("reader1", "varrock", Date.now());
  assert.ok(cat.library.length > 0);
  const subjects = Object.keys(cat.catalog);
  assert.equal(subjects.length, 10);
  for (const s of subjects) {
    assert.ok(cat.catalog[s].length >= 1 && cat.catalog[s].length <= 3);
  }
});

// 9. catalogFor is stable within a day, changes across days.
check("catalogFor daily rhythm", () => {
  const day1 = Date.UTC(2026, 9, 8, 12, 0, 0);
  const day2 = Date.UTC(2026, 9, 9, 12, 0, 0);
  const a = lib.catalogFor("daily1", "varrock", day1);
  const b = lib.catalogFor("daily1", "varrock", day1 + 3600000);
  assert.deepEqual(a, b);
  const c = lib.catalogFor("daily1", "varrock", day2);
  assert.ok(JSON.stringify(a) !== JSON.stringify(c), "catalog should usually differ day to day");
});

// 10. collectionSize grows over time.
check("collectionSize grows", () => {
  const t1 = Date.UTC(2026, 0, 1);
  const t2 = Date.UTC(2027, 0, 1);
  const s1 = lib.collectionSize("grower", "varrock", t1);
  const s2 = lib.collectionSize("grower", "varrock", t2);
  assert.ok(s2 > s1, `${s2} should exceed ${s1}`);
  assert.ok(s1 >= 400);
});

// 11. isTaleHours covers evening hours only.
check("isTaleHours", () => {
  const evening = new Date(2026, 9, 8, 20, 0, 0).getTime();
  const morning = new Date(2026, 9, 8, 10, 0, 0).getTime();
  assert.equal(lib.isTaleHours(evening), true);
  assert.equal(lib.isTaleHours(morning), false);
});

// 12. workLineFor / offerLineFor return non-empty strings for every type.
check("line pools non-empty", () => {
  const rng = lcg(42);
  for (const t of ["archivist", "researcher", "scribe", "storyteller"]) {
    const w = lib.workLineFor(t, rng);
    assert.ok(w && w.length > 0, `empty work line for ${t}`);
    const o = lib.offerLineFor(t, rng, "dragons");
    assert.ok(o && o.length > 0, `empty offer line for ${t}`);
    assert.ok(!o.includes("{topic}"), `unfilled template for ${t}`);
  }
});

// 13. borrowBook / borrowedFor / returnBook round-trip.
check("borrowing ledger round-trip", () => {
  const now = Date.now();
  const rec = lib.borrowBook("Jon", "A Chronicle of the Five Kingdoms", "Libby", now);
  assert.ok(rec && rec.dueInDays === 7);
  const got = lib.borrowedFor("jon"); // case-insensitive
  assert.ok(got && got.title === "A Chronicle of the Five Kingdoms");
  const ret = lib.returnBook("JON");
  assert.ok(ret && ret.title === "A Chronicle of the Five Kingdoms");
  assert.equal(lib.borrowedFor("jon"), null);
});

// 14. donateTome accepts and journals.
check("donateTome", () => {
  const r = lib.donateTome("Jon", "My Travel Diary", "Libby");
  assert.ok(r.accepted === true && r.title === "My Travel Diary");
});

// 15. isRealPlayer gates bots and nulls.
check("isRealPlayer gates", () => {
  assert.equal(lib.isRealPlayer(null), false);
  assert.equal(lib.isRealPlayer({}), false);
  const bot = { isPlayerBot: () => true, getUsername: () => "bot1" };
  assert.equal(lib.isRealPlayer(bot), false);
  const host = { getHostAddress: () => "bot", getUsername: () => "bot2" };
  assert.equal(lib.isRealPlayer(host), false);
  const human = { getHostAddress: () => "1.2.3.4", getUsername: () => "Jon" };
  assert.equal(lib.isRealPlayer(human), true);
});

// 16. withinTiles Chebyshev math.
check("withinTiles", () => {
  const mk = (x, y, z) => ({ getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => z }) });
  assert.equal(lib.withinTiles(mk(0, 0, 0), mk(10, 10, 0), 14), true);
  assert.equal(lib.withinTiles(mk(0, 0, 0), mk(15, 0, 0), 14), false);
  assert.equal(lib.withinTiles(mk(0, 0, 0), mk(0, 0, 1), 14), false); // different plane
  assert.equal(lib.withinTiles(null, mk(0, 0, 0), 14), false);
});

// 17. tickLibrarians never throws on a hostile director.
check("tickLibrarians never throws", () => {
  lib.tickLibrarians(null, Date.now());
  lib.tickLibrarians({}, Date.now());
  lib.tickLibrarians({ roster: null }, Date.now());
});

// 18. tickLibrarians fires near a real player and stays silent otherwise.
check("tickLibrarians proximity gating", () => {
  // Find a username that IS a librarian deterministically.
  let libUser = null;
  for (let i = 0; i < 500 && !libUser; i++) {
    if (lib.isLibrarian("ticklib" + i)) libUser = "ticklib" + i;
  }
  assert.ok(libUser, "should find a librarian username");

  const mkLoc = (x, y) => ({ getX: () => x, getY: () => y, getZ: () => 0 });
  const mkPlayer = (name, x, y, bot) => ({
    getUsername: () => name,
    getLocation: () => mkLoc(x, y),
    isPlayerBot: () => !!bot,
    getHostAddress: () => (bot ? "bot" : "9.9.9.9"),
    forceChat: () => {},
  });

  const record = { username: libUser, kingdom: "varrock" };
  const citizen = mkPlayer(libUser, 100, 100, true);
  const human = mkPlayer("Jon", 105, 105, false);

  const said = [];
  citizen.forceChat = (line) => said.push(line);

  // Case A: real player near -> may fire (chance-gated, run many ticks).
  let fired = 0;
  for (let i = 0; i < 40; i++) {
    said.length = 0;
    lib.tickLibrarians(
      {
        roster: new Map([[libUser, record]]),
        playerFor: () => citizen,
        onlinePlayers: () => [human],
      },
      Date.now() + i * 4 * 3600 * 1000 // step past cooldowns
    );
    if (said.length) fired++;
  }
  assert.ok(fired > 0, "expected at least one firing near a real player");

  // Case B: only bots near -> never fires.
  const botOnly = mkPlayer("botx", 105, 105, true);
  for (let i = 0; i < 10; i++) {
    said.length = 0;
    lib.tickLibrarians(
      {
        roster: new Map([[libUser, record]]),
        playerFor: () => citizen,
        onlinePlayers: () => [botOnly],
      },
      Date.now() + 10 * 86400000 + i * 4 * 3600 * 1000
    );
    assert.equal(said.length, 0, "should stay silent with only bots near");
  }
});

// 19. tickLibrarians skips non-librarians.
check("tickLibrarians skips non-librarians", () => {
  let nonLib = null;
  for (let i = 0; i < 500 && !nonLib; i++) {
    if (!lib.isLibrarian("nlib" + i)) nonLib = "nlib" + i;
  }
  const mkLoc = (x, y) => ({ getX: () => x, getY: () => y, getZ: () => 0 });
  const citizen = {
    getUsername: () => nonLib,
    getLocation: () => mkLoc(0, 0),
    isPlayerBot: () => true,
    getHostAddress: () => "bot",
    forceChat: () => {
      throw new Error("should never fire");
    },
  };
  const human = {
    getUsername: () => "Jon",
    getLocation: () => mkLoc(1, 1),
    isPlayerBot: () => false,
    getHostAddress: () => "9.9.9.9",
  };
  for (let i = 0; i < 5; i++) {
    lib.tickLibrarians(
      {
        roster: new Map([[nonLib, { username: nonLib, kingdom: "varrock" }]]),
        playerFor: () => citizen,
        onlinePlayers: () => [human],
      },
      Date.now() + i * 5 * 3600 * 1000
    );
  }
});

// 20. pickOne is deterministic with injected rng.
check("pickOne deterministic", () => {
  const arr = ["a", "b", "c"];
  assert.equal(lib.pickOne(lcg(7), arr), lib.pickOne(lcg(7), arr));
});

console.log(`\n${passed}/20 checks passed.`);
