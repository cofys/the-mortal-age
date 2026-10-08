"use strict";

/**
 * CitizenDecisions unit checks — the brain's decision layer.
 *
 * Pure scoring + picker + interrupt logic, no running server. Needs are
 * driven through the real CitizenNeeds registry (ensureNeeds + direct
 * mutation) so the tests prove the "drives FROM CitizenNeeds" contract.
 *
 * Timezone rule: no wall-clock-hour assertions (server-local time varies).
 */

const assert = require("node:assert/strict");

const {
  pick,
  scoreActivity,
  industriousness,
  sociabilityOf,
  decisionTick,
  resetForTests,
  CRITICAL_HUNGER,
  CRITICAL_ENERGY,
  _interruptTarget,
  _directedPick,
  _recentByUser,
  _nextDecisionAt,
} = require("./CitizenDecisions");
const { ensureNeeds, HUNGRY_AT, WEARY_AT } = require("./CitizenNeeds");

let userSeq = 0;
function freshUser() {
  userSeq += 1;
  return `decision-test-${userSeq}-${Date.now() % 100000}`;
}

/**
 * Mock citizen player. Needs live in the real CitizenNeeds registry keyed
 * by username — set them after construction via setNeeds().
 */
function mockPlayer(opts = {}) {
  const username = opts.username ?? freshUser();
  const attrs = {
    "citizens:role": opts.role ?? "commoner",
    "citizens:personality": { traits: opts.traits ?? [] },
    "citizens:goal": opts.goal ?? null,
    "kingdom:id": opts.kingdomId ?? "asgarnia",
  };
  const loc = {
    getX: () => opts.x ?? 2940,
    getY: () => opts.y ?? 3360,
    getZ: () => opts.z ?? 0,
  };
  const inventory = {
    getAmount: (id) => (id === 995 ? (opts.coins ?? 500) : 0),
    getItems: () => new Array(Math.max(0, 28 - (opts.freeSlots ?? 28))).fill({}),
    getFreeSlots: () => opts.freeSlots ?? 28,
  };
  return {
    getUsername: () => username,
    getAttribute: (k) => attrs[k] ?? null,
    getLocation: () => loc,
    getInventory: () => inventory,
    getLocalPlayers: () => opts.localPlayers ?? [],
    getMovementQueue: () => ({ size: () => 0 }),
    getForceMovement: () => null,
    forceChat: () => {},
    isPlayerBot: () => true,
  };
}

function setNeeds(username, { hunger = 100, energy = 100, mood = 80 } = {}) {
  const needs = ensureNeeds(username);
  needs.hunger = hunger;
  needs.energy = energy;
  needs.mood = mood;
  return needs;
}

function candidates(...ids) {
  return ids.map((id) => ({ id }));
}

// rng that never triggers the epsilon branch (0.99 > 0.15).
const noEpsilon = () => 0.99;
// rng that always triggers it, then rolls 0 for the weighted pick.
const forceEpsilon = (() => {
  let n = 0;
  return () => (n++ === 0 ? 0.01 : 0);
})();

function run(name, fn) {
  resetForTests();
  try {
    fn();
    console.log(`PASS: ${name}`);
  } catch (e) {
    console.error(`FAIL: ${name}\n  ${e.message}`);
    process.exitCode = 1;
  }
}

// --- scoring ---------------------------------------------------------------

run("hungry citizen picks meal", () => {
  const p = mockPlayer({ freeSlots: 28 });
  setNeeds(p.getUsername(), { hunger: 20, energy: 90, mood: 70 });
  const picked = pick(p, candidates("citizen_routine", "citizen_meal", "citizen_rest", "citizen_bank", "tavern_social"), Date.now(), noEpsilon);
  assert.equal(picked.id, "citizen_meal");
});

run("weary citizen picks rest", () => {
  const p = mockPlayer({ freeSlots: 28 });
  setNeeds(p.getUsername(), { hunger: 90, energy: 12, mood: 70 });
  const picked = pick(p, candidates("citizen_routine", "citizen_meal", "citizen_rest", "citizen_bank", "tavern_social"), Date.now(), noEpsilon);
  assert.equal(picked.id, "citizen_rest");
});

run("full inventory picks bank", () => {
  const p = mockPlayer({ freeSlots: 0 });
  setNeeds(p.getUsername(), { hunger: 90, energy: 90, mood: 70 });
  const picked = pick(p, candidates("citizen_routine", "citizen_meal", "citizen_rest", "citizen_bank", "tavern_social"), Date.now(), noEpsilon);
  assert.equal(picked.id, "citizen_bank");
});

