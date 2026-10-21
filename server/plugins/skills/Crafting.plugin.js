/**
 * Crafting (Wiki: Crafting; facts and capture ids in docs/crafting.md): sewing leather and
 * hides, cutting gems and amethyst, gold and silver jewellery, glassblowing, pottery,
 * spinning and weaving, and battlestaves. Each unit is in ./crafting/.
 *
 * Fork graft (2026-10-21 upstream merge): upstream split Crafting into the
 * ./crafting/ units above; the fork's citizen gem-cutting bot entry point
 * (CitizenCraft requires CRAFTING_RECIPES / startBotCrafting /
 * isCraftingActive from this file) is kept below as a self-contained
 * session task. Its GEMS table is derived from upstream's
 * data/crafting.json gems recipes (same names/levels/XP/animations the
 * hand path in crafting/Gems.Crafting.js resolves), so bot and hand cuts
 * never disagree. The bot path keeps the fork's simpler always-succeed
 * cut (no crush roll, no Jeweller's chisel bonus) as before the split.
 */
const { Skill } = require("../../src/main/typescript/elvarg/game/model/Skill");
const { Item } = require("../../src/main/typescript/elvarg/game/model/Item");
const { Animation } = require("../../src/main/typescript/elvarg/game/model/Animation");
const { Sound } = require("../../src/main/typescript/elvarg/game/Sound");
const { Sounds } = require("../../src/main/typescript/elvarg/game/Sounds");
const { ItemIds } = require("../../src/main/typescript/elvarg/util/IdEnums");
const { Task } = require("../../src/main/typescript/elvarg/game/task/Task");

const Shared = require("./crafting/Shared.Crafting");

// Ticks between gem cuts in a bot session (matches the hand-cut pace).
const CRAFT_INTERVAL_TICKS = 4;
const CRAFT_INITIAL_DELAY_TICKS = 2;

// Active bot crafting sessions: player -> { gem, remaining, nextActionTick }
const ACTIVE_CRAFTING_SESSIONS = new Map();
let craftingTick = 0;

const GEMS = new Map([
  [ItemIds.UNCUT_OPAL, { cut: ItemIds.OPAL, level: 1, xp: 15, animation: 890 }],
  [ItemIds.UNCUT_JADE, { cut: ItemIds.JADE, level: 13, xp: 20, animation: 891 }],
  [ItemIds.UNCUT_RED_TOPAZ, { cut: ItemIds.RED_TOPAZ, level: 16, xp: 25, animation: 892 }],
  [ItemIds.UNCUT_SAPPHIRE, { cut: ItemIds.SAPPHIRE, level: 20, xp: 50, animation: 888 }],
  [ItemIds.UNCUT_EMERALD, { cut: ItemIds.EMERALD, level: 27, xp: 67.5, animation: 889 }],
  [ItemIds.UNCUT_RUBY, { cut: ItemIds.RUBY, level: 34, xp: 85, animation: 887 }],
  [ItemIds.UNCUT_DIAMOND, { cut: ItemIds.DIAMOND, level: 43, xp: 107.5, animation: 886 }],
  [ItemIds.UNCUT_DRAGONSTONE, { cut: ItemIds.DRAGONSTONE, level: 55, xp: 137.5, animation: 885 }],
  [ItemIds.UNCUT_ONYX, { cut: ItemIds.ONYX, level: 67, xp: 167.5, animation: 2717 }],
  [ItemIds.UNCUT_ZENYTE, { cut: ItemIds.ZENYTE, level: 89, xp: 50, animation: 7185 }],
]);

/**
 * Bot entry point — cut uncut gems for real Crafting XP, no interface
 * clicking. Cuts `amount` gems of the best type the player's level allows
 * that they actually hold, one per interval tick. The brain calls this
 * once, the task drives the session.
 */
function startBotCrafting(player, amount) {
  return startCraftingSession(ACTIVE_CRAFTING_SESSIONS, player, amount);
}

function isCraftingActive(player) {
  return player != null && ACTIVE_CRAFTING_SESSIONS.has(player);
}

function getCraftingLevel(player) {
  try {
    return player.getSkillManager().getCurrentLevel(Skill.CRAFTING);
  } catch {
    return 1;
  }
}

