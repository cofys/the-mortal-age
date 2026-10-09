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
const ACT_TRAVEL = "citizen_travel";
const ACT_ENTERTAIN = "citizen_entertain";
const ACT_GUILD = "citizen_guild";
const ACT_PETCARE = "citizen_petcare";
const ACT_CREATEART = "citizen_createart";
const ACT_PERFORM = "citizen_perform";
const ACT_FASHION = "citizen_tailorwork";
const ACT_CUISINE = "citizen_chefwork";
const ACT_CELEBRATE = "citizen_celebrate";

const ACT_COMPETE = "citizen_compete";
const ACT_DIPLOMAT = "citizen_diplomat";
const ACT_EXPLORE = "citizen_explore";
const ACT_LAWYER = "citizen_lawyer";
const ACT_INVENT = "citizen_invent";
const ACT_PHILOSOPHIZE = "citizen_philosophize";
const ACT_SURGEON = "citizen_surgeon";
const ACT_CONSTRUCT = "citizen_construct";
const ACT_TEAMPLAY = "citizen_teamplay";
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
  ACT_TRAVEL,
  ACT_GUILD,
  ACT_PETCARE,
  ACT_CREATEART,
  ACT_PERFORM,
  ACT_FASHION,
  ACT_CUISINE,
  ACT_CELEBRATE,
  ACT_CUISINE,

ACT_COMPETE,
  ACT_DIPLOMAT, ACT_EXPLORE, ACT_LAWYER, ACT_INVENT, ACT_PHILOSOPHIZE, ACT_SURGEON, ACT_CONSTRUCT, ACT_TEAMPLAY,  ACT_MINE,
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
 * Climate right now: season + sky weather. Returns
 * { season, weather, isStorm, outdoorPenalty }. Defensive: a missing Sky
 * or season module scores as clear spring weather (no penalty).
 */
function climateInfo() {
  try {
    const Seasons = require("../lib/CitizenSeasons");
    const nowMs = Date.now();
    const season = Seasons.seasonOf(nowMs);
    let weather = "clear";
    try {
      weather = String(require("../../skills/fishing/Conditions.Fishing").getWeather?.() ?? "clear").toLowerCase();
    } catch {
      weather = "clear";
    }
    return {
      season,
      weather,
      isStorm: weather === "storm",
      outdoorPenalty: Seasons.outdoorWorkPenalty(weather),
    };
  } catch {
    return { season: "spring", weather: "clear", isStorm: false, outdoorPenalty: 0 };
  }
}

/**
 * Night right now: time-of-day and nocturnal effects. Returns
 * { timeOfDay, isNight, nightPenalty }. Defensive: a missing day/night
 * module scores as day (no penalty).
 */
function nightInfo() {
  try {
    const DayNight = require("../lib/CitizenDayNight");
    const nowMs = Date.now();
    return {
      timeOfDay: DayNight.timeOfDay(nowMs),
      isNight: DayNight.isNight(nowMs),
      nightPenalty: DayNight.nightWorkPenalty(nowMs),
    };
  } catch {
    return { timeOfDay: "day", isNight: false, nightPenalty: 0 };
  }
}

/**
 * Travel readiness: can this citizen afford the cheapest open route?
 * Returns { canTravel, cheapestFare, openCount }. Defensive: a
 * missing/broken travel module scores as unable to travel.
 */
function travelInfo(player) {
  try {
    const Travel = require("../lib/CitizenTravel");
    const { kingdomIdOf } = require("./CitizenSites");
    const home = kingdomIdOf(player);
    const coins = coinCount(player);
    const routes = (Travel.routesFrom?.(home) ?? []).filter((r) =>
      Travel.routeOpen?.(r.from, r.to)
    );
    if (!routes.length) return { canTravel: false, cheapestFare: 0, openCount: 0 };
    const cheapestFare = Math.min(...routes.map((r) => r.fare));
    return {
      canTravel: coins >= cheapestFare,
      cheapestFare,
      openCount: routes.length,
    };
  } catch {
    return { canTravel: false, cheapestFare: 0, openCount: 0 };
  }
}

/**
 * Entertainment readiness: can this citizen afford a night out?
 * Returns { canDrink, canDice, canTheater }. Defensive: a
 * missing/broken entertainment module scores as unable to have fun.
 */
function entertainInfo(player) {
  try {
    const Entertain = require("../lib/CitizenEntertainment");
    const coins = coinCount(player);
    return {
      canDrink: coins >= Entertain.DRINK_PRICE,
      canDice: coins >= Entertain.DICE_MIN_BET,
      canTheater: coins >= Entertain.THEATER_PRICE,
    };
  } catch {
    return { canDrink: false, canDice: false, canTheater: false };
  }
}

/**
 * Guild status for the decision layer: membership, rank, active mission,
 * and whether the citizen qualifies for any guild hall visit.
 * Defensive: a missing/broken guild module scores as guildless.
 */
function guildInfo(player) {
  try {
    const G = require("../lib/CitizenGuilds");
    const username = player?.username ?? player?.getUsername?.() ?? null;
    if (!username) return { member: false, guildId: null, rank: null, hasMission: false };
    const m = G.membershipFor(username);
    if (!m) return { member: false, guildId: null, rank: null, hasMission: false };
    return {
      member: true,
      guildId: m.guildId,
      rank: m.rank,
      favor: m.favor,
      hasMission: !!m.mission,
    };
  } catch {
    return { member: false, guildId: null, rank: null, hasMission: false };
  }
}

/**
 * Pet mood bonus: happy pets lift mood, starving pets drag it down.
 * Defensive: a missing/broken pets module contributes nothing.
 */
function petMoodBonus(player) {
  try {
    const Pets = require("../lib/CitizenPets");
    const username = player?.username ?? player?.getUsername?.() ?? null;
    if (!username) return 0;
    return Pets.moodBonusFor(username) || 0;
  } catch {
    return 0;
  }
}

/**
 * Pet info: does this citizen own pets, and do they need care?
 * Defensive: a missing/broken pets module scores as petless.
 */
