// CitizenInnkeepers2 unit checks — pure logic, no running server.
// From server/plugins/citizens: node lib/CitizenInnkeepers2.test.js (plain node)
"use strict";

const assert = require("node:assert/strict");
const Host = require("./CitizenInnkeepers2");

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log("ok - " + name);
}

// Deterministic name pool.
function names(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push("testuser" + i);
  return out;
}

function withFixedRandom(value, fn) {
  const orig = Math.random;
  Math.random = () => value;
  try {
    return fn();
  } finally {
    Math.random = orig;
  }
}

function mockLocation(x, y, z = 0) {
  return { getX: () => x, getY: () => y, getZ: () => z };
}
function mockPlayer(name, x, y, isBot = false) {
  return {
    getUsername: () => name,
    getHostAddress: () => (isBot ? "bot" : "127.0.0.1"),
    isPlayerBot: () => isBot,
    getLocation: () => mockLocation(x, y),
  };
}
function mockDirector(records, players) {
  const bots = new Map();
  return {
    roster: new Map(records.map((r) => [r.username, r])),
    playerFor: (record) => {
      const bot = mockPlayer(record.username, 3200, 3200, true);
      bot.forceChat = (m) => (bot._said = (bot._said || []).concat(m));
      bots.set(record.username, bot);
      return bot;
    },
    onlinePlayers: () => players,
    _bots: bots,
  };
}

// --- 1. type weights / reachability ---
check("type weights reachable", () => {
  const seen = new Set();
  for (const n of names(5000)) {
    const t = Host.hostfolkTypeOf({ username: n, role: "commoner" });
    if (t) seen.add(t);
  }
  for (const t of Host.HOSTFOLK_TYPES) assert.ok(seen.has(t), "type reachable: " + t);
});

// --- 2. type stability ---
check("type stable across calls", () => {
  for (const n of names(500)) {
    const a = Host.hostfolkTypeOf({ username: n, role: "commoner" });
    const b = Host.hostfolkTypeOf({ username: n, role: "commoner" });
    assert.equal(a, b, "stable: " + n);
  }
});

// --- 3. roll boundaries ---
check("hostfolkTypeFromRoll boundaries", () => {
  // weights: 30/30/25/15
  assert.equal(Host.hostfolkTypeFromRoll(0), Host.HOSTFOLK_HOST);
  assert.equal(Host.hostfolkTypeFromRoll(29), Host.HOSTFOLK_HOST);
  assert.equal(Host.hostfolkTypeFromRoll(30), Host.HOSTFOLK_BREWER);
  assert.equal(Host.hostfolkTypeFromRoll(59), Host.HOSTFOLK_BREWER);
  assert.equal(Host.hostfolkTypeFromRoll(60), Host.HOSTFOLK_FEASTER);
  assert.equal(Host.hostfolkTypeFromRoll(84), Host.HOSTFOLK_FEASTER);
  assert.equal(Host.hostfolkTypeFromRoll(85), Host.HOSTFOLK_REGULAR);
  assert.equal(Host.hostfolkTypeFromRoll(99), Host.HOSTFOLK_REGULAR);
});

// --- 4. commoner gating ---
check("commoner gating", () => {
  assert.equal(Host.hostfolkTypeOf({ username: "x", role: "guard" }), null);
  assert.equal(Host.hostfolkTypeOf({ username: "", role: "commoner" }), null);
  assert.equal(Host.hostfolkTypeOf(null), null);
});

// --- 5. salt correlation (name-first salts, no starved bucket) ---
check("no salt correlation in type deciles", () => {
  const buckets = new Array(10).fill(0);
  let total = 0;
  for (const n of names(10000)) {
    const roll = Host.hashStr(n + "|hostfolk") % 100;
    if (roll < 40) {
      const typeRoll = Host.hashStr(n + "|hostfolk-type") % 100;
      buckets[Math.floor(typeRoll / 10)]++;
      total++;
    }
  }
  assert.ok(total > 3000, "enough hostfolk sampled: " + total);
  for (let i = 0; i < 10; i++) {
    const expected = total / 10;
    assert.ok(buckets[i] > expected * 0.5, `bucket ${i} not starved: ${buckets[i]} vs ${expected}`);
  }
});

// --- 6. pro innkeeper exclusion (against the real module) ---
check("pro innkeepers excluded", () => {
  const Pro = require("./CitizenInnkeepers");
  let proName = null;
  for (const n of names(5000)) {
    if (Pro.innTypeFor(n)) {
      proName = n;
      break;
    }
  }
  assert.ok(proName, "found a pro innkeeper name");
  assert.equal(Host.hostfolkTypeOf({ username: proName, role: "commoner" }), null);
});

