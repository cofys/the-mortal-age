"use strict";

/**
 * CitizenTickLod.test.js — unit tests for the citizen LOD tick-stride layer.
 * Run with: node --test server/plugins/citizens/lib/CitizenTickLod.test.js
 * (from the repo root; uses node:test, no external deps)
 */

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const {
  NEAR_DISTANCE_TILES,
  MID_DISTANCE_TILES,
  ASLEEP_DISTANCE_TILES,
  HYSTERESIS_TILES,
  NEAR_STRIDE,
  MID_STRIDE,
  FAR_STRIDE,
  BAND_NEAR,
  BAND_MID,
  BAND_FAR,
  BAND_ASLEEP,
  bandRank,
  resolveBand,
  strideForBand,
  updateBand,
  isDueOnCycle,
  shouldForceTickOnBandChange,
  chebyshevDistanceTiles,
  tickLodBands,
  bandOf,
  clearBands,
} = require("./CitizenTickLod");

// Deterministic roster of N citizens.
function rosterNames(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(`lod_citizen_${i}`);
  return out;
}

describe("resolveBand", () => {
  it("classifies the exact threshold edges", () => {
    assert.equal(resolveBand(0), BAND_NEAR);
    assert.equal(resolveBand(NEAR_DISTANCE_TILES), BAND_NEAR);
    assert.equal(resolveBand(NEAR_DISTANCE_TILES + 1), BAND_MID);
    assert.equal(resolveBand(MID_DISTANCE_TILES), BAND_MID);
    assert.equal(resolveBand(MID_DISTANCE_TILES + 1), BAND_FAR);
    assert.equal(resolveBand(ASLEEP_DISTANCE_TILES), BAND_FAR);
    assert.equal(resolveBand(ASLEEP_DISTANCE_TILES + 1), BAND_ASLEEP);
  });

  it("treats Infinity (nobody online) as asleep", () => {
    assert.equal(resolveBand(Number.POSITIVE_INFINITY), BAND_ASLEEP);
  });

  it("treats NaN (unmeasurable) as far — the conservative middle", () => {
    assert.equal(resolveBand(NaN), BAND_FAR);
    assert.equal(resolveBand(undefined), BAND_FAR);
  });

  it("clamps nonsense negatives to near", () => {
    assert.equal(resolveBand(-5), BAND_NEAR);
  });
});

describe("strideForBand", () => {
  it("returns the 1/3/12 strides from the spec", () => {
    assert.equal(strideForBand(BAND_NEAR), NEAR_STRIDE);
    assert.equal(strideForBand(BAND_MID), MID_STRIDE);
    assert.equal(strideForBand(BAND_FAR), FAR_STRIDE);
    assert.equal(NEAR_STRIDE, 1);
    assert.equal(MID_STRIDE, 3);
    assert.equal(FAR_STRIDE, 12);
  });

  it("returns 0 (never due) for asleep and unknown bands", () => {
    assert.equal(strideForBand(BAND_ASLEEP), 0);
    assert.equal(strideForBand("bogus"), 0);
    assert.equal(strideForBand(null), 0);
  });
});

describe("bandRank", () => {
  it("orders near < mid < far < asleep", () => {
    assert.ok(bandRank(BAND_NEAR) < bandRank(BAND_MID));
    assert.ok(bandRank(BAND_MID) < bandRank(BAND_FAR));
    assert.ok(bandRank(BAND_FAR) < bandRank(BAND_ASLEEP));
  });
});

