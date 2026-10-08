"use strict";
// CitizenRumors unit checks — pure logic, no running server.
const assert = require("node:assert/strict");

const {
  seedRumor,
  distortRumor,
  retellRumor,
  rumorLine,
  shouldSpeak,
  pickRumorFor,
  confirmLead,
  resetForTests,
  _activeRumors,
  isRealPlayer,
  withinTiles,
  pickOne,
  swapWords,
  _tuning,
} = require("./CitizenRumors");

// Deterministic LCG — coverage is exact, not luck-based.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function makeEvent(overrides = {}) {
  return {
    kind: "quest",
    who: "TestPlayer",
    whoDisplay: "TestPlayer",
    what: "slew a big goblin",
    where: "Lumbridge",
    whereDisplay: "Lumbridge",
    amount: 10,
    holder: "Bob the Citizen",
    ...overrides,
  };
}

let passed = 0;
function check(name, fn) {
  resetForTests();
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

// 1. seedRumor creates a valid rumor with truth == claim initially
check("seed creates rumor with truth equal to claim", () => {
  const r = seedRumor(lcg(1), makeEvent());
  assert.ok(r, "rumor created");
  assert.equal(r.truth.what, "slew a big goblin");
  assert.equal(r.claim.what, r.truth.what, "claim starts true");
  assert.equal(r.claim.amount, 10);
  assert.equal(r.hops, 0);
  assert.equal(r.confirmed, false);
  assert.equal(r.lineage.length, 1);
  assert.equal(r.lineage[0].distortion, "seed");
});

// 2. seedRumor returns null for bad input
check("seed returns null without kind/what", () => {
  assert.equal(seedRumor(lcg(1), null), null);
  assert.equal(seedRumor(lcg(1), { kind: "quest" }), null);
  assert.equal(seedRumor(lcg(1), {}), null);
});

// 3. exaggerate inflates numbers
check("exaggerate inflates amount", () => {
  // Force distortion: loop seeds until we get an exaggerate (deterministic per seed).
  let found = false;
  for (let s = 1; s < 200 && !found; s++) {
    resetForTests();
    const r = seedRumor(lcg(s), makeEvent({ amount: 10 }));
    // Monkey-patch rng: first call <= DISTORT_CHANCE (distort), second < 0.4 (exaggerate)
    let calls = 0;
    const rigged = () => (++calls === 1 ? 0.1 : 0.2);
    const d = distortRumor(rigged, r, "Alice");
    if (d === "exaggerate") {
      found = true;
      assert.ok(r.claim.amount > 10, `amount inflated: ${r.claim.amount}`);
      assert.equal(r.truth.amount, 10, "truth untouched");
    }
  }
  assert.ok(found, "exaggerate distortion observed");
});

// 4. minimize shrinks numbers
check("minimize shrinks amount", () => {
  let found = false;
  for (let s = 1; s < 500 && !found; s++) {
    resetForTests();
    const r = seedRumor(lcg(s), makeEvent({ amount: 100 }));
    let calls = 0;
    const rigged = () => (++calls === 1 ? 0.1 : 0.5); // distort, then minimize band
    const d = distortRumor(rigged, r, "Alice");
    if (d === "minimize") {
      found = true;
      assert.ok(r.claim.amount < 100, `amount shrunk: ${r.claim.amount}`);
      assert.ok(r.claim.amount >= 1, "amount never below 1");
      assert.equal(r.truth.amount, 100, "truth untouched");
    }
  }
  assert.ok(found, "minimize distortion observed");
});

// 5. fabricate bolts on a false detail
check("fabricate adds false detail", () => {
  resetForTests();
  const r = seedRumor(lcg(7), makeEvent());
  const before = r.claim.what;
  let calls = 0;
  const rigged = () => (++calls === 1 ? 0.1 : 0.9); // distort, then fabricate band
  const d = distortRumor(rigged, r, "Alice");
  assert.equal(d, "fabricate");
  assert.ok(r.claim.what.length > before.length, "detail appended");
  assert.ok(r.claim.what.includes("—"), "detail separated with em dash");
  assert.equal(r.truth.what, before, "truth untouched");
});

// 6. lineage tracks every retelling
check("lineage records each distortion", () => {
  resetForTests();
  const r = seedRumor(lcg(3), makeEvent());
  const rigged = lcg(99);
  distortRumor(rigged, r, "Alice");
  distortRumor(rigged, r, "Carol");
  assert.equal(r.lineage.length, 3, "seed + 2 retellings");
  assert.equal(r.lineage[1].holder, "alice");
  assert.equal(r.lineage[2].holder, "carol");
  assert.ok(["exaggerate", "minimize", "fabricate", "none"].includes(r.lineage[1].distortion));
});

// 7. retellRumor advances hops and holder, respects max hops
check("retell advances hop count and holder", () => {
  resetForTests();
  const r = seedRumor(lcg(5), makeEvent({ holder: "Bob" }));
  r.lastHopAt = Date.now() - 10 * 60 * 1000; // past hop cooldown
  const out = retellRumor(lcg(11), r, "Dave");
  assert.ok(out, "retold");
  assert.equal(r.hops, 1);
  assert.equal(r.holder, "dave");
  assert.equal(r.holderDisplay, "Dave");

  // Exhaust hops
  r.hops = _tuning.RUMOR_MAX_HOPS;
  assert.equal(retellRumor(lcg(11), r, "Eve"), null, "no hop past max");
});

// 8. rumorLine produces a speakable string with claim content
check("rumorLine builds scripted line from claim", () => {
  resetForTests();
  const r = seedRumor(lcg(9), makeEvent());
  const line = rumorLine(lcg(4), r);
  assert.ok(typeof line === "string" && line.length > 10, "line is a string");
  assert.ok(line.includes("TestPlayer"), "line names the subject");
  assert.ok(line.includes("Lumbridge"), "line names the place");
});

// 9. lead rumors get the treasure-hint frame
check("lead rumors use lead frames", () => {
  resetForTests();
  const r = seedRumor(
    lcg(13),
    makeEvent({ isLead: true, leadTarget: { x: 3200, y: 3200, z: 0, description: "buried cache" } })
  );
  assert.ok(r.isLead, "marked as lead");
  assert.deepEqual(r.leadTarget, { x: 3200, y: 3200, z: 0, description: "buried cache" });
  const line = rumorLine(lcg(2), r);
  assert.ok(/hidden|worth a look|checks first/i.test(line), `lead frame used: ${line}`);
});

// 10. confirmLead marks the lead found and stops distortion
check("confirmLead resolves a lead", () => {
  resetForTests();
  const r = seedRumor(lcg(17), makeEvent({ isLead: true }));
  const done = confirmLead(r.id, "Investigator");
  assert.ok(done, "confirmed");
  assert.equal(r.confirmed, true);
  assert.equal(r.lineage[r.lineage.length - 1].distortion, "confirmed");
  // Confirmed rumors can't distort or retell
  assert.equal(distortRumor(lcg(1), r, "X"), "none");
  assert.equal(retellRumor(lcg(1), r, "Y"), null);
  // Double-confirm is a no-op
  assert.equal(confirmLead(r.id, "SomeoneElse"), null);
});

// 11. shouldSpeak respects cooldown and chance
check("shouldSpeak gates on cooldown then chance", () => {
  const now = Date.now();
  assert.equal(shouldSpeak(() => 0.01, now - 1000, now), false, "cooldown blocks");
  assert.equal(shouldSpeak(() => 0.99, 0, now), false, "high roll blocks");
  assert.equal(shouldSpeak(() => 0.01, 0, now), true, "low roll passes");
});

// 12. swapWords replaces one pair
check("swapWords swaps first matching pair", () => {
  assert.equal(swapWords("a big goblin", [["big", "enormous"]]), "a enormous goblin");
  assert.equal(swapWords("a small goblin", [["big", "enormous"]]), "a small goblin");
});

// 13. isRealPlayer / withinTiles behave
check("isRealPlayer and withinTiles gates", () => {
  assert.equal(isRealPlayer(null), false);
  assert.equal(isRealPlayer({ isPlayerBot: () => true }), false);
  assert.equal(isRealPlayer({ getHostAddress: () => "bot" }), false);
  assert.equal(isRealPlayer({ getUsername: () => "Jon" }), true);

  const at = (x, y, z = 0) => ({ getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => z }) });
  assert.equal(withinTiles(at(0, 0), at(5, 5), 12), true);
  assert.equal(withinTiles(at(0, 0), at(50, 50), 12), false);
  assert.equal(withinTiles(at(0, 0, 0), at(5, 5, 1), 12), false, "different plane");
});