// --- 7. distribution band ---
check("distribution in band", () => {
  let count = 0;
  const total = 3000;
  for (const n of names(total)) {
    if (Host.hostfolkTypeOf({ username: n, role: "commoner" })) count++;
  }
  const pct = (count / total) * 100;
  assert.ok(pct > 20 && pct < 45, `distribution ${pct}% in 20-45 band`);
});

// --- 8. kingdom-preferred venues ---
check("kingdom-preferred venues", () => {
  const v = Host.venueFor({ username: "x", kingdomId: "asgarnia" });
  assert.equal(v.kingdom, "asgarnia");
  const v2 = Host.venueFor({ username: "x", kingdomId: "notakingdom" });
  assert.ok(v2 && v2.name, "falls back to any venue");
});

// --- 9. brew determinism + day variance ---
check("brew determinism and day variance", () => {
  const d1 = new Date(2026, 9, 8, 12, 0).getTime();
  const d2 = new Date(2026, 9, 9, 12, 0).getTime();
  assert.equal(Host.brewForToday("alice", d1), Host.brewForToday("alice", d1));
  const seen = new Set();
  for (let d = 0; d < 10; d++) {
    seen.add(Host.brewForToday("alice", d1 + d * 86400000));
  }
  assert.ok(seen.size > 1, "brew varies across days");
  assert.ok(Host.BREWS.includes(Host.brewForToday("alice", d2)));
});

// --- 10. feast determinism + rarity ---
check("feast determinism and rarity", () => {
  const venue = { name: "the Test Hall", kingdom: "misthalin" };
  const d1 = new Date(2026, 9, 8, 12, 0).getTime();
  assert.equal(Host.feastFor(venue, d1), Host.feastFor(venue, d1));
  assert.equal(Host.feastFor(null, d1), null);
  let hits = 0;
  const days = 500;
  for (let d = 0; d < days; d++) {
    if (Host.feastFor(venue, d1 + d * 86400000)) hits++;
  }
  const rate = hits / days;
  assert.ok(rate > 0.03 && rate < 0.15, `feast rate ~8%: ${rate}`);
});

// --- 11. dishForFeast tie-in never throws ---
check("dishForFeast tie-in safe", () => {
  const d = new Date(2026, 9, 8, 12, 0).getTime();
  const dish = Host.dishForFeast("alice", "misthalin", d);
  assert.ok(typeof dish === "string" && dish.length > 0, "returns a dish: " + dish);
});

// --- 12. ledgers round-trip + TTL ---
check("ledgers round-trip and expire", () => {
  Host._resetState();
  const t0 = 1_800_000_000_000;
  assert.equal(Host.rentRoom("Jon", "the Test Hall", t0), "the Test Hall");
  assert.equal(Host.roomFor("Jon", t0), "the Test Hall");
  assert.equal(Host.buyMug("Jon", "a mug of nut-brown home ale", t0), "a mug of nut-brown home ale");
  assert.equal(Host.mugFor("Jon", t0), "a mug of nut-brown home ale");
  assert.equal(Host.joinFeast("Jon", "the Test Hall", t0), "the Test Hall");
  assert.equal(Host.feastForPlayer("Jon", t0), "the Test Hall");
  // TTL expiry (8 days later): prune runs again and drops the entry.
  const t1 = t0 + 8 * 86400000;
  assert.equal(Host.roomFor("Jon", t1), null);
  assert.equal(Host.mugFor("Jon", t1), null);
  assert.equal(Host.feastForPlayer("Jon", t1), null);
  Host._resetState();
});

// --- 13. hospitality hours (local-time constructors per timezone rule) ---
check("hospitality hours", () => {
  assert.equal(Host.isHospitalityHour(new Date(2026, 9, 8, 12, 0).getTime()), true);
  assert.equal(Host.isHospitalityHour(new Date(2026, 9, 8, 10, 0).getTime()), true);
  assert.equal(Host.isHospitalityHour(new Date(2026, 9, 8, 22, 59).getTime()), true);
  assert.equal(Host.isHospitalityHour(new Date(2026, 9, 8, 9, 59).getTime()), false);
  assert.equal(Host.isHospitalityHour(new Date(2026, 9, 8, 23, 0).getTime()), false);
  assert.equal(Host.isHospitalityHour(new Date(2026, 9, 8, 3, 0).getTime()), false);
});

// --- 14. player/bot/tile guards ---
check("isRealPlayer / isCitizenBot / withinTiles", () => {
  const real = mockPlayer("Jon", 3200, 3200, false);
  const bot = mockPlayer("Bot", 3200, 3200, true);
  assert.equal(Host.isRealPlayer(real), true);
  assert.equal(Host.isRealPlayer(bot), false);
  assert.equal(Host.isRealPlayer(null), false);
  assert.equal(Host.isCitizenBot(bot), true);
  assert.equal(Host.isCitizenBot(real), false);
  const a = mockPlayer("A", 3200, 3200, true);
  const b = mockPlayer("B", 3205, 3205, false);
  const far = mockPlayer("C", 3300, 3300, false);
  assert.equal(Host.withinTiles(a, b, 14), true);
  assert.equal(Host.withinTiles(a, far, 14), false);
});

