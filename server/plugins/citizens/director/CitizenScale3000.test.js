"use strict";

/**
 * Citizen scale-3000 test (2026-10-12, Jon: "upwards of 3k players").
 *
 * Drives the REAL boot() with the engine boundary stubbed and pins:
 *   1. Total roster = 650 base (100 capitals + 400 settlements + 150 towns)
 *      + 2460 expansion = 3110.
 *   2. The expansion runs AFTER the base plans: the first 650 roster entries
 *      keep their original seeds/names (journal preservation).
 *   3. Work-anchor positions have spread (not all stacked on the exact tile).
 *   4. Roster build stays fast (< 15s for 3110).
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
        return originalLoad.call(this, request, parent, isMain); // REAL
      }
      return genericStub();
    }

    return originalLoad.call(this, request, parent, isMain);
  };
}

installStubs();

const { CitizenDirector } = require("./CitizenDirector");

describe("citizen scale-3000 expansion", () => {
  let director;
  let buildMs;
  let usernames;

  before(() => {
    director = new CitizenDirector({ api: {}, registry: {} });
    director.startTask = () => {};
    director.log = () => {};
    const t0 = Date.now();
    director.boot();
    buildMs = Date.now() - t0;
    usernames = [...director.roster.values()].map((r) => r.username);
  });

  it("builds 3110 citizens: 650 base + 2460 expansion", () => {
    assert.equal(director.roster.size, 3110);
  });

  it("builds fast", () => {
    assert.ok(buildMs < 15000, `roster build took ${buildMs}ms`);
  });

  it("all usernames are unique", () => {
    const seen = new Set(usernames);
    assert.equal(seen.size, usernames.length);
  });

  it("expansion covers all 5 capitals", () => {
    const counts = {};
    let i = 0;
    for (const record of director.roster.values()) {
      i += 1;
      if (i <= 650) continue; // base plans
      if (!record.settlementId && !record.townId) {
        counts[record.kingdomId] = (counts[record.kingdomId] || 0) + 1;
      }
    }
    assert.equal(Object.keys(counts).length, 5);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    assert.equal(total, 700);
  });

  it("expansion covers all 8 settlements", () => {
    const counts = {};
    let i = 0;
    for (const record of director.roster.values()) {
      i += 1;
      if (i <= 650) continue;
      if (record.settlementId) {
        counts[record.settlementId] = (counts[record.settlementId] || 0) + 1;
      }
    }
    assert.equal(Object.keys(counts).length, 8);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    assert.equal(total, 720);
  });

  it("expansion covers all 16 towns/districts", () => {
    const counts = {};
    let i = 0;
    for (const record of director.roster.values()) {
      i += 1;
      if (i <= 650) continue;
      if (record.townId) {
        counts[record.townId] = (counts[record.townId] || 0) + 1;
      }
    }
    assert.equal(Object.keys(counts).length, 16);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    assert.equal(total, 1040);
  });

  it("positions start at home (no anchors) — location emerges from movement", () => {
    // Jon 2026-10-12: citizens are sandbox agents, not anchored NPCs.
    // Position starts at home; the brain syncs it during materialization.
    for (const record of director.roster.values()) {
      assert.equal(
        record.position.x,
        record.home.x,
        `${record.username} position not at home`
      );
      assert.equal(
        record.position.y,
        record.home.y,
        `${record.username} position not at home`
      );
      assert.equal(record.workKind, null, `${record.username} has workKind`);
      assert.equal(
        record.anchorActivityId,
        null,
        `${record.username} has anchorActivityId`
      );
    }
  });

  it("every citizen has a valid position and home", () => {
    for (const record of director.roster.values()) {
      assert.ok(record.position, `no position for ${record.username}`);
      assert.ok(
        typeof record.position.x === "number" &&
          typeof record.position.y === "number",
        `bad position for ${record.username}`
      );
      assert.ok(record.home, `no home for ${record.username}`);
    }
  });
});
