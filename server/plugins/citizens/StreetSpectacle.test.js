"use strict";

// StreetSpectacle unit test — pure helpers only (no engine, no director).

const assert = require("node:assert/strict");
const { tierOf, voiceOf, fillLine, pickNotableDrop, KILL_LINES, DROP_LINES } = require("./StreetSpectacle");

// --- tierOf: combat level -> spectacle tier ---
assert.equal(tierOf(0), "trivial");
assert.equal(tierOf(1), "trivial");
assert.equal(tierOf(11), "trivial");
assert.equal(tierOf(12), "common");
assert.equal(tierOf(79), "common");
assert.equal(tierOf(80), "notable");
assert.equal(tierOf(199), "notable");
assert.equal(tierOf(200), "monster");
assert.equal(tierOf(753), "monster");
assert.equal(tierOf(NaN), "trivial");
assert.equal(tierOf(undefined), "trivial");
console.log("tierOf: PASS");

// --- voiceOf: fearful citizens flinch at monsters ---
const fearful = { personality: { traits: ["fearful"] } };
const warm = { personality: { traits: ["cheerful", "friendly"] } };
const wry = { personality: { traits: ["gruff"] } };
assert.equal(voiceOf(fearful, "monster"), "fearful");
assert.equal(voiceOf(fearful, "notable"), "neutral"); // flinching is monster-only
assert.equal(voiceOf(warm, "common"), "warm");
assert.equal(voiceOf(wry, "common"), "wry");
assert.equal(voiceOf(null, "common"), "neutral");
assert.equal(voiceOf(undefined, "monster"), "neutral");
console.log("voiceOf: PASS");

// --- fillLine: placeholders ---
assert.equal(fillLine("Well fought, {name} — a {foe}!", { name: "Jon", foe: "goblin" }),
  "Well fought, Jon — a goblin!");
assert.equal(fillLine("{foe} x2", { name: "x", foe: "rat" }), "rat x2");
console.log("fillLine: PASS");

// --- KILL_LINES: every tier has every voice the voiceOf can pick ---
for (const tier of ["trivial", "common", "notable"]) {
  for (const voice of ["warm", "neutral", "wry"]) {
    const pool = KILL_LINES[tier][voice];
    assert.ok(Array.isArray(pool) && pool.length > 0, `${tier}/${voice} pool missing`);
    for (const line of pool) {
      assert.ok(line.length <= 120, `${tier}/${voice} line too long: ${line}`);
      assert.ok(!line.includes("{skill}"), `${tier}/${voice} has unfilled placeholder`);
    }
  }
}
for (const voice of ["warm", "neutral", "wry", "fearful"]) {
  const pool = KILL_LINES.monster[voice];
  assert.ok(Array.isArray(pool) && pool.length > 0, `monster/${voice} pool missing`);
  for (const line of pool) {
    assert.ok(line.length <= 120, `monster/${voice} line too long: ${line}`);
  }
}
console.log("KILL_LINES: PASS");

// --- pickNotableDrop: first collection-log drop in the roll ---
const fakeLogged = (id) => id === 4151 || id === 1038;
assert.equal(pickNotableDrop([{ itemId: 995, amount: 1000 }], fakeLogged), null);
assert.deepEqual(
  pickNotableDrop([{ itemId: 995 }, { itemId: 4151, amount: 1 }], fakeLogged),
  { itemId: 4151, amount: 1 }
);
assert.equal(pickNotableDrop([{ id: 1038 }], fakeLogged)?.id, 1038);
assert.equal(pickNotableDrop(null, fakeLogged), null);
assert.equal(pickNotableDrop([], fakeLogged), null);
assert.equal(
  pickNotableDrop([{ itemId: 4151 }], () => { throw new Error("boom"); }),
  null
);
console.log("pickNotableDrop: PASS");

// --- DROP_LINES: every voice has lines, all short, all placeholders fillable ---
for (const voice of ["warm", "neutral", "wry"]) {
  const pool = DROP_LINES[voice];
  assert.ok(Array.isArray(pool) && pool.length > 0, `drop/${voice} pool missing`);
  for (const line of pool) {
    assert.ok(line.length <= 120, `drop/${voice} line too long: ${line}`);
    assert.ok(
      !line.includes("{skill}") && !line.includes("{level}"),
      `drop/${voice} has unfillable placeholder`
    );
  }
}
console.log("DROP_LINES: PASS");

console.log("All StreetSpectacle tests PASS");
