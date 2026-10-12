"use strict";

/**
 * CitizenAlive.test.js — unit tests for the alive layer.
 * Run with: node --test server/plugins/citizens/lib/CitizenAlive.test.js
 * (from the repo root; uses node:test, no external deps)
 */

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

// Stub BotNavigation before CitizenAlive loads: the real module needs the
// engine runtime, and the alive layer's internal requestMovement try/catches
// its require. The stub records movement requests for assertions.
const navPath = require.resolve("../../bots/behaviours/navigation/BotNavigation");
const navCalls = [];
require.cache[navPath] = {
  id: navPath,
  filename: navPath,
  loaded: true,
  exports: {
    requestMovement: (bot, x, y, opts) => {
      navCalls.push({ x, y, opts });
      return true;
    },
    peekMovementRequest: () => null,
    dispatchMovementRequest: () => null,
    clearMovementRequest: () => {},
  },
};

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
  _tickIdleMicrobehaviors,
  _isMicroIdle,
  _microState,
  microDriftIntervalMs,
  microFaceIntervalMs,
  pickFaceTarget,
  faceToward,
  MICRO_DRIFT_MIN_MS,
  MICRO_DRIFT_MAX_MS,
  MICRO_FACE_MIN_MS,
  MICRO_FACE_MAX_MS,
  MICRO_DRIFT_RADIUS,
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
    face: () => {}, // legacy no-op: Player bots have no `face` method
    setPositionToFaceCoordinates: function (x, y, z) {
      this._faced = this._faced ?? [];
      this._faced.push({ x, y, z });
    },
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

describe("playAnim — 2026-10-08 playtest crash regression", () => {
  const { _playAnim } = require("./CitizenAlive");

  function directorWithAnim() {
    return {
      api: {
        core: {
          Animation: class {
            constructor(id) { this.id = id; }
            getId() { return this.id; }
            getDelay() { return 0; }
            getPriority() { return 0; }
          },
        },
      },
    };
  }

  it("passes a real Animation object (with getId/getDelay), never a raw id", () => {
    let received = null;
    const bot = fakeBot({ performAnimation: (a) => { received = a; } });
    const ok = _playAnim(directorWithAnim(), bot, 861);
    assert.equal(ok, true);
    assert.equal(typeof received.getId, "function", "must have getId()");
    assert.equal(typeof received.getDelay, "function", "must have getDelay()");
    assert.equal(received.getId(), 861);
    // The exact shape PlayerSession.createActorUpdates reads:
    assert.doesNotThrow(() => ({ id: received.getId(), delay: received.getDelay() }));
  });

  it("returns false and never touches the bot when the engine Animation class is unavailable", () => {
    let called = false;
    const bot = fakeBot({ performAnimation: () => { called = true; } });
    const ok = _playAnim({ api: { core: {} } }, bot, 861);
    assert.equal(ok, false);
    assert.equal(called, false);
  });
});

describe("microDriftIntervalMs — personality-scaled drift cooldown", () => {
  it("stays near 45-90s for a default citizen", () => {
    const lo = microDriftIntervalMs({ tempoSigma: 0.7 }, () => 0);
    const hi = microDriftIntervalMs({ tempoSigma: 0.7 }, () => 0.999);
    assert.equal(lo, MICRO_DRIFT_MIN_MS);
    assert.ok(hi < MICRO_DRIFT_MAX_MS, `hi=${hi} within 90s`);
  });

  it("restless (fidgety) citizens drift more often than methodical ones", () => {
    const rng = () => 0.5;
    const fidgety = microDriftIntervalMs({ tempoSigma: 1.0 }, rng);
    const normal = microDriftIntervalMs({ tempoSigma: 0.7 }, rng);
    const methodical = microDriftIntervalMs({ tempoSigma: 0.45 }, rng);
    assert.ok(fidgety < normal, `fidgety ${fidgety} < normal ${normal}`);
    assert.ok(normal < methodical, `normal ${normal} < methodical ${methodical}`);
  });
});

describe("microFaceIntervalMs — facing-change cooldown", () => {
  it("stays within 20-40s", () => {
    assert.equal(microFaceIntervalMs(() => 0), MICRO_FACE_MIN_MS);
    const hi = microFaceIntervalMs(() => 0.999);
    assert.ok(hi >= MICRO_FACE_MIN_MS && hi <= MICRO_FACE_MAX_MS, `hi=${hi}`);
  });
});

