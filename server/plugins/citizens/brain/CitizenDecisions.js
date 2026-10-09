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
const ACT_LIGHT_FIRE = "citizen_light_fire";
const ACT_SMELT = "citizen_smelt";
const ACT_CRAFT = "citizen_craft";
const ACT_COOK = "citizen_cook";
const ACT_HERB = "citizen_herb";
const ACT_FLETCH = "citizen_fletch";
const ACT_RC = "citizen_rc";
const ACT_AGILITY = "citizen_agility";
const ACT_SLAYER = "citizen_slayer";
const ACT_HUNT = "citizen_hunt";
const ACT_FARM = "citizen_farm";
const ACT_THIEVE = "citizen_thieve";
const ACT_BUILD = "citizen_build";
// Patch types the citizen_farm circuit works (mirrors CitizenFarm.js).
const FARM_PATCH_TYPES = ["HERB", "ALLOTMENT", "FLOWER"];
const ACT_SOCIAL = "tavern_social";
const ACT_MINE = "citizen_mine";
const ACT_CHOP = "citizen_chop";
// Work activities — the ones sickness keeps citizens away from. Meal,
// rest, bank, and social are NOT work: a sick citizen still eats, rests,
// banks, and complains to friends about feeling awful.
const WORK_ACTIVITIES = new Set([
  ACT_ROUTINE,
  ACT_LIGHT_FIRE,
  ACT_SMELT,
  ACT_CRAFT,
  ACT_COOK,
  ACT_HERB,
  ACT_FLETCH,
  ACT_RC,
  ACT_AGILITY,
  ACT_SLAYER,
  ACT_HUNT,
  ACT_FARM,
  ACT_THIEVE,
  ACT_MINE,
  ACT_CHOP,
]);
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
  ACT_CHOP,
  ACT_FARM,
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

/** Count of burnable logs in the inventory (firemaking fuel). */
function logCount(player) {
  try {
    const Firemaking = require("../../skills/Firemaking.plugin");
    if (typeof Firemaking?.isWoodcuttingLog !== "function") return 0;
    let n = 0;
    for (const item of player?.getInventory?.()?.getItems?.() ?? []) {
      let id = 0;
      try {
        id = item?.getId?.() ?? 0;
      } catch {
        continue;
      }
      if (id > 0 && Firemaking.isWoodcuttingLog(id)) n++;
    }
    return n;
  } catch {
    return 0;
  }
}

/** Bars the citizen could smelt right now (inventory ore, else bank ore). */
function smeltableBars(player) {
  try {
    const Smithing = require("../../skills/Smithing.plugin");
    const recipes = Smithing?.SMELTING_RECIPES;
    if (!Array.isArray(recipes) || !recipes.length) return 0;
    const inv = player?.getInventory?.();
    const invAmount = (id) => {
      try {
        return inv?.getAmount?.(id) ?? 0;
      } catch {
        return 0;
      }
    };
    const bankAmount = (id) => {
      let total = 0;
      try {
        for (let tab = 0; tab < 8; tab++) {
          const bank = player?.getBank?.(tab);
          if (!bank) continue;
          const slot = bank.getSlotForItemId?.(id) ?? -1;
          if (slot < 0) continue;
          const stack = bank.getItems?.()[slot];
          if (!stack || stack.getId?.() !== id) continue;
          total += stack.getAmount?.() ?? 0;
        }
      } catch {
        // treat as empty
      }
      return total;
    };
    const barsFrom = (recipe, useBank) => {
      let bars = Number.MAX_SAFE_INTEGER;
      for (const [itemId, perBar] of recipe.ingredients ?? []) {
        if (!Number.isInteger(itemId) || !Number.isInteger(perBar) || perBar <= 0)
          return 0;
        const have = invAmount(itemId) + (useBank ? bankAmount(itemId) : 0);
        bars = Math.min(bars, Math.floor(have / perBar));
      }
      return bars === Number.MAX_SAFE_INTEGER ? 0 : bars;
    };
    // Inventory first (no trip needed), then bank.
    let best = 0;
    for (const recipe of recipes) best = Math.max(best, barsFrom(recipe, false));
    if (best > 0) return best;
    for (const recipe of recipes) best = Math.max(best, barsFrom(recipe, true));
    return best;
  } catch {
    return 0;
  }
}

