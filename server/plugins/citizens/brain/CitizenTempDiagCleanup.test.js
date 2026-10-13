"use strict";

/**
 * TEMP-DIAG cleanup verification (Jon 2026-10-13): the decisionTick wiring
 * diagnostics were temporary. They are gone now, and the decision layer
 * they were proving must work exactly as before:
 *  - getDecisionWiring is no longer exported
 *  - no citizen_decision_tick_alive log line is ever emitted
 *  - initCitizenDecisions still installs the activity picker and the
 *    world.decisionTick hook (idempotent, null-safe)
 *  - decisionTick still gates, still staggers, still interrupts
 */

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const Decisions = require("./CitizenDecisions");
const {
  decisionTick,
  initCitizenDecisions,
  resetForTests,
  _interruptTarget,
  _nextDecisionAt,
} = Decisions;
const { ensureNeeds } = require("./CitizenNeeds");

let userSeq = 0;
function freshUser(prefix = "cleanup-test") {
  userSeq += 1;
  return `${prefix}-${userSeq}-${Date.now() % 100000}`;
}

function mockPlayer(opts = {}) {
  const username = opts.username ?? freshUser();
  const attrs = {
    "citizens:role": opts.role ?? "commoner",
    "citizens:personality": { traits: opts.traits ?? [] },
    "citizens:goal": opts.goal ?? null,
    "kingdom:id": opts.kingdomId ?? "asgarnia",
  };
  return {
    getUsername: () => username,
    getAttribute: (k) => attrs[k] ?? null,
    getLocation: () => ({
      getX: () => 2940,
      getY: () => 3360,
      getZ: () => 0,
    }),
    getInventory: () => ({
      getAmount: () => 0,
      getItems: () => [],
      getFreeSlots: () => 28,
      deleteNumber: () => {},
      adds: () => {},
    }),
    getLocalPlayers: () => [],
    getMovementQueue: () => ({ size: () => 0 }),
    getForceMovement: () => null,
    getHitpoints: () => opts.hp ?? 100,
    getSkillManager: () => ({ getMaxLevel: () => 100 }),
    getRunEnergy: () => 100,
    setRunEnergy: () => {},
    heal: () => {},
    forceChat: () => {},
    isPlayerBot: () => true,
  };
}

function mockBrain(logSpy, currentId, availableIds) {
  const logged = [];
  const brain = {
    logged,
    world: {
      log: (...args) => {
        logged.push(args);
        if (logSpy) logSpy(args);
      },
    },
    frames: [{ behaviour: { id: currentId ?? "citizen_routine" } }],
  };
  if (availableIds) {
    brain.registry = {
      listAvailable: () => availableIds.map((id) => ({ id })),
    };
  }
  return brain;
}

function setNeeds(username, { hp = 100, energy = 100, mood = 80 } = {}) {
  const needs = ensureNeeds(username);
  needs.hp = hp;
  needs.energy = energy;
  needs.mood = mood;
  return needs;
}

describe("TEMP-DIAG removal", () => {
  it("getDecisionWiring is no longer exported", () => {
    assert.equal(Decisions.getDecisionWiring, undefined);
    assert.ok(!Object.keys(Decisions).includes("getDecisionWiring"));
  });

  it("no wiringDiag state is exposed on the module", () => {
    const keys = Object.keys(Decisions).join(" ");
    assert.ok(!/wiring/i.test(keys), "no wiring keys in exports: " + keys);
  });

  it("decisionTick never emits the citizen_decision_tick_alive log line", () => {
    resetForTests();
    const p = mockPlayer();
    setNeeds(p.getUsername(), { hp: 100, energy: 100, mood: 80 });
    const b = mockBrain();
    decisionTick({ player: p, brain: b, nowMs: Date.now() });
    decisionTick({ player: p, brain: b, nowMs: Date.now() + 1000 });
    const aliveLines = b.logged.filter((a) => a[0] === "citizen_decision_tick_alive");
    assert.equal(aliveLines.length, 0);
  });

  it("resetForTests still clears state after TEMP-DIAG removal", () => {
    resetForTests();
    assert.doesNotThrow(() => resetForTests());
  });
});

describe("decision layer install (fresh module per test)", () => {
  // initCitizenDecisions guards on a module-level `initialized` flag, so each
  // install test needs a fresh module instance.
  const path = require("node:path");
  const modPath = path.join(__dirname, "CitizenDecisions.js");
  let D;
  let registry;

  beforeEach(() => {
    delete require.cache[require.resolve(modPath)];
    D = require(modPath);
    registry = { setActivityPicker: null, world: {} };
  });

  it("installs the activity picker", () => {
    let installed = null;
    registry.setActivityPicker = (fn) => { installed = fn; };
    D.initCitizenDecisions(registry);
    assert.equal(typeof installed, "function");
  });

  it("installs world.decisionTick", () => {
    D.initCitizenDecisions(registry);
    assert.equal(typeof registry.world.decisionTick, "function");
  });

  it("is idempotent", () => {
    let pickerCalls = 0;
    registry.setActivityPicker = () => { pickerCalls += 1; };
    D.initCitizenDecisions(registry);
    D.initCitizenDecisions(registry);
    assert.equal(pickerCalls, 1);
  });

  it("null/undefined registry does not throw", () => {
    assert.doesNotThrow(() => D.initCitizenDecisions(null));
    assert.doesNotThrow(() => D.initCitizenDecisions(undefined));
  });

  it("tolerates a registry without setActivityPicker", () => {
    assert.doesNotThrow(() => D.initCitizenDecisions({ world: {} }));
  });

  it("tolerates a registry without a world", () => {
    let installed = null;
    assert.doesNotThrow(() => D.initCitizenDecisions({ setActivityPicker: (fn) => { installed = fn; } }));
    assert.equal(typeof installed, "function");
  });
});

