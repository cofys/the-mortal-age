// CitizenFishingTournaments unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const {
  FISH_POOL,
  PRIZE_COINS,
  tournamentKey,
  hash01,
  fishingSkillFor,
  entryKeenness,
  pickEntrants,
  simulateCatches,
  scoreCategories,
  newTournament,
  advanceTournament,
  buildResultsText,
  fillLine,
  ANNOUNCE_MS,
  REGISTRATION_MS,
  COMPETITION_MS,
  WEIGHIN_MS,
  PRIZES_MS,
  CYCLE_MS,
  MAX_ENTRANTS,
  _tournaments,
} = require("./CitizenFishingTournaments");

// Deterministic LCG — coverage is exact, not luck-based.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function fakeRecord(username, traits, role, kingdomId) {
  return {
    username,
    personality: { traits },
    role,
    kingdomId,
  };
}

function fakeDirector(records) {
  const roster = new Map(records.map((r) => [r.username.toLowerCase(), r]));
  return {
    roster,
    api: { emitCustomEvent: () => {} },
  };
}

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

// 1. tournamentKey is the kingdom id string.
check("tournamentKey returns kingdom id", () => {
  assert.equal(tournamentKey("asgarnia"), "asgarnia");
  assert.equal(tournamentKey(42), "42");
});

// 2. hash01 is deterministic and in [0,1).
check("hash01 deterministic in range", () => {
  const a = hash01("hello");
  const b = hash01("hello");
  assert.equal(a, b);
  assert.ok(a >= 0 && a < 1);
  assert.notEqual(hash01("hello"), hash01("world"));
});

// 3. fishingSkillFor is stable 1-99 and case-insensitive.
check("fishingSkillFor stable 1-99", () => {
  const s1 = fishingSkillFor("Bob");
  const s2 = fishingSkillFor("bob");
  const s3 = fishingSkillFor("BOB");
  assert.equal(s1, s2);
  assert.equal(s2, s3);
  assert.ok(s1 >= 1 && s1 <= 99);
  // Different names (usually) give different skills.
  assert.notEqual(fishingSkillFor("Alice"), fishingSkillFor("Zara the Unlikely"));
});

// 4. entryKeenness: patient types keen, gruff types averse, bounded 0..1.
check("entryKeenness personality weighting", () => {
  const keen = entryKeenness(fakeRecord("a", ["patient", "calm"], "commoner", "k"));
  const averse = entryKeenness(fakeRecord("b", ["gruff", "suspicious"], "guard", "k"));
  assert.ok(keen > averse);
  assert.ok(keen >= 0 && keen <= 1);
  assert.ok(averse >= 0 && averse <= 1);
});

// 5. pickEntrants caps at MAX_ENTRANTS.
check("pickEntrants caps entrants", () => {
  const rng = lcg(7);
  const eligible = [];
  for (let i = 0; i < 30; i++) {
    eligible.push(fakeRecord(`c${i}`, ["patient"], "commoner", "k"));
  }
  const chosen = pickEntrants(rng, eligible);
  assert.equal(chosen.length, MAX_ENTRANTS);
});

// 6. simulateCatches: skill gates fish, catches have shape.
check("simulateCatches skill-gated", () => {
  const rng = lcg(99);
  // Low-skill citizen can only catch low-minSkill fish.
  const lowSkill = Object.keys({}).length; // placeholder
  void lowSkill;
  const catches = simulateCatches(rng, "lowbie");
  for (const c of catches) {
    assert.ok(typeof c.name === "string");
    assert.ok(c.weightKg > 0);
    assert.ok(c.rarity >= 0);
  }
  // Over many ticks a high-skill citizen sees rare fish; a 1-skill never does.
  // Find a username hashing to low skill by brute force (deterministic).
  let lowName = null;
  for (let i = 0; i < 500 && !lowName; i++) {
    if (fishingSkillFor("low" + i) <= 5) lowName = "low" + i;
  }
  const r2 = lcg(1234);
  let sawRare = false;
  for (let t = 0; t < 200; t++) {
    for (const c of simulateCatches(r2, lowName)) {
      if (c.rarity >= 7) sawRare = true;
    }
  }
  assert.equal(sawRare, false, "low-skill citizen must never catch rare fish");
});

// 7. scoreCategories picks the right winners.
check("scoreCategories three categories", () => {
  const entrants = [
    { username: "big", catches: [{ name: "shark", weightKg: 100, rarity: 7 }], isPlayer: false },
    { username: "many", catches: [
      { name: "shrimp", weightKg: 0.05, rarity: 0 },
      { name: "shrimp", weightKg: 0.06, rarity: 0 },
      { name: "sardine", weightKg: 0.1, rarity: 0 },
    ], isPlayer: false },
    { username: "rare", catches: [{ name: "sacred eel", weightKg: 1.5, rarity: 10 }], isPlayer: false },
  ];
  const r = scoreCategories(entrants);
  assert.equal(r.biggest.username, "big");
  assert.equal(r.biggest.weightKg, 100);
  assert.equal(r.most.username, "many");
  assert.equal(r.most.count, 3);
  assert.equal(r.rarest.username, "rare");
  assert.equal(r.rarest.rarity, 10);
});