run("broke + industrious picks work", () => {
  const p = mockPlayer({ coins: 10, traits: ["dutiful", "methodical"], freeSlots: 28 });
  setNeeds(p.getUsername(), { hunger: 90, energy: 90, mood: 70 });
  const picked = pick(p, candidates("citizen_routine", "tavern_social"), Date.now(), noEpsilon);
  assert.equal(picked.id, "citizen_routine");
});

run("starving beats everything (critical hunger)", () => {
  const p = mockPlayer({ coins: 10000, traits: ["dutiful"], freeSlots: 28 });
  setNeeds(p.getUsername(), { hunger: 5, energy: 90, mood: 70 });
  const mealScore = scoreActivity("citizen_meal", {
    hunger: 5, energy: 90, mood: 70, goal: null, personality: { traits: [] },
    coins: 10000, freeSlots: 28, nearby: 0, hour: 12,
  });
  const workScore = scoreActivity("citizen_routine", {
    hunger: 5, energy: 90, mood: 70, goal: null,
    personality: { traits: ["dutiful"] }, coins: 10000, freeSlots: 28, nearby: 0, hour: 12,
  });
  assert.ok(mealScore > workScore, `meal ${mealScore} should beat work ${workScore}`);
  assert.ok(mealScore > 90, "critical hunger scores near-max");
});

// --- personality changes picks ---------------------------------------------

run("personality changes social scoring (chatty vs taciturn)", () => {
  const base = { hunger: 90, energy: 90, mood: 70, goal: null, coins: 500, freeSlots: 28, nearby: 0, hour: 12 };
  const chatty = scoreActivity("tavern_social", { ...base, personality: { traits: ["chatty"] } });
  const taciturn = scoreActivity("tavern_social", { ...base, personality: { traits: ["taciturn"] } });
  assert.ok(chatty > taciturn, `chatty ${chatty} should outscore taciturn ${taciturn}`);
  assert.ok(chatty - taciturn > 10, "personality gap is meaningful");
});

run("industriousness ranks dutiful above daydreamer", () => {
  assert.ok(industriousness({ traits: ["dutiful", "methodical"] }) > industriousness({ traits: ["daydreamer"] }));
  assert.ok(sociabilityOf({ traits: ["chatty"] }) > sociabilityOf({ traits: ["gruff", "suspicious"] }));
});

// --- variety + epsilon ------------------------------------------------------

run("variety guard blocks the same pick 3x in a row", () => {
  const p = mockPlayer({ coins: 10, traits: ["dutiful"] }); // routine scores top
  setNeeds(p.getUsername(), { hunger: 90, energy: 90, mood: 70 });
  const cands = candidates("citizen_routine", "tavern_social");
  const first = pick(p, cands, Date.now(), noEpsilon);
  assert.equal(first.id, "citizen_routine");
  const second = pick(p, cands, Date.now() + 1, noEpsilon);
  assert.equal(second.id, "citizen_routine");
  const third = pick(p, cands, Date.now() + 2, noEpsilon);
  assert.equal(third.id, "tavern_social", "third consecutive routine must be vetoed");
});

run("epsilon-greedy sometimes picks non-best", () => {
  const p = mockPlayer({ freeSlots: 28 });
  setNeeds(p.getUsername(), { hunger: 90, energy: 90, mood: 70 });
  const cands = candidates("citizen_routine", "tavern_social", "citizen_bank");
  const picked = pick(p, cands, Date.now(), forceEpsilon);
  assert.notEqual(picked.id, "citizen_routine", "forced epsilon must avoid the greedy pick");
});

run("non-citizen picker returns null (base bots unaffected)", () => {
  const p = mockPlayer({});
  p.getAttribute = () => null; // no citizens:role
  const picked = pick(p, candidates("citizen_routine"), Date.now(), noEpsilon);
  assert.equal(picked, null);
});

run("empty candidates returns null", () => {
  const p = mockPlayer({});
  assert.equal(pick(p, [], Date.now(), noEpsilon), null);
});

// --- interrupts ---------------------------------------------------------------

function mockBrain(currentId, availableIds) {
  const acts = new Map(availableIds.map((id) => [id, { id }]));
  let ended = null;
  return {
    brain: {
      frames: [
        {
          behaviour: acts.get(currentId),
          action: () => ({ stop: () => {} }),
        },
      ],
      registry: {
        listAvailable: () => availableIds.map((id) => acts.get(id)),
      },
      context: () => ({}),
      endFrame: (frame, nowMs, failed) => {
        ended = { frame, nowMs, failed };
      },
    },
    get ended() {
      return ended;
    },
  };
}

