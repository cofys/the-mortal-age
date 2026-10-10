const { Skill } = require("../../src/main/typescript/elvarg/game/model/Skill");
const { Item } = require("../../src/main/typescript/elvarg/game/model/Item");
const { Animation } = require("../../src/main/typescript/elvarg/game/model/Animation");
const { Sound } = require("../../src/main/typescript/elvarg/game/Sound");
const { Sounds } = require("../../src/main/typescript/elvarg/game/Sounds");
const { ItemIds } = require("../../src/main/typescript/elvarg/util/IdEnums");
const { Task } = require("../../src/main/typescript/elvarg/game/task/Task");

// Ticks between gem cuts in a bot session (matches the hand-cut pace).
const CRAFT_INTERVAL_TICKS = 4;
const CRAFT_INITIAL_DELAY_TICKS = 2;

// Active bot crafting sessions: player -> { gem, remaining, nextActionTick }
const ACTIVE_CRAFTING_SESSIONS = new Map();
let pluginApi = null;
let TaskManager = null;
let craftingTick = 0;

const GEMS = new Map([
  [ItemIds.UNCUT_OPAL, { cut: ItemIds.OPAL, level: 1, xp: 15, animation: 890 }],
  [ItemIds.UNCUT_JADE, { cut: ItemIds.JADE, level: 13, xp: 20, animation: 891 }],
  [ItemIds.UNCUT_RED_TOPAZ, { cut: ItemIds.RED_TOPAZ, level: 16, xp: 25, animation: 892 }],
  [ItemIds.UNCUT_SAPPHIRE, { cut: ItemIds.SAPPHIRE, level: 20, xp: 50, animation: 888 }],
  [ItemIds.UNCUT_EMERALD, { cut: ItemIds.EMERALD, level: 27, xp: 68, animation: 889 }],
  [ItemIds.UNCUT_RUBY, { cut: ItemIds.RUBY, level: 34, xp: 85, animation: 887 }],
  [ItemIds.UNCUT_DIAMOND, { cut: ItemIds.DIAMOND, level: 43, xp: 108, animation: 886 }],
  [ItemIds.UNCUT_DRAGONSTONE, { cut: ItemIds.DRAGONSTONE, level: 55, xp: 138, animation: 885 }],
  [ItemIds.UNCUT_ONYX, { cut: ItemIds.ONYX, level: 67, xp: 168, animation: 2717 }],
  [ItemIds.UNCUT_ZENYTE, { cut: ItemIds.ZENYTE, level: 89, xp: 200, animation: 7185 }],
]);

/**
 * Wiki ('perfect' necklace/ring, Family Crest): a 'perfect' gold bar, a ruby and the
 * matching mould at a furnace, 40 Crafting; 75 XP necklace, 70 XP ring. The mould is
 * a tool and is kept.
 */
const PERFECT_JEWELLERY = [
  { name: "'perfect' ring", itemId: ItemIds.PERFECT_RING, mouldId: ItemIds.RING_MOULD, level: 40, xp: 70 },
  { name: "'perfect' necklace", itemId: ItemIds.PERFECT_NECKLACE, mouldId: ItemIds.NECKLACE_MOULD, level: 40, xp: 75 },
];

const FURNACE_NAMES = new Set(["Furnace", "Small furnace"]);

const POTTERY_WHEEL_ANIMATION = new Animation(883);

/**
 * Wiki (Crafting#Pottery): soft clay is shaped on a potter's wheel and the unfired piece
 * fired in a pottery oven, which has no Crafting level requirement. Pot, pie dish and bowl
 * are the free-to-play recipes the skill table gives (The Golem and Dragon Slayer I need
 * soft clay and an unfired bowl).
 * ponytail: firing always succeeds; the crack chance below level 14 can be added with the
 * wiki's success curve if failing pottery ever matters.
 */
const POTTERY = [
  { name: "pot", unfiredId: ItemIds.UNFIRED_POT, firedId: ItemIds.POT, level: 1, shapingXp: 6.3, firingXp: 6.3 },
  { name: "pie dish", unfiredId: ItemIds.UNFIRED_PIE_DISH, firedId: ItemIds.PIE_DISH, level: 7, shapingXp: 15, firingXp: 10 },
  { name: "bowl", unfiredId: ItemIds.UNFIRED_BOWL, firedId: ItemIds.BOWL, level: 8, shapingXp: 18, firingXp: 15 },
];

