"use strict";

/**
 * CitizenDecisions — the brain's decision layer (model doc build steps 1+2).
 *
 * The engine existed but wasn't connected: CitizenNeeds ticked hp/energy/
 * mood, goals and personalities existed, the activity registry picked
 * sticky-random. This module connects them:
 *
 *   1. pick(player, candidates, nowMs) — installed as the registry's activity
 *      picker. Scores every candidate from goals + CitizenNeeds + inventory
 *      state + social context + personality, then epsilon-greedy picks with a
 *      variety guard (never the same activity 3x in a row).
 *   2. decisionTick({player, state, brain, nowMs}) — installed as the brain
 *      world's decisionTick hook. Staggered per citizen (~25-45s): interrupts
 *      the current activity for critical needs (badly hurt/exhausted),
 *      otherwise re-decides with hysteresis when a much better activity
 *      beckons.
 *
 * There is no hunger in RuneScape — food need is HP-driven (eat when hurt),
 * energy is run energy. Drives FROM CitizenNeeds — there is no parallel
 * needs system here.
 * Near-zero dead time: activities end into assignNext -> pick, and interrupts
 * fire within one decision cadence. No long cooldowns anywhere — needs are
 * the pacing. Zero LLM in this path: all arithmetic.
 *
 * Director interplay (deliberate): the director's 60s tick re-asserts its
 * wall-clock phase via record.currentActivityId, which this module does NOT
 * update on interrupt. That staleness is load-bearing — it stops the schedule
 * from clobbering a needs-driven meal/rest/bank within the same hour. When
 * the phase genuinely changes (e.g. evening tavern time), the director wins
 * and the decision layer re-evaluates from the new activity; critical needs
 * always re-interrupt. Do not "fix" the staleness without replacing this
 * contract.
 *
 * Two-tier safe: every entry point no-ops for non-citizens (no citizens:role
 * attribute) and every public function is try/catch-guarded by its caller.
 */

const {
  needsFor,
  hpPercent,
  breadCount,
  HURT_AT,
  WEARY_AT,
} = require("./CitizenNeeds");
const {
  ATTR_CITIZEN_ROLE,
  ATTR_CITIZEN_PERSONALITY,
  ATTR_CITIZEN_GOAL,
} = require("../constants");
const {
  GOAL_SAVE_GOLD,
  GOAL_RANK_UP,
  GOAL_MASTER_TRADE,
  GOAL_BOSS_SLAYER,
  GOAL_MAKE_FRIENDS,
} = require("../lib/goals");
const { hashSeed, agentRng } = require("../lib/humanizer");
const { tickIntents, intentBonusFor } = require("./CitizenIntents");

const COINS_ID = 995;
const INVENTORY_SIZE = 28;

// Critical need thresholds — these ALWAYS interrupt, whatever the citizen
// is doing (a badly hurt guard leaves the patrol; players do the same).
// There is no hunger in RuneScape: food need is HP-driven.
const CRITICAL_HP = 30;
const CRITICAL_ENERGY = 10;

// Non-critical re-decision needs the winner to beat the current activity by
// this margin, or citizens thrash between close options.
const SWITCH_MARGIN = 15;
// Minimum gap between non-critical interrupts for one citizen.
const INTERRUPT_COOLDOWN_MS = 90 * 1000;
// Per-citizen decision cadence: 25-45s, hash-staggered so the population
// doesn't decide in lockstep.
const DECISION_MIN_MS = 25 * 1000;
const DECISION_JITTER_MS = 20 * 1000;
// Epsilon-greedy: this often, pick a non-best option (variety, not noise).
const EPSILON = 0.15;
const EPSILON_DAYDREAMER = 0.28;

// Activity ids this module knows how to score. Anything else from the
// registry gets a neutral default so new JSON activities don't break.
const ACT_ROUTINE = "citizen_routine";
const ACT_MEAL = "citizen_meal";
const ACT_REST = "citizen_rest";
const ACT_BANK = "citizen_bank";
const ACT_SOCIAL = "tavern_social";
const ACT_MINE = "citizen_mine";
// Repeat:true "anchor" activities — the only ones eligible for hysteresis
// re-decision. Short activities (meal/rest/bank) complete on their own.
const ANCHOR_ACTIVITIES = new Set([
  ACT_ROUTINE,
  ACT_SOCIAL,
  "guard_patrol",
  "merchant_tend",
  "prime_merchant",
  "courtier_attend",
  "leisure_stroll",
  "refugee_flight",
  ACT_MINE,
]);

