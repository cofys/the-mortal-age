// CitizenHunters unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const H = require("./CitizenHunters");

// Deterministic LCG — coverage is exact, not luck-based.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Mock locations for withinTiles.
function fakePlayer(x, y, z) {
  return {
    getLocation() {
      return { getX: () => x, getY: () => y, getZ: () => z };
    },
    getUsername() { return "Player"; },
  };
}
function fakeBot(x, y, z) {
  return {
    getLocation() {
      return { getX: () => x, getY: () => y, getZ: () => z };
    },
    isPlayerBot() { return true; },
    getHostAddress() { return "bot"; },
  };
}

let checks = 0;
function check(name, fn) {
  fn();
  checks++;
  console.log(`ok - ${name}`);
}

// 1. hashStr is deterministic and distributes.
check("hashStr deterministic", () => {
  assert.equal(H.hashStr("hunter|alice"), H.hashStr("hunter|alice"));
  assert.notEqual(H.hashStr("hunter|alice"), H.hashStr("hunter|bob"));
});

// 2. hunterTypeFor: ~35% are hunters, stable, valid types.
check("hunterTypeFor stable and typed", () => {
  const names = [];
  for (let i = 0; i < 200; i++) names.push("citizen" + i);
  let hunters = 0;
  for (const n of names) {
    const t1 = H.hunterTypeFor(n);
    const t2 = H.hunterTypeFor(n);
    assert.equal(t1, t2, "type must be stable");
    if (t1) {
      hunters++;
      assert.ok(H.HUNTER_TYPES.includes(t1), "type must be one of the four");
    }
  }
  assert.ok(hunters >= 3 && hunters <= 30, `~6% hunters (primary-profession partition), got ${hunters}/200`);
  assert.equal(H.hunterTypeFor(null), null);
  assert.equal(H.hunterTypeFor(""), null);
});

// 3. groundFor prefers the citizen's kingdom and stays stable.
check("groundFor kingdom preference and stability", () => {
  const g = H.groundFor("alice", "kandarin", "bowman");
  assert.ok(g, "ground must exist");
  assert.equal(g.kingdom, "kandarin");
  assert.equal(H.groundFor("alice", "kandarin", "bowman"), g);
  const fb = H.groundFor("alice", "no-such-kingdom", "bowman");
  assert.ok(fb, "falls back to all grounds");
});

// 4. beastmasters prefer low-danger ground.
check("beastmaster ground is low danger", () => {
  let low = 0;
  for (let i = 0; i < 100; i++) {
    const g = H.groundFor("beast" + i, "kandarin", "beastmaster");
    assert.ok(g);
    if (g.danger === "low") low++;
  }
  assert.ok(low >= 80, `beastmasters want calm ground, got ${low}/100 low`);
});

// 5. preyFor comes from the right danger table.
check("preyFor matches ground danger", () => {
  const low = { danger: "low" };
  const high = { danger: "high" };
  assert.ok(H.PREY.low.includes(H.preyFor("x", low, 0)));
  assert.ok(H.PREY.high.includes(H.preyFor("x", high, 0)));
  // deterministic per day
  assert.equal(H.preyFor("x", high, 86400000), H.preyFor("x", high, 86400000));
});

// 6. trophyFor comes from the trophy table.
check("trophyFor matches ground danger", () => {
  const med = { danger: "medium" };
  assert.ok(H.TROPHIES.medium.includes(H.trophyFor("x", med, 0)));
});

// 7. Line pools are complete for every type.
check("work lines exist for all four types", () => {
  const rng = lcg(42);
  for (const t of H.HUNTER_TYPES) {
    const line = H.workLineFor(rng, t);
    assert.ok(typeof line === "string" && line.length > 0, `no line for ${t}`);
  }
  assert.equal(H.workLineFor(lcg(1), "nope"), null);
});

