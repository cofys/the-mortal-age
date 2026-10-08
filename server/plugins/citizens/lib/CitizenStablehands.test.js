// CitizenStablehands unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const {
  hashStr,
  hashChance,
  pickOne,
  fill,
  stableTypeFor,
  stableForUsername,
  mountsFor,
  rareBreedFor,
  feedFor,
  seasonFor,
  dayKey,
  stableMountFor,
  releaseMountFor,
  stabledMountsFor,
  shouldFire,
  isRealPlayer,
  withinTiles,
  tickStablehands,
  STABLES,
  STABLE_TYPES,
  RARE_BREEDS,
  _resetState,
} = require("./CitizenStablehands");

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function loc(x, y, z = 0) {
  return { getX: () => x, getY: () => y, getZ: () => z };
}

function fakePlayer(username, isBot = false, x = 100, y = 100) {
  return {
    getUsername: () => username,
    isPlayerBot: () => isBot,
    getHostAddress: () => (isBot ? "bot" : "1.2.3.4"),
    getLocation: () => loc(x, y),
    forceChatCalls: [],
    forceChat(line) {
      this.forceChatCalls.push(line);
    },
  };
}

let n = 0;
function check(name, fn) {
  _resetState();
  try {
    fn();
    n++;
  } catch (e) {
    console.error(`FAIL: ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

// 1. hashStr is deterministic and non-empty.
check("hashStr deterministic", () => {
  assert.equal(hashStr("ada"), hashStr("ada"));
  assert.ok(hashStr("ada").length > 0);
  assert.notEqual(hashStr("ada"), hashStr("bob"));
});

// 2. hashChance stays in [0, 1).
check("hashChance range", () => {
  for (let i = 0; i < 50; i++) {
    const v = hashChance("seed", i);
    assert.ok(v >= 0 && v < 1, `out of range: ${v}`);
  }
});

// 3. pickOne picks from the array.
check("pickOne", () => {
  const arr = ["a", "b", "c"];
  const got = pickOne(lcg(7), arr);
  assert.ok(arr.includes(got));
});

// 4. fill replaces slots.
check("fill", () => {
  assert.equal(fill("Hello {name} of {place}", { name: "Ada", place: "Varrock" }), "Hello Ada of Varrock");
  assert.equal(fill("No slots", {}), "No slots");
});

// 5. stableTypeFor: stable across calls, null or a valid type.
check("stableTypeFor stable + valid", () => {
  const a = stableTypeFor("ada");
  const b = stableTypeFor("ada");
  assert.equal(a, b);
  assert.ok(a === null || STABLE_TYPES.includes(a), `bad type: ${a}`);
});

// 6. Distribution: ~35% of usernames are stablehands.
check("stableTypeFor ~35%", () => {
  let count = 0;
  for (let i = 0; i < 2000; i++) {
    if (stableTypeFor(`user${i}`)) count++;
  }
  assert.ok(count > 500 && count < 900, `unexpected count: ${count}`);
});

// 7. All four types appear in a large sample.
check("all stablehand types appear", () => {
  const seen = new Set();
  for (let i = 0; i < 5000 && seen.size < 4; i++) {
    const t = stableTypeFor(`typecheck${i}`);
    if (t) seen.add(t);
  }
  assert.equal(seen.size, 4, `missing types: ${[...seen]}`);
});

// 8. stableForUsername prefers the kingdom's stable.
check("stableForUsername kingdom-preferred", () => {
  let preferred = 0;
  for (let i = 0; i < 200; i++) {
    const s = stableForUsername(`pref${i}`, "varrock");
    assert.ok(STABLES.includes(s));
    if (s.kingdom === "varrock") preferred++;
  }
  assert.ok(preferred > 150, `preferred only ${preferred}/200`);
});

// 9. mountsFor returns 3-7 mounts with valid types and coats.
check("mountsFor roster", () => {
  const mounts = mountsFor(STABLES[0], Date.UTC(2026, 5, 15));
  assert.ok(mounts.length >= 3 && mounts.length <= 7, `count ${mounts.length}`);
  for (const m of mounts) {
    assert.ok(["horse", "warhorse", "pony"].includes(m.type));
    assert.ok(typeof m.coat === "string" && m.coat.length > 0);
  }
});

// 10. mountsFor is deterministic for the same day.
check("mountsFor deterministic", () => {
  const a = mountsFor(STABLES[2], Date.UTC(2026, 5, 15));
  const b = mountsFor(STABLES[2], Date.UTC(2026, 5, 15));
  assert.deepEqual(a, b);
});

// 11. rareBreedFor: null or a valid breed entry.
check("rareBreedFor valid", () => {
  const known = new Set(RARE_BREEDS.map((r) => r.breed));
  for (let d = 0; d < 40; d++) {
    const r = rareBreedFor(STABLES[0], Date.UTC(2026, 0, 1 + d));
    if (r) {
      assert.ok(known.has(r.breed), `unknown breed: ${r.breed}`);
      assert.ok(r.sex === "colt" || r.sex === "filly");
    }
  }
});

// 12. feedFor returns a non-empty list.
check("feedFor non-empty", () => {
  const feed = feedFor(Date.UTC(2026, 6, 1));
  assert.ok(Array.isArray(feed) && feed.length > 0);
});

// 13. seasonFor buckets months correctly.
check("seasonFor", () => {
  assert.equal(seasonFor(Date.UTC(2026, 0, 15)), "winter");
  assert.equal(seasonFor(Date.UTC(2026, 3, 15)), "spring");
  assert.equal(seasonFor(Date.UTC(2026, 6, 15)), "summer");
  assert.equal(seasonFor(Date.UTC(2026, 9, 15)), "autumn");
});

// 14. dayKey format.
check("dayKey", () => {
  assert.equal(dayKey(Date.UTC(2026, 0, 5)), "2026-01-05");
});

// 15. Stabling ledger round-trip.
check("stabling ledger round-trip", () => {
  const now = Date.now();
  assert.equal(stableMountFor("Ada", "Varrock horse market", "bay horse", now), true);
  const list = stabledMountsFor("Ada");
  assert.equal(list.length, 1);
  assert.equal(list[0].stable, "Varrock horse market");
  assert.equal(list[0].mount, "bay horse");
  assert.equal(releaseMountFor("Ada", "Varrock horse market"), "bay horse");
  assert.deepEqual(stabledMountsFor("Ada"), []);
  assert.equal(releaseMountFor("Ada", "Varrock horse market"), null);
});

// 16. shouldFire respects cooldown.
check("shouldFire cooldown", () => {
  const now = 1_000_000_000;
  assert.equal(shouldFire(() => 0.0, now - 60 * 1000, now), false); // recent
  assert.equal(shouldFire(() => 0.0, now - 4 * 3600 * 1000, now), true); // old
  assert.equal(shouldFire(() => 0.99, 0, now), false); // chance fails
});

// 17. isRealPlayer gates bots and nulls.
check("isRealPlayer", () => {
  assert.equal(isRealPlayer(null), false);
  assert.equal(isRealPlayer(fakePlayer("Ada")), true);
  assert.equal(isRealPlayer(fakePlayer("Bot1", true)), false);
  assert.equal(isRealPlayer({}), false);
});

// 18. withinTiles Chebyshev.
check("withinTiles", () => {
  const a = fakePlayer("A", false, 100, 100);
  const b = fakePlayer("B", false, 110, 105);
  const c = fakePlayer("C", false, 200, 200);
  assert.equal(withinTiles(a, b, 14), true);
  assert.equal(withinTiles(a, c, 14), false);
});

// 19. tickStablehands never throws on hostile input.
check("tickStablehands never-throws", () => {
  tickStablehands(null, Date.now());
  tickStablehands({}, Date.now());
  tickStablehands({ roster: null }, Date.now());
});

// 20. tickStablehands fires for a materialized stablehand near a real player.
check("tickStablehands fires near real player", () => {
  // Find a username that maps to a stablehand type.
  let name = null;
  for (let i = 0; i < 5000 && !name; i++) {
    if (stableTypeFor(`tick${i}`)) name = `tick${i}`;
  }
  assert.ok(name, "no stablehand username found in sample");

  const citizen = fakePlayer(name, false, 100, 100);
  const real = fakePlayer("RealHuman", false, 105, 105);
  // Many stablehands so the 35% chance gate fires with near certainty.
  const citizens = [];
  const roster = new Map();
  let i = 0;
  while (citizens.length < 40 && i < 20000) {
    const nm = `tick${i}`;
    if (stableTypeFor(nm)) {
      const c = fakePlayer(nm, false, 100, 100);
      citizens.push(c);
      roster.set(nm, { username: nm, kingdom: "varrock" });
    }
    i++;
  }
  assert.ok(citizens.length >= 40, "not enough stablehand usernames found");
  const byName = new Map(citizens.map((c) => [c.getUsername(), c]));
  const director = {
    roster,
    playerFor: (record) => byName.get(record.username),
    onlinePlayers: () => [real],
  };
  tickStablehands(director, Date.now() + 10 * 3600 * 1000); // far future, past cooldowns
  const fired = citizens.filter((c) => c.forceChatCalls.length > 0);
  assert.ok(fired.length > 0, "expected at least one forceChat");
  for (const c of fired) {
    for (const line of c.forceChatCalls) {
      assert.ok(line.length <= 120, `line too long: ${line}`);
    }
  }
  // Cooldown entries were recorded for citizens that fired.
  const firedNames = citizens.filter((c) => c.forceChatCalls.length > 0).map((c) => c.getUsername());
  assert.ok(firedNames.length > 0);
  // Re-run at the same timestamp: fired citizens must stay silent (cooldown gate).
  const perCitizenBefore = new Map(citizens.map((c) => [c.getUsername(), c.forceChatCalls.length]));
  tickStablehands(director, Date.now() + 10 * 3600 * 1000);
  for (const nm of firedNames) {
    const c = byName.get(nm);
    assert.equal(c.forceChatCalls.length, perCitizenBefore.get(nm), `${nm} fired again despite cooldown`);
  }
});

// 21. tickStablehands stays silent with no real player near.
check("tickStablehands silent without players", () => {
  let name = null;
  for (let i = 0; i < 5000 && !name; i++) {
    if (stableTypeFor(`quiet${i}`)) name = `quiet${i}`;
  }
  assert.ok(name);
  const citizen = fakePlayer(name, false, 100, 100);
  const director = {
    roster: new Map([[name, { username: name, kingdom: "varrock" }]]),
    playerFor: () => citizen,
    onlinePlayers: () => [],
  };
  tickStablehands(director, Date.now() + 10 * 3600 * 1000);
  assert.equal(citizen.forceChatCalls.length, 0);
});

// 22. tickStablehands skips non-stablehands.
check("tickStablehands skips non-stablehands", () => {
  let name = null;
  for (let i = 0; i < 5000 && !name; i++) {
    if (!stableTypeFor(`plain${i}`)) name = `plain${i}`;
  }
  assert.ok(name);
  const citizen = fakePlayer(name, false, 100, 100);
  const real = fakePlayer("RealHuman", false, 105, 105);
  const director = {
    roster: new Map([[name, { username: name, kingdom: "varrock" }]]),
    playerFor: () => citizen,
    onlinePlayers: () => [real],
  };
  tickStablehands(director, Date.now() + 10 * 3600 * 1000);
  assert.equal(citizen.forceChatCalls.length, 0);
});

console.log(`CitizenStablehands: ${n} checks passed`);