/** Uncut gems the citizen could cut right now (inventory, else bank). */
function gemCount(player) {
  try {
    const Crafting = require("../../skills/Crafting.plugin");
    const recipes = Crafting?.CRAFTING_RECIPES;
    if (!Array.isArray(recipes) || !recipes.length) return 0;
    const inv = player?.getInventory?.();
    const invAmount = (id) => {
      try {
        return inv?.getAmount?.(id) ?? 0;
      } catch {
        return 0;
      }
    };
    const bankAmount = (id) => {
      let total = 0;
      try {
        for (let tab = 0; tab < 8; tab++) {
          const bank = player?.getBank?.(tab);
          if (!bank) continue;
          const slot = bank.getSlotForItemId?.(id) ?? -1;
          if (slot < 0) continue;
          const stack = bank.getItems?.()[slot];
          if (!stack || stack.getId?.() !== id) continue;
          total += stack.getAmount?.() ?? 0;
        }
      } catch {
        // treat as empty
      }
      return total;
    };
    // Inventory first (no trip needed), then bank.
    let invTotal = 0;
    for (const recipe of recipes) invTotal += invAmount(recipe.uncutId);
    if (invTotal > 0) return invTotal;
    let bankTotal = 0;
    for (const recipe of recipes) bankTotal += bankAmount(recipe.uncutId);
    return bankTotal;
  } catch {
    return 0;
  }
}

/** The citizen's Thieving level (1 when unreadable — bakery stalls only). */
function thiefLevel(player) {
  try {
    const Thieving = require("../../skills/Thieving.plugin");
    if (Thieving?.thievingLevel) return Thieving.thievingLevel(player);
  } catch {
    // fall through
  }
  return 1;
}

/** The citizen's Construction level (1 when unreadable — crude chairs only). */
function constructLevel(player) {
  try {
    const Construction = require("../../skills/Construction.plugin");
    if (Construction?.constructionLevel)
      return Construction.constructionLevel(player);
  } catch {
    // fall through
  }
  return 1;
}

/**
 * Furniture builds the citizen could make right now: best level-gated
 * recipe's achievable count from pack materials (no trip needed), else
 * from pack + bank combined.
 */
function buildCount(player) {
  try {
    const Construction = require("../../skills/Construction.plugin");
    const recipes = Construction?.CONSTRUCTION_RECIPES;
    if (!Array.isArray(recipes) || !recipes.length) return 0;
    const level = constructLevel(player);
    const inv = player?.getInventory?.();
    const invAmount = (id) => {
      try {
        return inv?.getAmount?.(id) ?? 0;
      } catch {
        return 0;
      }
    };
    const bankAmount = (id) => {
      let total = 0;
      try {
        for (let tab = 0; tab < 8; tab++) {
          const bank = player?.getBank?.(tab);
          if (!bank) continue;
          const slot = bank.getSlotForItemId?.(id) ?? -1;
          if (slot < 0) continue;
          const stack = bank.getItems?.()[slot];
          if (!stack || stack.getId?.() !== id) continue;
          total += stack.getAmount?.() ?? 0;
        }
      } catch {
        // treat as empty
      }
      return total;
    };
    const buildsFrom = (recipe, useBank) => {
      let builds = Number.MAX_SAFE_INTEGER;
      for (const [itemId, perBuild] of recipe.materials ?? []) {
        if (!Number.isInteger(itemId) || !Number.isInteger(perBuild) || perBuild <= 0)
          return 0;
        const have = invAmount(itemId) + (useBank ? bankAmount(itemId) : 0);
        builds = Math.min(builds, Math.floor(have / perBuild));
      }
      return builds === Number.MAX_SAFE_INTEGER ? 0 : builds;
    };
    // Inventory first (no trip needed), then bank.
    let best = 0;
    for (const recipe of recipes) {
      if ((recipe.level ?? 99) > level) continue;
      best = Math.max(best, buildsFrom(recipe, false));
    }
    if (best > 0) return best;
    for (const recipe of recipes) {
      if ((recipe.level ?? 99) > level) continue;
      best = Math.max(best, buildsFrom(recipe, true));
    }
    return best;
  } catch {
    return 0;
  }
}

/**
 * Housing tie-in: true when the citizen owns a home with empty furniture
 * slots — they're building to furnish their own place, not just to sell.
 */
function homeWantsFurniture(player) {
  try {
    const Homes = require("../lib/CitizenHomes");
    const username = player?.getUsername?.();
    if (!username || typeof Homes?.homeOf !== "function") return false;
    const home = Homes.homeOf(username);
    if (!home) return false;
    const furn = home.furnishings ?? [];
    return furn.length < 8; // MAX_FURNISHINGS
  } catch {
    return false;
  }
}