const MEAL_ROLES = new Set(["commoner", "merchant", "guard", "courtier"]);
const REST_ROLES = new Set(["commoner", "merchant", "guard", "courtier"]);
const BANK_ROLES = new Set(["commoner", "merchant", "guard", "courtier"]);

/** username -> [recent activity ids], newest last (variety guard). */
const recentByUser = new Map();
/** username -> ms of next allowed decision evaluation. */
const nextDecisionAt = new Map();
/** username -> activity id the picker must take next (interrupt handoff). */
const directedPick = new Map();
/** username -> ms of last non-critical interrupt. */
const lastInterruptAt = new Map();
let lastPruneAt = 0;

function pruneState(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) {
    return;
  }
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const map of [recentByUser, nextDecisionAt, directedPick, lastInterruptAt]) {
    for (const [k, v] of map) {
      const at = typeof v === "number" ? v : 0;
      if (at < cutoff) {
        map.delete(k);
      }
    }
  }
}

function usernameOf(player) {
  try {
    return player?.getUsername?.() ?? null;
  } catch {
    return null;
  }
}

function isCitizen(player) {
  try {
    const role = player?.getAttribute?.(ATTR_CITIZEN_ROLE);
    return typeof role === "string" && role.length > 0;
  } catch {
    return false;
  }
}

function traitSet(personality) {
  return new Set(personality?.traits ?? []);
}

function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}

/** 0..1 — dutiful/methodical/greedy citizens work harder and longer. */
function industriousness(personality) {
  const t = traitSet(personality);
  let s = 0.5;
  if (t.has("dutiful")) s += 0.2;
  if (t.has("methodical")) s += 0.15;
  if (t.has("greedy")) s += 0.15;
  if (t.has("daydreamer")) s -= 0.15;
  if (t.has("easygoing")) s -= 0.1;
  return clamp01(s);
}

/** 0..1 — chatty citizens seek company; taciturn ones avoid it. */
function sociabilityOf(personality) {
  const t = traitSet(personality);
  let s = 0.5;
  if (t.has("chatty")) s += 0.25;
  if (t.has("cheerful")) s += 0.1;
  if (t.has("taciturn")) s -= 0.25;
  if (t.has("gruff")) s -= 0.15;
  if (t.has("suspicious")) s -= 0.15;
  return clamp01(s);
}

function coinCount(player) {
  try {
    return player?.getInventory?.()?.getAmount?.(COINS_ID) ?? 0;
  } catch {
    return 0;
  }
}

function foodCount(player) {
  try {
    return breadCount(player);
  } catch {
    return 0;
  }
}

function freeSlots(player) {
  try {
    const inv = player?.getInventory?.();
    if (typeof inv?.getFreeSlots === "function") {
      return inv.getFreeSlots();
    }
    const items = inv?.getItems?.() ?? [];
    return Math.max(0, INVENTORY_SIZE - items.length);
  } catch {
    return INVENTORY_SIZE;
  }
}

function nearbyCount(player) {
  try {
    return (player?.getLocalPlayers?.() ?? []).length;
  } catch {
    return 0;
  }
}

/**
 * Cheap read-only snapshot of everything the scorer needs. needsFor is a Map
 * lookup against the director-ticked CitizenNeeds registry — never created
 * here (the director owns need lifecycle).
 */
function snapshot(player) {
  const needs = needsFor(player);
  let goal = null;
  let personality = {};
  try {
    goal = player?.getAttribute?.(ATTR_CITIZEN_GOAL) ?? null;
    personality = player?.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
  } catch {
    // Attributes unreadable — score with defaults.
  }
  return {
    hp: needs ? needs.hp : 100,
    energy: needs ? needs.energy : 100,
    mood: needs ? needs.mood : 80,
    goal,
    personality,
    coins: coinCount(player),
    food: foodCount(player),
    freeSlots: freeSlots(player),
    nearby: nearbyCount(player),
    hour: new Date().getHours(), // server-local, per the timezone rule
  };
}

function goalUrgency(goal) {
  if (!goal || typeof goal.target !== "number" || goal.target <= 0) {
    return 0;
  }
  const ratio = (goal.progress ?? 0) / goal.target;
  return ratio < 0.4 ? 1 : 0;
}

/**
 * Utility 0..100 for one candidate activity. Pure arithmetic on the snapshot —
 * no rng here, so scoring is deterministic and testable.
 */
