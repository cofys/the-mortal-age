// CitizenGuards unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const G = require("./CitizenGuards");

// Deterministic LCG — coverage is exact, not luck-based.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

let checks = 0;
function check(name, fn) {
  fn();
  checks++;
  console.log(`ok - ${name}`);
}

// --- pickOne is deterministic with an injected rng ---
check("pickOne deterministic", () => {
  const arr = ["a", "b", "c"];
  assert.equal(G.pickOne(lcg(1), arr), G.pickOne(lcg(1), arr));
});

// --- fnv1a stable across calls ---
check("fnv1a stable", () => {
  assert.equal(G.fnv1a("Ser Barristan"), G.fnv1a("Ser Barristan"));
  assert.notEqual(G.fnv1a("Ser Barristan"), G.fnv1a("Ser Bronn"));
});

// --- guardTypeFor: stable, valid type, roughly the documented split ---
check("guardTypeFor stable and valid", () => {
  const types = new Set(["city-watch", "gate-guard", "royal-guard", "investigator"]);
  assert.ok(types.has(G.guardTypeFor("Watchman Pell")));
  assert.equal(G.guardTypeFor("Watchman Pell"), G.guardTypeFor("Watchman Pell"));
  assert.equal(G.guardTypeFor("Watchman Pell"), G.guardTypeFor("watchman pell")); // case-insensitive
});
check("guardTypeFor distribution roughly matches spec", () => {
  const counts = { "city-watch": 0, "gate-guard": 0, "royal-guard": 0, investigator: 0 };
  for (let i = 0; i < 1000; i++) {
    counts[G.guardTypeFor(`Guard${i}`)]++;
  }
  assert.ok(counts["city-watch"] > 380 && counts["city-watch"] < 520, `city-watch=${counts["city-watch"]}`);
  assert.ok(counts["gate-guard"] > 150 && counts["gate-guard"] < 250, `gate-guard=${counts["gate-guard"]}`);
  assert.ok(counts["royal-guard"] > 100 && counts["royal-guard"] < 200, `royal-guard=${counts["royal-guard"]}`);
  assert.ok(counts.investigator > 150 && counts.investigator < 250, `investigator=${counts.investigator}`);
});

// --- shiftForHour ---
check("shiftForHour day/night", () => {
  assert.equal(G.shiftForHour(0), "night");
  assert.equal(G.shiftForHour(4), "night");
  assert.equal(G.shiftForHour(5), "day");
  assert.equal(G.shiftForHour(12), "day");
  assert.equal(G.shiftForHour(20), "day");
  assert.equal(G.shiftForHour(21), "night");
  assert.equal(G.shiftForHour(23), "night");
});

// --- inShiftChangeWindow ---
check("inShiftChangeWindow true near change hours", () => {
  assert.ok(G.inShiftChangeWindow({ hours: 5, minutes: 0, seconds: 0 }));
  assert.ok(G.inShiftChangeWindow({ hours: 5, minutes: 9, seconds: 59 }));
  assert.ok(G.inShiftChangeWindow({ hours: 21, minutes: 3 }));
  assert.ok(!G.inShiftChangeWindow({ hours: 5, minutes: 10, seconds: 1 }));
  assert.ok(!G.inShiftChangeWindow({ hours: 12, minutes: 0 }));
  assert.ok(!G.inShiftChangeWindow({ hours: 20, minutes: 59 }));
});

// --- fillLine ---
check("fillLine slots", () => {
  assert.equal(G.fillLine("Hold — {name}, the {place} is safe.", { name: "Cofy", place: "gate" }),
    "Hold — Cofy, the gate is safe.");
  assert.equal(G.fillLine("no slots"), "no slots");
});

// --- reportCrime / isWanted / serveSentence / wantedCount ---
check("reportCrime records wanted suspect", () => {
  const now = 1_700_000_000_000;
  assert.ok(G.reportCrime("ReporterA", "ThiefBob", "theft", now));
  assert.ok(G.isWanted("ThiefBob", now + 1000));
  assert.ok(G.isWanted("thiefbob", now + 1000)); // case-insensitive
  assert.equal(G.wantedCount(now + 1000), 1);
});
check("reportCrime rejects junk", () => {
  const now = 1_700_000_000_000;
  assert.ok(!G.reportCrime("", "ThiefX", "theft", now));
  assert.ok(!G.reportCrime("R", "", "theft", now));
  assert.ok(!G.reportCrime("R", "R", "theft", now)); // self-report
  assert.ok(!G.reportCrime("R", "S", "murder", now)); // unknown kind
});
check("wanted entries expire after TTL", () => {
  const now = 1_700_000_000_000;
  G.reportCrime("R2", "ThiefCarol", "attack", now);
  assert.ok(G.isWanted("ThiefCarol", now + G.WANTED_TTL_MS - 1));
  assert.ok(!G.isWanted("ThiefCarol", now + G.WANTED_TTL_MS + 1));
});
check("serveSentence clears the wanted entry", () => {
  const now = 1_700_000_000_000;
  G.reportCrime("R3", "ThiefDave", "theft", now);
  assert.ok(G.isWanted("ThiefDave", now + 1));
  assert.ok(G.serveSentence("ThiefDave"));
  assert.ok(!G.isWanted("ThiefDave", now + 1));
  assert.ok(!G.serveSentence("NobodyHere")); // no-op
});
check("normName normalizes", () => {
  assert.equal(G.normName("  Cofy "), "cofy");
  assert.equal(G.normName(null), "");
});