const POTTERY_BY_UNFIRED = new Map(POTTERY.map((recipe) => [recipe.unfiredId, recipe]));

/**
 * Wiki (Soft clay): a container of water (bucket, bowl, jug, vial) on clay makes soft clay
 * and leaves the empty container in the inventory.
 */
const WATER_CONTAINERS = new Map([
  [ItemIds.BUCKET_OF_WATER, ItemIds.BUCKET],
  [ItemIds.BOWL_OF_WATER, ItemIds.BOWL],
  [ItemIds.JUG_OF_WATER, ItemIds.JUG],
  [ItemIds.VIAL_OF_WATER, ItemIds.VIAL],
]);

const POTTER_WHEEL_NAMES = new Set(["Potter's Wheel", "Potter's wheel"]);
const POTTERY_OVEN_NAMES = new Set(["Pottery Oven"]);

function cutGem(event) {
  const { player, usedItemId, usedWithItemId } = event;
  const hasChisel =
    usedItemId === ItemIds.CHISEL || usedWithItemId === ItemIds.CHISEL;
  if (!hasChisel) {
    return;
  }

  const uncutId =
    usedItemId === ItemIds.CHISEL ? usedWithItemId : usedItemId;
  const gem = GEMS.get(uncutId);
  if (!gem) {
    return;
  }

  if (player.getSkillManager().getCurrentLevel(Skill.CRAFTING) < gem.level) {
    player.sendMessage(
      `You need a Crafting level of at least ${gem.level} to cut this gem.`
    );
    event.handled = true;
    return;
  }

  if (!player.getInventory().contains(uncutId)) {
    event.handled = true;
    return;
  }

  player.performAnimation(new Animation(gem.animation));
  Sounds.sendSound(player, Sound.GEM_CUTTING);
  player.getInventory().deleteNumber(uncutId, 1);
  player.getInventory().addItem(new Item(gem.cut, 1));
  player.getSkillManager().addExperiences(Skill.CRAFTING, gem.xp);
  event.handled = true;
}

function craftPerfectJewellery(player, recipe) {
  const inventory = player.getInventory();
  if (player.getSkillManager().getCurrentLevel(Skill.CRAFTING) < recipe.level) {
    player.sendMessage(`You need a Crafting level of at least ${recipe.level} to craft this.`);
    return;
  }
  if (!inventory.contains(ItemIds.PERFECT_GOLD_BAR) || !inventory.contains(ItemIds.RUBY) || !inventory.contains(recipe.mouldId)) {
    return;
  }
  inventory.deleteNumber(ItemIds.PERFECT_GOLD_BAR, 1);
  inventory.deleteNumber(ItemIds.RUBY, 1);
  inventory.addItem(new Item(recipe.itemId, 1));
  player.getSkillManager().addExperiences(Skill.CRAFTING, recipe.xp);
  player.sendMessage(`You craft a ${recipe.name}.`);
}

/**
 * Wiki (Glassblowing): a glassblowing pipe used on molten glass shapes an
 * unpowered orb, 46 Crafting, 52.5 XP; the pipe is kept. Legends' Quest needs
 * one for the trial magic gate.
 */
const GLASSBLOWING = [
  { name: "unpowered orb", itemId: ItemIds.UNPOWERED_ORB, level: 46, xp: 52.5 },
];

function blowGlass(event) {
  const { player, usedItemId, usedWithItemId } = event;
  const ids = new Set([usedItemId, usedWithItemId]);
  if (!ids.has(ItemIds.GLASSBLOWING_PIPE) || !ids.has(ItemIds.MOLTEN_GLASS)) return;
  const recipe = GLASSBLOWING[0];
  event.handled = true;
  if (player.getSkillManager().getCurrentLevel(Skill.CRAFTING) < recipe.level) {
    player.sendMessage(`You need a Crafting level of at least ${recipe.level} to make this.`);
    return;
  }
  const inventory = player.getInventory();
  if (!inventory.contains(ItemIds.MOLTEN_GLASS)) return;
  inventory.deleteNumber(ItemIds.MOLTEN_GLASS, 1);
  inventory.addItem(new Item(recipe.itemId, 1));
  player.getSkillManager().addExperiences(Skill.CRAFTING, recipe.xp);
  player.sendMessage(`You shape the glass into an ${recipe.name}.`);
}

