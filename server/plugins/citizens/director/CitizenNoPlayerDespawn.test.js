"use strict";

/**
 * No-player-online despawn tests (Jon 2026-10-13): with zero players online,
 * tickProximity must despawn every materialized citizen to the data tier —
 * the old early-return left them invisible-but-live forever (CPU leak on
 * Jon's 8GB box after logout).
 *
 * Covers:
 *  - tickProximity calls despawnAllMaterialized (and nothing else) when no
 *    players are online
 *  - tickProximity does NOT despawn on the normal path
 *  - despawnAllMaterialized goes through logoutCitizen (honest map dots:
 *    record.online flipped to false, XP persisted), handles missing records,
 *    throwers, map mutation during logout, mixed-case names, and stays
 *    silent when there is nothing to despawn
 */

const { describe, it, beforeEach } = require("node:test");
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
  return d;
}

function rec(name, x = 3000, y = 3000, z = 0) {
  return {
    username: name,
    position: { x, y, z },
    home: { x, y, z },
    role: "commoner",
    online: true,
    currentActivityId: "citizen_chop",
  };
}

function addRec(d, r) {
  d.roster.set(normalizeName(r.username), r);
  return r;
}

/** Director whose runtime holds exactly the given (raw, case-preserved) usernames. */
function withMaterialized(d, usernames, entryFactory) {
  const map = new Map();
  for (const u of usernames) {
    map.set(u, entryFactory ? entryFactory(u) : {});
  }
  d.runtime = () => ({ entriesByUsername: map });
  return map;
}

function collectLogs(d) {
  const lines = [];
  d.log = (msg, extra) => lines.push({ msg, extra });
  return lines;
}

describe("tickProximity no-player path", () => {
  let d;
  beforeEach(() => {
    d = makeDirector();
  });

  it("calls despawnAllMaterialized when no players are online", () => {
    d.realPlayerPositions = () => [];
    let called = 0;
    d.despawnAllMaterialized = () => { called += 1; };
    d.tickProximity();
    assert.equal(called, 1);
  });

  it("returns early: never scans the roster when no players are online", () => {
    d.realPlayerPositions = () => [];
    // Empty materialized set; roster set to null so ANY full-scan attempt throws.
    d.runtime = () => ({ entriesByUsername: new Map() });
    d.roster = null;
    assert.doesNotThrow(() => d.tickProximity());
  });

  it("still advances the tick counter on the idle path", () => {
    d.realPlayerPositions = () => [];
    d.runtime = () => ({ entriesByUsername: new Map() });
    const before = d.aiTickCount;
    d.tickProximity();
    assert.equal(d.aiTickCount, before + 1);
  });

  it("does NOT despawn when a player is present", () => {
    d.realPlayerPositions = () => [{ x: 3000, y: 3000, z: 0, name: "Jon" }];
    let called = 0;
    d.despawnAllMaterialized = () => { called += 1; };
    d.tickProximity();
    assert.equal(called, 0);
  });

  it("normal path survives with a full materialized set and players present", () => {
    d.realPlayerPositions = () => [{ x: 3000, y: 3000, z: 0, name: "Jon" }];
    const names = Array.from({ length: 60 }, (_, i) => `FullSet${i}`);
    withMaterialized(d, names);
    let called = 0;
    d.despawnAllMaterialized = () => { called += 1; };
    assert.doesNotThrow(() => d.tickProximity());
    assert.equal(called, 0);
  });
});