function petInfo(player) {
  try {
    const Pets = require("../lib/CitizenPets");
    const username = player?.username ?? player?.getUsername?.() ?? null;
    if (!username) return { hasPets: false, needsCare: false, count: 0 };
    const pets = Pets.petsOf(username);
    if (!pets.length) return { hasPets: false, needsCare: false, count: 0 };
    const needsCare = pets.some((p) => p.hunger < 70 || p.happiness < 80);
    const hasMount = pets.some((p) => Pets.PET_CATALOG[p.type]?.mount);
    return { hasPets: true, needsCare, count: pets.length, hasMount };
  } catch {
    return { hasPets: false, needsCare: false, count: 0 };
  }
}

/**
 * Art info: can this citizen make art right now, and are they the arty type?
 * Defensive: a missing/broken art module scores as unable.
 */
function artInfo(player) {
  try {
    const Art = require("../lib/CitizenArt");
    const inv = player?.getInventory?.();
    if (!inv) return { canCreate: false, medium: null };
    // Check each medium for affordable materials (same order as the action).
    for (const mediumId of ["sculpture", "painting", "writing"]) {
      const medium = Art.ART_MEDIUMS[mediumId];
      if (!medium) continue;
      let ok = true;
      for (const mat of medium.materials) {
        const ids = mat.anyOf ?? [mat.item];
        let have = 0;
        for (const id of ids) {
          try {
            if (typeof inv.getAmount === "function") have += inv.getAmount(id) ?? 0;
            else if (typeof inv.count === "function") have += inv.count(id) ?? 0;
            else if (typeof inv.contains === "function") have += inv.contains(id) ? 1 : 0;
          } catch { /* ignore */ }
        }
        if (have < mat.amount) { ok = false; break; }
      }
      for (const tool of medium.tools ?? []) {
        let have = 0;
        try {
          if (typeof inv.getAmount === "function") have = inv.getAmount(tool) ?? 0;
          else if (typeof inv.contains === "function") have = inv.contains(tool) ? 1 : 0;
        } catch { /* ignore */ }
        if (have < 1) { ok = false; break; }
      }
      if (ok) return { canCreate: true, medium: mediumId };
    }
    return { canCreate: false, medium: null };
  } catch {
    return { canCreate: false, medium: null };
  }
}

/**
 * Performance info: is this citizen a musician or dancer, and is there a
 * stage to play? Defensive: a missing/broken module scores as unable.
 */
function performInfo(player) {
  try {
    const MD = require("../lib/CitizenMusicDance");
    const username = player?.getUsername?.() ?? player?.getName?.() ?? "";
    if (!username) return { canPerform: false, music: 0, dance: 0 };
    const music = MD.musicOf(username);
    const dance = MD.danceOf(username);
    const canPerform = music >= 20 || dance >= 20;
    const inEnsemble = !!MD.ensembleOf(username);
    const inTroupe = !!MD.troupeOf(username);
    return { canPerform, music, dance, inEnsemble, inTroupe };
  } catch {
    return { canPerform: false, music: 0, dance: 0 };
  }
}

/**
 * Fashion readiness: can this citizen sew garments (has materials)?
 * Defensive: a missing/broken fashion module scores as unable.
 */
function fashionInfo(player) {
  try {
    const Fashion = require("../lib/CitizenFashion");
    const types = Fashion.GARMENT_TYPES ?? [];
    let affordableCount = 0;
    let bestType = null;
    for (const type of types) {
      if (Fashion.canAffordMaterials(player, type).ok) {
        affordableCount++;
        if (!bestType) bestType = type;
      }
    }
    return { canSew: affordableCount > 0, affordableCount, bestType };
  } catch {
    return { canSew: false, affordableCount: 0, bestType: null };
  }
}

/**
 * Cuisine readiness: can this citizen cook a signature dish?
 * Checks real Cooking level and whether ingredient item IDs resolve.
 * Defensive: a missing/broken cuisine module scores as unable to cook.
 */
function cuisineInfo(player) {
  try {
    const Cuisine = require("../lib/CitizenCuisine");
    const ids = Cuisine.ingredientIds();
    if (!ids) return { canCook: false, cookingLevel: 1, affordableCount: 0 };
    let cookingLevel = 1;
    try {
      const skills = player?.skills ?? player?.getSkills?.();
      if (skills?.getLevel) cookingLevel = skills.getLevel("cooking");
      else if (typeof skills?.cooking === "number") cookingLevel = skills.cooking;
      else cookingLevel = player?.getLevel?.("cooking") ?? 1;
    } catch { /* default 1 */ }
    // Count affordable dish types by checking real inventory.
    let affordableCount = 0;
    try {
      const inv = player?.inventory ?? player?.getInventory?.();
      const count = (id) => {
        if (id == null || !inv) return 0;
        try {
          if (typeof inv.count === "function") return inv.count(id) ?? 0;
          if (typeof inv.getAmount === "function") return inv.getAmount(id) ?? 0;
        } catch { /* fall through */ }
        return 0;
      };
      for (const type of Cuisine.DISH_TYPES) {
        const def = Cuisine.DISHES[type];
        let ok = true;
        for (const [kind, need] of Object.entries(def.ingredients)) {
          if (count(ids[kind]) < need) { ok = false; break; }
        }
        if (ok) affordableCount++;
      }
    } catch { /* affordableCount stays 0 */ }
    return { canCook: cookingLevel >= 30 && affordableCount > 0, cookingLevel, affordableCount };
  } catch {
    return { canCook: false, cookingLevel: 1, affordableCount: 0 };
  }
}

/**
 * Drunkenness check: is this citizen currently drunk?
 * Defensive: a missing/broken entertainment module scores as sober.
 */
function isDrunk(player) {
  try {
    const Entertain = require("../lib/CitizenEntertainment");
    const username = player?.getUsername?.() ?? player?.getName?.() ?? "";
    return Entertain.isDrunk(username);
  } catch {
    return false;
  }
}

/**
 * Celebration readiness: is there a custom festival to celebrate?
 * Checks for active or upcoming custom festivals in the citizen's kingdom.
 * Defensive: a missing/broken celebrations module scores as nothing.
 */