describe("decision layer behavior preserved", () => {
  beforeEach(() => {
    resetForTests();
  });

  it("decisionTick ignores missing player/brain", () => {
    assert.doesNotThrow(() => decisionTick({}));
    assert.doesNotThrow(() => decisionTick(null));
    assert.doesNotThrow(() => decisionTick(undefined));
  });

  it("decisionTick ignores non-citizen players", () => {
    const p = mockPlayer({ role: null });
    p.getAttribute = () => null; // no citizens:role -> not a citizen
    const b = mockBrain();
    assert.doesNotThrow(() => decisionTick({ player: p, brain: b }));
    assert.equal(b.logged.length, 0);
  });

  it("decisionTick stamps the stagger gate on first call", () => {
    const p = mockPlayer();
    setNeeds(p.getUsername(), { hp: 100, energy: 100, mood: 80 });
    const b = mockBrain();
    decisionTick({ player: p, brain: b, nowMs: 1_000_000 });
    assert.ok(
      _nextDecisionAt.has(p.getUsername()),
      "gate should be stamped for the citizen"
    );
  });

  it("interrupt path still fires for a hurt citizen", () => {
    const p = mockPlayer();
    setNeeds(p.getUsername(), { hp: 20, energy: 100, mood: 70 }); // hurt
    const ids = ["safetynet_wander", "citizen_meal", "citizen_chop"];
    const b = mockBrain(null, "citizen_chop", ids);
    const target = _interruptTarget(p, b, Date.now());
    assert.ok(target, "hurt citizen should get an interrupt target");
    assert.equal(target.reason, "hurt");
  });

  it("installed world.decisionTick delegates to decisionTick", () => {
    const path = require("node:path");
    const modPath = path.join(__dirname, "CitizenDecisions.js");
    delete require.cache[require.resolve(modPath)];
    const D = require(modPath);
    const registry = { world: {} };
    D.initCitizenDecisions(registry);
    const p = mockPlayer();
    setNeeds(p.getUsername(), { hp: 100, energy: 100, mood: 80 });
    const b = mockBrain();
    assert.doesNotThrow(() => registry.world.decisionTick({ player: p, brain: b, nowMs: 2_000_000 }));
    assert.ok(D._nextDecisionAt.has(p.getUsername()), "delegate must stamp the gate");
  });

  it("second immediate decisionTick call stays behind the stagger gate", () => {
    const p = mockPlayer();
    setNeeds(p.getUsername(), { hp: 100, energy: 100, mood: 80 });
    const b = mockBrain();
    const now = 3_000_000;
    decisionTick({ player: p, brain: b, nowMs: now });
    const gateAt = _nextDecisionAt.get(p.getUsername());
    assert.ok(gateAt > now, "gate must be set in the future");
    decisionTick({ player: p, brain: b, nowMs: now + 100 });
    assert.equal(_nextDecisionAt.get(p.getUsername()), gateAt, "gate must not move early");
  });

  it("decisionTick tolerates a brain without frames", () => {
    const p = mockPlayer();
    setNeeds(p.getUsername(), { hp: 100, energy: 100, mood: 80 });
    const b = { world: { log: () => {} } };
    assert.doesNotThrow(() => decisionTick({ player: p, brain: b, nowMs: Date.now() }));
  });

  it("decisionTick runs without TEMP-DIAG log noise for a fresh citizen", () => {
    const p = mockPlayer();
    setNeeds(p.getUsername(), { hp: 100, energy: 100, mood: 80 });
    const b = mockBrain();
    decisionTick({ player: p, brain: b, nowMs: Date.now() });
    const diagNoise = b.logged.filter(
      (a) => typeof a[0] === "string" && a[0].includes("decision_tick_alive")
    );
    assert.equal(diagNoise.length, 0);
  });
});

describe("CitizenMonitorApi TEMP-DIAG removal", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const src = fs.readFileSync(
    path.join(__dirname, "..", "..", "interface", "CitizenMonitorApi.js"),
    "utf8"
  );

  it("no decisionWiring references remain", () => {
    assert.ok(!src.includes("decisionWiring"), "decisionWiring must be gone");
  });

  it("no getDecisionWiring references remain", () => {
    assert.ok(!src.includes("getDecisionWiring"));
  });

  it("no TEMP-DIAG markers remain", () => {
    assert.ok(!src.includes("TEMP-DIAG"), "stale TEMP-DIAG comments must be gone");
  });

  it("public surface is unchanged (attach only)", () => {
    // CitizenMonitorApi requires the live director/engine, so assert the
    // surface statically: exactly one export, attach.
    assert.ok(src.includes("module.exports = { attach };"));
  });

  it("fake player debug endpoints are still present", () => {
    assert.ok(src.includes('getParam("fakePlayer")'));
    assert.ok(src.includes('getParam("clearFakePlayer")'));
  });

  it("tileCheck debug endpoint is still present", () => {
    assert.ok(src.includes('getParam("tileCheck")'));
  });
});
