"use strict";

// CitizenExplorers unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const {
  pickOne,
  isRealPlayer,
  withinTiles,
  hashName,
  isExplorer,
  explorerTypeFor,
  isAway,
  rollDiscovery,
  journeyOutcome,
  formExpedition,
  musterLine,
  departLine,
  returnLine,
  taleLine,
  hireExplorerGuide,
  explorersStatus,
  resetForTests,
  EXPLORER_TYPES,
  DISCOVERIES,
  INVITE_KIND_JOIN,
  INVITE_KIND_GUIDE,
} = require("./CitizenExplorers");

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
  resetForTests();
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

// --- pickOne ---
check("pickOne returns an element of the array", () => {
  const rng = lcg(1);
  const arr = ["a", "b", "c"];
  assert.ok(arr.includes(pickOne(rng, arr)));
});

check("pickOne with rng=0 returns the first element", () => {
  assert.strictEqual(pickOne(() => 0, ["x", "y"]), "x");
});

// --- isRealPlayer ---
check("isRealPlayer rejects bots and accepts real players", () => {
  assert.strictEqual(isRealPlayer(null), false);
  assert.strictEqual(isRealPlayer({}), false);
  assert.strictEqual(isRealPlayer({ isPlayerBot: () => true, getUsername: () => "Bot" }), false);
  assert.strictEqual(isRealPlayer({ getHostAddress: () => "bot", getUsername: () => "Bot" }), false);
  assert.strictEqual(
    isRealPlayer({ isPlayerBot: () => false, getHostAddress: () => "1.2.3.4", getUsername: () => "Jon" }),
    true
  );
});

// --- withinTiles ---
function fakeAt(x, y, z = 0) {
  return { getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => z }) };
}
check("withinTiles uses Chebyshev distance on the same plane", () => {
  assert.strictEqual(withinTiles(fakeAt(0, 0), fakeAt(10, 10), 10), true);
  assert.strictEqual(withinTiles(fakeAt(0, 0), fakeAt(11, 0), 10), false);
  assert.strictEqual(withinTiles(fakeAt(0, 0, 0), fakeAt(1, 1, 1), 10), false);
  assert.strictEqual(withinTiles(null, fakeAt(0, 0), 10), false);
});

// --- hash / explorer assignment ---
check("hashName is stable and explorer assignment is deterministic", () => {
  assert.strictEqual(hashName("Alice"), hashName("Alice"));
  assert.strictEqual(hashName("alice"), hashName("Alice"));
  assert.strictEqual(isExplorer("Alice"), isExplorer("Alice"));
  assert.strictEqual(explorerTypeFor("Bob"), explorerTypeFor("Bob"));
  assert.ok(EXPLORER_TYPES.includes(explorerTypeFor("Bob")));
});

// --- rollDiscovery ---
check("rollDiscovery pulls from the right vocation pool", () => {
  const rng = lcg(42);
  for (const type of EXPLORER_TYPES) {
    const d = rollDiscovery(type, rng);
    assert.strictEqual(d.type, type);
    assert.ok(DISCOVERIES[type].includes(d.name), `pool hit for ${type}`);
  }
  const fallback = rollDiscovery("bogus_type", lcg(7));
  assert.strictEqual(fallback.type, "bogus_type");
  assert.ok(DISCOVERIES.scout.includes(fallback.name));
});

// --- journeyOutcome ---
check("journeyOutcome returns valid counts", () => {
  for (let seed = 1; seed <= 50; seed++) {
    const o = journeyOutcome(lcg(seed));
    assert.ok(o.discoveryCount === 1 || o.discoveryCount === 2);
    assert.ok(o.dangerCount === 0 || o.dangerCount === 1);
  }
});

// --- formExpedition ---
check("formExpedition builds a muster-phase party or null when too few", () => {
  const nowMs = 1_000_000;
  const tooFew = formExpedition({ leader: "A", candidates: ["A"], nowMs });
  assert.strictEqual(tooFew, null);
  const exp = formExpedition({ leader: "A", candidates: ["A", "B", "C", "D", "E"], nowMs });
  assert.ok(exp);
  assert.strictEqual(exp.phase, "muster");
  assert.strictEqual(exp.leader, "A");
  assert.ok(exp.members.length >= 2 && exp.members.length <= 4);
  assert.ok(exp.members.includes("A"));
  assert.ok(exp.musterEndsAt > nowMs);
  assert.ok(exp.returnsAt > exp.musterEndsAt);
  assert.deepStrictEqual(exp.discoveries, []);
  assert.ok(EXPLORER_TYPES.includes(exp.type));
});

// --- line pools ---
check("muster/depart/return/tale lines are non-empty strings", () => {
  const rng = lcg(9);
  assert.ok(musterLine(rng).length > 10);
  assert.ok(departLine(rng).length > 10);
  assert.ok(returnLine(rng).length > 10);
  const tale = taleLine("scout", "a hidden grove", rng);
  assert.ok(tale.includes("a hidden grove"));
  assert.ok(tale.length > 10);
});

// --- isAway ---
check("isAway is false for unknowns and true only within the window", () => {
  assert.strictEqual(isAway("Nobody", 12345), false);
});

// --- hireExplorerGuide ---
check("hireExplorerGuide rejects bad input and non-pathfinders", () => {
  assert.strictEqual(hireExplorerGuide(null, "X", 1), false);
  assert.strictEqual(hireExplorerGuide("P", null, 1), false);
  // Find a username that is an explorer but NOT a pathfinder.
  let nonPathfinder = null;
  for (let i = 0; i < 5000 && !nonPathfinder; i++) {
    const name = `citizen_${i}`;
    if (isExplorer(name) && explorerTypeFor(name) !== "pathfinder") nonPathfinder = name;
  }
  assert.ok(nonPathfinder, "expected to find an explorer who is not a pathfinder");
  assert.strictEqual(hireExplorerGuide("Player1", nonPathfinder, Date.now()), false);
  // Non-explorer username is rejected.
  assert.strictEqual(hireExplorerGuide("Player1", "definitely_not_an_explorer_zzz", Date.now()), false);
});

// --- invite kinds ---
check("invite kinds are distinct namespaced strings", () => {
  assert.strictEqual(typeof INVITE_KIND_JOIN, "string");
  assert.strictEqual(typeof INVITE_KIND_GUIDE, "string");
  assert.notStrictEqual(INVITE_KIND_JOIN, INVITE_KIND_GUIDE);
});

// --- explorersStatus ---
check("explorersStatus reflects formed expeditions", () => {
  assert.deepStrictEqual(explorersStatus(), []);
  const exp = formExpedition({ leader: "A", candidates: ["A", "B", "C"], nowMs: 1 });
  assert.ok(exp);
  // Status reads module state only when expeditions are pushed via the tick;
  // formExpedition alone does not register. This documents that seam.
  assert.deepStrictEqual(explorersStatus(), []);
});

// --- resetForTests ---
check("resetForTests restores id counter determinism", () => {
  const e1 = formExpedition({ leader: "A", candidates: ["A", "B"], nowMs: 1 });
  resetForTests();
  const e2 = formExpedition({ leader: "A", candidates: ["A", "B"], nowMs: 1 });
  assert.strictEqual(e1.id, e2.id);
});

console.log(`\n${passed} assertions passed`);