function scoreActivity(activityId, snap) {
  const { hp, energy, mood, goal, personality, coins, food, freeSlots, nearby, hour } = snap;
  const industrious = industriousness(personality);
  const sociable = sociabilityOf(personality);
  const goalType = goal?.type ?? null;
  const urgent = goalUrgency(goal);
  const hurt = hp < HURT_AT;
  const weary = energy < WEARY_AT;
  const criticalHp = hp < CRITICAL_HP;
  const exhausted = energy < CRITICAL_ENERGY;

  switch (activityId) {
    case ACT_ROUTINE: {
      // Work: the commoner's living. Broke + industrious citizens grind;
      // the weary stay away until rested. Hurt citizens eat first.
      let s = 45;
      if (goalType === GOAL_MASTER_TRADE) s += 18;
      else if (goalType === GOAL_SAVE_GOLD) s += 14;
      else if (goalType === GOAL_RANK_UP) s += 4;
      else if (goalType === GOAL_BOSS_SLAYER) s -= 8;
      else if (goalType === GOAL_MAKE_FRIENDS) s -= 12;
      s += urgent * 8;
      s += industrious * 14;
      if (coins < 60) s += 22;
      else if (coins < 250) s += 8;
      if (weary) s -= 55;
      if (hurt) s -= 30;
      if (mood < 20) s -= 8;
      if (freeSlots <= 2) s += 10; // full inventory: the routine's bank leg handles it
      return s;
    }
    case ACT_MEAL: {
      // No hunger in RuneScape — eat when HP is low, from inventory, on the
      // spot. No food and hurt? Still go (the eat activity resupplies).
      if (!hurt) return 4;
      let s = 58 + (HURT_AT - hp) * 1.1;
      if (food <= 0) s += 10; // out of food and hurt: resupply is urgent
      return s;
    }
    case ACT_REST: {
      if (!weary) return 4;
      return 58 + (WEARY_AT - energy) * 1.3;
    }
    case ACT_BANK: {
      // The inventory clock: a full pack forces the hinge trip.
      let s = 6;
      if (freeSlots <= 2) s = 70;
      else if (freeSlots <= 6) s = 40;
      if (goalType === GOAL_MASTER_TRADE || goalType === GOAL_SAVE_GOLD) s += 10;
      if (criticalHp || exhausted) s -= 40;
      return s;
    }
    case ACT_SOCIAL: {
      let s = 18 + sociable * 22;
      if (mood < 40) s += 14;
      if (hour >= 17 || hour <= 1) s += 8; // evenings are tavern time
      if (goalType === GOAL_MAKE_FRIENDS) s += 18;
      if (nearby >= 3) s += 6; // a crowd is already there
      if (hp < 50) s -= 25;
      if (energy < 15) s -= 25;
      return s;
    }
    case "guard_patrol":
    case "merchant_tend":
    case "prime_merchant": {
      // Role work: this IS the job for guards and merchants.
      let s = 52 + industrious * 10;
      if (goalType === GOAL_RANK_UP || goalType === GOAL_BOSS_SLAYER) s += 8;
      if (goalType === GOAL_SAVE_GOLD) s += 8;
      if (goalType === GOAL_MAKE_FRIENDS) s -= 10;
      if (coins < 60) s += 12;
      if (criticalHp || exhausted) s -= 70; // critical needs beat duty
      else if (hurt) s -= 20;
      else if (weary) s -= 30;
      return s;
    }
    case "courtier_attend":
    case "leisure_stroll": {
      let s = 40 + sociable * 15;
      if (criticalHp || exhausted) s -= 70;
      return s;
    }
    case "refugee_flight": {
      let s = 55;
      if (exhausted) s -= 40;
      return s;
    }
    case ACT_MINE: {
      // Mining: ore for the smiths, coins for the miner. Industrious
      // citizens with a trade goal pick up the pickaxe. Like the routine,
      // it's work — the weary and hurt stay away.
      let s = 38;
      if (goalType === GOAL_MASTER_TRADE) s += 16;
      else if (goalType === GOAL_SAVE_GOLD) s += 12;
      s += urgent * 6;
      s += industrious * 12;
      if (coins < 60) s += 18;
      else if (coins < 250) s += 6;
      if (weary) s -= 50;
      if (hurt) s -= 25;
      if (freeSlots <= 2) s += 8; // full: bank hinge handles it
      return s;
    }
    default:
      return 30; // unknown future activity: neutral, never breaks
  }
}

function recordPick(username, activityId) {
  if (!username || !activityId) {
    return;
  }
  const recent = recentByUser.get(username) ?? [];
  recent.push(activityId);
  while (recent.length > 6) {
    recent.shift();
  }
  recentByUser.set(username, recent);
}