// --- joinWatch / isWatchVolunteer ---
check("joinWatch registers volunteers", () => {
  assert.ok(G.joinWatch("Cofy"));
  assert.ok(G.isWatchVolunteer("Cofy"));
  assert.ok(G.isWatchVolunteer("cofy"));
  assert.ok(!G.isWatchVolunteer("Stranger"));
  assert.ok(!G.joinWatch("   "));
});

// --- shouldFire gate ---
check("shouldFire cooldown then chance", () => {
  const now = 10_000_000;
  assert.ok(!G.shouldFire(lcg(1), now - 1000, now, 60_000, 1.0)); // cooldown
  assert.ok(G.shouldFire(lcg(1), 0, now, 60_000, 1.0)); // chance 1 fires
  assert.ok(!G.shouldFire(lcg(1), 0, now, 60_000, 0.0)); // chance 0 never
});

// --- isRealPlayer ---
check("isRealPlayer rejects bots and junk", () => {
  assert.ok(!G.isRealPlayer(null));
  assert.ok(!G.isRealPlayer({ isPlayerBot: () => true, getUsername: () => "x" }));
  assert.ok(!G.isRealPlayer({ getHostAddress: () => "bot", getUsername: () => "x" }));
  assert.ok(G.isRealPlayer({ getUsername: () => "Cofy" }));
});

// --- withinTiles ---
check("withinTiles chebyshev same plane", () => {
  const mk = (x, y, z) => ({ getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => z }) });
  assert.ok(G.withinTiles(mk(0, 0, 0), mk(3, 4, 0), 4));
  assert.ok(!G.withinTiles(mk(0, 0, 0), mk(5, 0, 0), 4));
  assert.ok(!G.withinTiles(mk(0, 0, 0), mk(0, 0, 1), 99)); // different plane
  assert.ok(!G.withinTiles(null, mk(0, 0, 0), 5));
});

// --- notorietyOf degrades gracefully ---
check("notorietyOf returns 0 without memory", () => {
  assert.equal(G.notorietyOf("Nobody", Date.now(), null), 0);
});

// --- line pools non-empty ---
check("line pools non-empty", () => {
  for (const pool of [
    G.SHIFT_CHANGE_DAY, G.SHIFT_CHANGE_NIGHT, G.GATE_CHALLENGE_LINES, G.GATE_CLEAR_LINES,
    G.ROYAL_GUARD_LINES, G.INVESTIGATOR_QUESTION_LINES, G.INVESTIGATOR_FOUND_LINES,
    G.ARREST_LINES, G.SURRENDER_LINES, G.REPORT_ACK_LINES, G.JOIN_WATCH_LINES,
  ]) {
    assert.ok(Array.isArray(pool) && pool.length > 0);
    for (const line of pool) assert.ok(typeof line === "string" && line.length > 0);
  }
});

// --- tickGuards never throws on hostile input (guard never breaks) ---
check("tickGuards never throws", () => {
  assert.doesNotThrow(() => G.tickGuards(null, Date.now()));
  assert.doesNotThrow(() => G.tickGuards({}, Date.now()));
  assert.doesNotThrow(() => G.tickGuards({ roster: new Map() }, Date.now()));
});

// --- tickGuards skips non-guards and unmaterialized guards ---
check("tickGuards skips without real players", () => {
  const director = {
    roster: new Map([
      ["notguard", { username: "NotGuard", role: "merchant" }],
      ["guard1", { username: "Guard1", role: "guard" }],
    ]),
    playerFor: () => null, // nobody materialized
    onlinePlayers: () => [],
  };
  assert.doesNotThrow(() => G.tickGuards(director, Date.now(), lcg(7)));
});

console.log(`\n${checks} checks passed.`);
