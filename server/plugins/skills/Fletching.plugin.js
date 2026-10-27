/**
 * Fletching (docs/fletching.md): every recipe on the Wiki's Fletching page, from
 * data/fletching.json, with menus, messages and animations from rsprox captures.
 *
 * Fork graft (2026-10-21 upstream merge): upstream split Fletching into the
 * ./fletching/ units below; the fork's citizen log-fletching bot entry point
 * (CitizenFletch requires FLETCHING_RECIPES / startBotFletching /
 * isFletchingActive from this file) is kept below as a self-contained
 * session task. FLETCHING_RECIPES is derived from upstream's
 * data/fletching.json "logs" group (single-material recipes only — the
 * multi-material hunters' spear is not bot-fletchable), so bot and hand
 * paths never disagree on level/xp/output. One log every 3 ticks matches
 * the upstream logs group's timing.
 */
const { Skill } = require("../../src/main/typescript/elvarg/game/model/Skill");
const { Item } = require("../../src/main/typescript/elvarg/game/model/Item");
const { Animation } = require("../../src/main/typescript/elvarg/game/model/Animation");
const { Task } = require("../../src/main/typescript/elvarg/game/task/Task");
const { ItemIds } = require("../../src/main/typescript/elvarg/util/IdEnums");

const Shared = require("./fletching/Shared.Fletching");

/** "fletching:shafts": the arrow shafts request.logId fletches into, how many and the XP, for content that fletches as it chops (a league relic); a log with no arrow-shaft recipe answers nothing. */
function answerShafts(request) {
  const shaft = Shared.getCore().ItemIdentifiers.ARROW_SHAFT;
  const recipe = Shared.getRecipes().find((candidate) => candidate.outputId === shaft
    && candidate.materials.some((material) => material.ids.includes(request.logId)));
  if (!recipe) return;
  request.itemId = recipe.outputId;
  request.amount = recipe.amount;
  request.xp = recipe.xp;
}

const UNITS = [
  Shared,
  require("./fletching/Recipes.Fletching"),
  require("./fletching/Spool.Fletching"),
  require("./fletching/Diaries.Fletching"),
];

const FLETCH_ANIMATION = new Animation(1248);
const FLETCH_INTERVAL_TICKS = 3;
const FLETCH_INITIAL_DELAY_TICKS = 2;

// Active bot fletching sessions: player -> { recipe, remaining, nextActionTick }
const ACTIVE_FLETCHING_SESSIONS = new Map();
let pluginApi = null;
let fletchingTick = 0;