/** Using a 'perfect' gold bar on a furnace, with a ruby and a mould, makes the jewellery. */
function handlePerfectJewellery(event) {
  const { player, object, itemId } = event;
  if (itemId !== ItemIds.PERFECT_GOLD_BAR) return;
  if (!FURNACE_NAMES.has(object?.getDefinition?.()?.getName?.())) return;

  const inventory = player.getInventory();
  const recipes = PERFECT_JEWELLERY.filter(
    (recipe) => inventory.contains(recipe.mouldId) && inventory.contains(ItemIds.RUBY)
  );
  if (recipes.length === 0) return;

  event.handled = true;
  if (recipes.length === 1) {
    craftPerfectJewellery(player, recipes[0]);
    return;
  }
  // Both moulds carried: let the player choose, as the OSRS jewellery interface does.
  pluginApi.sendMultiChatboxPrompt(
    player,
    "What would you like to make?",
    recipes[0].name,
    () => craftPerfectJewellery(player, recipes[0]),
    recipes[1].name,
    () => craftPerfectJewellery(player, recipes[1])
  );
}

/**
 * Wiki (Silver sickle): a silver bar on a furnace with a sickle mould makes a
 * silver sickle, 18 Crafting, 50 XP. The mould is kept. Nature Spirit needs it.
 */
const SILVER_SICKLE_RECIPE = {
  itemId: ItemIds.SILVER_SICKLE,
  mouldId: ItemIds.SICKLE_MOULD,
  level: 18,
  xp: 50,
};

function handleSilverSickle(event) {
  const { player, object, itemId } = event;
  if (itemId !== ItemIds.SILVER_BAR) return;
  if (!FURNACE_NAMES.has(object?.getDefinition?.()?.getName?.())) return;
  const inventory = player.getInventory();
  if (!inventory.contains(SILVER_SICKLE_RECIPE.mouldId)) return;
  event.handled = true;
  if (player.getSkillManager().getCurrentLevel(Skill.CRAFTING) < SILVER_SICKLE_RECIPE.level) {
    player.sendMessage(`You need a Crafting level of at least ${SILVER_SICKLE_RECIPE.level} to craft this.`);
    return;
  }
  if (!inventory.contains(ItemIds.SILVER_BAR)) return;
  inventory.deleteNumber(ItemIds.SILVER_BAR, 1);
  inventory.addItem(new Item(SILVER_SICKLE_RECIPE.itemId, 1));
  player.getSkillManager().addExperiences(Skill.CRAFTING, SILVER_SICKLE_RECIPE.xp);
  player.sendMessage("You craft a silver sickle.");
}

/** Using a container of water on clay softens it and returns the empty container. */
function makeSoftClay(event) {
  const { player, usedItemId, usedWithItemId } = event;
  const waterId = WATER_CONTAINERS.has(usedItemId) ? usedItemId : usedWithItemId;
  const clayId = usedItemId === ItemIds.CLAY ? usedItemId : usedWithItemId;
  if (!WATER_CONTAINERS.has(waterId) || clayId !== ItemIds.CLAY) return;

  const inventory = player.getInventory();
  if (!inventory.contains(ItemIds.CLAY) || !inventory.contains(waterId)) {
    event.handled = true;
    return;
  }
  inventory.deleteNumber(ItemIds.CLAY, 1);
  inventory.deleteNumber(waterId, 1);
  inventory.addItem(new Item(ItemIds.SOFT_CLAY, 1));
  inventory.addItem(new Item(WATER_CONTAINERS.get(waterId), 1));
  event.handled = true;
}

function craftUnfired(player, recipe) {
  const inventory = player.getInventory();
  if (!inventory.contains(ItemIds.SOFT_CLAY)) return;
  player.performAnimation(POTTERY_WHEEL_ANIMATION);
  inventory.deleteNumber(ItemIds.SOFT_CLAY, 1);
  inventory.addItem(new Item(recipe.unfiredId, 1));
  player.getSkillManager().addExperiences(Skill.CRAFTING, recipe.shapingXp);
}

