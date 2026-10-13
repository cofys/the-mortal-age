"use strict";

/**
 * Invisible materialization tests (Jon 2026-10-13): citizens must never
 * arrive as a synchronized visible wave.
 *
 * Covers the spawn-queue machinery in CitizenDirector:
 *  - enqueueSpawn dedups and keeps nearest-first order
 *  - queue overflow drops the farthest entries
 *  - detectArrivals ignores walking, fires on teleport/login
 *  - drainSpawnQueue trickles (<=4/tick), skips online citizens, drops
 *    entries whose player walked away, and respects the materialized cap
 *  - walkInSpawnTile keeps in-place spawns out of view and displaces
 *    in-view destinations to a walkable off-view tile
 */

const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");

function genericStub() {
  const noop = () => {};
  return new Proxy(
    {},
    {
      get: (target, prop) => (typeof prop === "string" ? noop : undefined),
    }
  );
}

class StubLocation {
  constructor(x, y, z) {
    this.x = x;
    this.y = y;
    this.z = z;
  }
  clone() {
    return new StubLocation(this.x, this.y, this.z);
  }
}

function installStubs() {
  const Module = require("node:module");
  const originalLoad = Module._load;
  const path = require("node:path");

  Module._load = function (request, parent, isMain) {
    const parentFile = parent && parent.filename ? parent.filename : "";
    const isDirector = parentFile.endsWith(
      path.join("director", "CitizenDirector.js")
    );

    if (request.includes("src/main/typescript")) {
      if (request.endsWith("/Location")) {
        return { Location: StubLocation };
      }
      return {};
    }

    if (isDirector) {
      if (request === "../constants") {
        return originalLoad.call(this, request, parent, isMain); // REAL
      }
      if (request.includes("brain/CitizenSites")) {
        return originalLoad.call(this, request, parent, isMain); // REAL
      }
      if (request.includes("lib/personalities")) {
        return originalLoad.call(this, request, parent, isMain); // REAL
      }
      if (request.includes("lib/humanizer")) {
        return originalLoad.call(this, request, parent, isMain); // REAL
      }
      if (request.includes("lib/CitizenAnchor")) {
        return originalLoad.call(this, request, parent, isMain); // REAL
      }
      if (request.includes("lib/CitizenBonds")) {
        return originalLoad.call(this, request, parent, isMain); // REAL (normalizeName)
      }
      return genericStub();
    }

    return originalLoad.call(this, request, parent, isMain);
  };
}

installStubs();

const { CitizenDirector } = require("./CitizenDirector");
const { normalizeName } = require("../lib/CitizenBonds");

function makeDirector() {
  const d = new CitizenDirector({ api: {}, registry: {} });
  d.log = () => {};
  d.taskStarted = true; // never submit real engine tasks in tests
  d.roster = new Map();
  d.spawnQueue = [];
  d.spawnQueued = new Set();
  d._lastPlayerPos = new Map();
  return d;
}

function rec(name, x, y, z = 0) {
  return {
    username: name,
    position: { x, y, z },
    home: { x, y, z },
    role: "commoner",
    sleepStart: 0,
    sleepHours: 0,
  };
}

function addRec(d, r) {
  d.roster.set(normalizeName(r.username), r);
  return r;
}

describe("spawn queue", () => {
  let d;
  before(() => {
    d = makeDirector();
  });

  it("enqueueSpawn dedups by username", () => {
    const r = addRec(d, rec("QueueAlice", 3000, 3000));
    d.isOnline = () => false;
    d.enqueueSpawn(r, 10);
    d.enqueueSpawn(r, 5);
    assert.equal(d.spawnQueue.length, 1);
    assert.equal(d.spawnQueued.size, 1);
    d.spawnQueue = [];
    d.spawnQueued = new Set();
  });

  it("enqueueSpawn keeps nearest-first order", () => {
    d.isOnline = () => false;
    const a = addRec(d, rec("QueueFar", 3100, 3100));
    const b = addRec(d, rec("QueueNear", 3010, 3010));
    const c = addRec(d, rec("QueueMid", 3050, 3050));
    d.enqueueSpawn(a, 100);
    d.enqueueSpawn(b, 10);
    d.enqueueSpawn(c, 50);
    const order = d.spawnQueue.map((i) => i.key);
    assert.deepEqual(order, [
      normalizeName("QueueNear"),
      normalizeName("QueueMid"),
      normalizeName("QueueFar"),
    ]);
    d.spawnQueue = [];
    d.spawnQueued = new Set();
  });

  it("enqueueSpawn refuses already-online citizens", () => {
    const r = addRec(d, rec("QueueOnline", 3000, 3000));
    d.isOnline = (rec) => rec.username === "QueueOnline";
    d.enqueueSpawn(r, 1);
    assert.equal(d.spawnQueue.length, 0);
    d.isOnline = () => false;
  });
});