const FLETCHING_RECIPES = [
  { name: "log:LOGS:ARROW_SHAFT", inputId: ItemIds.LOGS, needsId: ItemIds.KNIFE, outputId: ItemIds.ARROW_SHAFT, outputAmount: 15, level: 1, xp: 5 },
  { name: "log:LOGS:JAVELIN_SHAFT", inputId: ItemIds.LOGS, needsId: ItemIds.KNIFE, outputId: ItemIds.JAVELIN_SHAFT, outputAmount: 15, level: 3, xp: 5 },
  { name: "log:LOGS:SHORTBOW_U_", inputId: ItemIds.LOGS, needsId: ItemIds.KNIFE, outputId: ItemIds.SHORTBOW_U_, outputAmount: 1, level: 5, xp: 5 },
  { name: "log:LOGS:LONGBOW_U_", inputId: ItemIds.LOGS, needsId: ItemIds.KNIFE, outputId: ItemIds.LONGBOW_U_, outputAmount: 1, level: 10, xp: 10 },
  { name: "log:LOGS:WOODEN_STOCK", inputId: ItemIds.LOGS, needsId: ItemIds.KNIFE, outputId: ItemIds.WOODEN_STOCK, outputAmount: 1, level: 9, xp: 6 },
  { name: "log:OAK_LOGS:ARROW_SHAFT", inputId: ItemIds.OAK_LOGS, needsId: ItemIds.KNIFE, outputId: ItemIds.ARROW_SHAFT, outputAmount: 30, level: 15, xp: 10 },
  { name: "log:OAK_LOGS:OAK_SHORTBOW_U_", inputId: ItemIds.OAK_LOGS, needsId: ItemIds.KNIFE, outputId: ItemIds.OAK_SHORTBOW_U_, outputAmount: 1, level: 20, xp: 16.5 },
  { name: "log:OAK_LOGS:OAK_LONGBOW_U_", inputId: ItemIds.OAK_LOGS, needsId: ItemIds.KNIFE, outputId: ItemIds.OAK_LONGBOW_U_, outputAmount: 1, level: 25, xp: 25 },
  { name: "log:OAK_LOGS:OAK_STOCK", inputId: ItemIds.OAK_LOGS, needsId: ItemIds.KNIFE, outputId: ItemIds.OAK_STOCK, outputAmount: 1, level: 24, xp: 16 },
  { name: "log:WILLOW_LOGS:ARROW_SHAFT", inputId: ItemIds.WILLOW_LOGS, needsId: ItemIds.KNIFE, outputId: ItemIds.ARROW_SHAFT, outputAmount: 45, level: 30, xp: 15 },
  { name: "log:WILLOW_LOGS:WILLOW_SHORTBOW_U_", inputId: ItemIds.WILLOW_LOGS, needsId: ItemIds.KNIFE, outputId: ItemIds.WILLOW_SHORTBOW_U_, outputAmount: 1, level: 35, xp: 33.3 },
  { name: "log:WILLOW_LOGS:WILLOW_LONGBOW_U_", inputId: ItemIds.WILLOW_LOGS, needsId: ItemIds.KNIFE, outputId: ItemIds.WILLOW_LONGBOW_U_, outputAmount: 1, level: 40, xp: 41.5 },
  { name: "log:WILLOW_LOGS:WILLOW_STOCK", inputId: ItemIds.WILLOW_LOGS, needsId: ItemIds.KNIFE, outputId: ItemIds.WILLOW_STOCK, outputAmount: 1, level: 39, xp: 22 },
  { name: "log:TEAK_LOGS:TEAK_STOCK", inputId: ItemIds.TEAK_LOGS, needsId: ItemIds.KNIFE, outputId: ItemIds.TEAK_STOCK, outputAmount: 1, level: 46, xp: 27 },
  { name: "log:MAPLE_LOGS:ARROW_SHAFT", inputId: ItemIds.MAPLE_LOGS, needsId: ItemIds.KNIFE, outputId: ItemIds.ARROW_SHAFT, outputAmount: 60, level: 45, xp: 20 },
  { name: "log:MAPLE_LOGS:MAPLE_SHORTBOW_U_", inputId: ItemIds.MAPLE_LOGS, needsId: ItemIds.KNIFE, outputId: ItemIds.MAPLE_SHORTBOW_U_, outputAmount: 1, level: 50, xp: 50 },
  { name: "log:MAPLE_LOGS:MAPLE_LONGBOW_U_", inputId: ItemIds.MAPLE_LOGS, needsId: ItemIds.KNIFE, outputId: ItemIds.MAPLE_LONGBOW_U_, outputAmount: 1, level: 55, xp: 58.3 },
  { name: "log:MAPLE_LOGS:MAPLE_STOCK", inputId: ItemIds.MAPLE_LOGS, needsId: ItemIds.KNIFE, outputId: ItemIds.MAPLE_STOCK, outputAmount: 1, level: 54, xp: 32 },
  { name: "log:MAHOGANY_LOGS:MAHOGANY_STOCK", inputId: ItemIds.MAHOGANY_LOGS, needsId: ItemIds.KNIFE, outputId: ItemIds.MAHOGANY_STOCK, outputAmount: 1, level: 61, xp: 41 },
  { name: "log:YEW_LOGS:ARROW_SHAFT", inputId: ItemIds.YEW_LOGS, needsId: ItemIds.KNIFE, outputId: ItemIds.ARROW_SHAFT, outputAmount: 75, level: 60, xp: 25 },
  { name: "log:YEW_LOGS:YEW_SHORTBOW_U_", inputId: ItemIds.YEW_LOGS, needsId: ItemIds.KNIFE, outputId: ItemIds.YEW_SHORTBOW_U_, outputAmount: 1, level: 65, xp: 67.5 },
  { name: "log:YEW_LOGS:YEW_LONGBOW_U_", inputId: ItemIds.YEW_LOGS, needsId: ItemIds.KNIFE, outputId: ItemIds.YEW_LONGBOW_U_, outputAmount: 1, level: 70, xp: 75 },
  { name: "log:YEW_LOGS:YEW_STOCK", inputId: ItemIds.YEW_LOGS, needsId: ItemIds.KNIFE, outputId: ItemIds.YEW_STOCK, outputAmount: 1, level: 69, xp: 50 },
  { name: "log:MAGIC_LOGS:ARROW_SHAFT", inputId: ItemIds.MAGIC_LOGS, needsId: ItemIds.KNIFE, outputId: ItemIds.ARROW_SHAFT, outputAmount: 90, level: 75, xp: 30 },
  { name: "log:MAGIC_LOGS:MAGIC_SHORTBOW_U_", inputId: ItemIds.MAGIC_LOGS, needsId: ItemIds.KNIFE, outputId: ItemIds.MAGIC_SHORTBOW_U_, outputAmount: 1, level: 80, xp: 83.3 },
  { name: "log:MAGIC_LOGS:MAGIC_LONGBOW_U_", inputId: ItemIds.MAGIC_LOGS, needsId: ItemIds.KNIFE, outputId: ItemIds.MAGIC_LONGBOW_U_, outputAmount: 1, level: 85, xp: 91.5 },
  { name: "log:MAGIC_LOGS:MAGIC_STOCK", inputId: ItemIds.MAGIC_LOGS, needsId: ItemIds.KNIFE, outputId: ItemIds.MAGIC_STOCK, outputAmount: 1, level: 78, xp: 70 },
  { name: "log:REDWOOD_LOGS:ARROW_SHAFT", inputId: ItemIds.REDWOOD_LOGS, needsId: ItemIds.KNIFE, outputId: ItemIds.ARROW_SHAFT, outputAmount: 105, level: 90, xp: 35 },
  { name: "log:REDWOOD_LOGS:REDWOOD_HIKING_STAFF", inputId: ItemIds.REDWOOD_LOGS, needsId: ItemIds.KNIFE, outputId: ItemIds.REDWOOD_HIKING_STAFF, outputAmount: 1, level: 90, xp: 10.5 },
  { name: "log:ACHEY_TREE_LOGS:OGRE_ARROW_SHAFT", inputId: ItemIds.ACHEY_TREE_LOGS, needsId: ItemIds.KNIFE, outputId: ItemIds.OGRE_ARROW_SHAFT, outputAmount: 2, level: 5, xp: 6.4 },
  { name: "log:CELASTRUS_BARK:BATTLESTAFF", inputId: ItemIds.CELASTRUS_BARK, needsId: ItemIds.KNIFE, outputId: ItemIds.BATTLESTAFF, outputAmount: 1, level: 40, xp: 80 },
  { name: "log:ENT_BRANCH:ATLATL_DART_SHAFT", inputId: ItemIds.ENT_BRANCH, needsId: ItemIds.KNIFE, outputId: ItemIds.ATLATL_DART_SHAFT, outputAmount: 100, level: 74, xp: 30 },
];

