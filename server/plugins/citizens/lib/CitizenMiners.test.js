// CitizenMiners unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const M = require("./CitizenMiners");

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
  fn();
  passed += 1;
  console.log("ok -", name);
}

// --- hashStr: deterministic ---
check("hashStr is deterministic and 32-bit", () => {
  assert.equal(M.hashStr("miner|cofy"), M.hashStr("miner|cofy"));
  assert.ok(M.hashStr("x") >= 0 && M.hashStr("x") < 4294967296);
  assert.notEqual(M.hashStr("miner|a"), M.hashStr("miner|b"));
});

// --- minerTypeFor ---
check("minerTypeFor returns a valid type or null, stable across calls", () => {
  for (let i = 0; i < 50; i++) {
    const t = M.minerTypeFor("user" + i);
    assert.equal(t, M.minerTypeFor("user" + i)); // stable
    assert.ok(t === null || M.MINER_TYPES.includes(t), "bad type: " + t);
  }
  const miners = [];
  for (let i = 0; i < 200; i++) miners.push(M.minerTypeFor("miner-seed-" + i));
  const share = miners.filter(Boolean).length / miners.length;
  assert.ok(share > 0.02 && share < 0.12, "miner share out of range (primary-profession partition ~6%): " + share);
  assert.equal(M.minerTypeFor(""), null);
  assert.equal(M.minerTypeFor(null), null);
});

// --- mineFor: kingdom preference ---
check("mineFor prefers the citizen's kingdom", () => {
  const asg = M.mineFor("prospector-dan", "asgarnia");
  assert.equal(asg.kingdom, "asgarnia");
  const keld = M.mineFor("digger-sue", "keldagrim");
  assert.equal(keld.kingdom, "keldagrim");
  const fallback = M.mineFor("odd-one", "morytania");
  assert.ok(M.MINES.includes(fallback));
  assert.equal(M.mineFor("prospector-dan", "asgarnia").name, asg.name); // stable
});

// --- shiftFor ---
check("shiftFor maps hours to shifts", () => {
  assert.equal(M.shiftFor(Date.UTC(2026, 5, 1, 6, 0)), "dawn");
  assert.equal(M.shiftFor(Date.UTC(2026, 5, 1, 12, 0)), "day");
  assert.equal(M.shiftFor(Date.UTC(2026, 5, 1, 20, 0)), "evening");
  assert.equal(M.shiftFor(Date.UTC(2026, 5, 1, 2, 0)), "night");
});

// --- veinStateFor ---
check("veinStateFor returns a valid state, stable within a day", () => {
  const t = Date.UTC(2026, 5, 1, 12, 0);
  for (let i = 0; i < 50; i++) {
    const s = M.veinStateFor("user" + i, t);
    assert.ok(["rich", "depleted", "normal"].includes(s), "bad state: " + s);
    assert.equal(s, M.veinStateFor("user" + i, t + 3600000)); // same day
  }
  // rich states occur but are rare-ish
  const states = [];
  for (let i = 0; i < 500; i++) states.push(M.veinStateFor("vein-seed-" + i, t));
  const richShare = states.filter((s) => s === "rich").length / states.length;
  assert.ok(richShare > 0.05 && richShare < 0.25, "rich share: " + richShare);
});

// --- oreFor ---
check("oreFor returns a known ore, stable within a day", () => {
  const t = Date.UTC(2026, 5, 1, 12, 0);
  const ore = M.oreFor("digger-sue", t);
  assert.ok(M.ORES.includes(ore));
  assert.equal(ore, M.oreFor("digger-sue", t + 7200000));
});

// --- workLineFor ---
check("workLineFor has lines for every miner type", () => {
  const rng = lcg(42);
  for (const type of M.MINER_TYPES) {
    const line = M.workLineFor(rng, type);
    assert.ok(typeof line === "string" && line.length > 0, "no line for " + type);
  }
  assert.equal(M.workLineFor(rng, "not-a-type"), null);
});

// --- richVeinLineFor / hazardLineFor / hireLineFor ---
check("richVeinLineFor names the ore and the mine", () => {
  const rng = lcg(7);
  const line = M.richVeinLineFor(rng, M.MINES[0], "mithril");
  assert.ok(line.includes("mithril"), line);
  assert.ok(line.includes("Dwarven Mine"), line);
});

check("hazardLineFor returns a warning", () => {
  const line = M.hazardLineFor(lcg(9));
  assert.ok(typeof line === "string" && line.length > 10, line);
});

check("hireLineFor names the mine", () => {
  const line = M.hireLineFor(lcg(11), M.MINES[4]);
  assert.ok(line.includes("Deep Delve"), line);
});

check("maybeHireOffer returns a line for miners, null for non-miners", () => {
  // find a miner username deterministically
  let miner = null;
  for (let i = 0; i < 100 && !miner; i++) {
    if (M.minerTypeFor("hire-seed-" + i)) miner = "hire-seed-" + i;
  }
  assert.ok(miner, "no miner found in 100 tries");
  const offer = M.maybeHireOffer(lcg(13), { username: miner, kingdom: "asgarnia" });
  assert.ok(typeof offer === "string" && offer.length > 0, offer);
  assert.equal(M.maybeHireOffer(lcg(13), { username: null, kingdom: "asgarnia" }), null);
});

// --- shouldFire / shouldCallout / shouldWarnHazard ---
check("shouldFire respects cooldown and chance", () => {
  const now = 20_000_000; // past the 3h work cooldown from t=0
  assert.equal(M.shouldFire(lcg(1), now - 1000, now), false); // on cooldown
  const rng = lcg(77);
  const results = new Set();
  for (let i = 0; i < 50; i++) results.add(M.shouldFire(rng, 0, now));
  assert.ok(results.has(true) && results.has(false), "chance gate never varies");
});