function celebrateInfo(player) {
  try {
    const C = require("../lib/CitizenCelebrations");
    const { kingdomIdOf } = require("./CitizenSites");
    const home = kingdomIdOf(player);
    const now = Date.now();
    const active = C.activeCustom(home, now);
    const upcoming = C.upcomingCustoms(home, now);
    const isPlanner = (C.plannerFor(home)?.username ?? "") ===
      (player?.getUsername?.() ?? player?.username ?? "");
    return {
      hasFestival: !!(active || upcoming.length > 0),
      isActive: !!active,
      upcomingCount: upcoming.length,
      isPlanner,
      festivalName: active?.name ?? upcoming[0]?.name ?? null,
    };
  } catch {
    return { hasFestival: false, isActive: false, upcomingCount: 0, isPlanner: false, festivalName: null };
  }
}

/**
 * Diplomatic readiness: does this citizen have covert or dynastic work?
 * Spies (sneaky + real Thieving 20+) watch hot borders; charismatic,
 * famous citizens broker royal marriages on calm ones. Defensive: a
 * missing/broken diplomacy module scores as nothing.
 */
function diplomatInfo(player) {
  try {
    const Dip = require("../lib/CitizenDiplomacy");
    const { kingdomIdOf } = require("./CitizenSites");
    const username = player?.getUsername?.() ?? player?.username ?? "";
    const home = kingdomIdOf(player);
    const mission = Dip.spyMissionFor(username);
    // Hottest foreign border — where spies are needed.
    let hottest = null;
    let hottestT = 0;
    // Calmest foreign border — where marriages bloom.
    let calmest = null;
    let calmestT = 101;
    try {
      const Tension = require("../../kingdoms/Tension.Kingdoms");
      for (const k of Dip.kingdoms()) {
        if (k === home) continue;
        const t = Tension.getTension?.(home, k) ?? 0;
        if (t > hottestT) {
          hottestT = t;
          hottest = k;
        }
        if (t < calmestT) {
          calmestT = t;
          calmest = k;
        }
      }
    } catch { /* tension unreadable */ }
    let fame = 0;
    try {
      const Rep = require("./CitizenReputation");
      fame = Rep.reputationFor?.(username) ?? 0;
    } catch { /* reputation unreadable */ }
    return {
      hasMission: !!mission,
      hottestBorder: hottest,
      hottestTension: hottestT,
      calmestBorder: calmest,
      calmestTension: calmestT,
      fame,
    };
  } catch {
    return { hasMission: false, hottestBorder: null, hottestTension: 0, calmestBorder: null, calmestTension: 101, fame: 0 };
  }
}

/**
 * Exploration readiness: Hunter level, curiosity, recent discoveries.
 * Returns { hunterLevel, isCurious, recentFinds }.
 * Defensive: a missing/broken module scores as unable to explore.
 */
function exploreInfo(player) {
  try {
    let hunterLevel = 1;
    try {
      const Hunter = require("../../skills/Hunter.plugin");
      hunterLevel = Hunter.hunterLevel?.(player) ?? 1;
    } catch { /* hunter unreadable */ }

    let isCurious = false;
    try {
      const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
      const p = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
      const traits = p.traits ?? [];
      isCurious = traits.includes("curious") || traits.includes("adventurous");
    } catch { /* personality unreadable */ }

    let recentFinds = 0;
    try {
      const Discovery = require("../lib/CitizenDiscovery");
      const username = player?.getUsername?.() ?? player?.username ?? "";
      const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      recentFinds = Discovery.allDiscoveries().filter(
        (d) => d.discoverer === username && d.foundAt > weekAgo
      ).length;
    } catch { /* discovery unreadable */ }

    return { hunterLevel, isCurious, recentFinds };
  } catch {
    return { hunterLevel: 1, isCurious: false, recentFinds: 0 };
  }
}

/**
 * Legal readiness: is this citizen a lawyer, and are there accused citizens
 * needing counsel? Returns { isLawyer, clientsAvailable, activeCases }.
 * Defensive: a missing/broken module scores as unable to practice law.
 */
function legalInfo(player) {
  try {
    let isLawyer = false;
    try {
      const Careers = require("../lib/CitizenCareers");
      const username = player?.getUsername?.() ?? player?.username ?? "";
      isLawyer = Careers.careerOf?.(username) === "lawyer";
    } catch { /* careers unreadable */ }

    let clientsAvailable = 0;
    let activeCases = 0;
    try {
      const LegalCode = require("../lib/CitizenLegalCode");
      const Guards = require("../lib/CitizenGuards");
      const now = Date.now();
      activeCases = LegalCode.representationCount?.() ?? 0;
      // Clients available: wanted citizens are the pool.
      const wantedCount = typeof Guards.wantedCount === "function"
        ? Guards.wantedCount(now)
        : 0;
      clientsAvailable = Math.max(0, wantedCount - activeCases);
    } catch { /* legal/guards unreadable */ }

    return { isLawyer, clientsAvailable, activeCases };
  } catch {
    return { isLawyer: false, clientsAvailable: 0, activeCases: 0 };
  }
}

/**
 * Surgery readiness: is this citizen a surgeon, and are there patients
 * who need surgery? Defensive: a missing/broken surgery module scores
 * as unable to operate.
 */
function surgeryInfo(player) {
  try {
    const Surgery = require("../lib/CitizenSurgery");
    const username = player?.getUsername?.() ?? player?.username ?? "";
    const isSurgeon = Surgery.isSurgeon(username);
    if (!isSurgeon) return { isSurgeon: false, patientsWaiting: 0 };
    // Patients waiting: citizens who needSurgery in the same kingdom.
    // This is a data-tier scan — cheap because needsSurgery is a pure
    // read of CitizenHealth records.
    let patientsWaiting = 0;
    try {
      const Health = require("../lib/CitizenHealth");
      // We can't enumerate all citizens here (no roster access), so we
      // report whether the surgeon themself could operate. The Life
      // tick does the real matching. A surgeon with no personal
      // knowledge of patients still scores for ward duty.
      patientsWaiting = 1; // ward duty: surgeons tend the hospital
    } catch { /* health unreadable */ }
    return { isSurgeon, patientsWaiting };
  } catch {
    return { isSurgeon: false, patientsWaiting: 0 };
  }
}