run("critical hunger interrupts work -> meal (directed pick handoff)", () => {
  const p = mockPlayer({ role: "commoner" });
  setNeeds(p.getUsername(), { hunger: CRITICAL_HUNGER - 1, energy: 90, mood: 70 });
  const holder = mockBrain("citizen_routine", ["citizen_routine", "citizen_meal"]);
  const nowMs = Date.now();
  decisionTick({ player: p, brain: holder.brain, nowMs });
  assert.ok(holder.ended, "interrupt must end the current frame");
  assert.equal(_directedPick.get(p.getUsername()), "citizen_meal", "picker must be directed to meal");
  // The picker consumes the directed pick on the next assignment:
  const next = pick(p, candidates("citizen_routine", "citizen_meal"), nowMs + 1, noEpsilon);
  assert.equal(next.id, "citizen_meal");
});

run("critical energy interrupts work -> rest", () => {
  const p = mockPlayer({ role: "commoner" });
  setNeeds(p.getUsername(), { hunger: 90, energy: CRITICAL_ENERGY - 1, mood: 70 });
  const holder = mockBrain("citizen_routine", ["citizen_routine", "citizen_rest"]);
  decisionTick({ player: p, brain: holder.brain, nowMs: Date.now() });
  assert.ok(holder.ended, "interrupt must end the current frame");
  assert.equal(_directedPick.get(p.getUsername()), "citizen_rest");
});

run("no interrupt when needs are fine", () => {
  const p = mockPlayer({ role: "commoner", coins: 500 });
  setNeeds(p.getUsername(), { hunger: 90, energy: 90, mood: 70 });
  const holder = mockBrain("citizen_routine", ["citizen_routine", "tavern_social"]);
  decisionTick({ player: p, brain: holder.brain, nowMs: Date.now() });
  assert.equal(holder.ended, null, "comfortable citizen keeps working");
});

run("hysteresis: broke industrious citizen leaves the tavern for work", () => {
  const p = mockPlayer({ role: "commoner", coins: 5, traits: ["dutiful", "greedy"] });
  setNeeds(p.getUsername(), { hunger: 80, energy: 80, mood: 80 });
  const holder = mockBrain("tavern_social", ["citizen_routine", "tavern_social"]);
  decisionTick({ player: p, brain: holder.brain, nowMs: Date.now() });
  assert.ok(holder.ended, "much better work option should interrupt social");
  assert.equal(_directedPick.get(p.getUsername()), "citizen_routine");
});

run("decisionTick staggers (second immediate call is a no-op)", () => {
  const p = mockPlayer({ role: "commoner" });
  setNeeds(p.getUsername(), { hunger: CRITICAL_HUNGER - 1, energy: 90, mood: 70 });
  const holder = mockBrain("citizen_routine", ["citizen_routine", "citizen_meal"]);
  const nowMs = Date.now();
  decisionTick({ player: p, brain: holder.brain, nowMs });
  assert.ok(holder.ended, "first call interrupts");
  const holder2 = mockBrain("citizen_routine", ["citizen_routine", "citizen_meal"]);
  decisionTick({ player: p, brain: holder2.brain, nowMs: nowMs + 1000 });
  assert.equal(holder2.ended, null, "stagger must suppress the immediate re-decision");
  assert.ok((_nextDecisionAt.get(p.getUsername()) ?? 0) > nowMs, "next decision is scheduled");
});

run("decisionTick no-ops for non-citizens", () => {
  const p = mockPlayer({});
  p.getAttribute = () => null;
  const holder = mockBrain("some_bot_activity", ["some_bot_activity"]);
  decisionTick({ player: p, brain: holder.brain, nowMs: Date.now() });
  assert.equal(holder.ended, null);
});

// --- real destinations ---------------------------------------------------------
//
// The action modules pull BotNavigation (and the bank delegate pulls engine
// TS). Stub them in the require cache so plain-node tests stay engine-free;
// the stubs delegate through a mutable holder so each test sets its own spy.

const navStubHolder = {
  requestMovement: () => {},
  clearMovementRequest: () => {},
};
function stubNavigation() {
  const navPath = require.resolve("../../bots/behaviours/navigation/BotNavigation");
  require.cache[navPath] = {
    id: navPath,
    filename: navPath,
    loaded: true,
    exports: {
      requestMovement: (...args) => navStubHolder.requestMovement(...args),
      clearMovementRequest: (...args) => navStubHolder.clearMovementRequest(...args),
    },
  };
}
function stubBankDelegate() {
  const bankPath = require.resolve("../../bots/brain/actions/Bank");
  require.cache[bankPath] = {
    id: bankPath,
    filename: bankPath,
    loaded: true,
    exports: {
      createBankAction: () => ({ update: () => "running", stop: () => {} }),
    },
  };
}
stubNavigation();
stubBankDelegate();

