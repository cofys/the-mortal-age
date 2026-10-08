// CitizenFishers unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const {
  tickFishers,
  hashStr,
  fisherTypeFor,
  spotFor,
  seasonFor,
  weatherFor,
  catchFor,
  canFish,
  workLineFor,
  bigCatchLineFor,
  hawkLineFor,
  stormLineFor,
  fishCatchFor,
  animFor,
  shouldFire,
  shouldHawk,
  shouldWarnStorm,
  pickOne,
  isRealPlayer,
  withinTiles,
  FISHER_TYPES,
  SPOTS,
  CATCHES,
  _resetState,
} = require("./CitizenFishers");

// Deterministic LCG — coverage is exact, not luck-based.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function at(x, y, z) {
  return { getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => z }) };
}

function realPlayer(username, x, y) {
  return {
    getUsername: () => username,
    isPlayerBot: () => false,
    getHostAddress: () => "1.2.3.4",
    getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => 0 }),
  };
}

function botPlayer(username, x, y) {
  return {
    getUsername: () => username,
    isPlayerBot: () => true,
    getHostAddress: () => "bot",
    getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => 0 }),
  };
}

function citizenBot(x, y) {
  const chat = [];
  return {
    chat,
    forceChat: (line) => chat.push(line),
    performAnimation: () => true,
    getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => 0 }),
    isPlayerBot: () => true,
    getHostAddress: () => "bot",
    getUsername: () => "citizenbot",
  };
}

let checks = 0;
function check(name, fn) {
  try {
    fn();
    checks++;
    console.log("ok - " + name);
  } catch (e) {
    console.error("FAIL - " + name + ": " + (e && e.message));
    process.exitCode = 1;
  }
}

// 1. hashStr is deterministic and varies by input.
check("hashStr deterministic + varied", () => {
  assert.equal(hashStr("fisher|alice"), hashStr("fisher|alice"));
  assert.notEqual(hashStr("fisher|alice"), hashStr("fisher|bob"));
});

// 2. Fisher type distribution: ~35% of usernames are fishers, stable.
check("fisherTypeFor ~35% stable across restarts", () => {
  const names = [];
  for (let i = 0; i < 500; i++) names.push("citizen" + i);
  const fishers = names.filter((n) => fisherTypeFor(n));
  const ratio = fishers.length / names.length;
  assert.ok(ratio > 0.28 && ratio < 0.42, "ratio " + ratio);
  // Stability: same result on second pass.
  assert.deepEqual(names.map(fisherTypeFor), names.map(fisherTypeFor));
  // All types represented.
  const seen = new Set(fishers.map(fisherTypeFor));
  assert.deepEqual([...seen].sort(), [...FISHER_TYPES].sort());
  // Null/empty usernames are not fishers.
  assert.equal(fisherTypeFor(null), null);
  assert.equal(fisherTypeFor(""), null);
});

// 3. Spot assignment prefers the citizen's kingdom.
check("spotFor prefers kingdom, ice/deepsea need right water", () => {
  const s1 = spotFor("spotuser1", "kandarin", "river fisher");
  assert.equal(s1.kingdom, "kandarin");
  const s2 = spotFor("spotuser2", "keldagrim", "ice fisher");
  assert.equal(s2.kind, "ice");
  const s3 = spotFor("spotuser3", "misthalin", "deep-sea fisher");
  assert.ok(s3.kind === "sea" || s3.short === "mosleharmless", s3.kind);
  // Stability.
  assert.deepEqual(s1, spotFor("spotuser1", "kandarin", "river fisher"));
});

// 4. Seasons map months correctly.
check("seasonFor month mapping", () => {
  assert.equal(seasonFor(0), "winter");
  assert.equal(seasonFor(3), "spring");
  assert.equal(seasonFor(6), "summer");
  assert.equal(seasonFor(9), "autumn");
  assert.equal(seasonFor(11), "winter");
});

// 5. Weather is derived per-day, deterministic, and agrees for all.
check("weatherFor deterministic per day", () => {
  const day = Date.UTC(2026, 5, 15, 12);
  const w1 = weatherFor(day);
  const w2 = weatherFor(day + 3600 * 1000);
  assert.equal(w1, w2);
  assert.ok(["storm", "breezy", "calm"].includes(w1), w1);
  const other = weatherFor(Date.UTC(2026, 5, 16, 12));
  assert.ok(["storm", "breezy", "calm"].includes(other), other);
});

