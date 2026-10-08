"use strict";

const assert = require("node:assert");
const {
  primaryProfessionFor,
  primaryProfessionShareFor,
  PRIMARY_PROFESSIONS,
  PRIMARY_PROFESSION_KEYS,
  TOTAL_WEIGHT,
  hashStr,
} = require("./CitizenPrimaryProfession");

let passed = 0;
function check(cond, msg) {
  assert.ok(cond, msg);
  passed++;
}

// --- shape ---
check(PRIMARY_PROFESSIONS.length === 17, "17 primary professions");
check(PRIMARY_PROFESSION_KEYS.length === 17, "17 keys");
check(new Set(PRIMARY_PROFESSION_KEYS).size === 17, "keys unique");
check(Math.abs(TOTAL_WEIGHT - 598.1) < 0.01, `total weight ~598.1, got ${TOTAL_WEIGHT}`);
for (const p of PRIMARY_PROFESSIONS) {
  check(typeof p.key === "string" && p.key.length > 0, "key is non-empty string");
  check(typeof p.weight === "number" && p.weight > 0, "weight positive");
}

// --- null/empty handling ---
check(primaryProfessionFor(null) === null, "null -> null");
check(primaryProfessionFor(undefined) === null, "undefined -> null");
check(primaryProfessionFor("") === null, "empty -> null");

// --- exactly one, stable, case-insensitive ---
for (let i = 0; i < 500; i++) {
  const a = primaryProfessionFor("citizen" + i);
  const b = primaryProfessionFor("CITIZEN" + i);
  check(a !== null && PRIMARY_PROFESSION_KEYS.includes(a), `valid key for citizen${i}`);
  check(a === b, "case-insensitive, stable");
  check(a === primaryProfessionFor("citizen" + i), "deterministic across calls");
}

// --- distribution: every profession represented, roughly at its weight share ---
const counts = {};
for (const k of PRIMARY_PROFESSION_KEYS) counts[k] = 0;
const N = 20000;
for (let i = 0; i < N; i++) counts[primaryProfessionFor("dist" + i)]++;
for (const p of PRIMARY_PROFESSIONS) {
  const expected = p.weight / TOTAL_WEIGHT;
  const got = counts[p.key] / N;
  // Allow generous tolerance: within 25% relative of expected share.
  check(
    got > expected * 0.75 && got < expected * 1.25,
    `${p.key}: expected ~${(expected * 100).toFixed(2)}%, got ${(got * 100).toFixed(2)}%`
  );
}
// Nobody holds zero or two: exactly one per citizen by construction.
let total = 0;
for (const k of PRIMARY_PROFESSION_KEYS) total += counts[k];
check(total === N, "every citizen holds exactly one primary profession");

// --- shares ---
check(Math.abs(primaryProfessionShareFor("farmer") - 41.2 / TOTAL_WEIGHT) < 1e-9, "farmer share");
check(primaryProfessionShareFor("nope") === 0, "unknown key -> 0");
let shareSum = 0;
for (const k of PRIMARY_PROFESSION_KEYS) shareSum += primaryProfessionShareFor(k);
check(Math.abs(shareSum - 1) < 1e-9, "shares sum to 1");

// --- hash sanity ---
check(hashStr("abc") !== hashStr("abd"), "hash distinguishes inputs");
check(hashStr("x") === hashStr("x"), "hash deterministic");

console.log(`All CitizenPrimaryProfession checks passed (${passed} assertions).`);