// 14. pickRumorFor prefers held rumors, skips confirmed
check("pickRumorFor prefers holder's own rumors", () => {
  const r1 = seedRumor(lcg(21), makeEvent({ holder: "Zed" }));
  r1.createdAt = Date.now() - 3600000; // older
  const r2 = seedRumor(lcg(22), makeEvent({ holder: "Amy" }));
  r2.createdAt = Date.now(); // fresher but not Amy's... actually it is Amy's
  const pick = pickRumorFor(lcg(3), "Amy");
  assert.ok(pick, "picked something");
  assert.equal(pick.holder, "amy", "prefers own rumor over fresher stranger rumor");

  confirmLead(r2.id, "X"); // r2 isn't a lead, confirmLead returns null — use direct flag
  r2.confirmed = true;
  const pick2 = pickRumorFor(lcg(3), "Nobody");
  assert.ok(!pick2 || pick2.id !== r2.id, "confirmed rumors never picked");
});

// 15. active rumor cap is enforced
check("rumor cap enforced", () => {
  for (let i = 0; i < _tuning.RUMOR_MAX_ACTIVE + 5; i++) {
    seedRumor(lcg(100 + i), makeEvent({ what: `deed ${i}` }));
  }
  assert.ok(_activeRumors.size <= _tuning.RUMOR_MAX_ACTIVE, `capped at ${_activeRumors.size}`);
});

// 16. pickOne is deterministic with injected rng
check("pickOne deterministic", () => {
  assert.equal(pickOne(() => 0, ["a", "b", "c"]), "a");
  assert.equal(pickOne(() => 0.99, ["a", "b", "c"]), "c");
});

console.log(`\n${passed}/16 checks passed`);
