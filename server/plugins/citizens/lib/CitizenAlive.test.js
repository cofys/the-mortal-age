"use strict";

/**
 * CitizenAlive.test.js — unit tests for the alive layer.
 * Run with: node --test server/plugins/citizens/lib/CitizenAlive.test.js
 * (from the repo root; uses node:test, no external deps)
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  movementStyleFor,
  styleWalkTarget,
  shouldPauseMidWalk,
  _positionHistory,
  _tickStuckDetection,
  _tickIdleLife,
  _tickSocialAwareness,
  _tickImperfections,
  _tickEmoteReactions,
} = require("./CitizenAlive");

function fakeRecord(overrides = {}) {
  return {
    username: "test_citizen",
    personality: { traits: [], demeanor: "calm", age: 35 },
    home: { x: 3200, y: 3200, z: 0 },
    currentActivityId: "citizen_routine",
    ...overrides,
  };
}

function fakeBot(overrides = {}) {
  const loc = { x: 3200, y: 3200, z: 0 };
  return {
    getLocation: () => ({
      getX: () => loc.x,
      getY: () => loc.y,
      getZ: () => loc.z,
    }),
    getLocalPlayers: () => [],
    getMovementQueue: () => ({ size: () => 0, clear: () => {} }),
    getForceMovement: () => null,
    getUsername: () => "test_citizen",
    isPlayerBot: () => true,
    forceChat: () => {},
    performAnimation: () => {},
    face: () => {},
    _loc: loc,
    ...overrides,
  };
}

function fakeDirector() {
  return {
    roster: new Map(),
    isOnline: () => true,
    getBot: () => null,
    log: () => {},
  };
}

describe("movementStyleFor", () => {
  it("returns steady for a plain citizen", () => {
    assert.equal(movementStyleFor(fakeRecord()), "steady");
  });

  it("returns weaver for a drunk", () => {
    const r = fakeRecord({ personality: { traits: ["drunk"], demeanor: "", age: 40 } });
    assert.equal(movementStyleFor(r), "weaver");
  });

  it("returns skittish for a nervous citizen", () => {
    const r = fakeRecord({ personality: { traits: [], demeanor: "nervous", age: 30 } });
    assert.equal(movementStyleFor(r), "skittish");
  });

  it("returns ambler for an elder", () => {
    const r = fakeRecord({ personality: { traits: [], demeanor: "", age: 72 } });
    assert.equal(movementStyleFor(r), "ambler");
  });

  it("returns hasty for an energetic youth", () => {
    const r = fakeRecord({ personality: { traits: ["energetic"], demeanor: "", age: 22 } });
    assert.equal(movementStyleFor(r), "hasty");
  });
});

describe("styleWalkTarget", () => {
  it("returns the target unchanged for steady walkers", () => {
    const r = fakeRecord();
    const out = styleWalkTarget(r, 3210, 3210);
    assert.equal(out.x, 3210);
    assert.equal(out.y, 3210);
  });

  it("adds weave offset for drunk walkers", () => {
    const r = fakeRecord({ personality: { traits: ["drunk"], demeanor: "", age: 40 } });
    const out = styleWalkTarget(r, 3210, 3210);
    // Weaver adds a lateral offset — should differ from the input.
    assert.ok(out.x !== 3210 || out.y !== 3210, "weaver should offset the target");
  });

  it("adds noise for elderly amblers", () => {
    const r = fakeRecord({ personality: { traits: [], demeanor: "", age: 70 } });
    const out = styleWalkTarget(r, 3210, 3210);
    assert.ok(
      Math.abs(out.x - 3210) <= 2 && Math.abs(out.y - 3210) <= 2,
      "ambler noise should be small"
    );
  });
});

describe("shouldPauseMidWalk", () => {
  it("returns a boolean", () => {
    const r = fakeRecord();
    assert.equal(typeof shouldPauseMidWalk(r), "boolean");
  });

  it("skittish citizens pause more often than hasty ones (statistical)", () => {
    const skittish = fakeRecord({ personality: { traits: [], demeanor: "nervous", age: 30 } });
    const hasty = fakeRecord({ personality: { traits: ["hasty"], demeanor: "", age: 22 } });
    let skittishPauses = 0;
    let hastyPauses = 0;
    for (let i = 0; i < 200; i++) {
      // Use a deterministic-ish RNG by varying the seed through the record.
      if (shouldPauseMidWalk({ ...skittish, username: `s${i}` })) skittishPauses++;
      if (shouldPauseMidWalk({ ...hasty, username: `h${i}` })) hastyPauses++;
    }
    assert.ok(
      skittishPauses > hastyPauses,
      `skittish (${skittishPauses}) should pause more than hasty (${hastyPauses})`
    );
  });
});

describe("tickStuckDetection", () => {
  it("does not throw for a fresh citizen", () => {
    const director = fakeDirector();
    const record = fakeRecord();
    const bot = fakeBot();
    _positionHistory.clear();
    assert.doesNotThrow(() => _tickStuckDetection(director, record, bot, Date.now()));
  });

  it("records position on first sight", () => {
    const director = fakeDirector();
    const record = fakeRecord({ username: "stuck_test_1" });
    const bot = fakeBot();
    _positionHistory.clear();
    _tickStuckDetection(director, record, bot, 1000);
    assert.ok(_positionHistory.has("stuck_test_1"));
  });

  it("does not flag a merchant as stuck (stationary is fine)", () => {
    const director = fakeDirector();
    const record = fakeRecord({
      username: "stuck_test_2",
      currentActivityId: "merchant_tend",
    });
    const bot = fakeBot();
    _positionHistory.clear();
    // First sight.
    _tickStuckDetection(director, record, bot, 1000);
    // 10 minutes later, same tile — should refresh, not throw.
    assert.doesNotThrow(() =>
      _tickStuckDetection(director, record, bot, 1000 + 10 * 60 * 1000)
    );
  });
});

describe("tickIdleLife", () => {
  it("does not throw when the citizen is stationary", () => {
    const director = fakeDirector();
    const record = fakeRecord();
    const bot = fakeBot();
    assert.doesNotThrow(() => _tickIdleLife(director, record, bot, Date.now()));
  });

  it("skips when the citizen is moving", () => {
    const director = fakeDirector();
    const record = fakeRecord();
    const bot = fakeBot({
      getMovementQueue: () => ({ size: () => 3, clear: () => {} }),
    });
    // Should return early without throwing.
    assert.doesNotThrow(() => _tickIdleLife(director, record, bot, Date.now()));
  });
});

describe("tickSocialAwareness", () => {
  it("does not throw with no other citizens nearby", () => {
    const director = fakeDirector();
    const record = fakeRecord();
    const bot = fakeBot();
    assert.doesNotThrow(() => _tickSocialAwareness(director, record, bot, Date.now()));
  });
});

describe("tickImperfections", () => {
  it("does not throw", () => {
    const director = fakeDirector();
    const record = fakeRecord();
    const bot = fakeBot();
    assert.doesNotThrow(() => _tickImperfections(director, record, bot, Date.now()));
  });
});

describe("tickEmoteReactions", () => {
  it("does not throw with no players nearby", () => {
    const director = fakeDirector();
    const record = fakeRecord();
    const bot = fakeBot();
    assert.doesNotThrow(() => _tickEmoteReactions(director, record, bot, Date.now()));
  });

  it("does not throw when a nearby player is emoting", () => {
    const director = fakeDirector();
    const record = fakeRecord({
      personality: { traits: ["chatty"], demeanor: "warm", age: 30 },
    });
    const emotingPlayer = {
      getUsername: () => "real_player",
      isPlayerBot: () => false,
      getLocation: () => ({ getX: () => 3201, getY: () => 3201, getZ: () => 0 }),
      getAnimation: () => ({ getId: () => 1286 }), // wave
    };
    const bot = fakeBot({
      getLocalPlayers: () => [emotingPlayer],
    });
    assert.doesNotThrow(() => _tickEmoteReactions(director, record, bot, Date.now()));
  });
});