// 8. Trophy / hawk / warn / injury lines interpolate names.
check("scripted lines name the trophy, prey and ground", () => {
  const ground = { name: "the Kandarin forest" };
  const rngs = [() => 0.01, () => 0.34, () => 0.67, () => 0.99]; // hit every variant
  // Trophy lines always name the trophy; the pool mentions the ground.
  let trophyAll = "", warnAll = "", injuryAll = "", hawkAll = "";
  for (const r of rngs) {
    trophyAll += H.trophyLineFor(r, "twelve-point stag", ground);
    warnAll += H.warnLineFor(r, ground);
    injuryAll += H.injuryLineFor(r, ground);
    hawkAll += H.hawkLineFor(r, "deer", ground);
    assert.ok(H.trophyLineFor(r, "twelve-point stag", ground).includes("twelve-point stag"));
    assert.ok(H.hawkLineFor(r, "deer", ground).toLowerCase().includes("deer"));
  }
  assert.ok(trophyAll.includes("the Kandarin forest"));
  assert.ok(warnAll.includes("the Kandarin forest"));
  assert.ok(injuryAll.includes("the Kandarin forest"));
  assert.ok(hawkAll.includes("the Kandarin forest"));
  // null ground must not throw
  const r = () => 0.5;
  assert.ok(H.trophyLineFor(r, "deer", null).includes("deer"));
  assert.ok(H.hawkLineFor(r, "deer", null).toLowerCase().includes("deer"));
  assert.ok(H.warnLineFor(r, null).length > 0);
  assert.ok(H.injuryLineFor(r, null).length > 0);
});

// 9. shouldFire respects the cooldown.
check("shouldFire gates on cooldown then chance", () => {
  const now = 1_000_000_000;
  const rngHigh = () => 0.999; // fails chance
  const rngLow = () => 0.0; // passes chance
  assert.equal(H.shouldFire(rngLow, now - 1000, now), false, "cooldown blocks");
  assert.equal(H.shouldFire(rngHigh, 0, now), false, "chance fails");
  assert.equal(H.shouldFire(rngLow, 0, now), true, "fires when both pass");
});

// 10. shouldHawk / shouldWarn respect their cooldowns.
check("shouldHawk and shouldWarn gate correctly", () => {
  const now = 2_000_000_000;
  const rng = () => 0.0;
  assert.equal(H.shouldHawk(rng, now - 1000, now), false);
  assert.equal(H.shouldHawk(rng, 0, now), true);
  assert.equal(H.shouldWarn(rng, now - 1000, now), false);
  assert.equal(H.shouldWarn(rng, 0, now), true);
});

// 11. isRealPlayer distinguishes humans from bots.
check("isRealPlayer", () => {
  assert.equal(H.isRealPlayer(null), false);
  assert.equal(H.isRealPlayer(fakePlayer(0, 0, 0)), true);
  assert.equal(H.isRealPlayer(fakeBot(0, 0, 0)), false);
  assert.equal(H.isRealPlayer({}), false);
});

// 12. withinTiles uses Chebyshev distance on the same plane.
check("withinTiles Chebyshev", () => {
  const a = fakePlayer(100, 100, 0);
  assert.ok(H.withinTiles(a, fakePlayer(110, 105, 0), 10)); // dx=10 ok
  assert.ok(!H.withinTiles(a, fakePlayer(111, 100, 0), 10)); // dx=11 too far
  assert.ok(!H.withinTiles(a, fakePlayer(100, 100, 1), 10)); // different plane
  assert.ok(!H.withinTiles(null, a, 10));
});

// 13. animFor maps every type.
check("animFor maps all hunter types", () => {
  for (const t of H.HUNTER_TYPES) {
    assert.ok(Number.isInteger(H.animFor(t)), `no anim for ${t}`);
  }
});

// 14. huntLootFor returns loot for hunters, null for non-hunters.
check("huntLootFor supply hook", () => {
  let found = false;
  for (let i = 0; i < 60; i++) {
    const loot = H.huntLootFor("citizen" + i, "kandarin", 86400000);
    if (loot) {
      found = true;
      assert.ok(H.HUNTER_TYPES.includes(loot.type));
      assert.ok(typeof loot.ground === "string" && loot.ground.length > 0);
      assert.ok(typeof loot.prey === "string" && loot.prey.length > 0);
      break;
    }
  }
  assert.ok(found, "some citizen must be a hunter");
  assert.equal(H.huntLootFor(null, "kandarin", 0), null);
});