describe("updateBand (hysteresis)", () => {
  it("resolves directly on first sighting", () => {
    assert.equal(updateBand(null, 10), BAND_NEAR);
    assert.equal(updateBand(undefined, 200), BAND_FAR);
    assert.equal(updateBand(null, 9999), BAND_ASLEEP);
  });

  it("upgrades toward the player instantly", () => {
    assert.equal(updateBand(BAND_FAR, 10), BAND_NEAR);
    assert.equal(updateBand(BAND_ASLEEP, 50), BAND_MID);
    assert.equal(updateBand(BAND_MID, 5), BAND_NEAR);
  });

  it("holds the nearer band inside the hysteresis margin", () => {
    // near edge is 32; 36 is inside the 8-tile margin -> stays near
    assert.equal(updateBand(BAND_NEAR, NEAR_DISTANCE_TILES + HYSTERESIS_TILES - 4), BAND_NEAR);
    // mid edge is 96; 100 is inside the margin -> stays mid
    assert.equal(updateBand(BAND_MID, MID_DISTANCE_TILES + 4), BAND_MID);
    // far edge is 240; 245 is inside the margin -> stays far
    assert.equal(updateBand(BAND_FAR, ASLEEP_DISTANCE_TILES + 5), BAND_FAR);
  });

  it("downgrades once the distance clears edge + margin", () => {
    assert.equal(updateBand(BAND_NEAR, NEAR_DISTANCE_TILES + HYSTERESIS_TILES + 1), BAND_MID);
    assert.equal(updateBand(BAND_MID, MID_DISTANCE_TILES + HYSTERESIS_TILES + 1), BAND_FAR);
    assert.equal(updateBand(BAND_FAR, ASLEEP_DISTANCE_TILES + HYSTERESIS_TILES + 1), BAND_ASLEEP);
  });

  it("downgrades across multiple bands in one jump", () => {
    assert.equal(updateBand(BAND_NEAR, 500), BAND_ASLEEP);
  });

  it("Infinity always downgrades to asleep", () => {
    assert.equal(updateBand(BAND_NEAR, Number.POSITIVE_INFINITY), BAND_ASLEEP);
  });
});

describe("isDueOnCycle", () => {
  it("near citizens are due every cycle", () => {
    for (let tick = 0; tick < 12; tick++) {
      assert.equal(isDueOnCycle("anyone", BAND_NEAR, tick), true);
    }
  });

  it("asleep citizens are never due", () => {
    for (let tick = 0; tick < 12; tick++) {
      assert.equal(isDueOnCycle("anyone", BAND_ASLEEP, tick), false);
      assert.equal(isDueOnCycle("anyone", "bogus", tick), false);
    }
  });

  it("mid citizens tick exactly once per 3 cycles each", () => {
    const names = rosterNames(30);
    const dueCounts = new Map(names.map((n) => [n, 0]));
    for (let tick = 0; tick < 6; tick++) {
      for (const n of names) {
        if (isDueOnCycle(n, BAND_MID, tick)) dueCounts.set(n, dueCounts.get(n) + 1);
      }
    }
    for (const n of names) {
      assert.equal(dueCounts.get(n), 2, `${n} should be due 2x in 6 cycles`);
    }
  });

  it("far citizens tick exactly once per 12 cycles each", () => {
    const names = rosterNames(36);
    const dueCounts = new Map(names.map((n) => [n, 0]));
    for (let tick = 0; tick < 12; tick++) {
      for (const n of names) {
        if (isDueOnCycle(n, BAND_FAR, tick)) dueCounts.set(n, dueCounts.get(n) + 1);
      }
    }
    for (const n of names) {
      assert.equal(dueCounts.get(n), 1, `${n} should be due 1x in 12 cycles`);
    }
  });

  it("spreads each band evenly across cycles (no tick storm)", () => {
    for (const [band, stride, cycles] of [[BAND_MID, 3, 12], [BAND_FAR, 12, 24]]) {
      const names = rosterNames(48);
      const perCycle = [];
      for (let tick = 0; tick < cycles; tick++) {
        let due = 0;
        for (const n of names) if (isDueOnCycle(n, band, tick)) due++;
        perCycle.push(due);
      }
      const expected = names.length / stride;
      for (const due of perCycle) {
        assert.ok(
          Math.abs(due - expected) <= 2,
          `${band}: cycle had ${due} due, expected ~${expected}`
        );
      }
    }
  });

  it("is stable for the same citizen across restarts (hash-derived)", () => {
    const first = [];
    for (let tick = 0; tick < 12; tick++) {
      first.push(isDueOnCycle("stable_citizen", BAND_FAR, tick));
    }
    for (let tick = 0; tick < 12; tick++) {
      assert.equal(isDueOnCycle("stable_citizen", BAND_FAR, tick), first[tick]);
    }
  });

  it("handles a garbage tick counter without throwing", () => {
    assert.equal(isDueOnCycle("x", BAND_MID, NaN), isDueOnCycle("x", BAND_MID, 0));
  });
});