check("shouldCallout and shouldWarnHazard respect cooldowns", () => {
  const now = 20_000_000; // past the 4h/6h cooldowns from t=0
  assert.equal(M.shouldCallout(lcg(1), now - 1000, now), false);
  assert.equal(M.shouldWarnHazard(lcg(1), now - 1000, now), false);
  assert.equal(M.shouldCallout(lcg(3), 0, now), true); // lcg(3) rolls low
});

// --- pickOne ---
check("pickOne is deterministic with the same rng", () => {
  const arr = ["a", "b", "c"];
  assert.equal(M.pickOne(lcg(5), arr), M.pickOne(lcg(5), arr));
  assert.ok(arr.includes(M.pickOne(lcg(6), arr)));
});

// --- tickMiners with a mock director ---
check("tickMiners: miner citizen near a real player does visible work", () => {
  M._resetState();
  let miner = null;
  for (let i = 0; i < 200 && !miner; i++) {
    if (M.minerTypeFor("work-seed-" + i)) miner = "work-seed-" + i;
  }
  assert.ok(miner, "no miner found");

  const spoken = [];
  const citizen = {
    forceChat: (line) => spoken.push(line),
    performAnimation: () => {},
    getLocation: () => ({ getX: () => 3000, getY: () => 3000, getZ: () => 0 }),
    getLocalPlayers: () => [player],
  };
  const player = {
    getUsername: () => "RealPlayer",
    getLocation: () => ({ getX: () => 3005, getY: () => 3005, getZ: () => 0 }),
  };
  const director = {
    roster: new Map([[miner, { username: miner, role: "commoner", kingdom: "asgarnia" }]]),
    isOnline: () => true,
    getBot: () => citizen,
    api: { core: { Animation: class { constructor(id) { this.id = id; } } } },
  };

  // Force the chance gate: call repeatedly with fresh cooldown state.
  let fired = false;
  for (let i = 0; i < 30 && !fired; i++) {
    M._resetState();
    M.tickMiners(director, Date.now());
    fired = spoken.length > 0;
  }
  assert.ok(fired, "miner never fired visible work in 30 tries");
});

check("tickMiners: non-commoner and non-miner records are skipped", () => {
  M._resetState();
  const citizen = {
    forceChat: () => { throw new Error("should not fire"); },
    performAnimation: () => {},
    getLocation: () => ({ getX: () => 3000, getY: () => 3000, getZ: () => 0 }),
    getLocalPlayers: () => [player],
  };
  const player = {
    getUsername: () => "RealPlayer",
    getLocation: () => ({ getX: () => 3005, getY: () => 3005, getZ: () => 0 }),
  };
  // guard role + a commoner who is not a miner (null type)
  let nonMiner = null;
  for (let i = 0; i < 200 && !nonMiner; i++) {
    if (M.minerTypeFor("plain-seed-" + i) === null) nonMiner = "plain-seed-" + i;
  }
  const director = {
    roster: new Map([
      ["guard-bob", { username: "guard-bob", role: "guard", kingdom: "asgarnia" }],
      [nonMiner, { username: nonMiner, role: "commoner", kingdom: "asgarnia" }],
    ]),
    isOnline: () => true,
    getBot: () => citizen,
  };
  M.tickMiners(director, Date.now()); // must not throw, must not fire
});

check("tickMiners: silent with no real player near", () => {
  M._resetState();
  let miner = null;
  for (let i = 0; i < 200 && !miner; i++) {
    if (M.minerTypeFor("quiet-seed-" + i)) miner = "quiet-seed-" + i;
  }
  let spoke = false;
  const citizen = {
    forceChat: () => { spoke = true; },
    performAnimation: () => {},
    getLocation: () => ({ getX: () => 3000, getY: () => 3000, getZ: () => 0 }),
    getLocalPlayers: () => [bot],
  };
  // bot players don't count
  const bot = {
    getUsername: () => "BotBob",
    isPlayerBot: () => true,
    getHostAddress: () => "bot",
    getLocation: () => ({ getX: () => 3005, getY: () => 3005, getZ: () => 0 }),
  };
  const director = {
    roster: new Map([[miner, { username: miner, role: "commoner", kingdom: "asgarnia" }]]),
    isOnline: () => true,
    getBot: () => citizen,
  };
  for (let i = 0; i < 10; i++) {
    M._resetState();
    M.tickMiners(director, Date.now());
  }
  assert.equal(spoke, false, "miner fired with only bots nearby");
});

check("tickMiners: never throws on garbage input", () => {
  M.tickMiners({}, Date.now());
  M.tickMiners(null, Date.now());
  M.tickMiners({ roster: { values: () => { throw new Error("boom"); } } }, Date.now());
});

// --- isRealPlayer / withinTiles ---
check("isRealPlayer and withinTiles behave", () => {
  assert.equal(M.isRealPlayer(null), false);
  assert.equal(M.isRealPlayer({ isPlayerBot: () => true }), false);
  assert.equal(M.isRealPlayer({ getUsername: () => "x" }), true);
  const a = { getLocation: () => ({ getX: () => 0, getY: () => 0, getZ: () => 0 }) };
  const b = { getLocation: () => ({ getX: () => 3, getY: () => 4, getZ: () => 0 }) };
  assert.equal(M.withinTiles(a, b, 4), true); // Chebyshev: max(3,4)=4 <= 4
  assert.equal(M.withinTiles(a, b, 3), false);
});

console.log(`\n${passed} checks passed.`);