describe("despawnAllMaterialized", () => {
  let d;
  beforeEach(() => {
    d = makeDirector();
  });

  it("no-ops silently when runtime() is null", () => {
    d.runtime = () => null;
    const lines = collectLogs(d);
    assert.doesNotThrow(() => d.despawnAllMaterialized());
    assert.equal(lines.length, 0);
  });

  it("no-ops silently when entriesByUsername is missing", () => {
    d.runtime = () => ({});
    const lines = collectLogs(d);
    assert.doesNotThrow(() => d.despawnAllMaterialized());
    assert.equal(lines.length, 0);
  });

  it("no-ops silently when nothing is materialized", () => {
    d.runtime = () => ({ entriesByUsername: new Map() });
    const lines = collectLogs(d);
    d.despawnAllMaterialized();
    assert.equal(lines.length, 0);
  });

  it("routes through logoutCitizen with the roster record", () => {
    const r = addRec(d, rec("LogoutAlice", 3200, 3200));
    withMaterialized(d, ["LogoutAlice"]);
    const seen = [];
    d.logoutCitizen = (record) => { seen.push(record); };
    const lines = collectLogs(d);
    d.despawnAllMaterialized();
    assert.equal(seen.length, 1);
    assert.equal(seen[0], r, "must receive the exact roster record");
    assert.equal(lines.length, 1);
    assert.equal(lines[0].msg, "all materialized citizens despawned (no players online)");
    assert.equal(lines[0].extra.despawned, 1);
  });

  it("the real logoutCitizen path flips record.online false (honest map dots)", () => {
    const r = addRec(d, rec("HonestBob"));
    withMaterialized(d, ["HonestBob"]);
    // No bot -> getBot returns null -> record.online = false.
    d.despawnAllMaterialized();
    assert.equal(r.online, false);
    assert.equal(r.currentActivityId, null);
  });

  it("despawns every member of a 60-citizen cohort", () => {
    const names = Array.from({ length: 60 }, (_, i) => `Cohort${i}`);
    for (const n of names) addRec(d, rec(n));
    withMaterialized(d, names);
    const seen = new Set();
    d.logoutCitizen = (record) => {
      seen.add(record.username);
      record.online = false;
    };
    d.despawnAllMaterialized();
    assert.equal(seen.size, 60);
    for (const r of d.roster.values()) {
      assert.equal(r.online, false);
    }
  });

  it("normalizes mixed-case username keys before the roster lookup", () => {
    const r = addRec(d, rec("MixedCaseName"));
    withMaterialized(d, ["MixedCaseName"]);
    const seen = [];
    d.logoutCitizen = (record) => { seen.push(record); };
    d.despawnAllMaterialized();
    assert.equal(seen.length, 1);
    assert.equal(seen[0], r);
  });

  it("skips entries with no roster record; others still despawn", () => {
    const r = addRec(d, rec("HasRecord"));
    withMaterialized(d, ["HasRecord", "GhostNoRecord"]);
    const seen = [];
    d.logoutCitizen = (record) => { seen.push(record); };
    const lines = collectLogs(d);
    assert.doesNotThrow(() => d.despawnAllMaterialized());
    assert.deepEqual(seen.map((x) => x.username), ["HasRecord"]);
    assert.equal(r.online, true, "real logoutCitizen not used here; record untouched");
    assert.equal(lines[0].extra.despawned, 1);
  });

  it("continues when one logoutCitizen throws; logs the failure", () => {
    const a = addRec(d, rec("ThrowA"));
    const b = addRec(d, rec("ThrowB"));
    const c = addRec(d, rec("ThrowC"));
    withMaterialized(d, ["ThrowA", "ThrowB", "ThrowC"]);
    const seen = [];
    d.logoutCitizen = (record) => {
      if (record.username === "ThrowB") throw new Error("boom");
      seen.push(record.username);
    };
    const lines = collectLogs(d);
    assert.doesNotThrow(() => d.despawnAllMaterialized());
    assert.deepEqual(seen.sort(), ["ThrowA", "ThrowC"]);
    const failLines = lines.filter((l) => l.msg === "no-player despawn failed");
    assert.equal(failLines.length, 1);
    assert.equal(failLines[0].extra.citizen, "ThrowB");
    const okLines = lines.filter(
      (l) => l.msg === "all materialized citizens despawned (no players online)"
    );
    assert.equal(okLines.length, 1);
    assert.equal(okLines[0].extra.despawned, 2);
  });

  it("survives the entry map being mutated during logout (key snapshot)", () => {
    const map = withMaterialized(d, ["SnapA", "SnapB", "SnapC"]);
    for (const u of ["SnapA", "SnapB", "SnapC"]) addRec(d, rec(u));
    const seen = [];
    d.logoutCitizen = (record) => {
      // Engine-side: onPlayerLogout removes the entry when the bot logs out.
      map.delete(record.username);
      seen.push(record.username);
    };
    assert.doesNotThrow(() => d.despawnAllMaterialized());
    assert.deepEqual(seen.sort(), ["SnapA", "SnapB", "SnapC"]);
  });

  it("second call is idempotent when everything already despawned", () => {
    const r = addRec(d, rec("IdemA"));
    const map = withMaterialized(d, ["IdemA"]);
    d.logoutCitizen = (record) => {
      map.delete(record.username);
      record.online = false;
    };
    d.despawnAllMaterialized();
    const lines = collectLogs(d);
    d.despawnAllMaterialized(); // entries now empty
    assert.equal(lines.length, 0, "no log line when nothing to despawn");
    assert.equal(r.online, false);
  });

  it("empty cohort after clearing: no-op without touching the roster", () => {
    addRec(d, rec("Untouched"));
    d.runtime = () => ({ entriesByUsername: new Map() });
    const lines = collectLogs(d);
    d.despawnAllMaterialized();
    assert.equal(d.roster.size, 1);
    assert.equal(lines.length, 0);
  });

  it("despawn count matches the batch log exactly", () => {
    const names = ["One", "Two", "Three"];
    for (const n of names) addRec(d, rec(n));
    withMaterialized(d, names);
    d.logoutCitizen = () => {};
    const lines = collectLogs(d);
    d.despawnAllMaterialized();
    const batch = lines.find(
      (l) => l.msg === "all materialized citizens despawned (no players online)"
    );
    assert.ok(batch, "batch log must fire");
    assert.equal(batch.extra.despawned, 3);
  });

  it("normalizes whitespace-padded username keys", () => {
    const r = addRec(d, rec("trimmedname"));
    withMaterialized(d, ["  TrimmedName  "]);
    const seen = [];
    d.logoutCitizen = (record) => { seen.push(record); };
    d.despawnAllMaterialized();
    assert.equal(seen.length, 1);
    assert.equal(seen[0], r);
  });

  it("materialized records stay untouched when the entry set is empty", () => {
    const r = addRec(d, rec("StillThere"));
    d.runtime = () => ({ entriesByUsername: new Map() });
    d.logoutCitizen = () => { throw new Error("must not be called"); };
    d.despawnAllMaterialized();
    assert.equal(r.online, true);
  });

  it("idle tick does not touch the spawn queue", () => {
    d.realPlayerPositions = () => [];
    withMaterialized(d, ["QueueIdle1"]);
    d.logoutCitizen = () => {};
    d.spawnQueue = [{ key: "somequeued" }];
    d.spawnQueued = new Set(["somequeued"]);
    d.tickProximity();
    assert.deepEqual(d.spawnQueue, [{ key: "somequeued" }]);
  });

  it("entry values without a player field still despawn cleanly", () => {
    const r = addRec(d, rec("NoPlayerField"));
    withMaterialized(d, ["NoPlayerField"]);
    // Real logoutCitizen: entry exists but entry.player is undefined -> bot null.
    d.despawnAllMaterialized();
    assert.equal(r.online, false);
  });

  it("roster records persist after despawn (data tier keeps running)", () => {
    const r = addRec(d, rec("Persists"));
    withMaterialized(d, ["Persists"]);
    d.logoutCitizen = (record) => { record.online = false; };
    d.despawnAllMaterialized();
    assert.ok(d.roster.has(normalizeName("Persists")), "roster record must survive");
    assert.equal(d.roster.get(normalizeName("Persists")), r);
  });
});