describe("shouldForceTickOnBandChange", () => {
  it("forces on first sighting", () => {
    assert.equal(shouldForceTickOnBandChange(null, BAND_NEAR), true);
    assert.equal(shouldForceTickOnBandChange(undefined, BAND_ASLEEP), true);
  });

  it("forces when moving to a nearer band (player walked in)", () => {
    assert.equal(shouldForceTickOnBandChange(BAND_FAR, BAND_NEAR), true);
    assert.equal(shouldForceTickOnBandChange(BAND_ASLEEP, BAND_MID), true);
    assert.equal(shouldForceTickOnBandChange(BAND_MID, BAND_NEAR), true);
  });

  it("never forces when staying put or moving away", () => {
    assert.equal(shouldForceTickOnBandChange(BAND_NEAR, BAND_NEAR), false);
    assert.equal(shouldForceTickOnBandChange(BAND_NEAR, BAND_MID), false);
    assert.equal(shouldForceTickOnBandChange(BAND_MID, BAND_ASLEEP), false);
  });
});

describe("chebyshevDistanceTiles", () => {
  const loc = (x, y, z = 0) => ({
    getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => z }),
  });

  it("measures Chebyshev distance on the same plane", () => {
    assert.equal(chebyshevDistanceTiles(loc(0, 0), loc(3, 4)), 4);
    assert.equal(chebyshevDistanceTiles(loc(0, 0), loc(0, 0)), 0);
  });

  it("returns Infinity across planes or on missing data", () => {
    assert.equal(chebyshevDistanceTiles(loc(0, 0, 0), loc(1, 1, 1)), Number.POSITIVE_INFINITY);
    assert.equal(chebyshevDistanceTiles({}, loc(1, 1)), Number.POSITIVE_INFINITY);
  });
});

// --- tickLodBands with a mock director -----------------------------------------

function mockLocation(x, y, z = 0) {
  return { getX: () => x, getY: () => y, getZ: () => z };
}

function mockPlayer(username, x, y, { bot = false } = {}) {
  return {
    getUsername: () => username,
    isPlayerBot: () => bot,
    getHostAddress: () => (bot ? "bot" : "203.0.113.7"),
    getLocation: () => mockLocation(x, y),
    _locals: [],
    getLocalPlayers() {
      return this._locals;
    },
  };
}

function mockDirector(records, { online = () => true } = {}) {
  const bots = new Map();
  const states = new Map();
  for (const r of records) {
    const bot = mockPlayer(r.username, r.x, r.y, { bot: true });
    bots.set(r.username, bot);
    states.set(r.username, {});
  }
  const roster = new Map(records.map((r) => [r.username, r]));
  return {
    roster,
    isOnline: (record) => online(record),
    getBot: (record) => bots.get(record.username) ?? null,
    runtime: () => ({ botStatesByName: states }),
    log: () => {},
    _bots: bots,
    _states: states,
  };
}