/** Best cuttable gem: highest level at/below the player's level they hold. */
function findBestCraftableGem(player) {
  const inventory = player.getInventory?.();
  if (!inventory) return null;
  if (!inventory.contains(ItemIds.CHISEL)) return null;
  const level = getCraftingLevel(player);
  let best = null;
  for (const [uncutId, gem] of GEMS.entries()) {
    if (gem.level > level) continue;
    if (!inventory.contains(uncutId)) continue;
    if (!best || gem.level > best.level) {
      best = { uncutId, ...gem };
    }
  }
  return best;
}

function startCraftingSession(activeSessions, player, amount) {
  if (!player || !Number.isInteger(amount) || amount <= 0) {
    return false;
  }

  const gem = findBestCraftableGem(player);
  if (!gem) {
    return false;
  }

  stopCrafting(activeSessions, player, false);
  activeSessions.set(player, {
    gem,
    remaining: amount,
    nextActionTick: craftingTick + CRAFT_INITIAL_DELAY_TICKS,
  });
  player.performAnimation(new Animation(gem.animation));
  return true;
}

function stopCrafting(activeSessions, player, sendMessage = true) {
  if (activeSessions.delete(player) && sendMessage) {
    player.sendMessage("You stop cutting gems.");
  }
}

class CraftingTask extends Task {
  constructor(activeSessions) {
    super(1);
    this.activeSessions = activeSessions;
  }

  execute() {
    craftingTick++;

    for (const [player, session] of this.activeSessions) {
      if (!player || !player.isRegistered?.() || player.getHitpoints?.() <= 0) {
        this.activeSessions.delete(player);
        continue;
      }

      // Moving or busy — stop, like every other skilling session.
      try {
        if (
          player.getMovementQueue?.().size?.() > 0 ||
          player.getForceMovement?.() != null
        ) {
          stopCrafting(this.activeSessions, player, false);
          continue;
        }
      } catch {
        // engine read failed; try next tick
      }

      if (this.craftingTickGuard(session)) continue;

      // Cut one gem: the same inventory/XP/animation writes as the hand path.
      try {
        const inventory = player.getInventory();
        if (!inventory.contains(session.gem.uncutId)) {
          stopCrafting(this.activeSessions, player, false);
          continue;
        }
        if (!inventory.contains(ItemIds.CHISEL)) {
          stopCrafting(this.activeSessions, player, false);
          continue;
        }
        player.performAnimation(new Animation(session.gem.animation));
        Sounds.sendSound(player, Sound.GEM_CUTTING);
        inventory.deleteNumber(session.gem.uncutId, 1);
        inventory.addItem(new Item(session.gem.cut, 1));
        player.getSkillManager().addExperiences(Skill.CRAFTING, session.gem.xp);
        session.remaining -= 1;
        if (session.remaining <= 0) {
          stopCrafting(this.activeSessions, player, false);
        }
      } catch {
        stopCrafting(this.activeSessions, player, false);
      }
    }
  }

  craftingTickGuard(session) {
    if (craftingTick < session.nextActionTick) return true;
    session.nextActionTick = craftingTick + CRAFT_INTERVAL_TICKS;
    return false;
  }
}

module.exports = {
  name: "Crafting",
  // Data-driven recipes for bots: derived from the GEMS table so the hand-cut
  // and bot paths never disagree on level/xp/animation.
  CRAFTING_RECIPES: [...GEMS.entries()].map(([uncutId, gem]) => ({
    name: `Cut gem`,
    uncutId,
    cutId: gem.cut,
    level: gem.level,
    xp: gem.xp,
    animation: gem.animation,
  })),
  startBotCrafting,
  isCraftingActive,
  register(api) {
    Shared.attach(api);
    require("./crafting/Leather.Crafting")(api);
    require("./crafting/Gems.Crafting")(api);
    require("./crafting/Jewellery.Crafting")(api);
    require("./crafting/Glassblowing.Crafting")(api);
    require("./crafting/Pottery.Crafting")(api);
    require("./crafting/Spinning.Crafting")(api);
    require("./crafting/Battlestaves.Crafting")(api);

    // Fork bot session task + cleanup (upstream units manage their own).
    api.getTaskManager().submit(new CraftingTask(ACTIVE_CRAFTING_SESSIONS));
    api.onPlayerDisconnect(({ player }) => {
      stopCrafting(ACTIVE_CRAFTING_SESSIONS, player, false);
    });
    api.onCustomEvent("level-up:popup-opened", ({ player, skill }) => {
      if (skill === Skill.CRAFTING) {
        stopCrafting(ACTIVE_CRAFTING_SESSIONS, player, false);
      }
    });
  },
};