function getFletchingLevel(player) {
  try {
    return player.getSkillManager().getCurrentLevel(Skill.FLETCHING);
  } catch {
    return 1;
  }
}

/**
 * Bot entry point — fletch logs for real Fletching XP, no interface clicking.
 * Finds the best knife-on-logs recipe the player's level allows that they
 * actually hold (plus a knife), and works `amount` logs, one per interval
 * tick. Citizens chain from woodcutting: chop logs -> fletch arrow
 * shafts/bows. Highest level recipe wins — a human fletches the best thing
 * they've got the level and logs for.
 */
function findBestFletchingRecipe(player) {
  const inventory = player.getInventory?.();
  if (!inventory) return null;
  if (!inventory.contains(ItemIds.KNIFE)) return null;
  const level = getFletchingLevel(player);
  let best = null;
  for (const recipe of FLETCHING_RECIPES) {
    if (recipe.level > level) continue;
    let logCount = 0;
    try {
      logCount = inventory.getAmount(recipe.inputId);
    } catch {
      logCount = 0;
    }
    if (logCount <= 0) continue;
    if (!best || recipe.level > best.level) {
      best = recipe;
    }
  }
  return best;
}

function startBotFletching(player, amount) {
  if (!player || !Number.isInteger(amount) || amount <= 0) {
    return false;
  }
  const recipe = findBestFletchingRecipe(player);
  if (!recipe) return false;

  stopFletching(ACTIVE_FLETCHING_SESSIONS, player, false);
  ACTIVE_FLETCHING_SESSIONS.set(player, {
    recipe,
    remaining: amount,
    nextActionTick: fletchingTick + FLETCH_INITIAL_DELAY_TICKS,
  });
  player.performAnimation(FLETCH_ANIMATION);
  return true;
}