describe("pickFaceTarget — where idle citizens look", () => {
  const my = { x: 100, y: 100, z: 0 };

  it("faces a nearby point of interest when the roll favors it", () => {
    const pois = [{ x: 105, y: 102, z: 0 }];
    const seq = [0.2, 0.0]; // POI branch, then index 0
    let i = 0;
    const t = pickFaceTarget(() => seq[i++ % seq.length], my, pois);
    assert.deepEqual(t, pois[0]);
  });

  it("faces a random nearby direction when there is nothing to look at", () => {
    const t = pickFaceTarget(() => 0, my, []);
    const d = Math.max(Math.abs(t.x - my.x), Math.abs(t.y - my.y));
    assert.ok(d >= 1 && d <= 2, `direction offset ${d} is 1-2 tiles`);
  });
});

describe("_isMicroIdle — the strict idle gate", () => {
  function directorWithBrain(frames) {
    return {
      roster: new Map(),
      isOnline: () => true,
      getBot: () => null,
      log: () => {},
      runtime: () => ({
        entriesByUsername: new Map([
          ["test_citizen", { brain: { frames } }],
        ]),
      }),
    };
  }

  it("true for a plain idle citizen with no brain activity", () => {
    assert.equal(_isMicroIdle(fakeDirector(), fakeRecord(), fakeBot()), true);
  });

  it("true when the brain exists but has no activity frames (idle brain)", () => {
    const d = directorWithBrain([]);
    assert.equal(_isMicroIdle(d, fakeRecord(), fakeBot()), true);
  });

  it("false while the bot is already moving", () => {
    const bot = fakeBot({
      getMovementQueue: () => ({ size: () => 1, clear: () => {} }),
    });
    assert.equal(_isMicroIdle(fakeDirector(), fakeRecord(), bot), false);
  });

  it("false when the brain has an active activity frame", () => {
    const d = directorWithBrain([{ behaviour: { id: "citizen_fishing" } }]);
    assert.equal(_isMicroIdle(d, fakeRecord(), fakeBot()), false);
  });

  it("false while in a conversation", () => {
    const CC = require("../chat/CitizenConversations");
    const orig = CC.activeConversationFor;
    CC.activeConversationFor = () => true;
    try {
      assert.equal(_isMicroIdle(fakeDirector(), fakeRecord(), fakeBot()), false);
    } finally {
      CC.activeConversationFor = orig;
    }
  });

  it("false while following someone", () => {
    const Bonds = require("./CitizenBonds");
    Bonds.setFollow("test_citizen", "some_player", "test");
    try {
      assert.equal(_isMicroIdle(fakeDirector(), fakeRecord(), fakeBot()), false);
    } finally {
      Bonds.clearFollow("test_citizen");
    }
  });

  it("false while in combat", () => {
    const bot = fakeBot({
      getCombat: () => ({ getTarget: () => ({}), getAttacker: () => null }),
    });
    assert.equal(_isMicroIdle(fakeDirector(), fakeRecord(), bot), false);
  });

  it("false while trading", () => {
    const bot = fakeBot({
      getTrading: () => ({ getState: () => ({ isTrading: () => true }) }),
    });
    assert.equal(_isMicroIdle(fakeDirector(), fakeRecord(), bot), false);
  });
});