/**
 * Sickness work penalty 0..60, read from the health data tier.
 * Defensive: a missing/broken health module scores as healthy.
 */
function sickPenalty(player) {
  try {
    const Health = require("../lib/CitizenHealth");
    const username = player?.username ?? player?.getUsername?.() ?? null;
    if (!username || typeof Health.workPenaltyFor !== "function") return 0;
    return Health.workPenaltyFor(username);
  } catch {
    return 0;
  }
}

/**
 * Jail work penalty 0..60, read from the crime data tier. A jailed citizen
 * cannot work at all — 60, same as the plague.
 * Defensive: a missing/broken crime module scores as free.
 */
function jailPenalty(player) {
  try {
    const Crime = require("../lib/CitizenCrime");
    const username = player?.username ?? player?.getUsername?.() ?? null;
    if (!username || typeof Crime.jailPenaltyFor !== "function") return 0;
    return Crime.jailPenaltyFor(username);
  } catch {
    return 0;
  }
}

/**
 * Criminal notoriety 0..100, read from the crime data tier. Known criminals
 * find tavern doors heavier — social scores drop with reputation.
 * Defensive: a missing/broken crime module scores as clean.
 */
function notorietyOf(player) {
  try {
    const Crime = require("../lib/CitizenCrime");
    const username = player?.username ?? player?.getUsername?.() ?? null;
    if (!username || typeof Crime.notorietyFor !== "function") return 0;
    return Crime.notorietyFor(username);
  } catch {
    return 0;
  }
}

/**
 * Herb materials the citizen could work right now (inventory, else bank).
 * Counts inputs of recipes whose partner item (vial/secondary) is also
 * available in the same place — cleaning needs nothing, mixing needs
 * its 1:1 partner.
 */
function herbCount(player) {
  try {
    const Herblore = require("../../skills/Herblore.plugin");
    const recipes = Herblore?.HERBLORE_RECIPES;
    if (!Array.isArray(recipes) || !recipes.length) return 0;
    const inv = player?.getInventory?.();
    const invAmount = (id) => {
      try {
        return inv?.getAmount?.(id) ?? 0;
      } catch {
        return 0;
      }
    };
    const bankAmount = (id) => {
      let total = 0;
      try {
        for (let tab = 0; tab < 8; tab++) {
          const bank = player?.getBank?.(tab);
          if (!bank) continue;
          const slot = bank.getSlotForItemId?.(id) ?? -1;
          if (slot < 0) continue;
          const stack = bank.getItems?.()[slot];
          if (!stack || stack.getId?.() !== id) continue;
          total += stack.getAmount?.() ?? 0;
        }
      } catch {
        // treat as empty
      }
      return total;
    };
    const workable = (amount, recipe) =>
      amount(recipe.inputId) > 0 &&
      (!recipe.needsId || amount(recipe.needsId) > 0);
    // Inventory first (no trip needed), then bank.
    let invTotal = 0;
    for (const recipe of recipes) {
      if (workable(invAmount, recipe)) invTotal += invAmount(recipe.inputId);
    }
    if (invTotal > 0) return invTotal;
    let bankTotal = 0;
    for (const recipe of recipes) {
      if (workable(bankAmount, recipe)) bankTotal += bankAmount(recipe.inputId);
    }
    return bankTotal;
  } catch {
    return 0;
  }
}

/**
 * Logs the citizen could fletch right now (inventory, else bank). Counts
 * logs of level-gated recipes — the knife is the non-consumed partner, so
 * it must be in the same place as the logs (pack or bank).
 */
function fletchCount(player) {
  try {
    const Fletching = require("../../skills/Fletching.plugin");
    const recipes = Fletching?.FLETCHING_RECIPES;
    if (!Array.isArray(recipes) || !recipes.length) return 0;
    const inv = player?.getInventory?.();
    const invAmount = (id) => {
      try {
        return inv?.getAmount?.(id) ?? 0;
      } catch {
        return 0;
      }
    };
    const bankAmount = (id) => {
      let total = 0;
      try {
        for (let tab = 0; tab < 8; tab++) {
          const bank = player?.getBank?.(tab);
          if (!bank) continue;
          const slot = bank.getSlotForItemId?.(id) ?? -1;
          if (slot < 0) continue;
          const stack = bank.getItems?.()[slot];
          if (!stack || stack.getId?.() !== id) continue;
          total += stack.getAmount?.() ?? 0;
        }
      } catch {
        // treat as empty
      }
      return total;
    };
    const workable = (amount, recipe) =>
      Number.isInteger(recipe.inputId) &&
      amount(recipe.inputId) > 0 &&
      (!recipe.needsId || amount(recipe.needsId) > 0);
    // Inventory first (no trip needed), then bank.
    let invTotal = 0;
    for (const recipe of recipes) {
      if (workable(invAmount, recipe)) invTotal += invAmount(recipe.inputId);
    }
    if (invTotal > 0) return invTotal;
    let bankTotal = 0;
    for (const recipe of recipes) {
      if (workable(bankAmount, recipe)) bankTotal += bankAmount(recipe.inputId);
    }
    return bankTotal;
  } catch {
    return 0;
  }
}