// 6. Catches come from the spot's waters.
check("catchFor matches spot kind", () => {
  const sea = { name: "x", short: "x", kingdom: "k", kind: "sea" };
  const river = { name: "y", short: "y", kingdom: "k", kind: "river" };
  const day = Date.UTC(2026, 8, 1);
  assert.ok(CATCHES.sea.includes(catchFor("u", sea, day)));
  assert.ok(CATCHES.river.includes(catchFor("u", river, day)));
  // Stable within a day.
  assert.equal(catchFor("u", sea, day), catchFor("u", sea, day + 5000));
});

// 7. canFish: ice fishers only in winter, nobody in storms.
check("canFish gating", () => {
  assert.equal(canFish("ice fisher", "calm", "winter"), true);
  assert.equal(canFish("ice fisher", "calm", "summer"), false);
  assert.equal(canFish("deep-sea fisher", "storm", "summer"), false);
  assert.equal(canFish("river fisher", "breezy", "spring"), true);
  assert.equal(canFish("pearl diver", "storm", "autumn"), false);
});

// 8. Work lines exist for every type and are emotes/calls.
check("workLineFor every type non-null", () => {
  const rng = lcg(42);
  for (const t of FISHER_TYPES) {
    const line = workLineFor(rng, t);
    assert.ok(typeof line === "string" && line.length > 0, t);
  }
  assert.equal(workLineFor(rng, "nope"), null);
});

// 9. Big-catch lines mention the fish and spot.
check("bigCatchLineFor mentions fish + spot", () => {
  const line = bigCatchLineFor(lcg(7), "shark", { name: "the Karamja docks" });
  assert.ok(line.includes("shark"), line);
  assert.ok(line.includes("the Karamja docks"), line);
});

// 10. Hawk lines advertise fresh catch.
check("hawkLineFor advertises catch", () => {
  const line = hawkLineFor(lcg(11), "trout", { name: "the Hemenster falls" });
  assert.ok(line.toLowerCase().includes("trout"), line);
  assert.ok(line.toLowerCase().includes("fresh") || line.toLowerCase().includes("for sale"), line);
});

// 11. Storm lines read as warnings.
check("stormLineFor reads as warning", () => {
  const line = stormLineFor(lcg(13));
  assert.ok(/storm|sea|waves|swell|harbour/i.test(line), line);
});

// 12. fishCatchFor export for market stalls.
check("fishCatchFor supply hook", () => {
  const day = Date.UTC(2026, 9, 10);
  // Find a username that is definitely NOT a fisher.
  let nonFisher = null;
  for (let i = 0; i < 500 && !nonFisher; i++) {
    if (!fisherTypeFor("notafisher" + i)) nonFisher = "notafisher" + i;
  }
  assert.ok(nonFisher, "expected a non-fisher username");
  assert.equal(fishCatchFor(nonFisher, "kandarin", day), null);
  // Find a real fisher and verify the shape.
  let found = null;
  for (let i = 0; i < 200 && !found; i++) {
    const r = fishCatchFor("citizen" + i, "kandarin", day);
    if (r) found = r;
  }
  assert.ok(found, "expected at least one fisher");
  assert.ok(FISHER_TYPES.includes(found.type), found.type);
  assert.ok(typeof found.spot === "string" && typeof found.fish === "string");
});

// 13. animFor maps types to engine animations (622/621/618/619).
check("animFor per-type animations", () => {
  assert.equal(animFor("river fisher"), 622);
  assert.equal(animFor("deep-sea fisher"), 618);
  assert.equal(animFor("pearl diver"), 619);
  assert.equal(animFor("ice fisher"), 621);
});

// 14. shouldFire respects cooldown then chance.
check("shouldFire cooldown + chance", () => {
  const now = 20 * 3600 * 1000; // well past the 3h cooldown
  assert.equal(shouldFire(lcg(1), now - 1000, now), false);
  assert.equal(shouldFire(() => 0.999, 0, now), false);
  assert.equal(shouldFire(() => 0.0, 0, now), true);
});

// 15. shouldHawk / shouldWarnStorm respect cooldowns.
check("shouldHawk + shouldWarnStorm cooldowns", () => {
  const now = 20 * 3600 * 1000; // well past the 4h/6h cooldowns
  assert.equal(shouldHawk(lcg(2), now - 1000, now), false);
  assert.equal(shouldHawk(() => 0.0, 0, now), true);
  assert.equal(shouldWarnStorm(lcg(3), now - 1000, now), false);
  assert.equal(shouldWarnStorm(() => 0.0, 0, now), true);
});

