"use strict";

/**
 * AdminWorldMapApi.test.js — admin world map API contracts.
 *
 * Verifies: admin-only access, citizen row shape, teleport/toggle-brain/
 * set-activity/spawn actions, and that failures return { open:false }.
 *
 * Run: node server/plugins/interface/AdminWorldMapApi.test.js
 */

const assert = require("node:assert/strict");
const path = require("node:path");

const IFACE = path.resolve(__dirname);

function stub(rel, exports) {
  const p = path.resolve(IFACE, rel) + ".js";
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

// --- stubs ---
const moveToCalls = [];
const setAttrCalls = [];

const adminPlayer = {
  getUsername: () => "Jon",
  getRights: () => ({ isAdmin: () => true }),
  setAttribute: (k, v) => setAttrCalls.push([k, v]),
  getAttribute: () => "",
  moveTo: (loc) => moveToCalls.push(loc),
};
const normalPlayer = {
  getUsername: () => "SomePlayer",
  getRights: () => ({ isAdmin: () => false }),
  setAttribute: () => {},
  getAttribute: () => "",
};

stub("./ContentApiAuth", {
  setPluginApi: () => {},
  requireAuth: (query) => {
    const t = query.get("token");
    if (t === "admin-token") return adminPlayer;
    if (t === "user-token") return normalPlayer;
    return null;
  },
});

const citizenRecord = {
  username: "Test Citizen",
  position: { x: 3200, y: 3200, z: 0 },
  home: { x: 3200, y: 3200, z: 0 },
  currentActivityId: "citizen_fish",
  goal: "catch fish",
  kingdomId: "misthalin",
  role: "fisher",
  lastTickAt: Date.now() - 5000,
  brainPaused: false,
};
const roster = new Map([["test citizen", citizenRecord]]);

stub("../citizens/director/CitizenDirector", {
  getDirector: () => ({
    roster,
    getBot: () => null,
    debugSpawnCitizen: ({ x, y, z }) => "Spawned Citizen",
  }),
});

// Fake Location for teleport — intercept at _load, the most reliable point.
const Module = require("node:module");
const fakeLocationExports = {
  Location: class { constructor(x, y, z) { this.x = x; this.y = y; this.z = z; } },
};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (typeof request === "string" && request.endsWith("elvarg/game/model/Location")) {
    return fakeLocationExports;
  }
  return realLoad.call(this, request, parent, isMain);
};

// Capture the registered endpoint
let endpointHandler = null;
const fakeApi = {
  core: { World: { getPlayers: () => [adminPlayer] }, PlayerRights: null },
  registerContentEndpoint: (name, handler) => { endpointHandler = handler; },
};

require("./AdminWorldMapApi").attach(fakeApi);
assert.ok(endpointHandler, "endpoint registered");

function query(params) {
  const m = new Map(Object.entries(params));
  return { get: (k) => (m.has(k) ? m.get(k) : null) };
}

// 1. No token -> closed
let r = endpointHandler(query({}));
assert.equal(r.open, false, "no token closes");

// 2. Non-admin token -> closed
r = endpointHandler(query({ token: "user-token", action: "status" }));
assert.equal(r.open, false, "non-admin closes");

// 3. Admin status -> citizen rows
r = endpointHandler(query({ token: "admin-token", action: "status" }));
assert.equal(r.open, true, "admin opens");
assert.ok(Array.isArray(r.citizens), "citizens array");
assert.equal(r.citizens.length, 1, "one citizen");
const row = r.citizens[0];
assert.equal(row.n, "Test Citizen");
assert.equal(row.x, 3200);
assert.equal(row.a, "citizen_fish");
assert.equal(row.k, "misthalin");
assert.equal(row.o, 0);
assert.equal(row.b, 0);
assert.ok(r.stats && r.stats.roster === 1, "stats");

// 4. Teleport
r = endpointHandler(query({ token: "admin-token", action: "teleport", target: "Test Citizen" }));
assert.ok(r.ok && r.ok.includes("Test Citizen"), "teleport ok: " + JSON.stringify(r));
assert.equal(moveToCalls.length, 1, "moveTo called");
assert.equal(moveToCalls[0].x, 3200, "teleport x");

// 5. Teleport unknown citizen
r = endpointHandler(query({ token: "admin-token", action: "teleport", target: "Nobody" }));
assert.ok(r.error, "unknown citizen errors");

// 6. Toggle brain
assert.equal(citizenRecord.brainPaused, false);
r = endpointHandler(query({ token: "admin-token", action: "toggle-brain", target: "Test Citizen" }));
assert.equal(citizenRecord.brainPaused, true, "brain paused");
assert.ok(r.ok.includes("paused"));
r = endpointHandler(query({ token: "admin-token", action: "toggle-brain", target: "Test Citizen" }));
assert.equal(citizenRecord.brainPaused, false, "brain resumed");

// 7. Set activity
r = endpointHandler(query({
  token: "admin-token", action: "set-activity",
  target: "Test Citizen", activity: "citizen_mine",
}));
assert.equal(citizenRecord.currentActivityId, "citizen_mine", "activity set");
assert.ok(r.ok);

// 8. Spawn
r = endpointHandler(query({ token: "admin-token", action: "spawn", x: "3000", y: "3000" }));
assert.ok(r.ok, "spawn ok: " + JSON.stringify(r));

// 9. Spawn without coords
r = endpointHandler(query({ token: "admin-token", action: "spawn" }));
assert.ok(r.error, "spawn needs coords");

console.log("AdminWorldMapApi.test.js: all 9 checks passed");