describe("tickLodBands", () => {
  beforeEach(() => clearBands());

  it("classifies citizens by distance to the nearest real player", () => {
    const records = [
      { username: "near_citizen", x: 100, y: 100 },
      { username: "mid_citizen", x: 500, y: 500 },
      { username: "far_citizen", x: 900, y: 900 },
      { username: "alone_citizen", x: 2000, y: 2000 },
    ];
    const director = mockDirector(records);
    const human = mockPlayer("Jon", 105, 103); // 5 tiles from near_citizen
    director._bots.get("near_citizen")._locals = [human];
    const human2 = mockPlayer("Jon", 540, 520); // ~40 tiles from mid_citizen
    director._bots.get("mid_citizen")._locals = [human2];
    const human3 = mockPlayer("Jon", 1000, 1000); // 100 tiles from far_citizen
    director._bots.get("far_citizen")._locals = [human3];
    // alone_citizen: nobody in locals -> asleep

    const summary = tickLodBands(director, Date.now());
    assert.equal(bandOf({ username: "near_citizen" }), BAND_NEAR);
    assert.equal(bandOf({ username: "mid_citizen" }), BAND_MID);
    assert.equal(bandOf({ username: "far_citizen" }), BAND_FAR);
    assert.equal(bandOf({ username: "alone_citizen" }), BAND_ASLEEP);
    assert.deepEqual(summary, { near: 1, mid: 1, far: 1, asleep: 1, forced: 4 });

    const nearState = director._states.get("near_citizen");
    assert.equal(nearState.lodBand, BAND_NEAR);
    assert.equal(nearState.lodStride, 1);
    assert.ok(Number.isFinite(nearState.lodForceTickAt));
  });

  it("ignores other bots when measuring distance", () => {
    const records = [{ username: "lonely_citizen", x: 100, y: 100 }];
    const director = mockDirector(records);
    const otherBot = mockPlayer("other_bot", 101, 101, { bot: true });
    director._bots.get("lonely_citizen")._locals = [otherBot];
    tickLodBands(director, Date.now());
    assert.equal(bandOf({ username: "lonely_citizen" }), BAND_ASLEEP);
  });

  it("forces a catch-up tick when a player walks in, not on later cycles", () => {
    const records = [{ username: "walker_citizen", x: 100, y: 100 }];
    const director = mockDirector(records);
    const t0 = Date.now();
    tickLodBands(director, t0);
    assert.equal(bandOf({ username: "walker_citizen" }), BAND_ASLEEP);

    // Player walks in: band upgrades instantly and forces a tick.
    const human = mockPlayer("Jon", 102, 101);
    director._bots.get("walker_citizen")._locals = [human];
    const summary = tickLodBands(director, t0 + 1000);
    assert.equal(bandOf({ username: "walker_citizen" }), BAND_NEAR);
    assert.equal(summary.forced, 1);
    assert.equal(director._states.get("walker_citizen").lodForceTickAt, t0 + 1000);

    // Next cycle, same position: no force.
    const summary2 = tickLodBands(director, t0 + 2000);
    assert.equal(summary2.forced, 0);
  });

  it("applies hysteresis so edge-sitters don't flap", () => {
    const records = [{ username: "edge_citizen", x: 100, y: 100 }];
    const director = mockDirector(records);
    const bot = director._bots.get("edge_citizen");
    const t0 = Date.now();

    // 30 tiles out -> near.
    bot._locals = [mockPlayer("Jon", 130, 100)];
    tickLodBands(director, t0);
    assert.equal(bandOf({ username: "edge_citizen" }), BAND_NEAR);

    // Drift to 36 tiles (inside hysteresis) -> stays near.
    bot._locals = [mockPlayer("Jon", 136, 100)];
    tickLodBands(director, t0 + 1000);
    assert.equal(bandOf({ username: "edge_citizen" }), BAND_NEAR);

    // Drift to 50 tiles (past edge + margin) -> mid.
    bot._locals = [mockPlayer("Jon", 150, 100)];
    tickLodBands(director, t0 + 2000);
    assert.equal(bandOf({ username: "edge_citizen" }), BAND_MID);
  });

  it("drops bands for citizens that logged out", () => {
    const records = [{ username: "leaving_citizen", x: 100, y: 100 }];
    let isUp = true;
    const director = mockDirector(records, { online: () => isUp });
    director._bots.get("leaving_citizen")._locals = [mockPlayer("Jon", 101, 101)];
    tickLodBands(director, Date.now());
    assert.equal(bandOf({ username: "leaving_citizen" }), BAND_NEAR);
    isUp = false;
    const summary = tickLodBands(director, Date.now() + 1000);
    assert.equal(bandOf({ username: "leaving_citizen" }), null);
    assert.equal(summary.near, 0);
  });

  it("prunes bands for citizens removed from the roster", () => {
    const records = [{ username: "doomed_citizen", x: 100, y: 100 }];
    const director = mockDirector(records);
    const t0 = Date.now();
    tickLodBands(director, t0);
    assert.equal(bandOf({ username: "doomed_citizen" }), BAND_ASLEEP);

    director.roster.delete("doomed_citizen");
    tickLodBands(director, t0 + 2 * 3600 * 1000);
    assert.equal(bandOf({ username: "doomed_citizen" }), null);
  });

  it("survives getLocalPlayers throwing", () => {
    const records = [{ username: "brittle_citizen", x: 100, y: 100 }];
    const director = mockDirector(records);
    director._bots.get("brittle_citizen").getLocalPlayers = () => {
      throw new Error("boom");
    };
    const summary = tickLodBands(director, Date.now());
    assert.equal(bandOf({ username: "brittle_citizen" }), BAND_ASLEEP);
    assert.equal(summary.asleep, 1);
  });

  it("never throws on a hostile director", () => {
    const summary = tickLodBands(null, Date.now());
    assert.deepEqual(summary, { near: 0, mid: 0, far: 0, asleep: 0, forced: 0 });
    const summary2 = tickLodBands({}, Date.now());
    assert.deepEqual(summary2, { near: 0, mid: 0, far: 0, asleep: 0, forced: 0 });
  });
});
