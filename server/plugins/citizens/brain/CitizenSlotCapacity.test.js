"use strict";

/**
 * Tests for CitizenSlotCapacity — the per-spot occupancy layer that sits
 * on top of the 2026-10-08 personalSpot destack.
 *
 * Plain-node harness matching the repo's *.test.js style: no framework,
 * `node <file>` runs it, non-zero exit on failure.
 */

const assert = require("assert");

const Slots = require("./CitizenSlotCapacity");
const { personalSpot } = require("../lib/humanizer");

const ACT = "test_spot_work";

let failures = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (e) {
    failures += 1;
    console.error(`FAIL - ${name}: ${e.message}`);
  }
}

function fakePlayer(username) {
  return { getUsername: () => username, username };
}

function beforeEach() {
  Slots.resetForTests();
  Slots._setDefinitionsForTests([{ id: ACT, slotCapacity: 4 }]);
}

const ANCHOR = { x: 3200, y: 3200, z: 0 };

// --- 1. Slot capacity enforcement ----------------------------------------------

test("capacity enforcement: more claimants than capacity -> denied", () => {
  beforeEach();
  const results = [];
  for (let i = 0; i < 6; i++) {
    results.push(
      Slots.claimSlot(fakePlayer(`worker-${i}`), ACT, ANCHOR.x, ANCHOR.y, ANCHOR.z)
    );
  }
  const granted = results.filter(Boolean);
  const denied = results.filter((r) => r === null);
  assert.strictEqual(granted.length, 4, `4 slots granted, got ${granted.length}`);
  assert.strictEqual(denied.length, 2, `2 claimants denied, got ${denied.length}`);
});

test("capacity is data-driven: JSON slotCapacity honored, default otherwise", () => {
  beforeEach();
  assert.strictEqual(Slots.slotCapacityFor(ACT), 4, "JSON slotCapacity read");
  assert.strictEqual(
    Slots.slotCapacityFor("unknown_activity_xyz"),
    Slots.DEFAULT_SLOT_CAPACITY,
    "unknown activity falls back to the sane default"
  );
});

// --- 2. Release on depart/logout frees the slot --------------------------------

test("release on logout frees the slot for the next claimant", () => {
  beforeEach();
  const users = ["alice", "bob", "cara", "dan"];
  for (const u of users) {
    assert.ok(Slots.claimSlot(fakePlayer(u), ACT, ANCHOR.x, ANCHOR.y, ANCHOR.z), `${u} claims`);
  }
  // Spot is full now.
  assert.strictEqual(
    Slots.claimSlot(fakePlayer("erin"), ACT, ANCHOR.x, ANCHOR.y, ANCHOR.z),
    null,
    "5th claimant denied while full"
  );
  // Bob logs out -> releaseFor frees his slot.
  assert.ok(Slots.releaseFor(fakePlayer("bob")), "logout release returns true");
  assert.strictEqual(Slots.claimOf("bob"), null, "bob holds no claim after logout");
  const erin = Slots.claimSlot(fakePlayer("erin"), ACT, ANCHOR.x, ANCHOR.y, ANCHOR.z);
  assert.ok(erin, "erin claims the freed slot");
});

test("departing to a new spot releases the old claim (one claim per citizen)", () => {
  beforeEach();
  const a = Slots.claimSlot(fakePlayer("alice"), ACT, 3200, 3200, 0);
  assert.ok(a, "alice claims spot A");
  const b = Slots.claimSlot(fakePlayer("alice"), ACT, 3210, 3210, 0);
  assert.ok(b, "alice claims spot B");
  const claim = Slots.claimOf("alice");
  assert.strictEqual(claim.spotKey, b.spotKey, "alice now holds only the spot-B claim");
  const statusA = Slots.spotStatus(ACT, a.spotKey);
  assert.strictEqual(statusA.taken, 0, "spot A freed when alice departed");
});

test("release is idempotent and safe on strangers", () => {
  beforeEach();
  assert.strictEqual(Slots.releaseFor(fakePlayer("ghost")), false, "no claim -> false");
  assert.strictEqual(Slots.releaseFor(null), false, "null player -> false");
  assert.strictEqual(Slots.releaseFor({}), false, "player without username -> false");
});

// --- 3. Structural de-dup: K citizens, same anchor, K distinct tiles -----------