// 8. scoreCategories handles empty entrants.
check("scoreCategories empty safe", () => {
  const r = scoreCategories([]);
  assert.equal(r.biggest, null);
  assert.equal(r.most, null);
  assert.equal(r.rarest, null);
});

// 9. newTournament starts idle with staggered delay.
check("newTournament idle staggered", () => {
  const now = 1_000_000;
  const t1 = newTournament("asgarnia", now);
  const t2 = newTournament("misthalin", now);
  assert.equal(t1.phase, "idle");
  assert.equal(t2.phase, "idle");
  assert.ok(t1.phaseEndsAt > now && t1.phaseEndsAt <= now + 6 * 24 * 3600 * 1000);
  assert.notEqual(t1.phaseEndsAt, t2.phaseEndsAt, "staggered per kingdom");
});

// 10. advanceTournament walks the full phase machine.
check("advanceTournament full cycle", () => {
  const rng = lcg(42);
  const records = [];
  for (let i = 0; i < 20; i++) {
    records.push(fakeRecord(`angler${i}`, ["patient"], "commoner", "asgarnia"));
  }
  const director = fakeDirector(records);
  const t = newTournament("asgarnia", 0);
  let now = 0;

  // idle -> announcement
  now = t.phaseEndsAt + 1;
  let a = advanceTournament(rng, director, t, now);
  assert.equal(t.phase, "announcement");
  assert.equal(t.phaseEndsAt, now + ANNOUNCE_MS);
  assert.ok(a.length > 0);

  // announcement -> registration
  now = t.phaseEndsAt + 1;
  a = advanceTournament(rng, director, t, now);
  assert.equal(t.phase, "registration");
  assert.equal(t.phaseEndsAt, now + REGISTRATION_MS);

  // registration -> competition (entrants picked)
  now = t.phaseEndsAt + 1;
  a = advanceTournament(rng, director, t, now);
  assert.equal(t.phase, "competition");
  assert.equal(t.phaseEndsAt, now + COMPETITION_MS);
  assert.ok(t.entrants.length > 0 && t.entrants.length <= MAX_ENTRANTS);

  // give entrants some catches so results are non-empty
  for (const e of t.entrants) {
    e.catches.push({ name: "trout", weightKg: 0.5, rarity: 1 });
  }

  // competition -> weigh-in
  now = t.phaseEndsAt + 1;
  a = advanceTournament(rng, director, t, now);
  assert.equal(t.phase, "weigh-in");
  assert.equal(t.phaseEndsAt, now + WEIGHIN_MS);

  // weigh-in -> prizes (results scored)
  now = t.phaseEndsAt + 1;
  a = advanceTournament(rng, director, t, now);
  assert.equal(t.phase, "prizes");
  assert.equal(t.phaseEndsAt, now + PRIZES_MS);
  assert.ok(t.results);
  assert.ok(t.results.biggest && t.results.most && t.results.rarest);
  assert.ok(t.history.length === 1);

  // prizes -> idle (next cycle)
  now = t.phaseEndsAt + 1;
  a = advanceTournament(rng, director, t, now);
  assert.equal(t.phase, "idle");
  assert.equal(t.phaseEndsAt, now + CYCLE_MS);
});

// 11. advanceTournament does nothing before phase end.
check("advanceTournament no early advance", () => {
  const rng = lcg(1);
  const director = fakeDirector([]);
  const t = newTournament("k", 1000);
  const a = advanceTournament(rng, director, t, 1001);
  assert.equal(a.length, 0);
  assert.equal(t.phase, "idle");
});

// 12. buildResultsText formats winners.
check("buildResultsText formats", () => {
  const t = {
    kingdomId: "asgarnia",
    results: {
      biggest: { username: "big", fish: "shark", weightKg: 100 },
      most: { username: "many", count: 5 },
      rarest: { username: "rare", fish: "sacred eel" },
    },
  };
  const text = buildResultsText(t);
  assert.ok(text.includes("big"));
  assert.ok(text.includes("100kg shark"));
  assert.ok(text.includes("many"));
  assert.ok(text.includes("rare"));
});

// 13. buildResultsText handles no results.
check("buildResultsText empty safe", () => {
  const text = buildResultsText({ kingdomId: "k", results: null });
  assert.ok(text.includes("no catches"));
});

// 14. fillLine substitutes vars.
check("fillLine substitutes", () => {
  assert.equal(fillLine("Hello {name}!", { name: "Bob" }), "Hello Bob!");
  assert.equal(fillLine("{a} and {b}", { a: "x", b: "y" }), "x and y");
});

// 15. FISH_POOL is sane: names unique, minSkill ascending-ish, rarity bounded.
check("FISH_POOL sane", () => {
  const names = FISH_POOL.map((f) => f.name);
  assert.equal(new Set(names).size, names.length, "unique names");
  for (const f of FISH_POOL) {
    assert.ok(f.weightKg > 0);
    assert.ok(f.rarity >= 0 && f.rarity <= 10);
    assert.ok(f.minSkill >= 1 && f.minSkill <= 99);
  }
  assert.ok(FISH_POOL.length >= 15);
});

// 16. PRIZE_COINS has the three placements.
check("PRIZE_COINS placements", () => {
  assert.ok(PRIZE_COINS.first > PRIZE_COINS.second);
  assert.ok(PRIZE_COINS.second > PRIZE_COINS.third);
});

console.log(`\n${passed}/16 checks passed`);