/**
 * Invention readiness: Crafting level, creativity, active projects,
 * affordable blueprints. Returns { craftingLevel, isCreative,
 * activeProjects, affordableCount }.
 * Defensive: a missing/broken module scores as unable to invent.
 */
function inventInfo(player) {
  try {
    let craftingLevel = 1;
    try {
      craftingLevel = player?.getSkills?.()?.getLevel?.("crafting")
        ?? player?.skills?.crafting ?? 1;
    } catch { /* crafting unreadable */ }

    let isCreative = false;
    try {
      const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
      const p = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
      const traits = p.traits ?? [];
      isCreative = traits.includes("creative") || traits.includes("inventive")
        || traits.includes("curious");
    } catch { /* personality unreadable */ }

    let activeProjects = 0;
    let affordableCount = 0;
    try {
      const Inventions = require("../lib/CitizenInventions");
      const username = player?.getUsername?.() ?? player?.username ?? "";
      activeProjects = Inventions.projectsFor(username).length;
      // Count affordable blueprints (materials in inventory + level).
      const inv = player?.getInventory?.();
      if (inv) {
        for (const [bpId, bp] of Object.entries(Inventions.blueprints())) {
          if (craftingLevel < bp.craftingLevel) continue;
          let ok = true;
          for (const [itemId, amount] of Object.entries(bp.materials)) {
            let have = 0;
            try {
              if (typeof inv.getAmount === "function") have = inv.getAmount(Number(itemId)) ?? 0;
              else if (typeof inv.count === "function") have = inv.count(Number(itemId)) ?? 0;
            } catch { /* best-effort */ }
            if (have < amount) { ok = false; break; }
          }
          if (ok) affordableCount++;
        }
      }
    } catch { /* inventions unreadable */ }

    return { craftingLevel, isCreative, activeProjects, affordableCount };
  } catch {
    return { craftingLevel: 1, isCreative: false, activeProjects: 0, affordableCount: 0 };
  }
}

/**
 * Construction readiness: is there an active project in the citizen's
 * kingdom, do they carry donatable materials, what's their Construction
 * level? Defensive: missing module scores as unable.
 */
function constructInfo(player) {
  try {
    let constructionLevel = 1;
    try {
      constructionLevel = player?.getSkills?.()?.getLevel?.("construction")
        ?? player?.skills?.construction ?? 1;
    } catch { /* construction unreadable */ }

    let hasProject = false;
    let donatableCount = 0;
    try {
      const Construction = require("../lib/CitizenConstruction");
      const { kingdomIdOf } = require("./CitizenSites");
      const kingdomId = kingdomIdOf(player);
      const proj = kingdomId ? Construction.activeProjectFor(kingdomId) : null;
      hasProject = !!proj;
      if (proj) {
        const inv = player?.getInventory?.();
        if (inv) {
          for (const [itemId, need] of Object.entries(proj.materialsNeeded ?? {})) {
            const donated = proj.materialsDonated?.[itemId] ?? 0;
            if (donated >= need) continue;
            let have = 0;
            try {
              if (typeof inv.getAmount === "function") have = inv.getAmount(Number(itemId)) ?? 0;
              else if (typeof inv.count === "function") have = inv.count(Number(itemId)) ?? 0;
            } catch { /* best-effort */ }
            if (have > 0) donatableCount++;
          }
        }
      }
    } catch { /* construction unreadable */ }

    return { constructionLevel, hasProject, donatableCount };
  } catch {
    return { constructionLevel: 1, hasProject: false, donatableCount: 0 };
  }
}

/**
 * Philosophy readiness: is this citizen a philosopher, can they contemplate,
 * are they thoughtful? Defensive: missing module scores as unable.
 */
function philosophyInfo(player) {
  try {
    const Philosophy = require("../lib/CitizenPhilosophy");
    const username = player?.getUsername?.() ?? player?.username ?? "";
    const isPhil = Philosophy.isPhilosopher(username);
    const wisdom = Philosophy.wisdomFor(username);
    const canCont = Philosophy.canContemplate(username, Date.now());

    let isThoughtful = false;
    try {
      const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
      const p = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
      const traits = p.traits ?? [];
      isThoughtful = traits.includes("thoughtful") || traits.includes("curious")
        || traits.includes("wise") || traits.includes("philosophical");
    } catch { /* personality unreadable */ }

    return { isPhilosopher: isPhil, wisdom, canContemplate: canCont, isThoughtful };
  } catch {
    return { isPhilosopher: false, wisdom: 0, canContemplate: false, isThoughtful: false };
  }
}

/**
 * Team-league readiness: is this citizen on a team, and is there league
 * action in their kingdom? Team players train and play; fans follow.
 * Defensive: a missing/broken leagues module scores as nothing.
 */
