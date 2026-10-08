// CitizenHawker unit checks — pure logic, no running server.
// From server/plugins/citizens: node lib/CitizenHawker.test.js (plain node)
const assert = require("node:assert/strict");

const { HAWKER_POOLS, DEFAULT_POOL_KEY, stockTier, hawkerLine } = require("./CitizenHawker");

// Tiny deterministic LCG so coverage is exact, not luck-based.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const tests = [];

function test(name, fn) {
  tests.push([name, fn]);
}

// --- stockTier boundaries ---
test("tier: zero stock is empty", () => {
  assert.equal(stockTier(0, 6), "empty");
  assert.equal(stockTier(-3, 6), "empty");
});

test("tier: below threshold is low", () => {
  assert.equal(stockTier(1, 6), "low");
  assert.equal(stockTier(5, 6), "low");
});

test("tier: at/above threshold is full", () => {
  assert.equal(stockTier(6, 6), "full");
  assert.equal(stockTier(28, 6), "full");
});

test("tier: garbage inputs degrade safe", () => {
  assert.equal(stockTier(undefined, 6), "empty");
  assert.equal(stockTier(NaN, 6), "empty");
  // restockThreshold of 0 can never happen in Merchant.js, but must not explode
  assert.equal(stockTier(3, 0), "full");
});

// --- hawkerLine: empty never advertises ---
test("line: empty stock returns null (never hawks missing wares)", () => {
  const rng = lcg(1);
  assert.equal(hawkerLine("bread", 0, 6, rng), null);
  assert.equal(hawkerLine("bronze_sword", 0, 6, rng), null);
  assert.equal(hawkerLine("bread", -5, 6, rng), null);
});

// --- hawkerLine: full pool draws only full-tier lines ---
test("line: full bread pool picks from the 5 known adverts", () => {
  const pool = HAWKER_POOLS.bread.full;
  assert.equal(pool.length, 5);
  const rng = lcg(42);
  for (let i = 0; i < 200; i++) {
    assert.ok(pool.includes(hawkerLine("bread", 28, 6, rng)));
  }
});

test("line: full sword pool picks from the 3 known adverts", () => {
  const pool = HAWKER_POOLS.bronze_sword.full;
  assert.equal(pool.length, 3);
  const rng = lcg(7);
  for (let i = 0; i < 200; i++) {
    assert.ok(pool.includes(hawkerLine("bronze_sword", 10, 6, rng)));
  }
});

// --- hawkerLine: low pool draws only low-tier pitches ---
test("line: low stock pitches 'going fast', not the full adverts", () => {
  const low = HAWKER_POOLS.bread.low;
  const full = HAWKER_POOLS.bread.full;
  const rng = lcg(99);
  for (let i = 0; i < 200; i++) {
    const line = hawkerLine("bread", 2, 6, rng);
    assert.ok(low.includes(line));
    assert.ok(!full.includes(line));
  }
});

test("line: low sword pool picks only low-tier lines", () => {
  const low = HAWKER_POOLS.bronze_sword.low;
  const rng = lcg(1234);
  for (let i = 0; i < 200; i++) {
    assert.ok(low.includes(hawkerLine("bronze_sword", 3, 6, rng)));
  }
});

// --- index coverage: deterministic rng hits every line, not just the pool ---
test("line: deterministic rng covers every full-pool line (no dead templates)", () => {
  for (const [key, pools] of Object.entries(HAWKER_POOLS)) {
    for (const tier of ["full", "low"]) {
      const pool = pools[tier];
      const seen = new Set();
      for (let i = 0; i < pool.length; i++) {
        seen.add(hawkerLine(key, tier === "full" ? 28 : 2, 6, () => i / pool.length));
      }
      assert.equal(seen.size, pool.length, `${key}/${tier} coverage`);
    }
  }
});

// --- caller contract ---
test("line: rng stub () => 0 picks pool[0], near-1 picks last", () => {
  const pool = HAWKER_POOLS.bread.full;
  assert.equal(hawkerLine("bread", 28, 6, () => 0), pool[0]);
  assert.equal(hawkerLine("bread", 28, 6, () => 0.999), pool[pool.length - 1]);
});

test("line: unknown poolKey falls back to bread, missing rng still works", () => {
  const rng = lcg(5);
  const line = hawkerLine("mystery_ware", 28, 6, rng);
  assert.ok(HAWKER_POOLS.bread.full.includes(line));
  const noRng = hawkerLine("bread", 28, 6);
  assert.ok(HAWKER_POOLS.bread.full.includes(noRng));
  assert.equal(DEFAULT_POOL_KEY, "bread");
});

// --- pure-module guard: no engine/IdEnums imports, frozen pools ---
test("module: pools frozen, no IdEnums dependency", () => {
  assert.ok(Object.isFrozen(HAWKER_POOLS));
  assert.ok(Object.isFrozen(HAWKER_POOLS.bread));
  assert.ok(Object.isFrozen(HAWKER_POOLS.bread.full));
  const src = require("node:fs").readFileSync(__filename.replace(".test.js", ".js"), "utf8");
  assert.ok(!/require\(\s*["'][^"']*IdEnums[^"']*["']/.test(src), "must not import IdEnums");
  assert.ok(!/\brequire\s*\(/.test(src), "must be dependency-free");
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log("ok - " + name);
  } catch (err) {
    failed++;
    console.error("FAIL - " + name + " :: " + (err && err.message));
  }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