/**
 * Essence the citizen could craft right now (inventory, else bank).
 * Counts rune essence + pure essence — the runecrafting inputs.
 */
function essenceCount(player) {
  try {
    const Runecrafting = require("../../skills/Runecrafting.plugin");
    const ids = Runecrafting?.ESSENCE_IDS;
    if (!Array.isArray(ids) || !ids.length) return 0;
    const inv = player?.getInventory?.();
    const invAmount = (id) => {
      try {
        return inv?.getAmount?.(id) ?? 0;
      } catch {
        return 0;
      }
    };
    const bankAmount = (id) => {
      let total = 0;
      try {
        for (let tab = 0; tab < 8; tab++) {
          const bank = player?.getBank?.(tab);
          if (!bank) continue;
          const slot = bank.getSlotForItemId?.(id) ?? -1;
          if (slot < 0) continue;
          const stack = bank.getItems?.()[slot];
          if (!stack || stack.getId?.() !== id) continue;
          total += stack.getAmount?.() ?? 0;
        }
      } catch {
        // treat as empty
      }
      return total;
    };
    // Inventory first (no trip needed), then bank.
    let invTotal = 0;
    for (const id of ids) invTotal += invAmount(id);
    if (invTotal > 0) return invTotal;
    let bankTotal = 0;
    for (const id of ids) bankTotal += bankAmount(id);
    return bankTotal;
  } catch {
    return 0;
  }
}

/** Raw food the citizen could cook right now (inventory, else bank). */
function rawFoodCount(player) {  try {
    const Cooking = require("../../skills/Cooking.plugin");
    const recipes = Cooking?.COOKING_RECIPES;
    if (!Array.isArray(recipes) || !recipes.length) return 0;
    const inv = player?.getInventory?.();
    const invAmount = (id) => {
      try {
        return inv?.getAmount?.(id) ?? 0;
      } catch {
        return 0;
      }
    };
    const bankAmount = (id) => {
      let total = 0;
      try {
        for (let tab = 0; tab < 8; tab++) {
          const bank = player?.getBank?.(tab);
          if (!bank) continue;
          const slot = bank.getSlotForItemId?.(id) ?? -1;
          if (slot < 0) continue;
          const stack = bank.getItems?.()[slot];
          if (!stack || stack.getId?.() !== id) continue;
          total += stack.getAmount?.() ?? 0;
        }
      } catch {
        // treat as empty
      }
      return total;
    };
    // Inventory first (no trip needed), then bank.
    let invTotal = 0;
    for (const recipe of recipes) invTotal += invAmount(recipe.rawId);
    if (invTotal > 0) return invTotal;
    let bankTotal = 0;
    for (const recipe of recipes) bankTotal += bankAmount(recipe.rawId);
    return bankTotal;
  } catch {
    return 0;
  }
}

/**
 * Bird snares the citizen could hunt with right now (inventory, else bank).
 * Counts snares for the best trap kind their Hunter level allows.
 */
function huntCount(player) {
  try {
    const Hunter = require("../../skills/Hunter.plugin");
    const info = Hunter?.huntingTrapInfo?.() ?? [];
    if (!Array.isArray(info) || !info.length) return 0;
    const inv = player?.getInventory?.();
    const invAmount = (id) => {
      try {
        return inv?.getAmount?.(id) ?? 0;
      } catch {
        return 0;
      }
    };
    const bankAmount = (id) => {
      let total = 0;
      try {
        for (let tab = 0; tab < 8; tab++) {
          const bank = player?.getBank?.(tab);
          if (!bank) continue;
          const slot = bank.getSlotForItemId?.(id) ?? -1;
          if (slot < 0) continue;
          const stack = bank.getItems?.()[slot];
          if (!stack || stack.getId?.() !== id) continue;
          total += stack.getAmount?.() ?? 0;
        }
      } catch {
        // treat as empty
      }
      return total;
    };
    // Inventory first (no trip needed), then bank.
    let invTotal = 0;
    for (const trap of info) invTotal += invAmount(trap.itemId);
    if (invTotal > 0) return invTotal;
    let bankTotal = 0;
    for (const trap of info) bankTotal += bankAmount(trap.itemId);
    return bankTotal;
  } catch {
    return 0;
  }
}

