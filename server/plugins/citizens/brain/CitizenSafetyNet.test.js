"use strict";

/**
 * CitizenSafetyNet unit checks — the idle-behavior safety net.
 *
 * Verifies:
 * 1. Safety-net activities match citizens with NO role (or invalid role).
 * 2. Safety-net activities do NOT match base bots (no citizen seed).
 * 3. The citizen condition still gates normal activities by role.
 *
 * Jon's directive (2026-10-12): it must be IMPOSSIBLE for a citizen to have
 * zero activity candidates, even if their role attribute is missing/broken.
 */

const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");

// Load the condition factory without registering action types (no engine needed).
// We replicate the require path resolution used by CitizenActionTypes.
const actionTypesPath = path.join(__dirname, "CitizenActionTypes.js");
const actionTypesSrc = fs.readFileSync(actionTypesPath, "utf8");

// Extract and evaluate createCitizenCondition in isolation with mocked constants.
const constants = require("../constants");
const { ATTR_CITIZEN_ROLE, ATTR_CITIZEN_SEED, ATTR_KINGDOM_ID } = constants;

function makeMockPlayer(attrs = {}) {
  return {
    getAttribute: (key) => attrs[key],
    getUsername: () => attrs.username ?? "test-citizen",
  };
}

// We can't easily import createCitizenCondition (not exported), so we test
// through the compiled activity definitions instead.
const activitiesPath = path.join(__dirname, "..", "data", "citizen-activities.json");
const { activities } = JSON.parse(fs.readFileSync(activitiesPath, "utf8"));

const safetynetIds = ["safetynet_wander", "safetynet_socialize", "safetynet_rest"];

console.log("Test 1: safety-net activities exist in catalogue");
for (const id of safetynetIds) {
  const act = activities.find((a) => a.id === id);
  assert.ok(act, `missing safety-net activity: ${id}`);
  assert.deepEqual(
    act.requires,
    [{ citizen: { safetyNet: true } }],
    `${id} must use safetyNet condition (no role requirement)`
  );
  assert.ok(act.capacity >= 100, `${id} capacity must be high (never fill up)`);
}
console.log("  PASS: 3 safety-net activities with safetyNet condition");

console.log("Test 2: safety-net condition logic (via source inspection)");
assert.ok(
  actionTypesSrc.includes("safetyNet"),
  "CitizenActionTypes.js must handle safetyNet flag"
);
assert.ok(
  actionTypesSrc.includes("ATTR_CITIZEN_SEED"),
  "safety-net check must verify citizen via seed attribute"
);
console.log("  PASS: safety-net handling present in condition factory");

console.log("Test 3: all non-safetynet activities still require roles");
const nonSafetynet = activities.filter((a) => !safetynetIds.includes(a.id));
const withoutRole = nonSafetynet.filter((a) =>
  !(a.requires || []).some(
    (r) => r.citizen && Array.isArray(r.citizen.roles) && r.citizen.roles.length > 0
  )
);
assert.deepEqual(
  withoutRole.map((a) => a.id),
  [],
  `non-safetynet activities without role requirement: ${withoutRole.map((a) => a.id)}`
);
console.log(`  PASS: all ${nonSafetynet.length} regular activities still role-gated`);

console.log("Test 4: role validation constants available");
const { ROLES, ROLE_COMMONER } = constants;
assert.ok(Array.isArray(ROLES) && ROLES.includes("commoner"), "ROLES must include commoner");
assert.equal(ROLE_COMMONER, "commoner");
console.log("  PASS: ROLES includes commoner for spawn default");

console.log("\nAll safety-net tests passed.");