function leagueInfo(player) {
  try {
    const L = require("../lib/CitizenLeagues");
    const { kingdomIdOf } = require("./CitizenSites");
    const username = player?.getUsername?.() ?? player?.username ?? "";
    const home = kingdomIdOf(player);
    if (!home) {
      return { onTeam: false, teamName: null, sportId: null, fanOf: null, hasLeague: false };
    }
    let onTeam = false;
    let teamName = null;
    let sportId = null;
    for (const sid of Object.keys(L.TEAM_SPORTS)) {
      const team = L.teamOf(username, home, sid);
      if (team) {
        onTeam = true;
        teamName = team.name;
        sportId = sid;
        break;
      }
    }
    const fanTeam = L.fanTeamOf(username);
    return {
      onTeam,
      teamName,
      sportId,
      fanOf: fanTeam ? fanTeam.name : null,
      hasLeague: true,
    };
  } catch {
    return { onTeam: false, teamName: null, sportId: null, fanOf: null, hasLeague: false };
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
 * Reputation summary { score, tier } for the fame system, read from the
 * reputation data tier. The famous are welcomed, the infamous shunned.
 * Defensive: a missing/broken reputation module scores as unknown.
 */
function reputationOf(player) {
  try {
    const Rep = require("../lib/CitizenReputation");
    const username = player?.username ?? player?.getUsername?.() ?? null;
    if (!username || typeof Rep.reputationSummary !== "function") {
      return { score: 0, tier: "unknown" };
    }
    const s = Rep.reputationSummary(username);
    return { score: s?.score ?? 0, tier: s?.tier ?? "unknown" };
  } catch {
    return { score: 0, tier: "unknown" };
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
    mood: (needs ? needs.mood : 80) + petMoodBonus(player),
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
    reputation: reputationOf(player),
    travel: travelInfo(player),
    entertain: entertainInfo(player),
    guild: guildInfo(player),
    pets: petInfo(player),
    art: artInfo(player),
    perform: performInfo(player),
    fashion: fashionInfo(player),
    cuisine: cuisineInfo(player),
    celebrate: celebrateInfo(player),

compete: competeInfo(player),
    diplomat: diplomatInfo(player),
    explore: exploreInfo(player),
    invent: inventInfo(player),
    construct: constructInfo(player),
    philosophy: philosophyInfo(player),
    legal: legalInfo(player),
    league: leagueInfo(player),
    surgery: surgeryInfo(player),
    drunk: isDrunk(player),
    climate: climateInfo(),
    night: nightInfo(),
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
const { hp, energy, mood, goal, personality, coins, food, freeSlots, nearby, logs, ore, gems, rawFood, herbs, fletchLogs, essence, hunts, seeds, thiefLevel, builds, buildLevel, homeFurnishable, notoriety, reputation, travel, entertain, guild, pets, art, perform, fashion, cuisine, celebrate, compete, diplomat, explore, invent, construct, philosophy, legal, league, surgery, drunk, climate, night, hour } = snap;  const industrious = industriousness(personality);
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
      let s = 58 + (WEARY_AT - energy) * 1.3;
      // Night is for sleeping: the weary rest deeper after dark.
      if (night?.isNight) s += 20;
      return s;
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
      // Weather: rain waters the crops (no penalty — a farmer works in rain),
      // but storms are dangerous even in the fields.
      if (climate?.isStorm) s -= 30;
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
      // Storms are a thief's friend: fewer witnesses, guards huddled inside.
      if (climate?.isStorm) s += 8;
      // Night is a thief's friend: dark streets, fewer witnesses.
      if (night?.isNight) s += 8;
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
      // Storms shut down the workshop — nobody frames furniture in a gale.
      s += climate?.outdoorPenalty ?? 0;
      if (criticalHp || exhausted) s -= 70;
      else if (hurt) s -= 30;
      else if (weary) s -= 25;
      if (mood < 20) s -= 8;
      return s;
    }
    case ACT_TRAVEL: {
      // Travel: ships and caravans between capitals. Costs real fare,
      // takes real time, roads aren't safe. Merchants travel for trade,
      // the curious for the world, the desperate to start over. No fare,
      // no travel — a human can't board without paying. War closes routes.
      const t = travel ?? { canTravel: false, cheapestFare: 0, openCount: 0 };
      if (!t.canTravel || t.openCount <= 0) return 4;
      let s = 22;
      if (goalType === GOAL_MASTER_TRADE) s += 16; // new markets, better prices
      else if (goalType === GOAL_SAVE_GOLD) s -= 10; // travel spends, not saves
      const curious = personality?.curious ?? personality?.adventurous ?? 0;
      if (curious > 0.6) s += 10;
      if (sociable > 0.7) s += 6; // visiting friends in other cities
      if (coins > t.cheapestFare * 5) s += 8; // comfortably afford it
      if (mood > 75) s += 4; // good mood, wanderlust
      if (criticalHp || exhausted) s -= 70;
      else if (hurt) s -= 30;
      else if (weary) s -= 25;
      if (mood < 20) s -= 8;
      return s;
    }
    case ACT_ENTERTAIN: {
      // Entertainment: tavern drinks, dice, bard music, theater. Costs
      // real coins — broke citizens can't have fun. Low-mood citizens
      // seek it out; the sociable love the tavern; the curious love the
      // theater. Drunk citizens shouldn't drink more.
      const e = entertain ?? { canDrink: false, canDice: false, canTheater: false };
      if (!e.canDrink && !e.canDice && !e.canTheater) return 4;
      let s = 20;
      if (mood < 30) s += 16; // miserable citizens need a night out
      else if (mood < 50) s += 8;
      const sociable = personality?.sociable ?? personality?.extroverted ?? 0;
      if (sociable > 0.7) s += 10; // tavern is the social hub
      const curious = personality?.curious ?? personality?.adventurous ?? 0;
      if (curious > 0.6 && e.canTheater) s += 8; // theater for the curious
      if (goalType === GOAL_MASTER_TRADE) s -= 6; // traders save, not spend
      else if (goalType === GOAL_SAVE_GOLD) s -= 10; // fun spends, not saves
      if (drunk) s -= 20; // already drunk — one more ale is a bad idea
      if (criticalHp || exhausted) s -= 70;
      else if (hurt) s -= 30;
      else if (weary) s -= 25;
      return s;
    }
    case ACT_GUILD: {
      // Guilds: the professional's home. Members train for favor and work
      // missions; the ambitious join for rank and reputation. Non-members
      // with a qualifying skill can walk in and sign up (dues are real).
      const gd = guild ?? { member: false };
      let s = 18;
      if (gd.member) {
        s += 8; // members keep their rank warm
        if (!gd.hasMission) s += 10; // a mission waiting is a reason to visit
        if (gd.rank === "novice") s += 6; // novices grind toward member
      } else {
        // The ambitious and career-driven seek a guild to join.
        const ambitious = personality?.ambitious ?? personality?.driven ?? 0;
        if (ambitious > 0.6) s += 12;
        if (goalType === GOAL_MASTER_TRADE) s += 6; // merchants guild calls
      }
      if (goalType === GOAL_SAVE_GOLD && !gd.member) s -= 8; // dues cost coins
      if (criticalHp || exhausted) s -= 70;
      else if (hurt) s -= 30;
      else if (weary) s -= 25;
      return s;
    }
    case ACT_PETCARE: {
      // Pet care: feed the hungry, play with the sad. A human with pets
      // tends them — hungry pets are a real obligation, not optional.
      const pi = pets ?? { hasPets: false };
      if (!pi.hasPets) return 4; // no pets, no pet care
      let s = 16;
      if (pi.needsCare) s += 20; // hungry/sad pets are urgent
      const nurturing = personality?.nurturing ?? personality?.kind ?? 0;
      if (nurturing > 0.6) s += 8; // animal lovers seek it out
      if (criticalHp || exhausted) s -= 70;
      else if (hurt) s -= 30;
      else if (weary) s -= 25;
      return s;
    }
    case ACT_CREATEART: {
      // Art: creative citizens with materials make art. A human artist
      // doesn't grind — they create when inspired and supplied.
      const ai = art ?? { canCreate: false };
      if (!ai.canCreate) return 4; // no materials, no art
      let s = 14;
      const creativity = personality?.creativity ?? personality?.creative ?? 0;
      if (creativity > 0.7) s += 14; // true artists seek it out
      else if (creativity > 0.5) s += 6;
      if (goalType === GOAL_MASTER_TRADE) s += 6; // art sells
      if (mood != null && mood < 30) s += 4; // art as solace
      if (criticalHp || exhausted) s -= 70;
      else if (hurt) s -= 30;
      else if (weary) s -= 25;
      return s;
    }

    case ACT_PERFORM: {
      // Performance: musicians and dancers seek the stage. A human
      // performer practices daily, shows up for the ensemble, and lives
      // for the concert hall — the unskilled have no business on stage.
      const pi = perform ?? { canPerform: false };
      if (!pi.canPerform) return 4; // no skill, no stage
      let s = 14;
      const creativity = personality?.creativity ?? personality?.creative ?? 0;
      if (creativity > 0.7) s += 12; // born performers seek it out
      else if (creativity > 0.5) s += 6;
      const sociable = personality?.sociable ?? personality?.extroverted ?? 0;
      if (sociable > 0.7) s += 6; // the stage loves a crowd
      if (pi.inEnsemble || pi.inTroupe) s += 8; // booked groups rehearse
      if (goalType === GOAL_MASTER_TRADE) s += 4; // lessons and tickets pay
      if (mood != null && mood < 30) s += 4; // music as solace
      if (criticalHp || exhausted) s -= 70;
      else if (hurt) s -= 30;
      else if (weary) s -= 25;
      if (drunk) s -= 20; // drunk performers are a liability
      return s;
    }

    case ACT_FASHION: {
      // Fashion: tailors sew real garments from real materials. A human
      // tailor sews when they have cloth and thread; the vain dress well,
      // the practical mend what they have. No materials, no sewing.
      const fi = fashion ?? { canSew: false, affordableCount: 0 };
      if (!fi.canSew) return 4; // no materials, nothing to sew
      let s = 16;
      const creativity = personality?.creativity ?? personality?.creative ?? 0;
      if (creativity > 0.7) s += 10; // fashion is an art
      else if (creativity > 0.5) s += 5;
      if (fi.affordableCount >= 3) s += 6; // well-stocked workshop
      if (goalType === GOAL_MASTER_TRADE) s += 8; // garments sell
      else if (goalType === GOAL_SAVE_GOLD) s += 4; // sewing saves buying
      if (criticalHp || exhausted) s -= 70;
      else if (hurt) s -= 30;
      else if (weary) s -= 25;
      if (drunk) s -= 20; // drunk tailors prick fingers
      return s;
    }

    case ACT_CUISINE: {
      // Cuisine: master chefs create real signature dishes from real
      // ingredients. A human chef cooks when they have ingredients and
      // the skill; the creative plate beautiful dishes, the ambitious
      // chase the master-chef title. No ingredients or low skill, no cooking.
      const ci = cuisine ?? { canCook: false, cookingLevel: 1, affordableCount: 0 };
      if (!ci.canCook) return 4; // can't cook, nothing to do
      let s = 18;
      const creativity = personality?.creativity ?? personality?.creative ?? 0;
      if (creativity > 0.7) s += 10; // cuisine is an art
      else if (creativity > 0.5) s += 5;
      if (ci.cookingLevel >= 50) s += 8; // master chefs lead the kitchen
      if (ci.affordableCount >= 3) s += 6; // well-stocked pantry
      if (goalType === GOAL_MASTER_TRADE) s += 8; // fine dining sells
      if (criticalHp || exhausted) s -= 70;
      else if (hurt) s -= 30;
      else if (weary) s -= 25;
      if (drunk) s -= 20; // drunk chefs burn the roast
      return s;
    }

    case ACT_CELEBRATE: {
      // Celebrations: citizens join custom festivals, parades, fireworks,
      // and carnival games. A human celebrates when there's a festival;
      // the sociable love the crowd, the planner organizes. No festival,
      // no celebration. Sick/hurt citizens stay home.
      const cb = celebrate ?? { hasFestival: false, isActive: false, upcomingCount: 0, isPlanner: false };
      if (!cb.hasFestival) return 4;
      let s = 20;
      if (cb.isActive) s += 10; // the festival is happening NOW
      if (cb.isPlanner) s += 12; // planners lead the celebration
      const sociable = personality?.sociable ?? personality?.sociability ?? 0.5;
      const soc = typeof sociable === "number" && sociable <= 1 ? sociable : 0.5;
      if (soc > 0.7) s += 8; // social butterflies love festivals
      else if (soc < 0.3) s -= 10; // loners avoid crowds
      if (mood != null && mood < 30) s += 6; // celebrations lift low mood
      if (criticalHp || exhausted) s -= 70;
      else if (hurt) s -= 30;
      else if (weary) s -= 25;
      if (drunk) s -= 15; // drunk celebrants cause trouble
      return s;
    }

case ACT_COMPETE: {
      // Tournaments: citizens compete for glory, prizes, and fame. A human
      // athlete enters when there's an open bracket they can afford;
      // the competitive live for this, the timid watch from the stands.
      const ci = compete ?? { openCount: 0 };
      if (!ci.openCount) return 4; // no open tournament, nothing to enter
      if (ci.entered) return 10; // already entered — training can wait
      if (!ci.canAfford) return 4; // entry fee is real — broke can't enter
      let s = 16;
      const competitive = personality?.competitive ?? personality?.driven ?? 0;
      if (competitive > 0.7) s += 14; // true competitors seek it out
      else if (competitive > 0.5) s += 6;
      if ((ci.bestRating ?? 0) > 150) s += 8; // a real contender smells gold
      if (goalType === GOAL_MASTER_TRADE) s -= 6; // entry fee spends, not saves
      if (goalType === GOAL_SAVE_GOLD) s -= 8;
      if (criticalHp || exhausted) s -= 70;
      else if (hurt) s -= 30;
      else if (weary) s -= 25;
      if (drunk) s -= 20; // nobody fights drunk well
      return s;
    }
    case ACT_DIPLOMAT: {
      // Covert and dynastic diplomacy: spies watch hot borders, famous
      // brokers arrange royal marriages on calm ones. A human spy moves
      // when it matters; a broker moves when the families might say yes.
      const d = diplomat ?? { hasMission: false, hottestTension: 0, calmestTension: 101, fame: 0 };
      const sneaky = personality?.sneaky ?? personality?.mischievous ?? 0;
      const charisma = personality?.charisma ?? personality?.charming ?? 0;
      const canSpy = sneaky > 0.6 && (thievingLevel ?? 1) >= 20;
      const canBroker = charisma > 0.6 && (d.fame ?? 0) >= 40;
      if (!d.hasMission && !canSpy && !canBroker) return 4; // nothing to do
      if (d.hasMission) return 24; // the mission is active — see it through
      let s = 12;
      if (canSpy && (d.hottestTension ?? 0) >= 50) s += 10; // hot border needs eyes
      else if (canSpy) s += 2; // nothing hot — spies wait
      if (canBroker && (d.calmestTension ?? 101) <= 40) s += 10; // calm border may marry
      else if (canBroker) s += 2;
      if (criticalHp || exhausted) s -= 70;
      else if (hurt) s -= 30;
      else if (weary) s -= 25;
      if (drunk) s -= 20; // nobody spies drunk well
      return s;
    }
    case ACT_EXPLORE: {
      // Exploration: venture into the wilds, search, discover. Hunters
      // thrive (survival + finds), the curious can't stay home, recent
      // discoverers ride the high. The hurt and weary stay by the fire.
      const e = explore ?? { hunterLevel: 1, isCurious: false, recentFinds: 0 };
      let s = 20 + Math.min((e.hunterLevel ?? 1) * 0.5, 15);
      if (e.isCurious) s += 12; // curiosity is the engine
      if ((e.recentFinds ?? 0) > 0) s += 8; // success breeds ambition
      if (goalType === GOAL_MASTER_TRADE) s += 8; // new routes, new markets
      if (criticalHp || exhausted) s -= 70;
      else if (hurt) s -= 30;
      else if (weary) s -= 25;
      if (drunk) s -= 20; // nobody explores drunk well
      if (mood < 20) s -= 8;
      return s;
    }
    case ACT_INVENT: {
      // Invention: research blueprints at the workshop. Crafters with
      // materials invent; the creative can't resist tinkering. An active
      // project pulls the inventor back to the bench. No affordable
      // blueprint and no active project means no inventing — a human
      // can't research without materials. The hurt and weary stay home.
      const v = invent ?? { craftingLevel: 1, isCreative: false, activeProjects: 0, affordableCount: 0 };
      if ((v.activeProjects ?? 0) > 0) {
        // Active research — finish what you started.
        let s = 30;
        if (v.isCreative) s += 8;
        if (criticalHp || exhausted) s -= 70;
        else if (hurt) s -= 30;
        else if (weary) s -= 25;
        if (drunk) s -= 20;
        return s;
      }
      if ((v.affordableCount ?? 0) <= 0) return 4; // no materials, no research
      let s = 22 + Math.min((v.craftingLevel ?? 1) * 0.4, 14);
      if (v.isCreative) s += 14; // creativity is the engine
      if ((v.affordableCount ?? 0) >= 3) s += 6; // spoiled for choice
      if (goalType === GOAL_MASTER_TRADE) s += 8; // patents pay royalties
      else if (goalType === GOAL_SAVE_GOLD) s += 6; // inventions sell
      if (criticalHp || exhausted) s -= 70;
      else if (hurt) s -= 30;
      else if (weary) s -= 25;
      if (drunk) s -= 20; // nobody invents drunk well
      if (mood < 20) s -= 8;
      return s;
    }
    case ACT_PHILOSOPHIZE: {
      // Philosophy: contemplate at the academy, gain wisdom, join debates.
      // The thoughtful are drawn to it; philosophers return to deepen their
      // wisdom. Contemplation has a cooldown — no point going when the mind
      // is still digesting the last session. The hurt and weary stay home.
      const v = philosophy ?? { isPhilosopher: false, wisdom: 0, canContemplate: false, isThoughtful: false };
      if (!v.isThoughtful && !v.isPhilosopher) return 4; // not a thinker
      if (v.isPhilosopher && !v.canContemplate) return 4; // mind still digesting
      let s = 20;
      if (v.isPhilosopher) s += 10; // committed to the path
      if (v.isThoughtful) s += 8; // temperament draws them
      s += Math.min((v.wisdom ?? 0) * 0.2, 10); // the wise seek more wisdom
      if (goalType === GOAL_MASTER_TRADE) s -= 6; // philosophy doesn't pay
      if (criticalHp || exhausted) s -= 70;
      else if (hurt) s -= 30;
      else if (weary) s -= 25;
      if (drunk) s -= 20; // nobody philosophizes drunk well
      if (mood < 20) s -= 8;
      return s;
    }
    case ACT_LAWYER: {
      // Law: lawyers take cases for accused citizens. A human lawyer seeks
      // clients when the courts are busy — justice is work, and work pays.
      // Non-lawyers have no business at the courthouse.
      const li = legal ?? { isLawyer: false, clientsAvailable: 0, activeCases: 0 };
      if (!li.isLawyer) return 4; // not a lawyer
      if ((li.clientsAvailable ?? 0) <= 0) return 4; // no clients, no cases
      let s = 22;
      if ((li.activeCases ?? 0) > 0) s += 8; // a practice with clients grows
      const just = personality?.just ?? personality?.lawful ?? personality?.honest ?? 0;
      if (just > 0.6) s += 10; // the just are drawn to the bar
      if (criticalHp || exhausted) s -= 70;
      else if (hurt) s -= 30;
      else if (weary) s -= 25;
      if (drunk) s -= 20; // nobody argues drunk well
      return s;
    }
    case ACT_SURGEON: {
      // Surgery: surgeons operate on the severely ill and injured. A human
      // surgeon works the ward when patients need them — medicine is work,
      // and work pays. Non-surgeons have no business in the operating room.
      const si = surgery ?? { isSurgeon: false, patientsWaiting: 0 };
      if (!si.isSurgeon) return 4; // not a surgeon
      let s = 24;
      if ((si.patientsWaiting ?? 0) > 0) s += 12; // patients need you
      const caring = personality?.compassion ?? personality?.kind ?? personality?.helpful ?? 0;
      if (caring > 0.6) s += 10; // the caring are drawn to healing
      if (criticalHp || exhausted) s -= 70;
      else if (hurt) s -= 30;
      else if (weary) s -= 25;
      if (drunk) s -= 40; // nobody operates drunk
      return s;
    }
    case ACT_CONSTRUCT: {
      // Construction: builders raise the kingdom's real buildings. A human
      // builder shows up when there's an active project — and especially
      // when they're carrying materials the project needs. No project, no
      // work. The hurt and weary stay home.
      const c = construct ?? { constructionLevel: 1, hasProject: false, donatableCount: 0 };
      if (!c.hasProject) return 4; // nothing being built
      let s = 22;
      if ((c.donatableCount ?? 0) > 0) s += 14; // carrying needed materials
      s += Math.min((c.constructionLevel ?? 1) * 0.3, 10); // skill matters
      if (goalType === GOAL_MASTER_TRADE) s += 6; // construction pays
      if (criticalHp || exhausted) s -= 70;
      else if (hurt) s -= 30;
      else if (weary) s -= 25;
      if (drunk) s -= 20;
      if (mood < 20) s -= 8;
      return s;
    }
    case ACT_TEAMPLAY: {
      // Team leagues: citizens play for real teams in real seasons. A human
      // athlete trains with their team when they're on one — and the
      // competitive join a team when there's space. Fans follow their team.
      // The hurt and weary stay home; nobody plays drunk well.
      const lg = league ?? { onTeam: false, teamName: null, fanOf: null, hasLeague: false };
      if (!lg.hasLeague) return 4; // no league in this kingdom
      let s = 14;
      if (lg.onTeam) s += 16; // on a team — training matters
      else s += 4; // not on a team — might join, might just watch
      const competitive = personality?.competitive ?? personality?.driven ?? 0;
      if (competitive > 0.7) s += 10;
      else if (competitive > 0.5) s += 5;
      if (lg.fanOf) s += 4; // fans follow their team
      if (goalType === GOAL_MAKE_FRIENDS) s += 8; // team sports are social
      if (criticalHp || exhausted) s -= 70;
      else if (hurt) s -= 30;
      else if (weary) s -= 25;
      if (drunk) s -= 20;
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
      // Fame cuts the other way: the famous are welcomed, the infamous
      // shunned. Snapshot carries { score, tier }; the modifier is a pure
      // function of the tier ladder (unknown = 0).
      const repTier = reputation?.tier ?? "unknown";
      if (repTier === "legendary") s += 12;
      else if (repTier === "famous") s += 8;
      else if (repTier === "known") s += 4;
      else if (repTier === "disliked") s -= 4;
      else if (repTier === "notorious") s -= 8;
      else if (repTier === "infamous") s -= 12;
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
  const drunkPenalty = snap.drunk ? 30 : 0;
  const scored = candidates
    .filter((a) => a && typeof a.id === "string")
    .map((a) => ({
      activity: a,
      // Session intents steer the pick: a citizen with "earn 2000 coins"
      // scores work higher. Capped so intents never override critical needs.
      // Sickness keeps citizens away from work: the sicker they are, the
      // less work appeals (a plague is -60: effectively no work at all).
      // Jail is the same: a jailed citizen serves time, not shifts.
      // Drunkenness is similar: a drunk citizen shouldn't operate machinery.
      // Night darkens outdoor labor: nobody sane chops trees in the dark
      // (nightPenalty is already negative, so it adds the penalty).
      score:
        scoreActivity(a.id, snap) +
        intentBonusFor(a.id, player) -
        (sick > 0 && WORK_ACTIVITIES.has(a.id) ? sick : 0) -
        (jailed > 0 && WORK_ACTIVITIES.has(a.id) ? jailed : 0) -
        (drunkPenalty > 0 && WORK_ACTIVITIES.has(a.id) ? drunkPenalty : 0) +
        (night?.nightPenalty < 0 && WORK_ACTIVITIES.has(a.id) ? night.nightPenalty : 0),
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
  ACT_TRAVEL,
  ACT_ENTERTAIN,
  ACT_GUILD,
  ACT_PETCARE,
  ACT_CREATEART,
  ACT_PERFORM,
  ACT_FASHION,
  ACT_CUISINE,
  ACT_CELEBRATE,

ACT_COMPETE,
  ACT_DIPLOMAT, ACT_EXPLORE, ACT_LAWYER, ACT_INVENT, ACT_PHILOSOPHIZE, ACT_SURGEON, ACT_CONSTRUCT, ACT_TEAMPLAY,  ACT_MEAL,
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