/** Variety guard: never the same activity 3 picks in a row. */
function violatesVariety(username, activityId) {
  const recent = recentByUser.get(username) ?? [];
  return (
    recent.length >= 2 &&
    recent[recent.length - 1] === activityId &&
    recent[recent.length - 2] === activityId
  );
}

/**
 * Registry picker: score every candidate, epsilon-greedy pick with the
 * variety guard. Returns a candidate or null (null = default brain choice).
 * rng is injectable for deterministic tests.
 */
function pick(player, candidates, nowMs = Date.now(), rng = Math.random) {
  if (!isCitizen(player) || !Array.isArray(candidates) || candidates.length === 0) {
    return null;
  }
  const username = usernameOf(player);
  pruneState(nowMs);

  // The interrupt path may direct the next pick (consumed once).
  if (username) {
    const directedId = directedPick.get(username);
    if (directedId) {
      directedPick.delete(username);
      const directed = candidates.find((a) => a?.id === directedId);
      if (directed) {
        recordPick(username, directed.id);
        return directed;
      }
    }
  }

  const snap = snapshot(player);
  const scored = candidates
    .filter((a) => a && typeof a.id === "string")
    .map((a) => ({
      activity: a,
      // Session intents steer the pick: a citizen with "earn 2000 coins"
      // scores work higher. Capped so intents never override critical needs.
      score: scoreActivity(a.id, snap) + intentBonusFor(a.id, player),
    }))
    .sort((x, y) => y.score - x.score);
  if (scored.length === 0) {
    return null;
  }

  const traits = traitSet(snap.personality);
  const epsilon = traits.has("daydreamer") ? EPSILON_DAYDREAMER : EPSILON;
  let chosen = scored[0].activity;
  if (scored.length > 1 && rng() < epsilon) {
    // Non-greedy pick: weighted by score among the runners-up.
    const rest = scored.slice(1);
    const total = rest.reduce((sum, e) => sum + Math.max(1, e.score), 0);
    let roll = rng() * total;
    for (const entry of rest) {
      roll -= Math.max(1, entry.score);
      if (roll <= 0) {
        chosen = entry.activity;
        break;
      }
    }
  }
  if (username && violatesVariety(username, chosen.id)) {
    const alt = scored.find((e) => e.activity.id !== chosen.id);
    if (alt) {
      chosen = alt.activity;
    }
  }
  recordPick(username, chosen.id);
  return chosen;
}

/**
 * Where the interrupt wants to go, if anywhere. Critical needs always win;
 * otherwise hysteresis against the current anchor activity.
 */
function interruptTarget(player, brain, nowMs) {
  const username = usernameOf(player);
  const frames = brain?.frames ?? [];
  const frame = frames[frames.length - 1];
  const currentId = frame?.behaviour?.id ?? null;
  if (!currentId) {
    return null; // idle brain: assignNext -> pick handles it
  }
  let candidates = [];
  try {
    candidates =
      brain?.registry?.listAvailable?.(player, nowMs) ??
      brain?.registry?.activities ??
      [];
  } catch {
    return null;
  }
  const byId = new Map(candidates.filter((a) => a?.id).map((a) => [a.id, a]));
  const role = player?.getAttribute?.(ATTR_CITIZEN_ROLE);

  const snap = snapshot(player);
  // Critical needs: interrupt whatever they're doing (with a short
  // re-arm guard so a failed meal doesn't spin).
  if (snap.hp < CRITICAL_HP && currentId !== ACT_MEAL && MEAL_ROLES.has(role)) {
    const target = byId.get(ACT_MEAL);
    if (target) {
      return { activity: target, reason: "hurt" };
    }
  }
  if (snap.energy < CRITICAL_ENERGY && currentId !== ACT_REST && REST_ROLES.has(role)) {
    const target = byId.get(ACT_REST);
    if (target) {
      return { activity: target, reason: "exhausted" };
    }
  }
  // Only anchor (repeat) activities get hysteresis re-decision; short
  // activities (meal/rest/bank) complete on their own.
  if (!ANCHOR_ACTIVITIES.has(currentId)) {
    return null;
  }
  const lastInterrupt = lastInterruptAt.get(username) ?? 0;
  if (nowMs - lastInterrupt < INTERRUPT_COOLDOWN_MS) {
    return null;
  }
  let best = null;
  let bestScore = -Infinity;
  for (const activity of candidates) {
    const s = scoreActivity(activity.id, snap);
    if (s > bestScore) {
      bestScore = s;
      best = activity;
    }
  }
  if (!best || best.id === currentId) {
    return null;
  }
  const currentScore = scoreActivity(currentId, snap);
  if (bestScore > currentScore + SWITCH_MARGIN) {
    return { activity: best, reason: "better" };
  }
  return null;
}