function spyMovement() {
  let walkedTo = null;
  navStubHolder.requestMovement = (player, x, y, opts) => {
    walkedTo = { x, y, opts };
  };
  navStubHolder.clearMovementRequest = () => {};
  return () => walkedTo;
}

run("meal walks to the REAL market anchor, not an invented tile", () => {
  const getWalkedTo = spyMovement();
  const { createCitizenMealAction } = require("./actions/CitizenMeal");
  // Far from the Asgarnia market anchor (2945, 3369 per sites.json).
  const p = mockPlayer({ kingdomId: "asgarnia", x: 2900, y: 3300 });
  setNeeds(p.getUsername(), { hunger: 20, energy: 90, mood: 70 });
  const action = createCitizenMealAction({}, {});
  const result = action.update({ player: p, nowMs: Date.now(), state: {} });
  assert.equal(result, "running");
  const walkedTo = getWalkedTo();
  assert.ok(walkedTo, "must request movement toward the market");
  const cheb = Math.max(Math.abs(walkedTo.x - 2945), Math.abs(walkedTo.y - 3369));
  assert.ok(cheb <= 5, `walk target must be the real Asgarnia market (2945,3369), got ${walkedTo.x},${walkedTo.y}`);
  assert.equal(walkedTo.opts && walkedTo.opts.reason, "citizen_meal");
});

run("meal completes when fed (non-repeat hinge)", () => {
  const p = mockPlayer({ kingdomId: "asgarnia", x: 2945, y: 3369 }); // at the market
  setNeeds(p.getUsername(), { hunger: 95, energy: 90, mood: 70 });
  const { createCitizenMealAction } = require("./actions/CitizenMeal");
  const action = createCitizenMealAction({}, {});
  const result = action.update({ player: p, nowMs: Date.now(), state: {} });
  assert.equal(result, "success", "fed citizen finishes the meal immediately");
});

run("rest walks home (the citizen's real home tile)", () => {
  const getWalkedTo = spyMovement();
  const { createCitizenRestAction } = require("./actions/CitizenRest");
  const home = { x: 3000, y: 3400, z: 0 };
  const p = mockPlayer({ x: 2900, y: 3300 });
  setNeeds(p.getUsername(), { hunger: 90, energy: 10, mood: 70 });
  const action = createCitizenRestAction({}, {});
  const result = action.update({ player: p, nowMs: Date.now(), state: { home } });
  assert.equal(result, "running");
  const walkedTo = getWalkedTo();
  assert.ok(walkedTo, "must request movement toward home");
  const cheb = Math.max(Math.abs(walkedTo.x - home.x), Math.abs(walkedTo.y - home.y));
  assert.ok(cheb <= 5, `walk target must be the real home tile, got ${walkedTo.x},${walkedTo.y}`);
});

run("rest completes when rested", () => {
  const p = mockPlayer({ x: 3000, y: 3400 });
  setNeeds(p.getUsername(), { hunger: 90, energy: 80, mood: 70 });
  const { createCitizenRestAction } = require("./actions/CitizenRest");
  const action = createCitizenRestAction({}, {});
  const result = action.update({
    player: p,
    nowMs: Date.now(),
    state: { home: { x: 3000, y: 3400, z: 0 } },
  });
  assert.equal(result, "success", "rested citizen finishes the rest break");
});

run("bank walks to the REAL bank anchor", () => {
  const getWalkedTo = spyMovement();
  const { createCitizenBankAction } = require("./actions/CitizenBank");
  // Asgarnia bank anchor: 3012, 3355 per sites.json.
  const p = mockPlayer({ kingdomId: "asgarnia", x: 2900, y: 3300, freeSlots: 0 });
  const action = createCitizenBankAction({}, {});
  const result = action.update({ player: p, nowMs: Date.now(), state: {} });
  assert.equal(result, "running");
  const walkedTo = getWalkedTo();
  assert.ok(walkedTo, "must request movement toward the bank");
  const cheb = Math.max(Math.abs(walkedTo.x - 3012), Math.abs(walkedTo.y - 3355));
  assert.ok(cheb <= 5, `walk target must be the real Asgarnia bank (3012,3355), got ${walkedTo.x},${walkedTo.y}`);
});

// --- thresholds ---------------------------------------------------------------

run("threshold constants match CitizenNeeds", () => {
  assert.ok(CRITICAL_HUNGER < HUNGRY_AT, "critical hunger is below the hungry line");
  assert.ok(CRITICAL_ENERGY < WEARY_AT, "critical energy is below the weary line");
});

console.log("ALL CITIZENDECISIONS TESTS DONE");