/** Seeds the citizen could plant right now (inventory, else bank). */
function seedCount(player) {
  try {
    const Farming = require("../../skills/farming/Patches.Farming");
    const seeds = Farming?.botFarm?.seeds;
    if (!seeds) return 0;
    let level = 1;
    try {
      const Skill = require("../../src/main/typescript/elvarg/game/model/Skill")
        .Skill;
      const mgr = player?.getSkillManager?.();
      if (mgr && Skill && typeof mgr.getCurrentLevel === "function") {
        const lvl = mgr.getCurrentLevel(Skill.FARMING);
        if (Number.isInteger(lvl) && lvl > 0) level = lvl;
      }
    } catch {
      // level 1 fallback — low-level seeds only
    }
    const inv = player?.getInventory?.();
    const invAmount = (id) => {
      try {
        return inv?.getAmount?.(id) ?? 0;
      } catch {
        return 0;
      }
    };
    const bankAmount = (id) => {
      let total = 0;
      try {
        for (let tab = 0; tab < 8; tab++) {
          const bank = player?.getBank?.(tab);
          if (!bank) continue;
          const slot = bank.getSlotForItemId?.(id) ?? -1;
          if (slot < 0) continue;
          const stack = bank.getItems?.()[slot];
          if (!stack || stack.getId?.() !== id) continue;
          total += stack.getAmount?.() ?? 0;
        }
      } catch {
        // treat as empty
      }
      return total;
    };
    // Inventory first (no trip needed), then bank.
    let invTotal = 0;
    for (const [seedId, crop] of seeds) {
      if (!crop || !FARM_PATCH_TYPES.includes(crop.type)) continue;
      if ((crop.level ?? 99) > level) continue;
      invTotal += invAmount(seedId);
    }
    if (invTotal > 0) return invTotal;
    let bankTotal = 0;
    for (const [seedId, crop] of seeds) {
      if (!crop || !FARM_PATCH_TYPES.includes(crop.type)) continue;
      if ((crop.level ?? 99) > level) continue;
      bankTotal += bankAmount(seedId);
    }
    return bankTotal;
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
    logs: logCount(player),
    ore: smeltableBars(player),
    gems: gemCount(player),
    rawFood: rawFoodCount(player),
    herbs: herbCount(player),
    fletchLogs: fletchCount(player),
    essence: essenceCount(player),
    hunts: huntCount(player),
    seeds: seedCount(player),
    thiefLevel: thiefLevel(player),
    builds: buildCount(player),
    buildLevel: constructLevel(player),
    homeFurnishable: homeWantsFurniture(player),
    sick: sickPenalty(player),
    jailed: jailPenalty(player),
    notoriety: notorietyOf(player),
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
  const { hp, energy, mood, goal, personality, coins, food, freeSlots, nearby, logs, ore, gems, rawFood, herbs, fletchLogs, essence, hunts, seeds, thiefLevel, builds, buildLevel, homeFurnishable, notoriety, hour } = snap;
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
    case ACT_LIGHT_FIRE: {
      // Firemaking: burn logs for XP. No logs, no fire. Industrious citizens
      // burn in the evening by the bank; nobody lights fires while hurt or
      // exhausted. Fires are social — a small bonus when others are near.
      if ((logs ?? 0) <= 0) return 4;
      let s = 34 + industrious * 12;
      if (hour >= 17 || hour <= 2) s += 8; // evening fire time
      if (goalType === GOAL_MASTER_TRADE) s += 10; // skilling goal
      if (goalType === GOAL_SAVE_GOLD) s += 4;
      if (nearby >= 2) s += 6;
      if (logs >= 10) s += 8; // a real stockpile to work through
      if (criticalHp || exhausted) s -= 70;
      else if (hurt) s -= 30;
      else if (weary) s -= 25;
      if (mood < 20) s -= 8;
      return s;
    }
    case ACT_FLETCH: {
      // Fletching: cut logs into shafts and bows for XP and coin. No logs
      // (or no knife) anywhere, no cutting. Fletching is inventory work —
      // no station needed — so citizens pick it up whenever they've got
      // logs from woodcutting. Shafts and bows sell steadily, so broke
      // traders grind them; the weary and hurt stay away.
      if ((fletchLogs ?? 0) <= 0) return 4;
      let s = 36 + industrious * 12;
      if (goalType === GOAL_MASTER_TRADE) s += 14;
      else if (goalType === GOAL_SAVE_GOLD) s += 10;
      if (coins < 60) s += 10; // shafts sell steadily — a broke cutter grinds
      if (fletchLogs >= 10) s += 8; // a real stockpile to work through
      if (criticalHp || exhausted) s -= 70;
      else if (hurt) s -= 30;
      else if (weary) s -= 25;
      if (mood < 20) s -= 8;
      return s;
    }
    case ACT_AGILITY: {
      // Agility: run obstacle courses for XP and faster run-energy restore.
      // No materials — the course itself is the tool — so there's no stock
      // gate; the action returns "success" quickly when no course is nearby.
      // Industrious citizens with a skilling goal train laps; the hurt,
      // exhausted, and weary stay off the ropes.
      let s = 36 + industrious * 12;
      if (goalType === GOAL_MASTER_TRADE) s += 10; // skilling goal
      if (goalType === GOAL_RANK_UP) s += 8;
      if (criticalHp || exhausted) s -= 70;
      else if (hurt) s -= 30;
      else if (weary) s -= 25;
      if (mood < 20) s -= 8;
      return s;
    }
    case ACT_SLAYER: {
      // Slayer: hunt assigned monsters for Slayer + combat XP. No task and
      // no master nearby means the action returns "success" quickly, so
      // there's no stock gate — the action itself handles the empty states.
      // Brave, industrious citizens with combat goals take tasks; the hurt,
      // exhausted, and weary stay home. Wilderness tasks are never hunted
      // (the action refuses them), so scoring doesn't need a wilderness gate.
      let s = 36 + industrious * 12;
      if (goalType === GOAL_BOSS_SLAYER) s += 16; // slayer goal
      else if (goalType === GOAL_MASTER_TRADE) s += 8;
      if (goalType === GOAL_RANK_UP) s += 8;
      if (criticalHp || exhausted) s -= 70;
      else if (hurt) s -= 30;
      else if (weary) s -= 25;
      if (mood < 20) s -= 8;
      return s;
    }
    case ACT_HUNT: {
      // Hunter: lay bird snares and trap birds for Hunter XP and loot.
      // No snares anywhere, no hunting trip. Hunter is field work — the
      // citizen must travel to the hunting grounds — so it's picked up
      // when there's a real stockpile of snares to justify the journey.
      // Feathers and bird meat sell to fletchers and cooks, so broke
      // traders grind them; the weary and hurt stay away.
      if ((hunts ?? 0) <= 0) return 4;
      let s = 36 + industrious * 12;
      if (goalType === GOAL_MASTER_TRADE) s += 14;
      else if (goalType === GOAL_SAVE_GOLD) s += 10;
      if (coins < 60) s += 10; // feathers sell well — a broke hunter grinds
      if (hunts >= 3) s += 8; // a real stockpile to work through
      if (criticalHp || exhausted) s -= 70;
      else if (hurt) s -= 30;
      else if (weary) s -= 25;
      if (mood < 20) s -= 8;
      return s;
    }
    case ACT_FARM: {
      // Farming: run the patch circuit for XP and produce. No seeds
      // anywhere, no farming — a human can't farm without seeds either.
      // Herb runs are the classic money-maker, so save-gold citizens lean
      // in; like the other skilling activities, the weary and hurt stay
      // away. Farming is periodic by nature: after a run the patches are
      // planted and growing, so the action itself ends the run and the
      // picker only re-selects it when there's fresh work.
      if ((seeds ?? 0) <= 0) return 4;
      let s = 34 + industrious * 12;
      if (goalType === GOAL_MASTER_TRADE) s += 14;
      else if (goalType === GOAL_SAVE_GOLD) s += 12;
      if (coins < 60) s += 8; // herb runs pay — a broke farmer grinds
      if (seeds >= 6) s += 8; // a real seed stockpile to work through
      if (criticalHp || exhausted) s -= 70;
      else if (hurt) s -= 30;
      else if (weary) s -= 25;
      if (mood < 20) s -= 8;
      return s;
    }
    case ACT_THIEVE: {
      // Thieving: steal from market stalls for Thieving XP and loot.
      // No materials — the market itself is the tool — so there's no stock
      // gate; the action returns "success" quickly when no stall is nearby.
      // Need drives thieves: the broke steal to eat. The sneaky and the
      // greedy steal from inclination. Higher Thieving unlocks richer
      // stalls, so veterans lean in. The hurt, exhausted, and weary keep
      // their hands in their pockets.
      let s = 30 + industrious * 12;
      if (coins < 60) s += 14; // need drives thieves
      const traits = traitSet(personality);
      if (traits.has("sneaky") || traits.has("mischievous")) s += 10;
      if (traits.has("greedy")) s += 6;
      if (traits.has("honest") || traits.has("dutiful")) s -= 12;
      if (goalType === GOAL_SAVE_GOLD) s += 8;
      if ((thiefLevel ?? 1) >= 20) s += 6; // silk stalls and up
      if ((thiefLevel ?? 1) >= 35) s += 6; // fur stalls and up
      if (criticalHp || exhausted) s -= 70;
      else if (hurt) s -= 30;
      else if (weary) s -= 25;
      if (mood < 20) s -= 8;
      return s;
    }
    case ACT_BUILD: {
      // Construction: build furniture from planks for XP and coin. No
      // planks anywhere, no carpentry — a human can't build without timber.
      // Carpenters whose own home still has empty furniture slots build to
      // furnish first; finished furniture sells well, so broke traders grind
      // it too. Higher Construction unlocks oak furniture, so veterans lean
      // in. The hurt, exhausted, and weary stay away from the workbench.
      if ((builds ?? 0) <= 0) return 4;
      let s = 34 + industrious * 12;
      if (goalType === GOAL_MASTER_TRADE) s += 14;
      else if (goalType === GOAL_SAVE_GOLD) s += 10;
      if (coins < 60) s += 10; // furniture sells well — a broke carpenter grinds
      if (builds >= 8) s += 8; // a real timber stockpile to work through
      if (homeFurnishable) s += 8; // building to furnish my own home
      if ((buildLevel ?? 1) >= 29) s += 6; // oak bookcases and up
      if (criticalHp || exhausted) s -= 70;
      else if (hurt) s -= 30;
      else if (weary) s -= 25;
      if (mood < 20) s -= 8;
      return s;
    }
    case ACT_RC: {
      // Runecrafting: craft essence into runes for XP and coin. No essence
      // anywhere, no altar trip. Runecrafting is station work — the citizen
      // must travel to the altar — so it's picked up when there's a real
      // stockpile to justify the journey. Runes sell well to mages and
      // crafters, so broke traders grind them; the weary and hurt stay away.
      if ((essence ?? 0) <= 0) return 4;
      let s = 36 + industrious * 12;
      if (goalType === GOAL_MASTER_TRADE) s += 14;
      else if (goalType === GOAL_SAVE_GOLD) s += 10;
      if (coins < 60) s += 10; // runes sell well — a broke crafter grinds
      if (essence >= 14) s += 8; // a real stockpile to justify the altar trip
      if (criticalHp || exhausted) s -= 70;
      else if (hurt) s -= 30;
      else if (weary) s -= 25;
      if (mood < 20) s -= 8;
      return s;
    }
    case ACT_SMELT: {
      // Smelting: turn ore into bars for XP and coin. No ore anywhere, no
      // furnace trip. Industrious citizens with a trade goal work the
      // furnace; like mining, the weary and hurt stay away.
      if ((ore ?? 0) <= 0) return 4;
      let s = 36 + industrious * 12;
      if (goalType === GOAL_MASTER_TRADE) s += 14;
      else if (goalType === GOAL_SAVE_GOLD) s += 10;
      if (coins < 60) s += 10; // bars sell well — a broke smith grinds
      if (ore >= 10) s += 8; // a real stockpile to work through
      if (criticalHp || exhausted) s -= 70;
      else if (hurt) s -= 30;
      else if (weary) s -= 25;
      if (mood < 20) s -= 8;
      return s;
    }
    case ACT_CRAFT: {
      // Crafting: cut uncut gems for XP and coin. No gems anywhere, no
      // cutting. Gem cutting is inventory work — no station needed — so
      // citizens pick it up whenever they've got gems. Cut gems sell well,
      // so broke traders grind them; the weary and hurt stay away.
      if ((gems ?? 0) <= 0) return 4;
      let s = 36 + industrious * 12;
      if (goalType === GOAL_MASTER_TRADE) s += 14;
      else if (goalType === GOAL_SAVE_GOLD) s += 10;
      if (coins < 60) s += 10; // cut gems sell well — a broke cutter grinds
      if (gems >= 10) s += 8; // a real stockpile to work through
      if (criticalHp || exhausted) s -= 70;
      else if (hurt) s -= 30;
      else if (weary) s -= 25;
      if (mood < 20) s -= 8;
      return s;
    }
    case ACT_COOK: {
      // Cooking: turn raw food into cooked food for XP, coin, and healing.
      // No raw food anywhere, no cooking. Cooked food is what citizens eat
      // to heal, so low-food citizens cook to survive; broke traders cook to
      // sell. The weary and hurt stay away (the meal hinge handles eating).
      if ((rawFood ?? 0) <= 0) return 4;
      let s = 36 + industrious * 12;
      if (goalType === GOAL_MASTER_TRADE) s += 14;
      else if (goalType === GOAL_SAVE_GOLD) s += 10;
      if (coins < 60) s += 10; // cooked food sells well — a broke cook grinds
      if (rawFood >= 10) s += 8; // a real stockpile to work through
      if (food < 3) s += 12; // low on food — cook to eat, not just to sell
      if (criticalHp || exhausted) s -= 70;
      else if (hurt) s -= 30;
      else if (weary) s -= 25;
      if (mood < 20) s -= 8;
      return s;
    }
    case ACT_HERB: {
      // Herblore: clean herbs and mix potions for XP and coin. No herbs
      // anywhere, no mixing. Herblore is inventory work — no station
      // needed — so citizens pick it up whenever they've got herbs.
      // Potions heal and sell well, so broke traders grind them; the
      // weary and hurt stay away.
      if ((herbs ?? 0) <= 0) return 4;
      let s = 36 + industrious * 12;
      if (goalType === GOAL_MASTER_TRADE) s += 14;
      else if (goalType === GOAL_SAVE_GOLD) s += 10;
      if (coins < 60) s += 10; // potions sell well — a broke mixer grinds
      if (herbs >= 10) s += 8; // a real stockpile to work through
      if (criticalHp || exhausted) s -= 70;
      else if (hurt) s -= 30;
      else if (weary) s -= 25;
      if (mood < 20) s -= 8;
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
      // A criminal reputation empties the tavern around you: notorious
      // citizens are shunned (notoriety 100 = -30 social).
      if ((notoriety ?? 0) > 0) s -= Math.min(30, Math.round((notoriety ?? 0) * 0.3));
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
    case ACT_CHOP: {
      // Woodcutting: logs for the fires, coins for the cutter. Industrious
      // citizens with a trade goal grab the axe. Citizens low on logs (for
      // firemaking) chop more. Like mining, it's work — the weary stay away.
      let s = 36;
      if (goalType === GOAL_MASTER_TRADE) s += 14;
      else if (goalType === GOAL_SAVE_GOLD) s += 10;
      s += urgent * 6;
      s += industrious * 12;
      if (coins < 60) s += 16;
      else if (coins < 250) s += 5;
      // Low on logs? The fire needs feeding.
      if (logs < 5) s += 12;
      else if (logs < 15) s += 6;
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
  const sick = snap.sick ?? 0;
  const jailed = snap.jailed ?? 0;
  const scored = candidates
    .filter((a) => a && typeof a.id === "string")
    .map((a) => ({
      activity: a,
      // Session intents steer the pick: a citizen with "earn 2000 coins"
      // scores work higher. Capped so intents never override critical needs.
      // Sickness keeps citizens away from work: the sicker they are, the
      // less work appeals (a plague is -60: effectively no work at all).
      // Jail is the same: a jailed citizen serves time, not shifts.
      score:
        scoreActivity(a.id, snap) +
        intentBonusFor(a.id, player) -
        (sick > 0 && WORK_ACTIVITIES.has(a.id) ? sick : 0) -
        (jailed > 0 && WORK_ACTIVITIES.has(a.id) ? jailed : 0),
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
  ACT_CHOP,
  ACT_LIGHT_FIRE,
  ACT_SMELT,
  ACT_CRAFT,
  ACT_COOK,
  ACT_HERB,
  ACT_FLETCH,
  ACT_RC,
  ACT_AGILITY,
  ACT_SLAYER,
  ACT_HUNT,
  ACT_FARM,
  ACT_THIEVE,
  ACT_BUILD,
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