function doInterrupt(player, brain, target, nowMs, critical) {
  const username = usernameOf(player);
  const frames = brain?.frames ?? [];
  const frame = frames[frames.length - 1];
  if (!frame) {
    return false;
  }
  try {
    // Stop the current action cleanly (clears movement requests etc.),
    // then pop the frame. endFrame's assignNext -> pickActivity -> pick
    // consumes the directed pick below.
    const ctx = brain.context(frame, nowMs);
    frame.action()?.stop?.(ctx);
  } catch {
    // A broken stop never blocks the interrupt.
  }
  if (username) {
    directedPick.set(username, target.activity.id);
    if (!critical) {
      lastInterruptAt.set(username, nowMs);
    }
  }
  try {
    brain.endFrame(frame, nowMs, false);
  } catch {
    if (username) {
      directedPick.delete(username);
    }
    return false;
  }
  return true;
}

/**
 * Brain-world hook (world.decisionTick), called from BotBrain.tick after
 * supportTick. Staggered per citizen; cheap gates first. Interrupts on
 * critical needs or a much better activity, then returns — the frame switch
 * below in tick() picks up whatever the interrupt installed.
 */
function decisionTick(args) {
  const { player, brain, nowMs = Date.now() } = args ?? {};
  if (!player || !brain || !isCitizen(player)) {
    return;
  }
  const username = usernameOf(player);
  pruneState(nowMs);
  // Session intents tick BEFORE the stagger gate: the first call after
  // materialize is the "login with a plan" moment and must not wait up to
  // 45s. Sampling itself is cheap (Map lookups + a few inventory reads).
  try {
    tickIntents(player, brain, nowMs);
  } catch {
    // Intent failures never break the decision layer.
  }
  // Stagger: each citizen re-evaluates every ~25-45s, not every brain tick.
  if (username) {
    const nextAt = nextDecisionAt.get(username) ?? 0;
    if (nowMs < nextAt) {
      return;
    }
    const stagger = DECISION_MIN_MS + (hashSeed(username) % DECISION_JITTER_MS);
    nextDecisionAt.set(username, nowMs + stagger);
  }
  let target = null;
  try {
    target = interruptTarget(player, brain, nowMs);
  } catch {
    return;
  }
  if (!target) {
    return;
  }
  const critical = target.reason === "hurt" || target.reason === "exhausted";
  try {
    doInterrupt(player, brain, target, nowMs, critical);
  } catch {
    // Never break the brain tick.
  }
}

/**
 * Plugin init: installs the picker on the shared registry and the
 * decisionTick hook on the shared brain world. Idempotent.
 */
let initialized = false;
function initCitizenDecisions(registry) {
  if (initialized || !registry) {
    return;
  }
  initialized = true;
  try {
    if (typeof registry.setActivityPicker === "function") {
      registry.setActivityPicker((player, candidates, nowMs) =>
        pick(player, candidates, nowMs)
      );
    }
  } catch {
    // The picker is an enhancement; the brain works without it.
  }
  try {
    const world = registry.world;
    if (world && !world.decisionTick) {
      world.decisionTick = (args) => decisionTick(args);
    }
  } catch {
    // Same: enhancement only.
  }
}

/** Test seam: clear all per-citizen decision state. */
function resetForTests() {
  recentByUser.clear();
  nextDecisionAt.clear();
  directedPick.clear();
  lastInterruptAt.clear();
  lastPruneAt = 0;
}

module.exports = {
  ACT_ROUTINE,
  ACT_MINE,
  ACT_MEAL,
  ACT_REST,
  ACT_BANK,
  ACT_SOCIAL,
  CRITICAL_HP,
  CRITICAL_ENERGY,
  SWITCH_MARGIN,
  EPSILON,
  initCitizenDecisions,
  decisionTick,
  pick,
  scoreActivity,
  snapshot,
  industriousness,
  sociabilityOf,
  resetForTests,
  // Test seams (not part of the public contract):
  _interruptTarget: interruptTarget,
  _directedPick: directedPick,
  _recentByUser: recentByUser,
  _nextDecisionAt: nextDecisionAt,
};