describe("_tickIdleMicrobehaviors — drift and facing", () => {
  beforeEach(() => {
    _microState.clear();
    navCalls.length = 0;
  });

  it("anchors on the first idle tick and schedules drift + face", () => {
    const bot = fakeBot();
    const out = _tickIdleMicrobehaviors(fakeDirector(), fakeRecord(), bot, 1000);
    const st = _microState.get("test_citizen");
    assert.ok(st, "per-citizen state created");
    assert.deepEqual(st.anchor, { x: 3200, y: 3200, z: 0 });
    assert.ok(
      st.driftAt >= 1000 + MICRO_DRIFT_MIN_MS * 0.65 &&
        st.driftAt <= 1000 + MICRO_DRIFT_MAX_MS * 1.6,
      `driftAt=${st.driftAt} is ~45-90s out (personality-scaled)`
    );
    assert.ok(
      st.faceAt >= 1000 + MICRO_FACE_MIN_MS && st.faceAt <= 1000 + MICRO_FACE_MAX_MS,
      `faceAt=${st.faceAt} is 20-40s out`
    );
    assert.equal(out.faced, true, "faces immediately on first idle tick");
  });

  it("drifts within 3 tiles of the anchor when the cooldown expires", () => {
    const bot = fakeBot();
    const d = fakeDirector();
    _tickIdleMicrobehaviors(d, fakeRecord(), bot, 1000);
    const st = _microState.get("test_citizen");
    navCalls.length = 0;
    const out = _tickIdleMicrobehaviors(d, fakeRecord(), bot, st.driftAt + 1);
    assert.equal(navCalls.length, 1, "one drift movement requested");
    const { x, y, opts } = navCalls[0];
    const dist = Math.max(Math.abs(x - 3200), Math.abs(y - 3200));
    assert.ok(dist <= MICRO_DRIFT_RADIUS, `drift target ${dist} tiles from anchor (<=3)`);
    assert.equal(opts.reason, "citizen_idle_drift");
    assert.ok(out.drifted, "reports the drift target");
  });

  it("does not drift again before the cooldown elapses", () => {
    const bot = fakeBot();
    const d = fakeDirector();
    _tickIdleMicrobehaviors(d, fakeRecord(), bot, 1000);
    navCalls.length = 0;
    const out = _tickIdleMicrobehaviors(d, fakeRecord(), bot, 1001);
    assert.equal(navCalls.length, 0, "no movement before the cooldown");
    assert.equal(out.drifted, null);
  });

  it("yields immediately when the brain picks an activity", () => {
    const bot = fakeBot();
    _tickIdleMicrobehaviors(fakeDirector(), fakeRecord(), bot, 1000);
    assert.ok(_microState.has("test_citizen"), "state exists while idle");
    const busy = {
      roster: new Map(),
      isOnline: () => true,
      getBot: () => null,
      log: () => {},
      runtime: () => ({
        entriesByUsername: new Map([
          ["test_citizen", { brain: { frames: [{ behaviour: { id: "citizen_fishing" } }] } }],
        ]),
      }),
    };
    navCalls.length = 0;
    const out = _tickIdleMicrobehaviors(busy, fakeRecord(), bot, 2000);
    assert.deepEqual(out, { drifted: null, faced: false });
    assert.equal(navCalls.length, 0, "no movement while busy");
    assert.ok(!_microState.has("test_citizen"), "anchor state dropped on yield");
  });

  it("never drifts while following — the gate holds inside the tick", () => {
    const Bonds = require("./CitizenBonds");
    Bonds.setFollow("test_citizen", "some_player", "test");
    try {
      const out = _tickIdleMicrobehaviors(fakeDirector(), fakeRecord(), fakeBot(), 1000);
      assert.deepEqual(out, { drifted: null, faced: false });
      assert.equal(navCalls.length, 0);
    } finally {
      Bonds.clearFollow("test_citizen");
    }
  });
});

describe("faceToward — real engine facing (2026-10-11: bot.face was a no-op)", () => {
  function facedBot() {
    const b = fakeBot();
    const faced = [];
    b.setPositionToFaceCoordinates = (x, y, z) => {
      faced.push({ x, y, z });
    };
    b._faced = faced;
    return b;
  }

  it("issues setPositionToFaceCoordinates toward the target tile", () => {
    const b = facedBot();
    const ok = faceToward(b, { x: 3205, y: 3200, z: 0 });
    assert.equal(ok, true);
    assert.deepEqual(b._faced, [{ x: 3205, y: 3200, z: 0 }]);
  });

  it("does nothing when the target is the current tile", () => {
    const b = facedBot();
    const ok = faceToward(b, { x: 3200, y: 3200, z: 0 });
    assert.equal(ok, false);
    assert.equal(b._faced.length, 0);
  });

  it("returns false when the bot lacks the engine facing API", () => {
    const b = fakeBot();
    delete b.setPositionToFaceCoordinates; // legacy/no-engine bot shape
    assert.equal(faceToward(b, { x: 3205, y: 3200 }), false);
  });

  it("returns false on null target", () => {
    const b = facedBot();
    assert.equal(faceToward(b, null), false);
    assert.equal(b._faced.length, 0);
  });
});

describe("tickImperfections — pause-and-scan distraction", () => {
  // Find a timestamp whose seeded rng fires the distraction branch
  // (first rng draw of tickImperfections). Deterministic, not flaky.
  function distractionNowMs() {
    const { agentRng } = require("./humanizer");
    for (let t = 1; t < 100000; t += 997) {
      const rng = agentRng(`alive:imperfect:test_citizen:${t >> 13}`);
      if (rng() < 0.06) return t;
    }
    throw new Error("no distraction timestamp found");
  }

  it("distraction stops the walk AND turns toward something (pause-and-scan)", () => {
    const faced = [];
    let cleared = false;
    const b = fakeBot({
      getMovementQueue: () => ({
        size: () => 3,
        clear: () => {
          cleared = true;
        },
      }),
      setPositionToFaceCoordinates: (x, y, z) => {
        faced.push({ x, y, z });
      },
      getLocalPlayers: () => [], // unwatched: no speech, pure movement
    });
    const nowMs = distractionNowMs();
    assert.doesNotThrow(() => _tickImperfections(fakeDirector(), fakeRecord(), b, nowMs));
    assert.equal(cleared, true, "movement queue cleared on distraction");
    assert.ok(faced.length >= 1, "citizen turns to look at something while paused");
  });
});
