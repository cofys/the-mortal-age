"use strict";

// CitizenPrimaryHobby.test.js — plain-node tests for the primary-hobby
// partition and visibility gate. Run with: node CitizenPrimaryHobby.test.js
const assert = require("assert");
const H = require("./CitizenPrimaryHobby");

let checks = 0;
function check(cond, msg) {
  checks++;
  assert.ok(cond, msg);
}

// 1. HOBBY_KEYS has exactly the 7 activity systems.
check(H.HOBBY_KEYS.length === 7, "7 hobby keys");
check(new Set(H.HOBBY_KEYS).size === 7, "keys unique");

// 2. primaryHobbyFor returns a valid key for any username.
for (const n of ["Alice", "bob", "  Charlie  ", "x", "Citizen123"]) {
  const h = H.primaryHobbyFor(n);
  check(H.HOBBY_KEYS.includes(h), `valid key for ${n}: ${h}`);
}

// 3. Stable across calls and case/whitespace-insensitive.
check(H.primaryHobbyFor("Alice") === H.primaryHobbyFor("alice"), "case-insensitive");
check(H.primaryHobbyFor("Alice") === H.primaryHobbyFor("  ALICE "), "whitespace-insensitive");
check(H.primaryHobbyFor("Bob") === H.primaryHobbyFor("Bob"), "stable");

// 4. Null/empty handling.
check(H.primaryHobbyFor("") === null, "empty -> null");
check(H.primaryHobbyFor(null) === null, "null -> null");
check(H.primaryHobbyFor(undefined) === null, "undefined -> null");
check(H.isHobbyVisible("", "gardener") === false, "empty username not visible");
check(H.isHobbyVisible("Alice", "") === false, "empty key not visible");
check(H.isHobbyVisible("Alice", "blacksmith") === false, "unknown key not visible");
check(H.isHobbyVisible(null, "gardener") === false, "null username not visible");

// 5. Roughly uniform distribution across 7 keys (3000 names).
const counts = {};
for (let i = 0; i < 3000; i++) {
  const h = H.primaryHobbyFor("Citizen" + i);
  counts[h] = (counts[h] || 0) + 1;
}
for (const k of H.HOBBY_KEYS) {
  const share = (counts[k] || 0) / 3000;
  check(share > 0.10 && share < 0.19, `uniform ${k}: ${(share * 100).toFixed(1)}%`);
}

// 6. Primary hobby is always visible.
for (let i = 0; i < 200; i++) {
  const name = "VisCitizen" + i;
  const primary = H.primaryHobbyFor(name);
  check(H.isHobbyVisible(name, primary) === true, `primary visible for ${name}`);
}

// 7. Non-primary hobbies visible ~1/3 (deterministic).
let visCount = 0;
let total = 0;
for (let i = 0; i < 2000; i++) {
  const name = "HobbyVis" + i;
  const primary = H.primaryHobbyFor(name);
  for (const k of H.HOBBY_KEYS) {
    if (k === primary) continue;
    total++;
    if (H.isHobbyVisible(name, k)) visCount++;
  }
}
const visRate = visCount / total;
check(visRate > 0.28 && visRate < 0.39, `non-primary visibility ~1/3: ${(visRate * 100).toFixed(1)}%`);

// 8. Deterministic: same result across calls.
check(
  H.isHobbyVisible("DeterministicDan", "mender") === H.isHobbyVisible("DeterministicDan", "mender"),
  "visibility deterministic"
);

// 9. Primary fires 3x more often than a given non-primary (per-citizen ratio).
// For a fixed citizen, primary always passes (1.0); each other passes 1/3.
let primaryPasses = 0;
let otherPasses = 0;
const trials = 500;
for (let i = 0; i < trials; i++) {
  const name = "Ratio" + i;
  const primary = H.primaryHobbyFor(name);
  if (H.isHobbyVisible(name, primary)) primaryPasses++;
  // pick the first non-primary key deterministically
  const other = H.HOBBY_KEYS.find((k) => k !== primary);
  if (H.isHobbyVisible(name, other)) otherPasses++;
}
check(primaryPasses === trials, "primary always passes");
const ratio = primaryPasses / Math.max(1, otherPasses);
check(ratio > 2.4 && ratio < 3.8, `primary:other ratio ~3:1, got ${ratio.toFixed(2)}`);

console.log(`All CitizenPrimaryHobby checks passed (${checks} assertions).`);