// 16. isRealPlayer / withinTiles gates.
check("isRealPlayer + withinTiles", () => {
  assert.equal(isRealPlayer(realPlayer("jon", 0, 0)), true);
  assert.equal(isRealPlayer(botPlayer("bot1", 0, 0)), false);
  assert.equal(isRealPlayer(null), false);
  const a = at(0, 0, 0);
  assert.equal(withinTiles(a, at(5, 5, 0), 10), true);
  assert.equal(withinTiles(a, at(20, 0, 0), 10), false);
  assert.equal(withinTiles(a, at(5, 5, 1), 10), false);
  assert.equal(withinTiles(a, null, 10), false);
});

// 17. pickOne is deterministic with injected rng.
check("pickOne deterministic", () => {
  const arr = ["a", "b", "c"];
  assert.equal(pickOne(() => 0.0, arr), "a");
  assert.equal(pickOne(() => 0.99, arr), "c");
});

// 18. tickFishers fires near a real player, silent near bots only.
check("tickFishers work pass fires near real players only", () => {
  _resetState();
  // Pick a username that is definitely a fisher, and not an ice fisher
  // (ice fishers only work in winter).
  let fisher = null;
  for (let i = 0; i < 500 && !fisher; i++) {
    const t = fisherTypeFor("tickfisher" + i);
    if (t && t !== "ice fisher") fisher = "tickfisher" + i;
  }
  assert.ok(fisher, "need a non-ice fisher username");
  const bot = citizenBot(100, 100);
  const rec = { username: fisher, role: "commoner", kingdom: "kandarin" };
  // Mock Math.random to always pass the chance gate.
  const origRandom = Math.random;
  Math.random = () => 0.0;
  try {
    // Force calm weather for determinism: stub Date? weatherFor uses the
    // real clock — instead accept any weather except storm by looping days.
    // Simpler: just verify silence with no players, then chat with one.
    const noPlayers = {
      roster: new Map([[fisher, rec]]),
      playerFor: () => bot,
      onlinePlayers: () => [],
      api: null,
    };
    tickFishers(noPlayers, Date.now());
    assert.equal(bot.chat.length, 0, "no players -> no work lines");

    // Bots only -> silence.
    const botsOnly = {
      roster: new Map([[fisher, rec]]),
      playerFor: () => bot,
      onlinePlayers: () => [botPlayer("b1", 100, 101)],
      api: null,
    };
    tickFishers(botsOnly, Date.now());
    assert.equal(bot.chat.length, 0, "bots only -> no work lines");

    // Real player nearby -> fires unless storm/off-season. Run up to a few
    // candidate timestamps; at least one should fire within 3 tries
    // (weather is per-day; most days are not storms).
    let fired = 0;
    for (let d = 0; d < 5; d++) {
      _resetState();
      const bot2 = citizenBot(100, 100);
      const withPlayer = {
        roster: new Map([[fisher, rec]]),
        playerFor: () => bot2,
        onlinePlayers: () => [realPlayer("jon", 100, 102)],
        api: null,
      };
      tickFishers(withPlayer, Date.UTC(2026, 6, 1 + d, 12));
      fired += bot2.chat.length;
    }
    assert.ok(fired > 0, "real player nearby should trigger work lines");
  } finally {
    Math.random = origRandom;
  }
});

// 19. tickFishers never throws on hostile input.
check("tickFishers never throws", () => {
  _resetState();
  tickFishers(null, Date.now());
  tickFishers({}, Date.now());
  tickFishers({ roster: new Map([["x", null]]) }, Date.now());
  tickFishers({ roster: null }, Date.now());
});

// 20. Guards never fish.
check("guards are not fishers in the tick", () => {
  _resetState();
  let fisher = null;
  for (let i = 0; i < 500 && !fisher; i++) {
    if (fisherTypeFor("guardfisher" + i)) fisher = "guardfisher" + i;
  }
  const origRandom = Math.random;
  Math.random = () => 0.0;
  try {
    const bot = citizenBot(100, 100);
    const director = {
      roster: new Map([[fisher, { username: fisher, role: "guard", kingdom: "kandarin" }]]),
      playerFor: () => bot,
      onlinePlayers: () => [realPlayer("jon", 100, 102)],
      api: null,
    };
    tickFishers(director, Date.UTC(2026, 6, 1, 12));
    assert.equal(bot.chat.length, 0, "guards never fish");
  } finally {
    Math.random = origRandom;
  }
});

console.log("\n" + checks + " checks passed");