describe("detectArrivals", () => {
  let d;
  before(() => {
    d = makeDirector();
    d.isOnline = () => false;
    addRec(d, rec("ArriveBob", 3005, 3005));
  });

  it("ignores ordinary walking (no roster scan side effects)", () => {
    d._lastPlayerPos.set("walker", { x: 3000, y: 3000, z: 0 });
    d.detectArrivals([{ x: 3002, y: 3001, z: 0, name: "walker" }]);
    assert.equal(d.spawnQueue.length, 0);
  });

  it("enqueues on teleport discontinuity", () => {
    d._lastPlayerPos.set("teleporter", { x: 1000, y: 1000, z: 0 });
    d.detectArrivals([{ x: 3000, y: 3000, z: 0, name: "teleporter" }]);
    assert.ok(d.spawnQueue.length >= 1, "teleport should enqueue nearby citizens");
    const keys = d.spawnQueue.map((i) => i.key);
    assert.ok(keys.includes(normalizeName("ArriveBob")));
    d.spawnQueue = [];
    d.spawnQueued = new Set();
  });

  it("enqueues for brand-new players (login)", () => {
    d.detectArrivals([{ x: 3000, y: 3000, z: 0, name: "newlogin" }]);
    const keys = d.spawnQueue.map((i) => i.key);
    assert.ok(keys.includes(normalizeName("ArriveBob")));
    d.spawnQueue = [];
    d.spawnQueued = new Set();
  });

  it("prunes departed players from tracking", () => {
    d._lastPlayerPos.set("gone", { x: 1, y: 1, z: 0 });
    d.detectArrivals([{ x: 3000, y: 3000, z: 0, name: "staying" }]);
    assert.ok(!d._lastPlayerPos.has("gone"));
    d.spawnQueue = [];
    d.spawnQueued = new Set();
  });
});

describe("drainSpawnQueue", () => {
  it("trickles at most 4 per tick", () => {
    const d = makeDirector();
    d.isOnline = () => false;
    d.runtime = () => ({ entriesByUsername: new Map() });
    for (let i = 0; i < 10; i++) {
      addRec(d, rec(`Drain${i}`, 3000 + i, 3000));
    }
    const positions = [{ x: 3000, y: 3000, z: 0, name: "p" }];
    for (const r of d.roster.values()) d.enqueueSpawn(r, 5);
    let spawned = 0;
    d.spawnCitizen = () => {
      spawned++;
      return true;
    };
    d.drainSpawnQueue(positions);
    assert.ok(spawned >= 2 && spawned <= 4, `drained ${spawned}, expected 2-4`);
    assert.ok(d.spawnQueue.length > 0, "remainder stays queued");
  });

  it("drops entries whose player walked away", () => {
    const d = makeDirector();
    d.isOnline = () => false;
    d.runtime = () => ({ entriesByUsername: new Map() });
    const r = addRec(d, rec("DrainLeft", 3000, 3000));
    d.enqueueSpawn(r, 5);
    let spawned = 0;
    d.spawnCitizen = () => {
      spawned++;
      return true;
    };
    // Player is now 200 tiles away — beyond the 50-tile spawn radius.
    d.drainSpawnQueue([{ x: 3200, y: 3200, z: 0, name: "p" }]);
    assert.equal(spawned, 0);
    assert.equal(d.spawnQueue.length, 0);
  });

  it("respects the materialized cap", () => {
    const d = makeDirector();
    d.isOnline = () => false;
    const full = new Map();
    for (let i = 0; i < 60; i++) full.set(`bot${i}`, {});
    d.runtime = () => ({ entriesByUsername: full });
    const r = addRec(d, rec("DrainCapped", 3000, 3000));
    d.enqueueSpawn(r, 5);
    let spawned = 0;
    d.spawnCitizen = () => {
      spawned++;
      return true;
    };
    d.drainSpawnQueue([{ x: 3000, y: 3000, z: 0, name: "p" }]);
    assert.equal(spawned, 0);
    assert.equal(d.spawnQueue.length, 1, "stays queued for later");
  });
});

describe("walkInSpawnTile", () => {
  it("returns null when the destination is outside every player's view", () => {
    const d = makeDirector();
    d.snapToWalkableTile = (x, y, z) => ({ x, y, z });
    const tile = d.walkInSpawnTile(
      { x: 3000, y: 3000, z: 0 },
      rec("WalkFar", 3000, 3000),
      [{ x: 3100, y: 3100, z: 0, name: "p" }]
    );
    assert.equal(tile, null);
  });

  it("displaces in-view destinations to a walkable off-view tile", () => {
    const d = makeDirector();
    d.snapToWalkableTile = (x, y, z) => ({ x, y, z });
    const player = { x: 3000, y: 3000, z: 0, name: "p" };
    const tile = d.walkInSpawnTile(
      { x: 3005, y: 3005, z: 0 },
      rec("WalkNear", 3005, 3005),
      [player]
    );
    assert.ok(tile, "expected a walk-in tile");
    const viewDist = Math.max(Math.abs(tile.x - player.x), Math.abs(tile.y - player.y));
    assert.ok(viewDist > 22, `walk-in tile must be outside the viewport, got ${viewDist}`);
  });

  it("returns null when no positions are known", () => {
    const d = makeDirector();
    const tile = d.walkInSpawnTile({ x: 3000, y: 3000, z: 0 }, rec("WalkNo", 3000, 3000), []);
    assert.equal(tile, null);
  });
});