/** Wheel Use (or soft clay used on it): shape one soft clay into an unfired item. */
function usePotterWheel(event) {
  const { player } = event;
  event.handled = true;
  if (!player.getInventory().contains(ItemIds.SOFT_CLAY)) {
    player.sendMessage("You need soft clay to make pottery.");
    return;
  }
  const craftingLevel = player.getSkillManager().getCurrentLevel(Skill.CRAFTING);
  const recipes = POTTERY.filter((recipe) => craftingLevel >= recipe.level);
  if (recipes.length === 1) {
    craftUnfired(player, recipes[0]);
    return;
  }
  pluginApi.sendMultiChatboxPrompt(
    player,
    "What would you like to make?",
    ...recipes.flatMap((recipe) => [recipe.name, () => craftUnfired(player, recipe)])
  );
}

function firePottery(player, recipe) {
  const inventory = player.getInventory();
  if (!inventory.contains(recipe.unfiredId)) return;
  inventory.deleteNumber(recipe.unfiredId, 1);
  inventory.addItem(new Item(recipe.firedId, 1));
  player.getSkillManager().addExperiences(Skill.CRAFTING, recipe.firingXp);
}

/** Oven Fire (or an unfired item used on it): fire one unfired item, no level needed. */
function usePotteryOven(event) {
  const { player } = event;
  event.handled = true;
  const inventory = player.getInventory();
  const recipes = POTTERY.filter((recipe) => inventory.contains(recipe.unfiredId));
  if (recipes.length === 0) {
    player.sendMessage("You have no unfired pottery to fire.");
    return;
  }
  if (recipes.length === 1) {
    firePottery(player, recipes[0]);
    return;
  }
  pluginApi.sendMultiChatboxPrompt(
    player,
    "What would you like to fire?",
    ...recipes.flatMap((recipe) => [recipe.name, () => firePottery(player, recipe)])
  );
}

/** Soft clay on a wheel, unfired pottery on a pottery oven. */
function handlePotteryItemOnObject(event) {
  const objectName = event.object?.getDefinition?.()?.getName?.();
  if (POTTER_WHEEL_NAMES.has(objectName) && event.itemId === ItemIds.SOFT_CLAY) {
    usePotterWheel(event);
  } else if (POTTERY_OVEN_NAMES.has(objectName) && POTTERY_BY_UNFIRED.has(event.itemId)) {
    event.handled = true;
    firePottery(event.player, POTTERY_BY_UNFIRED.get(event.itemId));
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
    pluginApi = api;
    TaskManager = api.getTaskManager();
    TaskManager.submit(new CraftingTask(ACTIVE_CRAFTING_SESSIONS));
    api.onItemOnItem(cutGem, { noted: false });
    api.onItemOnItem(makeSoftClay, { noted: false });
    api.onItemOnItem(blowGlass, { noted: false });
    api.onItemOnObject(handlePerfectJewellery, { noted: false });
    api.onItemOnObject(handleSilverSickle, { noted: false });
    api.onItemOnObject(handlePotteryItemOnObject, { noted: false });
    api.onObjectInteraction("Potter's Wheel", { Use: usePotterWheel });
    api.onObjectInteraction("Potter's wheel", { Use: usePotterWheel });
    api.onObjectInteraction("Pottery Oven", { Fire: usePotteryOven });

    api.onPlayerDisconnect(({ player }) => {
      stopCrafting(ACTIVE_CRAFTING_SESSIONS, player, false);
    });
    api.onPlayerLevelUp(({ player, skill }) => {
      if (skill === Skill.CRAFTING) {
        stopCrafting(ACTIVE_CRAFTING_SESSIONS, player, false);
      }
    });

    api.log("registered", { gems: GEMS.size, perfectJewellery: PERFECT_JEWELLERY.length, pottery: POTTERY.length });
  },
};

/**
 * Bot entry point — cut uncut gems for real Crafting XP, no interface
 * clicking. Cuts `amount` gems of the best type the player's level allows
 * that they actually hold, one per interval tick. Same shape as upstream
 * Smelt.js: the brain calls this once, the task drives the session.
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

      // Cut one gem: the same inventory/XP/animation writes as cutGem.
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
