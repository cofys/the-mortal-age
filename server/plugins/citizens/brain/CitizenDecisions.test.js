"use strict";

/**
 * CitizenDecisions unit checks — the brain's decision layer.
 *
 * Pure scoring + picker + interrupt logic, no running server. Needs are
 * driven through the real CitizenNeeds registry (ensureNeeds + direct
 * mutation) so the tests prove the "drives FROM CitizenNeeds" contract.
 *
 * Jon's correction (2026-10-08): no hunger in RuneScape — food need is
 * HP-driven. Tests use hp (hitpoints percent), not hunger.
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
  CRITICAL_HP,
  CRITICAL_ENERGY,
  getPickDiag,
  queueDirectedPick,
  _interruptTarget,
  _directedPick,
  _recentByUser,
  _nextDecisionAt,
} = require("./CitizenDecisions");
const { ensureNeeds, HURT_AT, WEARY_AT } = require("./CitizenNeeds");

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
  const bread = opts.bread ?? 3;
  let hpCur = opts.hpAbs ?? 100;
  const hpMax = opts.hpMax ?? 100;
  let breadLeft = bread;
  const inventory = {
    getAmount: (id) => {
      if (id === 995) return opts.coins ?? 500;
      if (id === 2309) return breadLeft;
      return 0;
    },
    getItems: () => new Array(Math.max(0, 28 - (opts.freeSlots ?? 28))).fill({}),
    getFreeSlots: () => opts.freeSlots ?? 28,
    deleteNumber: (id, n) => { if (id === 2309) breadLeft = Math.max(0, breadLeft - n); },
    adds: () => {},
  };
  return {
    getUsername: () => username,
    getAttribute: (k) => attrs[k] ?? null,
    getLocation: () => loc,
    getInventory: () => inventory,
    getLocalPlayers: () => opts.localPlayers ?? [],
    getMovementQueue: () => ({ size: () => 0 }),
    getForceMovement: () => null,
    getHitpoints: () => hpCur,
    getSkillManager: () => ({ getMaxLevel: () => hpMax }),
    getRunEnergy: () => opts.runEnergy ?? 100,
    setRunEnergy: () => {},
    heal: (n) => { hpCur = Math.min(hpMax, hpCur + (n ?? 0)); },
    forceChat: () => {},
    isPlayerBot: () => true,
  };
}

function setNeeds(username, { hp = 100, energy = 100, mood = 80 } = {}) {
  const needs = ensureNeeds(username);
  needs.hp = hp;
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

run("hurt citizen picks meal (eat on the spot)", () => {
  const p = mockPlayer({ freeSlots: 28, bread: 3 });
  setNeeds(p.getUsername(), { hp: 50, energy: 90, mood: 70 });
  const picked = pick(p, candidates("citizen_routine", "citizen_meal", "citizen_rest", "citizen_bank", "tavern_social"), Date.now(), noEpsilon);
  assert.equal(picked.id, "citizen_meal");
});

run("full-HP citizen does NOT pick meal", () => {
  const p = mockPlayer({ freeSlots: 28, bread: 3 });
  setNeeds(p.getUsername(), { hp: 100, energy: 90, mood: 70 });
  const mealScore = scoreActivity("citizen_meal", {
    hp: 100, energy: 90, mood: 70, goal: null, personality: { traits: [] },
    coins: 500, food: 3, freeSlots: 28, nearby: 0, hour: 12,
  });
  assert.ok(mealScore < 10, `full HP should score meal near-zero, got ${mealScore}`);
});

run("weary citizen picks rest", () => {
  const p = mockPlayer({ freeSlots: 28 });
  setNeeds(p.getUsername(), { hp: 100, energy: 12, mood: 70 });
  const picked = pick(p, candidates("citizen_routine", "citizen_meal", "citizen_rest", "citizen_bank", "tavern_social"), Date.now(), noEpsilon);
  assert.equal(picked.id, "citizen_rest");
});

run("full inventory picks bank", () => {
  const p = mockPlayer({ freeSlots: 0 });
  setNeeds(p.getUsername(), { hp: 100, energy: 90, mood: 70 });
  const picked = pick(p, candidates("citizen_routine", "citizen_meal", "citizen_rest", "citizen_bank", "tavern_social"), Date.now(), noEpsilon);
  assert.equal(picked.id, "citizen_bank");
});

run("broke + industrious picks work", () => {
  const p = mockPlayer({ coins: 10, traits: ["dutiful", "methodical"], freeSlots: 28 });
  setNeeds(p.getUsername(), { hp: 100, energy: 90, mood: 70 });
  const picked = pick(p, candidates("citizen_routine", "tavern_social"), Date.now(), noEpsilon);
  assert.equal(picked.id, "citizen_routine");
});

run("critical HP beats everything", () => {
  const p = mockPlayer({ coins: 10000, traits: ["dutiful"], freeSlots: 28 });
  setNeeds(p.getUsername(), { hp: 20, energy: 90, mood: 70 });
  const mealScore = scoreActivity("citizen_meal", {
    hp: 20, energy: 90, mood: 70, goal: null, personality: { traits: [] },
    coins: 10000, food: 3, freeSlots: 28, nearby: 0, hour: 12,
  });
  const workScore = scoreActivity("citizen_routine", {
    hp: 20, energy: 90, mood: 70, goal: null,
    personality: { traits: ["dutiful"] }, coins: 10000, food: 3, freeSlots: 28, nearby: 0, hour: 12,
  });
  assert.ok(mealScore > workScore, `meal ${mealScore} should beat work ${workScore}`);
  assert.ok(mealScore > 90, "critical HP scores near-max");
});

// --- personality changes picks ---------------------------------------------

run("personality changes social scoring (chatty vs taciturn)", () => {
  const base = { hp: 100, energy: 90, mood: 70, goal: null, coins: 500, food: 3, freeSlots: 28, nearby: 0, hour: 12 };
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
  setNeeds(p.getUsername(), { hp: 100, energy: 90, mood: 70 });
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
  setNeeds(p.getUsername(), { hp: 100, energy: 90, mood: 70 });
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

run("critical HP interrupts work -> meal (directed pick handoff)", () => {
  const p = mockPlayer({ role: "commoner" });
  setNeeds(p.getUsername(), { hp: CRITICAL_HP - 1, energy: 90, mood: 70 });
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
  setNeeds(p.getUsername(), { hp: 100, energy: CRITICAL_ENERGY - 1, mood: 70 });
  const holder = mockBrain("citizen_routine", ["citizen_routine", "citizen_rest"]);
  decisionTick({ player: p, brain: holder.brain, nowMs: Date.now() });
  assert.ok(holder.ended, "interrupt must end the current frame");
  assert.equal(_directedPick.get(p.getUsername()), "citizen_rest");
});

run("no interrupt when needs are fine", () => {
  const p = mockPlayer({ role: "commoner", coins: 500 });
  setNeeds(p.getUsername(), { hp: 100, energy: 90, mood: 70 });
  const holder = mockBrain("citizen_routine", ["citizen_routine", "tavern_social"]);
  decisionTick({ player: p, brain: holder.brain, nowMs: Date.now() });
  assert.equal(holder.ended, null, "comfortable citizen keeps working");
});

run("hysteresis: broke industrious citizen leaves the tavern for work", () => {
  const p = mockPlayer({ role: "commoner", coins: 5, traits: ["dutiful", "greedy"] });
  setNeeds(p.getUsername(), { hp: 100, energy: 80, mood: 80 });
  const holder = mockBrain("tavern_social", ["citizen_routine", "tavern_social"]);
  decisionTick({ player: p, brain: holder.brain, nowMs: Date.now() });
  assert.ok(holder.ended, "much better work option should interrupt social");
  assert.equal(_directedPick.get(p.getUsername()), "citizen_routine");
});

run("decisionTick staggers (second immediate call is a no-op)", () => {
  const p = mockPlayer({ role: "commoner" });
  setNeeds(p.getUsername(), { hp: CRITICAL_HP - 1, energy: 90, mood: 70 });
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

// --- real destinations + anti-stacking ----------------------------------------
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

run("hurt citizen with food eats ON THE SPOT (no market walk)", () => {
  const getWalkedTo = spyMovement();
  const { createCitizenMealAction } = require("./actions/CitizenMeal");
  // Far from any market — should NOT walk there when food is on hand.
  // HP 50 -> needs 4 bread (5 HP each) to reach HURT_AT 70; give 5.
  const p = mockPlayer({ kingdomId: "asgarnia", x: 2900, y: 3300, bread: 5, hpAbs: 50, hpMax: 100 });
  const action = createCitizenMealAction({}, {});
  let result = "running";
  for (let i = 0; i < 10 && result === "running"; i++) {
    result = action.update({ player: p, nowMs: Date.now() + i * 1000, state: {} });
  }
  assert.equal(result, "success", "eating on the spot completes");
  assert.equal(getWalkedTo(), null, "must NOT request movement when food is in inventory");
});

run("hurt citizen WITHOUT food walks to a personal market spot", () => {
  const getWalkedTo = spyMovement();
  const { createCitizenMealAction } = require("./actions/CitizenMeal");
  const p = mockPlayer({ kingdomId: "asgarnia", x: 2900, y: 3300, bread: 0, hpAbs: 50, hpMax: 100 });
  const action = createCitizenMealAction({}, {});
  const result = action.update({ player: p, nowMs: Date.now(), state: {} });
  assert.equal(result, "running");
  const walkedTo = getWalkedTo();
  assert.ok(walkedTo, "must request movement toward the market for resupply");
  // Asgarnia market anchor (2945,3369): personal spot within 4-10 tiles.
  const cheb = Math.max(Math.abs(walkedTo.x - 2945), Math.abs(walkedTo.y - 3369));
  assert.ok(cheb >= 2 && cheb <= 12, `walk target must be a spread spot near the market, got ${walkedTo.x},${walkedTo.y} (cheb ${cheb})`);
});

run("full-HP citizen skips the meal entirely", () => {
  const p = mockPlayer({ kingdomId: "asgarnia", x: 2945, y: 3369, hpAbs: 100, hpMax: 100 });
  setNeeds(p.getUsername(), { hp: 100, energy: 90, mood: 70 });
  const { createCitizenMealAction } = require("./actions/CitizenMeal");
  const action = createCitizenMealAction({}, {});
  const result = action.update({ player: p, nowMs: Date.now(), state: {} });
  assert.equal(result, "success", "full HP finishes the meal immediately");
});

run("bank walks to a PERSONAL spot near the real bank anchor (anti-stack)", () => {
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
  assert.ok(cheb >= 2 && cheb <= 12, `walk target must be a spread spot near the bank, got ${walkedTo.x},${walkedTo.y}`);
});

run("two citizens get DIFFERENT bank spots (spread)", () => {
  const { personalSpot } = require("../lib/humanizer");
  const a = personalSpot("Alice Test", 3012, 3355, 4, 10);
  const b = personalSpot("Bob Test", 3012, 3355, 4, 10);
  const cheb = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  assert.ok(cheb > 0, `different citizens must get different spots, got ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
});

run("personalSpot is stable per citizen", () => {
  const { personalSpot } = require("../lib/humanizer");
  const a1 = personalSpot("Alice Test", 3012, 3355, 4, 10);
  const a2 = personalSpot("Alice Test", 3012, 3355, 4, 10);
  assert.deepEqual(a1, a2, "same citizen must always get the same spot");
});

run("rest walks home with personal offset", () => {
  const getWalkedTo = spyMovement();
  const { createCitizenRestAction } = require("./actions/CitizenRest");
  const home = { x: 3000, y: 3400, z: 0 };
  const p = mockPlayer({ x: 2900, y: 3300, username: "rest-test-user" });
  setNeeds(p.getUsername(), { hp: 100, energy: 10, mood: 70 });
  const action = createCitizenRestAction({}, {});
  const result = action.update({ player: p, nowMs: Date.now(), state: { home } });
  assert.equal(result, "running");
  const walkedTo = getWalkedTo();
  assert.ok(walkedTo, "must request movement toward home");
  const cheb = Math.max(Math.abs(walkedTo.x - home.x), Math.abs(walkedTo.y - home.y));
  assert.ok(cheb <= 5, `walk target must be near the real home tile, got ${walkedTo.x},${walkedTo.y}`);
});

run("rest completes when rested", () => {
  const p = mockPlayer({ x: 3000, y: 3400 });
  setNeeds(p.getUsername(), { hp: 100, energy: 80, mood: 70 });
  const { createCitizenRestAction } = require("./actions/CitizenRest");
  const action = createCitizenRestAction({}, {});
  const result = action.update({
    player: p,
    nowMs: Date.now(),
    state: { home: { x: 3000, y: 3400, z: 0 } },
  });
  assert.equal(result, "success", "rested citizen finishes the rest break");
});

// --- kingdom resource profiles (phase 3) -----------------------------------------
// Jon's directive: "some kingdoms naturally have more of something" — the
// citizen's kingdom shapes WHAT work they pick, at tie-breaker scale.

run("keldagrim citizen scores mining above woodcutting, all else equal", () => {
  const base = {
    hp: 100, energy: 90, mood: 70, goal: null, personality: { traits: [] },
    coins: 500, freeSlots: 28, nearby: 0, hour: 12,
    logs: 20, herbs: 5, seeds: 5, rawFood: 20,
  };
  const mine = scoreActivity("citizen_mine", { ...base, kingdomId: "keldagrim" });
  const chop = scoreActivity("citizen_chop", { ...base, kingdomId: "keldagrim" });
  assert.ok(mine > chop, `keldagrim mine ${mine} should beat chop ${chop}`);
  // The profile's own contribution: +8 mining (surplus), -4 chop (deficit).
  assert.equal(mine - scoreActivity("citizen_mine", base), 8, "keldagrim mine bonus");
  assert.equal(chop - scoreActivity("citizen_chop", base), -4, "keldagrim chop penalty");
});

run("kandarin citizen scores woodcutting above mining, all else equal", () => {
  const base = {
    hp: 100, energy: 90, mood: 70, goal: null, personality: { traits: [] },
    coins: 500, freeSlots: 28, nearby: 0, hour: 12,
    logs: 20, herbs: 5, seeds: 5, rawFood: 20,
  };
  const chop = scoreActivity("citizen_chop", { ...base, kingdomId: "kandarin" });
  const mine = scoreActivity("citizen_mine", { ...base, kingdomId: "kandarin" });
  assert.ok(chop > mine, `kandarin chop ${chop} should beat mine ${mine}`);
  // The profile's own contribution: +8 chop (surplus), -4 mine (deficit).
  assert.equal(chop - scoreActivity("citizen_chop", base), 8, "kandarin chop bonus");
  assert.equal(mine - scoreActivity("citizen_mine", base), -4, "kandarin mine penalty");
});

run("morytania citizen scores herb gathering above mining, all else equal", () => {
  const base = {
    hp: 100, energy: 90, mood: 70, goal: null, personality: { traits: [] },
    coins: 500, freeSlots: 28, nearby: 0, hour: 12,
    logs: 20, herbs: 5, seeds: 5, rawFood: 20, kingdomId: "morytania",
  };
  const herb = scoreActivity("citizen_herb", base);
  const mine = scoreActivity("citizen_mine", base);
  assert.ok(herb > mine, `morytania herb ${herb} should beat mine ${mine}`);
});

run("asgarnia citizen scores farming above woodcutting, all else equal", () => {
  const base = {
    hp: 100, energy: 90, mood: 70, goal: null, personality: { traits: [] },
    coins: 500, freeSlots: 28, nearby: 0, hour: 12,
    logs: 20, herbs: 5, seeds: 5, rawFood: 20, kingdomId: "asgarnia",
  };
  const farm = scoreActivity("citizen_farm", base);
  const chop = scoreActivity("citizen_chop", base);
  assert.ok(farm > chop, `asgarnia farm ${farm} should beat chop ${chop}`);
  // Asgarnia also has a limestone surplus: mining is honest work there too.
  const mine = scoreActivity("citizen_mine", base);
  assert.ok(mine > chop, `asgarnia mine ${mine} should beat chop ${chop} (limestone surplus)`);
});

run("deficit work is a nudge, not a lock: kandarin citizen can still mine", () => {
  const base = {
    hp: 100, energy: 90, mood: 70, goal: null, personality: { traits: [] },
    coins: 500, freeSlots: 28, nearby: 0, hour: 12,
    logs: 20, herbs: 5, seeds: 5, rawFood: 20, kingdomId: "kandarin",
  };
  const mine = scoreActivity("citizen_mine", base);
  assert.ok(mine > 20, `kandarin mine ${mine} must stay viable work, not forbidden`);
});

run("kingdom profile bonus is smaller than critical-need penalties", () => {
  const base = {
    hp: 100, energy: 90, mood: 70, goal: null, personality: { traits: [] },
    coins: 500, freeSlots: 28, nearby: 0, hour: 12,
    logs: 20, herbs: 5, seeds: 5, rawFood: 20,
  };
  const kelda = scoreActivity("citizen_mine", { ...base, kingdomId: "keldagrim" });
  const kanda = scoreActivity("citizen_mine", { ...base, kingdomId: "kandarin" });
  const gap = kelda - kanda;
  assert.ok(gap > 0 && gap <= 20, `kingdom gap ${gap} must be tie-breaker scale`);
});

run("no kingdom on the snap scores neutrally (backwards compatible)", () => {
  const base = {
    hp: 100, energy: 90, mood: 70, goal: null, personality: { traits: [] },
    coins: 500, freeSlots: 28, nearby: 0, hour: 12,
    logs: 20, herbs: 5, seeds: 5, rawFood: 20,
  };
  const mine = scoreActivity("citizen_mine", base);
  assert.equal(mine, 44, `no-kingdom mine should score the bare 44, got ${mine}`);
});

// --- prayer hinge scoring --------------------------------------------------------

run("empty prayer bar scores the prayer hinge high", () => {
  const base = {
    hp: 100, energy: 90, mood: 70, goal: null, personality: { traits: [] },
    coins: 500, freeSlots: 28, nearby: 0, hour: 12,
    prayer: { points: 5, max: 50, bones: 0 },
  };
  const s = scoreActivity("citizen_prayer", base);
  assert.ok(s > 40, `empty bar should score high, got ${s}`);
});

run("bones in the pack score the prayer hinge (bury them)", () => {
  const base = {
    hp: 100, energy: 90, mood: 70, goal: null, personality: { traits: [] },
    coins: 500, freeSlots: 28, nearby: 0, hour: 12,
    prayer: { points: 50, max: 50, bones: 6 },
  };
  const s = scoreActivity("citizen_prayer", base);
  assert.ok(s >= 30, `bones should score the hinge, got ${s}`);
});

run("full bar and no bones: prayer hinge stays quiet", () => {
  const base = {
    hp: 100, energy: 90, mood: 70, goal: null, personality: { traits: [] },
    coins: 500, freeSlots: 28, nearby: 0, hour: 12,
    prayer: { points: 50, max: 50, bones: 0 },
  };
  assert.ok(scoreActivity("citizen_prayer", base) < 12, "quiet when nothing to do");
});

run("prayer 1 citizens never pray", () => {
  const base = {
    hp: 100, energy: 90, mood: 70, goal: null, personality: { traits: [] },
    coins: 500, freeSlots: 28, nearby: 0, hour: 12,
    prayer: { points: 0, max: 1, bones: 5 },
  };
  assert.equal(scoreActivity("citizen_prayer", base), 2, "prayer 1: nothing to do");
});

run("devout citizens detour for prayer more eagerly", () => {
  const base = {
    hp: 100, energy: 90, mood: 70, goal: null,
    coins: 500, freeSlots: 28, nearby: 0, hour: 12,
    prayer: { points: 20, max: 50, bones: 0 },
  };
  const devout = scoreActivity("citizen_prayer", { ...base, personality: { traits: ["devout"] } });
  const plain = scoreActivity("citizen_prayer", { ...base, personality: { traits: [] } });
  assert.ok(devout > plain, `devout ${devout} should beat plain ${plain}`);
});

// --- thresholds ---------------------------------------------------------------

run("threshold constants match CitizenNeeds", () => {
  assert.ok(CRITICAL_HP < HURT_AT, "critical HP is below the hurt line");
  assert.ok(CRITICAL_ENERGY < WEARY_AT, "critical energy is below the weary line");
});

// --- 2026-10-13: wanderer re-decide regressions --------------------------------
// Root cause: scoreActivity("citizen_digguild") / ("citizen_stageguild")
// threw ReferenceError (digguild/stageguild not destructured, file is
// "use strict"). Both activities require role commoner, so EVERY commoner's
// pick() threw (no pickDiag, registry sticky-random fallback pinned them on
// their spawn activity) and interruptTarget's margin loop threw (decisionTick
// swallowed it: no interrupts, macro re-decide unreachable).

run("digguild/stageguild scorers do not throw and return numbers", () => {
  const base = {
    hp: 100, energy: 90, mood: 70, goal: null, personality: { traits: [] },
    coins: 500, freeSlots: 28, nearby: 0, hour: 12, kingdomId: "misthalin",
  };
  for (const id of ["citizen_digguild", "citizen_stageguild"]) {
    let s;
    assert.doesNotThrow(() => { s = scoreActivity(id, base); }, `${id} must not throw`);
    assert.equal(typeof s, "number", `${id} must score a number`);
  }
});

run("pick() survives guild candidates: commoner gets a real scored pick + diag", () => {
  const p = mockPlayer({ role: "commoner", coins: 500, traits: ["industrious"] });
  setNeeds(p.getUsername(), { hp: 100, energy: 100, mood: 80 });
  const ids = ["safetynet_wander", "citizen_chop", "citizen_mine", "citizen_fish", "citizen_digguild", "citizen_stageguild"];
  let picked;
  assert.doesNotThrow(() => {
    picked = pick(p, candidates(...ids), Date.now(), noEpsilon);
  }, "pick must not throw when guild candidates are present");
  assert.ok(picked && ids.includes(picked.id), "must return a candidate");
  const diag = getPickDiag(p.getUsername());
  assert.ok(diag, "pickDiag must be stamped");
  assert.equal(diag.chosen, picked.id);
});

run("interrupt margin path fires for a healthy wanderer with guild candidates present", () => {
  const p = mockPlayer({ role: "commoner", coins: 500, traits: ["industrious"] });
  setNeeds(p.getUsername(), { hp: 100, energy: 100, mood: 80 });
  const ids = ["safetynet_wander", "citizen_chop", "citizen_mine", "citizen_fish", "citizen_digguild", "citizen_stageguild"];
  const holder = mockBrain("safetynet_wander", ids);
  let target;
  assert.doesNotThrow(() => {
    target = _interruptTarget(p, holder.brain, Date.now());
  }, "interruptTarget must not throw");
  assert.ok(target, "healthy wanderer near work must be interrupted");
  assert.notEqual(target.activity.id, "safetynet_wander");
});

run("macro re-decide is reachable even when the margin path declines", () => {
  // Weary citizen on wander: work scores tank, wander (12) is the static
  // best == current, so the margin path declines every gate. The macro
  // branch (every 10th gate) must still run pick() — previously it sat
  // below the best===current early return and was dead code.
  const p = mockPlayer({ role: "commoner", coins: 500, traits: [] });
  setNeeds(p.getUsername(), { hp: 100, energy: 5, mood: 80 });
  const ids = ["safetynet_wander", "citizen_chop", "citizen_mine"];
  const holder = mockBrain("safetynet_wander", ids);
  const now0 = Date.now();
  let firedMargin = false;
  for (let g = 0; g < 10; g++) {
    const t = _interruptTarget(p, holder.brain, now0 + g * 35000);
    if (t) { firedMargin = true; break; }
  }
  assert.ok(!firedMargin, "margin path should decline for the weary wanderer");
  const diag = getPickDiag(p.getUsername());
  assert.ok(diag, "macro re-decide must have run pick() by the 10th gate (pickDiag stamped)");
});

run("directed picks stamp pickDiag (spawn/interrupt kicks are decisions too)", () => {
  const p = mockPlayer({ role: "commoner" });
  setNeeds(p.getUsername(), { hp: 100, energy: 100, mood: 80 });
  // First pick fires resetForTests' forced hourly prune (lastPruneAt=0);
  // queue the directed pick after so it survives to the consume.
  pick(p, candidates("safetynet_wander", "citizen_chop"), Date.now(), noEpsilon);
  queueDirectedPick(p.getUsername(), "citizen_chop");
  const picked = pick(p, candidates("safetynet_wander", "citizen_chop"), Date.now() + 1, noEpsilon);
  assert.equal(picked.id, "citizen_chop");
  const diag = getPickDiag(p.getUsername());
  assert.ok(diag, "directed pick must stamp pickDiag");
  assert.equal(diag.chosen, "citizen_chop");
  assert.equal(diag.directed, true);
});

console.log("ALL CITIZENDECISIONS TESTS DONE");
