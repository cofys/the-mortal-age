const Pickpocket = require("./thieving/Pickpocket.Thieving");
const CoinPouch = require("./thieving/CoinPouch.Thieving");
const Stalls = require("./thieving/Stalls.Thieving");

const STALLS = Stalls._test.STALLS;
const THIEVING_ANIMATION = 881;
let core;
let pluginApi;

/** Weighted stall reward as an Item (the fork bot path's shape; Stalls' own roll returns {item, message}). */
function randomReward(rewards) {
  const totalWeight = rewards.reduce((sum, [, , weight]) => sum + weight, 0);
  let roll = Math.floor(Math.random() * totalWeight);
  for (const reward of rewards) {
    roll -= reward[2];
    if (roll < 0) {
      return new core.Item(core.ItemIds[reward[0]], reward[1]);
    }
  }
  const [itemId, amount] = rewards[rewards.length - 1];
  return new core.Item(core.ItemIds[itemId], amount);
}

/** Thieving level with defensive fallback to 1 (same pattern as Hunter). */
function thievingLevel(player) {
  try {
    const level = player.getSkillManager().getCurrentLevel(core.Skill.THIEVING);
    if (typeof level === "number" && level >= 1) return level;
  } catch {
    // fall through
  }
  return 1;
}

/**
 * Bot entry points (for citizen thieves — same pattern as the other skill
 * plugins' startBot* functions). Stall thieving is synchronous: one steal
 * per call, the brain paces the attempts.
 */

/** Stall object IDs, resolved from the cache by stall name. */
let STALL_OBJECT_IDS = null;
function stallObjectIds() {
  if (STALL_OBJECT_IDS) return STALL_OBJECT_IDS;
  STALL_OBJECT_IDS = [];
  try {
    const {
      CacheDefinitions,
    } = require("../../src/main/typescript/elvarg/game/cache/CacheDefinitions");
    const names = new Set([...STALLS.keys()]);
    const count = CacheDefinitions.getCounts?.().objects ?? 0;
    for (let id = 0; id < count; id++) {
      let name = null;
      try {
        name = CacheDefinitions.getObject(id)?.name;
      } catch {
        /* skip unreadable definitions */
      }
      if (name && names.has(name)) STALL_OBJECT_IDS.push(id);
    }
  } catch {
    /* leave empty — the brain falls back to market proximity */
  }
  return STALL_OBJECT_IDS;
}

/** Unique stall info for the brain/decision layer (deduped by stall record). */
function stallInfo() {
  const seen = new Set();
  const info = [];
  for (const [name, stall] of STALLS) {
    if (seen.has(stall)) continue;
    seen.add(stall);
    info.push({ name, level: stall.level, xp: stall.xp });
  }
  return info;
}

/** Best stall the given Thieving level allows (highest level at/under). */
function bestStallForLevel(level) {
  let best = null;
  for (const s of stallInfo()) {
    if (s.level <= level && (!best || s.level > best.level)) best = s;
  }
  return best;
}

/**
 * Steal from a stall without clicking. Mirrors handleStealFromStall but
 * returns a result object instead of consuming an event. The brain paces
 * attempts itself, so the click delay is not applied here.
 */
function stealFromStallBot(player, stallName, object) {
  const stall = STALLS.get(stallName);
  if (!stall) return { ok: false, reason: "no-stall" };
  let level = 1;
  try {
    level = player.getSkillManager().getCurrentLevel(core.Skill.THIEVING);
  } catch {
    return { ok: false, reason: "no-skill" };
  }
  if (level < stall.level)
    return { ok: false, reason: "level", level: stall.level };
  try {
    if (player.getInventory().isFull()) return { ok: false, reason: "full" };
  } catch {
    return { ok: false, reason: "no-inventory" };
  }
  try {
    if (object?.getLocation?.()) player.setPositionToFace(object.getLocation());
    player.performAnimation(THIEVING_ANIMATION);
    const reward = randomReward(stall.rewards);
    player.getInventory().addItem(reward);
    player.getSkillManager().addExperiences(core.Skill.THIEVING, stall.xp);
    try {
      pluginApi?.emitCustomEvent("thieving:success", {
        player,
        skill: core.Skill.THIEVING,
        petBase: stall.petBase,
      });
    } catch {
      /* non-fatal */
    }
    return {
      ok: true,
      xp: stall.xp,
      itemId: reward.getId(),
      amount: reward.getAmount(),
    };
  } catch {
    return { ok: false, reason: "error" };
  }
}

module.exports = {
  name: "Thieving",
  members: true,
  register(api) {
    core = api.core;
    pluginApi = api;
    Pickpocket.register(api);
    CoinPouch.register(api);
    require("./thieving/Blackjacking.Thieving")(api);
    Stalls(api);
  },
};

module.exports._test = { ...Pickpocket._test, ...Stalls._test };

// Bot entry points for citizen thieves.
module.exports.stealFromStallBot = stealFromStallBot;
module.exports.stallObjectIds = stallObjectIds;
module.exports.stallInfo = stallInfo;
module.exports.bestStallForLevel = bestStallForLevel;
module.exports.thievingLevel = thievingLevel;
module.exports.startBotPickpocket = Pickpocket.startBotPickpocket;
module.exports.pickpocketTargetsForLevel = Pickpocket.pickpocketTargetsForLevel;