// 15. tickHunters fires near real players only, never throws on hostile input.
// (hunters audit 2026-10-08: old mocks used the dead director.playerFor /
// director.onlinePlayers — replaced with isOnline/getBot + bot getLocalPlayers.)
check("tickHunters gates and never throws", () => {
  H._resetState();
  const real = fakePlayer(0, 0, 0);
  const botNear = fakeBot(1, 1, 0);
  const citizens = [];
  // Find a deterministic hunter username.
  let hunterName = null;
  for (let i = 0; i < 200; i++) {
    if (H.hunterTypeFor("hunterx" + i)) { hunterName = "hunterx" + i; break; }
  }
  assert.ok(hunterName, "need a hunter username");
  const seen = [];
  const citizen = {
    forceChat(msg) { seen.push(msg); },
    getLocation() { return { getX: () => 0, getY: () => 0, getZ: () => 0 }; },
    performAnimation() {},
    getLocalPlayers() { return [real, botNear]; },
  };
  const director = {
    roster: new Map([[hunterName, { username: hunterName, role: "commoner", kingdomId: "kandarin" }]]),
    isOnline: () => true,
    getBot: () => citizen,
    api: {},
  };
  // With the hunter at the same tile as the real player, a work loop
  // should eventually fire (chance 0.4, no cooldown after reset).
  const { getJournal } = require("./CitizenJournal");
  getJournal().resetForTests();
  let fired = false;
  for (let i = 0; i < 25 && !fired; i++) {
    H._resetState();
    seen.length = 0;
    H.tickHunters(director, Date.now());
    if (seen.length > 0) fired = true;
  }
  assert.ok(fired, "work loop must fire near a real player within 25 ticks");
  // Journal is canonical: one kind:"work" entry per visible loop, ground
  // kingdom-preferred (records carry kingdomId, not kingdom).
  const events = getJournal().recent(hunterName, 10);
  const work = events.find((e) => e.kind === "work");
  assert.ok(work, "journal holds a kind:work entry for the hunter");
  const ground = H.groundFor(hunterName, "kandarin", H.hunterTypeFor(hunterName));
  assert.ok(ground && work.text.includes(ground.name), "work loop journals the kingdom-preferred ground");
  // Silence near bots only: citizen bot present but no real player nearby.
  const botLines = [];
  const citizenBotsOnly = {
    forceChat(msg) { botLines.push(msg); },
    getLocation() { return { getX: () => 0, getY: () => 0, getZ: () => 0 }; },
    performAnimation() {},
    getLocalPlayers() { return [botNear]; },
  };
  H._resetState();
  H.tickHunters({
    roster: new Map([[hunterName, { username: hunterName, role: "commoner", kingdomId: "kandarin" }]]),
    isOnline: () => true,
    getBot: () => citizenBotsOnly,
    api: {},
  }, Date.now());
  assert.equal(botLines.length, 0, "tick stays silent when only bots are near");
  // Silence when offline: non-materialized citizen never works.
  const empty = { roster: new Map(), isOnline: () => false, getBot: () => null };
  H.tickHunters(empty, Date.now());
  // Hostile input never throws.
  H.tickHunters(null, Date.now());
  H.tickHunters({}, "not-a-date");
});

// 16. Guards never hunt; non-commoners are skipped.
// (hunters audit 2026-10-08: the old prod code used director.playerFor /
// director.onlinePlayers, which do not exist, so this tier was
// dead-on-arrival. These mocks pin the real-API shape: isOnline/getBot on
// the director (CitizenDirector.js:1374/1379), getLocalPlayers on the bot
// (Player.ts:796). Records carry kingdomId, not kingdom.)
check("guards never hunt", () => {
  H._resetState();
  const real = fakePlayer(0, 0, 0);
  const citizen = {
    forceChat() { throw new Error("guard must not fire"); },
    getLocation() { return { getX: () => 0, getY: () => 0, getZ: () => 0 }; },
    getLocalPlayers() { return [real]; },
  };
  const director = {
    roster: new Map([["guard1", { username: "guard1", role: "guard", kingdomId: "kandarin" }]]),
    isOnline: () => true,
    getBot: () => citizen,
    api: {},
  };
  for (let i = 0; i < 5; i++) H.tickHunters(director, Date.now() + i * 1000);
});

console.log(`\nAll ${checks} checks passed.`);