function isFletchingActive(player) {
  return player != null && ACTIVE_FLETCHING_SESSIONS.has(player);
}

function stopFletching(activeSessions, player, sendMessage = true) {
  if (activeSessions.delete(player) && sendMessage) {
    player.sendMessage("You stop fletching.");
  }
}

class FletchingBotTask extends Task {
  constructor(activeSessions) {
    super(1);
    this.activeSessions = activeSessions;
  }

  execute() {
    fletchingTick++;

    for (const [player, session] of this.activeSessions) {
      if (!player || !player.isRegistered?.() || player.getHitpoints?.() <= 0) {
        this.activeSessions.delete(player);
        continue;
      }

      try {
        if (player.getForceMovement?.() != null) {
          stopFletching(this.activeSessions, player, false);
          continue;
        }
      } catch {
        // engine read failed; try next tick
      }

      if (fletchingTick < session.nextActionTick) continue;
      session.nextActionTick = fletchingTick + FLETCH_INTERVAL_TICKS;

      // Fletch one log: the same inventory/XP/animation writes as the hand
      // path, plus the fork's crafting:produced event CraftingQuality
      // stamps quality from (the hand path emits it in Shared.Fletching).
      try {
        const inventory = player.getInventory();
        const { recipe } = session;
        if (!inventory.contains(recipe.inputId) || !inventory.contains(ItemIds.KNIFE)) {
          stopFletching(this.activeSessions, player, false);
          continue;
        }
        inventory.deleteNumber(recipe.inputId, 1);
        const fletched = new Item(recipe.outputId, recipe.outputAmount);
        pluginApi?.emitCustomEvent("crafting:produced", {
          player,
          item: fletched,
          skill: Skill.FLETCHING,
          requiredLevel: recipe.level,
        });
        inventory.addItem(fletched);
        player.performAnimation(FLETCH_ANIMATION);
        player.getSkillManager().addExperiences(Skill.FLETCHING, recipe.xp);
        session.remaining -= 1;
        if (session.remaining <= 0) {
          stopFletching(this.activeSessions, player, false);
        }
      } catch {
        stopFletching(this.activeSessions, player, false);
      }
    }
  }
}

module.exports = {
  answerShafts,
  name: "Fletching",
  members: true,
  // Bot entry points + recipe table for citizen brains.
  FLETCHING_RECIPES,
  startBotFletching,
  isFletchingActive,
  findBestFletchingRecipe,
  register(api) {
    pluginApi = api;
    for (const unit of UNITS) unit.init?.(api);
    for (const unit of UNITS) unit.attach?.(api);

    // Fork bot session task + cleanup (upstream units manage their own).
    api.getTaskManager().submit(new FletchingBotTask(ACTIVE_FLETCHING_SESSIONS));
    api.onPlayerDisconnect(({ player }) => {
      stopFletching(ACTIVE_FLETCHING_SESSIONS, player, false);
    });
    api.onCustomEvent("level-up:popup-opened", ({ player, skill }) => {
      if (skill === Skill.FLETCHING) {
        stopFletching(ACTIVE_FLETCHING_SESSIONS, player, false);
      }
    });
    api.onCustomEvent("fletching:shafts", answerShafts);
  },
};