// --- 15. tick fires near real player ---
check("tick fires near real player", () => {
  Host._resetState();
  // Find a hostfolk name.
  let hname = null;
  for (const n of names(2000)) {
    if (Host.hostfolkTypeOf({ username: n, role: "commoner" })) {
      hname = n;
      break;
    }
  }
  assert.ok(hname, "found hostfolk name");
  const noon = new Date(2026, 9, 8, 12, 0).getTime();
  const director = mockDirector([{ username: hname, role: "commoner", kingdomId: "misthalin" }], [
    mockPlayer("Jon", 3202, 3202, false),
  ]);
  withFixedRandom(0.05, () => Host.tickHostfolk(director, noon));
  const bot = director._bots.get(hname);
  assert.ok(bot && (bot._said || []).length === 1, "hostfolk spoke once");
});

// --- 16. tick silent near bots only ---
check("tick silent near bots only", () => {
  Host._resetState();
  let hname = null;
  for (const n of names(2000)) {
    if (Host.hostfolkTypeOf({ username: n, role: "commoner" })) {
      hname = n;
      break;
    }
  }
  const noon = new Date(2026, 9, 8, 12, 0).getTime();
  const director = mockDirector([{ username: hname, role: "commoner", kingdomId: "misthalin" }], [
    mockPlayer("BotBob", 3202, 3202, true),
  ]);
  withFixedRandom(0.05, () => Host.tickHostfolk(director, noon));
  const bot = director._bots.get(hname);
  assert.ok(!bot || (bot._said || []).length === 0, "silent near bots only");
});

// --- 17. tick silent outside hours ---
check("tick silent outside hours", () => {
  Host._resetState();
  let hname = null;
  for (const n of names(2000)) {
    if (Host.hostfolkTypeOf({ username: n, role: "commoner" })) {
      hname = n;
      break;
    }
  }
  const night = new Date(2026, 9, 8, 3, 0).getTime();
  const director = mockDirector([{ username: hname, role: "commoner", kingdomId: "misthalin" }], [
    mockPlayer("Jon", 3202, 3202, false),
  ]);
  withFixedRandom(0.05, () => Host.tickHostfolk(director, night));
  const bot = director._bots.get(hname);
  assert.ok(!bot || (bot._said || []).length === 0, "silent outside hours");
});

// --- 18. pro innkeeper skipped at type gate ---
check("pro innkeeper skipped before materialization", () => {
  Host._resetState();
  const Pro = require("./CitizenInnkeepers");
  let proName = null;
  for (const n of names(5000)) {
    if (Pro.innTypeFor(n)) {
      proName = n;
      break;
    }
  }
  const noon = new Date(2026, 9, 8, 12, 0).getTime();
  const director = mockDirector([{ username: proName, role: "commoner", kingdomId: "misthalin" }], [
    mockPlayer("Jon", 3202, 3202, false),
  ]);
  withFixedRandom(0.05, () => Host.tickHostfolk(director, noon));
  assert.ok(!director._bots.has(proName), "no bot materialized for pro innkeeper");
});

// --- 19. never throws on hostile input ---
check("never throws on hostile input", () => {
  Host._resetState();
  Host.tickHostfolk(null, Date.now());
  Host.tickHostfolk({}, Date.now());
  Host.tickHostfolk({ roster: null }, Date.now());
  assert.equal(Host.hostfolkTypeOf(undefined), null);
  assert.ok(Host.venueFor(null)?.name, "venueFor(null) falls back to a venue");
  assert.equal(Host.feastFor(undefined, Date.now()), null);
  assert.equal(Host.rentRoom("", "x"), null);
  assert.equal(Host.buyMug("x", ""), null);
  assert.equal(Host.joinFeast("x", null), null);
});

// --- 20. pure helpers ---
check("pure helpers", () => {
  assert.equal(Host.fill("Hello {name}!", { name: "Jon" }), "Hello Jon!");
  assert.equal(Host.fill("No slots", {}), "No slots");
  assert.ok(Host.hashStr("abc") !== Host.hashStr("abd"), "hash differs");
  assert.equal(Host.dayNumber(86400000), 1);
  const rng = Host.seededRng(42);
  assert.ok(rng() >= 0 && rng() < 1, "seeded rng in range");
  assert.equal(Host.chance(() => 0.1, 0.15), true);
  assert.equal(Host.chance(() => 0.5, 0.15), false);
});

console.log(`\nAll CitizenInnkeepers2 checks passed (${passed} groups).`);
