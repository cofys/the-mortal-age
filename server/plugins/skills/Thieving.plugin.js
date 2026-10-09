const { Skill } = require("../../src/main/typescript/elvarg/game/model/Skill");
const { Item } = require("../../src/main/typescript/elvarg/game/model/Item");
const { Animation } = require("../../src/main/typescript/elvarg/game/model/Animation");
const { ItemIds } = require("../../src/main/typescript/elvarg/util/IdEnums");
const Pickpocket = require("./thieving/Pickpocket.Thieving");
const CoinPouch = require("./thieving/CoinPouch.Thieving");

const THIEVING_ANIMATION = new Animation(881);

const STALLS = new Map([
  ["Bakery stall", { petBase: 124066, level: 5, xp: 16, rewards: [[ItemIds.COINS, 20]] }],
  ["Silk stall", { petBase: 68926, level: 20, xp: 24, rewards: [[ItemIds.COINS, 60]] }],
  ["Tea stall", { petBase: 68926, level: 5, xp: 16, rewards: [[ItemIds.COINS, 20]] }],
  ["Fur stall", { petBase: 36490, level: 35, xp: 36, rewards: [[ItemIds.COINS, 100]] }],
  ["Gem stall", { petBase: 36490, level: 75, xp: 160, rewards: [[ItemIds.UNCUT_SAPPHIRE, 1], [ItemIds.UNCUT_EMERALD, 1]] }],
  ["Seed Stall", { petBase: 36490, level: 27, xp: 10, rewards: [[ItemIds.POTATO_SEED, 1], [ItemIds.ONION_SEED, 1]] }],
]);

STALLS.set("Baker's stall", STALLS.get("Bakery stall"));
STALLS.set("Baker's Stall", STALLS.get("Bakery stall"));
STALLS.set("Gem Stall", STALLS.get("Gem stall"));

function randomReward(rewards) {
  const [itemId, maxAmount] = rewards[Math.floor(Math.random() * rewards.length)];
  const amount = Math.max(1, Math.floor(Math.random() * maxAmount) + 1);
  return new Item(itemId, amount);
}

let pluginApi;

function handleStealFromStall(event) {
  const stall = STALLS.get(event.definition.getName());
  if (!stall) {
    return;
  }

  const player = event.player;
  if (player.getSkillManager().getCurrentLevel(Skill.THIEVING) < stall.level) {
    player.sendMessage(`You need a Thieving level of at least ${stall.level} to do this.`);
    event.handled = true;
    return;
  }
  if (!player.getClickDelay().elapsedTime(1000)) {
    event.handled = true;
    return;
  }
  if (player.getInventory().isFull()) {
    player.getInventory().full();
    event.handled = true;
    return;
  }

  player.getClickDelay().reset();
  player.setPositionToFace(event.object.getLocation());
  player.performAnimation(THIEVING_ANIMATION);
  const reward = randomReward(stall.rewards);
  player.getInventory().addItem(reward);
  player.getSkillManager().addExperiences(Skill.THIEVING, stall.xp);
  player.sendMessage(`You steal ${reward.getAmount()} x ${reward.getDefinition().getName()}.`);
  pluginApi.emitCustomEvent("thieving:success", { player, skill: Skill.THIEVING, petBase: stall.petBase });
  event.handled = true;
}

/** Thieving level with defensive fallback to 1 (same pattern as Hunter). */
function thievingLevel(player) {
  try {
    const level = player.getSkillManager().getCurrentLevel(Skill.THIEVING);
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
    level = player.getSkillManager().getCurrentLevel(Skill.THIEVING);
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
    player.getSkillManager().addExperiences(Skill.THIEVING, stall.xp);
    try {
      pluginApi?.emitCustomEvent("thieving:success", {
        player,
        skill: Skill.THIEVING,
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
    pluginApi = api;
    Pickpocket.register(api);
    CoinPouch.register(api);

    for (const name of STALLS.keys()) {
      api.onObjectInteraction(name, { [name === "Seed Stall" ? "Steal from" : "Steal-from"]: handleStealFromStall });
    }

    api.log("registered", {
      pickpocketTargets: Pickpocket.TARGETS.length,
      stallNames: STALLS.size,
    });
  },
};

module.exports._test = Pickpocket._test;

// Bot entry points for citizen thieves.
module.exports.stealFromStallBot = stealFromStallBot;
module.exports.stallObjectIds = stallObjectIds;
module.exports.stallInfo = stallInfo;
module.exports.bestStallForLevel = bestStallForLevel;
module.exports.thievingLevel = thievingLevel;
module.exports.startBotPickpocket = Pickpocket.startBotPickpocket;
module.exports.pickpocketTargetsForLevel = Pickpocket.pickpocketTargetsForLevel;