test("K citizens at the same anchor get K distinct tiles", () => {
  beforeEach();
  const K = 4; // == slotCapacity for ACT
  const tiles = new Set();
  for (let i = 0; i < K; i++) {
    const claim = Slots.claimSlot(
      fakePlayer(`crowd-${i}`),
      ACT,
      ANCHOR.x,
      ANCHOR.y,
      ANCHOR.z,
      () => 0.99 // rng pinned: jitter path exercised, still distinct
    );
    assert.ok(claim, `crowd-${i} gets a slot`);
    tiles.add(`${claim.x},${claim.y}`);
    // Every slot tile is a real tile near the anchor — not a fiction.
    const d = Math.hypot(claim.x - ANCHOR.x, claim.y - ANCHOR.y);
    assert.ok(d >= 2 && d <= 6, `slot ${claim.slot} within 2-6 tiles of the anchor (d=${d})`);
  }
  assert.strictEqual(tiles.size, K, `${K} citizens -> ${tiles.size} distinct tiles`);
});

test("slot tiles are distinct by construction across many slots", () => {
  const seen = new Set();
  for (let slot = 0; slot < 32; slot++) {
    const t = Slots._slotTile(3200, 3200, slot);
    assert.ok(Number.isInteger(t.x) && Number.isInteger(t.y), `slot ${slot} integer tile`);
    const key = `${t.x},${t.y}`;
    assert.ok(!seen.has(key), `slot ${slot} tile ${key} unique`);
    seen.add(key);
  }
});

test("variety: citizens do not all take slot 0", () => {
  beforeEach();
  const slotsTaken = new Set();
  for (let i = 0; i < 4; i++) {
    const claim = Slots.claimSlot(fakePlayer(`variety-${i}`), ACT, ANCHOR.x, ANCHOR.y, ANCHOR.z);
    slotsTaken.add(claim.slot);
  }
  assert.ok(slotsTaken.size > 1, `favorites spread across slots: ${[...slotsTaken]}`);
});

// --- 4. FAIL-before / PASS-after ------------------------------------------------
// The pre-change behavior was personalSpot-only (the 2026-10-08 destack with
// no coordination). This repro runs the same crowd through both and shows
// the difference: personalSpot stacks under pressure, slots cannot.

test("FAIL-before: personalSpot-only stacks N citizens on identical tiles", () => {
  const K = 60;
  const tiles = new Set();
  for (let i = 0; i < K; i++) {
    const t = personalSpot(`repro-${i}`, 3200, 3200, 2, 8);
    tiles.add(`${t.x},${t.y}`);
  }
  assert.ok(
    tiles.size < K,
    `personalSpot-only: ${K} citizens -> only ${tiles.size} distinct tiles ` +
      `(${K - tiles.size} stacked) — the bug this module fixes`
  );
  console.log(`    (repro: ${K} citizens, personalSpot-only -> ${tiles.size} distinct tiles)`);
});

test("PASS-after: slot claims distribute the same crowd with zero stacking", () => {
  Slots.resetForTests();
  Slots._setDefinitionsForTests([{ id: ACT, slotCapacity: 60 }]);
  const K = 60;
  const tiles = new Set();
  for (let i = 0; i < K; i++) {
    const claim = Slots.claimSlot(fakePlayer(`repro-${i}`), ACT, 3200, 3200, 0);
    assert.ok(claim, `repro-${i} claims a slot`);
    tiles.add(`${claim.x},${claim.y}`);
  }
  assert.strictEqual(
    tiles.size,
    K,
    `slot claims: ${K} citizens -> ${tiles.size} distinct tiles`
  );
  console.log(`    (repro: ${K} citizens, slot claims -> ${tiles.size} distinct tiles)`);
  beforeEach(); // restore the standard 4-slot fixture
});

// --- spot registration / status -------------------------------------------------

test("registerSpot is idempotent and spotsForActivity lists spots", () => {
  beforeEach();
  const k1 = Slots.registerSpot(ACT, 3200, 3200, 0);
  const k2 = Slots.registerSpot(ACT, 3200, 3200, 0);
  assert.strictEqual(k1, k2, "same real position -> same spot key");
  const spots = Slots.spotsForActivity(ACT);
  assert.strictEqual(spots.length, 1, "one registered spot");
  assert.strictEqual(spots[0].x, 3200, "spot x is the real anchor x");
  assert.strictEqual(spots[0].capacity, 4, "data-driven capacity surfaced");
});

test("spotStatus reports occupancy honestly", () => {
  beforeEach();
  const key = Slots.registerSpot(ACT, 3200, 3200, 0);
  let st = Slots.spotStatus(ACT, key);
  assert.deepStrictEqual(
    { capacity: st.capacity, taken: st.taken, free: st.free },
    { capacity: 4, taken: 0, free: 4 }
  );
  Slots.claimSlot(fakePlayer("alice"), ACT, 3200, 3200, 0);
  st = Slots.spotStatus(ACT, key);
  assert.strictEqual(st.taken, 1, "one occupant");
  assert.strictEqual(st.free, 3, "three free");
});

console.log(
  `\n${failures === 0 ? "All CitizenSlotCapacity tests passed." : `${failures} test(s) FAILED.`}`
);
process.exitCode = failures === 0 ? 0 : 1;
