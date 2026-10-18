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

/**
 * Wiki (Crafting#Jewellery): a gold bar used on a furnace with a ring, necklace, amulet or
 * bracelet mould makes the plain gold piece, or the gem-set one when the matching cut gem
 * is carried too. The bar and the gem are used up; the mould is a tool and is kept.
 * Amulets are made unstrung, (u).
 *
 * Each product row is [itemId, Crafting level, XP], in the same order as JEWELLERY_GEMS.
 * shortcut: silver jewellery is not included; add it when extending the furnace recipes.
 */
const JEWELLERY_GEMS = [
  { name: "gold", gemId: null },
  { name: "sapphire", gemId: ItemIds.SAPPHIRE },
  { name: "emerald", gemId: ItemIds.EMERALD },
  { name: "ruby", gemId: ItemIds.RUBY },
  { name: "diamond", gemId: ItemIds.DIAMOND },
  { name: "dragonstone", gemId: ItemIds.DRAGONSTONE },
  { name: "onyx", gemId: ItemIds.ONYX },
  { name: "zenyte", gemId: ItemIds.ZENYTE },
];

const JEWELLERY_TYPES = [
  {
    name: "ring",
    mouldId: ItemIds.RING_MOULD,
    products: [
      [ItemIds.GOLD_RING, 5, 15],
      [ItemIds.SAPPHIRE_RING, 20, 40],
      [ItemIds.EMERALD_RING, 27, 55],
      [ItemIds.RUBY_RING, 34, 70],
      [ItemIds.DIAMOND_RING, 43, 85],
      [ItemIds.DRAGONSTONE_RING, 55, 100],
      [ItemIds.ONYX_RING, 67, 115],
      [ItemIds.ZENYTE_RING, 89, 150],
    ],
  },
  {
    name: "necklace",
    mouldId: ItemIds.NECKLACE_MOULD,
    products: [
      [ItemIds.GOLD_NECKLACE, 6, 20],
      [ItemIds.SAPPHIRE_NECKLACE, 22, 55],
      [ItemIds.EMERALD_NECKLACE, 29, 60],
      [ItemIds.RUBY_NECKLACE, 40, 75],
      [ItemIds.DIAMOND_NECKLACE, 56, 90],
      [ItemIds.DRAGON_NECKLACE, 72, 105],
      [ItemIds.ONYX_NECKLACE, 82, 120],
      [ItemIds.ZENYTE_NECKLACE, 92, 165],
    ],
  },
  {
    name: "amulet",
    mouldId: ItemIds.AMULET_MOULD,
    products: [
      [ItemIds.GOLD_AMULET_U_, 8, 30],
      [ItemIds.SAPPHIRE_AMULET_U_, 24, 65],
      [ItemIds.EMERALD_AMULET_U_, 31, 70],
      [ItemIds.RUBY_AMULET_U_, 50, 85],
      [ItemIds.DIAMOND_AMULET_U_, 70, 100],
      [ItemIds.DRAGONSTONE_AMULET_U_, 80, 150],
      [ItemIds.ONYX_AMULET_U_, 90, 165],
      [ItemIds.ZENYTE_AMULET_U_, 98, 200],
    ],
  },
  {
    name: "bracelet",
    mouldId: ItemIds.BRACELET_MOULD,
    products: [
      [ItemIds.GOLD_BRACELET_2, 7, 25],
      [ItemIds.SAPPHIRE_BRACELET_2, 23, 60],
      [ItemIds.EMERALD_BRACELET, 30, 65],
      [ItemIds.RUBY_BRACELET, 42, 80],
      [ItemIds.DIAMOND_BRACELET, 58, 95],
      [ItemIds.DRAGONSTONE_BRACELET, 74, 110],
      [ItemIds.ONYX_BRACELET, 84, 125],
      [ItemIds.ZENYTE_BRACELET_2, 95, 180],
    ],
  },
];

/**
 * Wiki (Crafting#Jewellery, amulet stringing): a ball of wool used on an unstrung amulet
 * strings it, 4 XP and no level requirement; the wool and the (u) amulet are used up.
 */
const STRING_AMULET_XP = 4;
const STRUNG_AMULETS = new Map([
  [ItemIds.GOLD_AMULET_U_, ItemIds.GOLD_AMULET],
  [ItemIds.SAPPHIRE_AMULET_U_, ItemIds.SAPPHIRE_AMULET],
  [ItemIds.EMERALD_AMULET_U_, ItemIds.EMERALD_AMULET],
  [ItemIds.RUBY_AMULET_U_, ItemIds.RUBY_AMULET],
  [ItemIds.DIAMOND_AMULET_U_, ItemIds.DIAMOND_AMULET],
  [ItemIds.DRAGONSTONE_AMULET_U_, ItemIds.DRAGONSTONE_AMULET],
  [ItemIds.ONYX_AMULET_U_, ItemIds.ONYX_AMULET],
  [ItemIds.ZENYTE_AMULET_U_, ItemIds.ZENYTE_AMULET],
]);

/**
 * Wiki (Leather, Thread, Crafting#Leather) and rsprox captures (recordings 1854, 1857, 1858,
 * 3276): a needle on leather, hard leather or dragon leather opens the skillmulti menu
 * ("How many do you wish to make?", up to the leather carried). Every 3 ticks the player
 * makes one item ("You make ..."), the first 2 ticks after choosing it. A reel of thread lasts
 * five items ("You use up one of your reels of thread."); a costume needle needs none. Items
 * above the player's level stay in the menu and answer with a message box when chosen.
 */
const LEATHER_TASK_ATTRIBUTE = "crafting:leather-task";
const THREAD_USES_ATTRIBUTE = "crafting:thread-uses";
const CRAFTS_PER_THREAD = 5;
const NEEDLES = new Set([ItemIds.NEEDLE, ItemIds.COSTUME_NEEDLE]);
const LEATHER_MENU_TITLE = "How many do you wish to make?";
// skillmulti_setup's first argument for leather menus, as captured.
const LEATHER_MENU_MODE = 0;

/** The three dragonhide items of one colour, in the menu's order: body, vambraces, chaps. */
function dragonhideRecipes(colour, [bodyId, bodyLevel, bodyXp], [vambracesId, vambracesLevel, vambracesXp],
  [chapsId, chapsLevel, chapsXp]) {
  const lower = colour.toLowerCase();
  return [
    { itemId: bodyId, label: `${colour} dragonhide body`, leather: 3, level: bodyLevel, xp: bodyXp,
      made: `a ${lower} dragonhide body`, members: true },
    { itemId: vambracesId, label: `${colour} dragonhide vambraces`, leather: 1, level: vambracesLevel,
      xp: vambracesXp, made: `a pair of ${lower} dragonhide vambraces`, members: true },
    { itemId: chapsId, label: `${colour} dragonhide chaps`, leather: 2, level: chapsLevel, xp: chapsXp,
      made: `a pair of ${lower} dragonhide chaps`, members: true },
  ];
}

/**
 * Leather -> the items it makes, in menu order. `made` completes "You make ..."; every text is
 * captured except the leather boots, cowl and vambraces, which follow the captured pattern.
 */
const LEATHER_RECIPES = new Map([
  [ItemIds.LEATHER, [
    { itemId: ItemIds.LEATHER_GLOVES, leather: 1, level: 1, xp: 13.8, made: "a pair of leather gloves" },
    { itemId: ItemIds.LEATHER_BOOTS, leather: 1, level: 7, xp: 16.25, made: "a pair of leather boots" },
    { itemId: ItemIds.LEATHER_COWL, leather: 1, level: 9, xp: 18.5, made: "a leather cowl" },
    { itemId: ItemIds.LEATHER_VAMBRACES, leather: 1, level: 11, xp: 22, made: "a pair of leather vambraces" },
    { itemId: ItemIds.LEATHER_BODY, leather: 1, level: 14, xp: 25, made: "a leather body" },
    { itemId: ItemIds.LEATHER_CHAPS, leather: 1, level: 18, xp: 27, made: "a pair of leather chaps" },
    { itemId: ItemIds.COIF, leather: 1, level: 38, xp: 37, made: "a coif", members: true },
  ]],
  [ItemIds.HARD_LEATHER, [
    { itemId: ItemIds.HARDLEATHER_BODY, leather: 1, level: 28, xp: 35, made: "a hard leather body" },
  ]],
  [ItemIds.GREEN_DRAGON_LEATHER, dragonhideRecipes("Green",
    [ItemIds.GREEN_DHIDE_BODY, 63, 186], [ItemIds.GREEN_DHIDE_VAMBRACES, 57, 62], [ItemIds.GREEN_DHIDE_CHAPS, 60, 124])],
  [ItemIds.BLUE_DRAGON_LEATHER, dragonhideRecipes("Blue",
    [ItemIds.BLUE_DHIDE_BODY, 71, 210], [ItemIds.BLUE_DHIDE_VAMBRACES, 66, 70], [ItemIds.BLUE_DHIDE_CHAPS, 68, 140])],
  [ItemIds.RED_DRAGON_LEATHER, dragonhideRecipes("Red",
    [ItemIds.RED_DHIDE_BODY, 77, 234], [ItemIds.RED_DHIDE_VAMBRACES, 73, 78], [ItemIds.RED_DHIDE_CHAPS, 75, 156])],
  [ItemIds.BLACK_DRAGON_LEATHER, dragonhideRecipes("Black",
    [ItemIds.BLACK_DHIDE_BODY, 84, 258], [ItemIds.BLACK_DHIDE_VAMBRACES, 79, 86], [ItemIds.BLACK_DHIDE_CHAPS, 82, 172])],
]);

/** human_leather_crafting. */
const LEATHER_CRAFTING_ANIMATION = new Animation(1249);

/** The furnace smelting animation, used for jewellery as well. */
const FURNACE_ANIMATION = new Animation(899);

// crafting_gold components and quantity varp, verified in cache scripts 429 and 2928.
const GOLD_CRAFTING_INTERFACE = 446;
const MAIN_MODAL_TARGET_UID = (161 << 16) | 16;
const JEWELLERY_FIRST_COMPONENTS = [8, 23, 37, 50];
const JEWELLERY_QUANTITIES = new Map([[60, 1], [61, 5], [62, 10], [63, "x"], [64, 28]]);
const MAKE_QUANTITY_VARP = 2224;
const JEWELLERY_MENU_ATTRIBUTE = "crafting:jewellery-menu";
const JEWELLERY_TASK_ATTRIBUTE = "crafting:jewellery-task";

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

function carriedNeedle(inventory) {
  return [...NEEDLES].find((id) => inventory.contains(id));
}

function hasLeatherMaterials(player, materialId, recipe) {
  const inventory = player.getInventory();
  const needle = carriedNeedle(inventory);
  return needle !== undefined &&
    (needle === ItemIds.COSTUME_NEEDLE || inventory.contains(ItemIds.THREAD)) &&
    inventory.getAmount(materialId) >= recipe.leather;
}

/** One use of the carried reel; the fifth uses it up. A costume needle needs no thread. */
function useThread(player) {
  const inventory = player.getInventory();
  if (carriedNeedle(inventory) === ItemIds.COSTUME_NEEDLE) return;
  const uses = (player.getAttribute(THREAD_USES_ATTRIBUTE) ?? 0) + 1;
  if (uses < CRAFTS_PER_THREAD) {
    player.setAttribute(THREAD_USES_ATTRIBUTE, uses);
    return;
  }
  player.setAttribute(THREAD_USES_ATTRIBUTE, 0);
  inventory.deleteNumber(ItemIds.THREAD, 1);
  player.sendMessage("You use up one of your reels of thread.");
}

function craftLeatherItem(player, materialId, recipe) {
  if (!hasLeatherMaterials(player, materialId, recipe)) return false;
  const inventory = player.getInventory();
  inventory.deleteNumber(materialId, recipe.leather);
  inventory.addItem(new Item(recipe.itemId, 1));
  player.getSkillManager().addExperiences(Skill.CRAFTING, recipe.xp);
  player.sendMessage(`You make ${recipe.made}.`);
  useThread(player);
  return true;
}

function startLeatherCraftingTask(player, materialId, recipe, amount) {
  if (player.getSkillManager().getCurrentLevel(Skill.CRAFTING) < recipe.level) {
    const { DialogueChainBuilder, StatementDialogue } = pluginApi.core;
    player.getDialogueManager().startDialogues(new DialogueChainBuilder().add(
      new StatementDialogue(0, `You need a Crafting level of ${recipe.level} to make ${recipe.made}.`)));
    return;
  }
  if (!hasLeatherMaterials(player, materialId, recipe)) return;
  const { Task } = pluginApi.core;

  player.getAttribute(LEATHER_TASK_ATTRIBUTE)?.stop();
  player.performAnimation(LEATHER_CRAFTING_ANIMATION);

  class LeatherCraftingTask extends Task {
    constructor() {
      super(1, player);
      this.ticks = 0;
      this.remaining = amount;
    }
    execute() {
      if (!player.isRegistered() || player.getHitpoints() <= 0 ||
        player.getMovementQueue().size() > 0 || player.getForceMovement() != null ||
        player.getInterfaceId() !== -1 || !hasLeatherMaterials(player, materialId, recipe)) {
        this.stop();
        return;
      }
      // Items on ticks 2, 5, 8 ... after the choice; the animation restarts with each one.
      if (++this.ticks % 3 !== 2) return;
      if (!craftLeatherItem(player, materialId, recipe) || --this.remaining <= 0 ||
        !hasLeatherMaterials(player, materialId, recipe)) {
        this.stop();
        return;
      }
      player.performAnimation(LEATHER_CRAFTING_ANIMATION);
    }
    stop() {
      super.stop();
      if (player.getAttribute(LEATHER_TASK_ATTRIBUTE) === this) {
        player.setAttribute(LEATHER_TASK_ATTRIBUTE, null);
      }
      player.performAnimation(Animation.DEFAULT_RESET_ANIMATION);
    }
  }

  const task = new LeatherCraftingTask();
  player.setAttribute(LEATHER_TASK_ATTRIBUTE, task);
  pluginApi.getTaskManager().submit(task);
}

/** A needle (or costume needle) used on leather, in either order, opens the skillmulti menu. */
function handleNeedleOnLeather(event) {
  const { player, usedItemId, usedWithItemId } = event;
  const needleId = NEEDLES.has(usedItemId) ? usedItemId : usedWithItemId;
  const materialId = needleId === usedItemId ? usedWithItemId : usedItemId;
  if (!NEEDLES.has(needleId) || !LEATHER_RECIPES.has(materialId)) return;
  event.handled = true;

  const inventory = player.getInventory();
  if (needleId !== ItemIds.COSTUME_NEEDLE && !inventory.contains(ItemIds.THREAD)) {
    // ponytail: not in the captures or on the Wiki; replace with the live text when captured.
    player.sendMessage("You need some thread to sew leather.");
    return;
  }

  player.getAttribute(LEATHER_TASK_ATTRIBUTE)?.stop();
  const members = pluginApi.core.WorldDefinition.isMembersWorld();
  const recipes = LEATHER_RECIPES.get(materialId).filter((recipe) => members || !recipe.members);
  const recipeByItem = new Map(recipes.map((recipe) => [recipe.itemId, recipe]));
  const menu = new pluginApi.core.CreationMenu(
    LEATHER_MENU_TITLE,
    recipes.map((recipe) => recipe.itemId),
    {
      execute: (itemId, amount) => {
        const recipe = recipeByItem.get(itemId);
        if (recipe) startLeatherCraftingTask(player, materialId, recipe, amount);
      },
    },
    {
      labels: recipes.map((recipe) => recipe.label ?? pluginApi.core.CacheDefinitions.getItem(recipe.itemId).name),
      maxAmount: inventory.getAmount(materialId),
      mode: LEATHER_MENU_MODE,
    }
  );
  player.getPacketSender().sendCreationMenu(menu);
}

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

/** Wiki glassblowing recipes needed by Legends' Quest and While Guthix Sleeps. */
const GLASSBLOWING = [
  { name: "unpowered orb", itemId: ItemIds.UNPOWERED_ORB, level: 46, xp: 52.5 },
  { name: "lantern lens", itemId: ItemIds.LANTERN_LENS, level: 49, xp: 55 },
];

function shapeGlass(player, recipe) {
  const inventory = player.getInventory();
  if (!inventory.contains(ItemIds.GLASSBLOWING_PIPE) || !inventory.contains(ItemIds.MOLTEN_GLASS)) return;
  if (player.getSkillManager().getCurrentLevel(Skill.CRAFTING) < recipe.level) {
    player.sendMessage(`You need a Crafting level of at least ${recipe.level} to make this.`);
    return;
  }
  inventory.deleteNumber(ItemIds.MOLTEN_GLASS, 1);
  inventory.addItem(new Item(recipe.itemId, 1));
  player.getSkillManager().addExperiences(Skill.CRAFTING, recipe.xp);
  player.sendMessage(`You shape the glass into ${recipe.name}.`);
}

function blowGlass(event) {
  const ids = new Set([event.usedItemId, event.usedWithItemId]);
  if (!ids.has(ItemIds.GLASSBLOWING_PIPE) || !ids.has(ItemIds.MOLTEN_GLASS)) return;
  event.handled = true;
  pluginApi.sendMultiChatboxPrompt(event.player, "What would you like to make?",
    ...GLASSBLOWING.flatMap(recipe => [recipe.name, () => shapeGlass(event.player, recipe)]));
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

function hasJewelleryMaterials(player, type, gemIndex) {
  const gem = JEWELLERY_GEMS[gemIndex];
  const inventory = player.getInventory();
  return inventory.contains(ItemIds.GOLD_BAR) && inventory.contains(type.mouldId) &&
    (gem.gemId === null || inventory.contains(gem.gemId));
}

function craftGoldJewellery(player, type, gemIndex) {
  const [itemId, level, xp] = type.products[gemIndex];
  if (player.getSkillManager().getCurrentLevel(Skill.CRAFTING) < level) {
    player.sendMessage(`You need a Crafting level of at least ${level} to craft this.`);
    return false;
  }
  if (!hasJewelleryMaterials(player, type, gemIndex) ||
      pluginApi.core.PluginManager.emitCanUseItem(player, itemId, "craft") === false) return false;
  const inventory = player.getInventory();
  inventory.deleteNumber(ItemIds.GOLD_BAR, 1);
  const gem = JEWELLERY_GEMS[gemIndex];
  if (gem.gemId !== null) inventory.deleteNumber(gem.gemId, 1);
  inventory.addItem(new Item(itemId, 1));
  player.getSkillManager().addExperiences(Skill.CRAFTING, xp);
  Sounds.sendSound(player, Sound.SMELTING);
  return true;
}

function startGoldJewellery(player, menu, type, gemIndex) {
  if (!hasJewelleryMaterials(player, type, gemIndex)) return;
  const { Task } = pluginApi.core;
  const previous = player.getAttribute(JEWELLERY_TASK_ATTRIBUTE);
  previous?.stop();
  player.setAttribute(JEWELLERY_MENU_ATTRIBUTE, null);
  player.setInterfaceId(-1);
  player.getPacketSender().closeSubInterface(MAIN_MODAL_TARGET_UID);
  class JewelleryTask extends Task {
    constructor() {
      super(1, player);
      this.ticks = 0;
      this.remaining = menu.amount;
    }
    execute() {
      if (!player.isRegistered() || player.getHitpoints() <= 0 ||
          player.getMovementQueue().size() > 0 || player.getForceMovement() != null ||
          player.getLocation().getDistance(menu.location) > 2 ||
          player.getInterfaceId() !== -1 || !hasJewelleryMaterials(player, type, gemIndex)) {
        this.stop();
        return;
      }
      this.ticks++;
      if (this.ticks % 3 === 1) player.performAnimation(FURNACE_ANIMATION);
      if (this.ticks % 3 === 0 && (!craftGoldJewellery(player, type, gemIndex) || --this.remaining <= 0)) this.stop();
    }
    stop() {
      super.stop();
      if (player.getAttribute(JEWELLERY_TASK_ATTRIBUTE) === this) player.setAttribute(JEWELLERY_TASK_ATTRIBUTE, null);
      player.performAnimation(Animation.DEFAULT_RESET_ANIMATION);
    }
  }
  const task = new JewelleryTask();
  player.setAttribute(JEWELLERY_TASK_ATTRIBUTE, task);
  pluginApi.getTaskManager().submit(task);
}

function handleGoldJewelleryButton(event) {
  const { player, buttonId } = event;
  if ((buttonId >>> 16) !== GOLD_CRAFTING_INTERFACE || player.getInterfaceId() !== GOLD_CRAFTING_INTERFACE) return;
  const menu = player.getAttribute(JEWELLERY_MENU_ATTRIBUTE);
  if (!menu || player.getLocation().getDistance(menu.location) > 2) return;
  const component = buttonId & 0xffff;
  const amount = JEWELLERY_QUANTITIES.get(component);
  event.handled = true;
  if (amount === "x") {
    player.setEnteredAmountAction({ execute: (value) => {
      if (!Number.isInteger(value) || value <= 0 || player.getAttribute(JEWELLERY_MENU_ATTRIBUTE) !== menu) return;
      menu.amount = Math.min(value, 28);
      player.getPacketSender().sendConfig(MAKE_QUANTITY_VARP, menu.amount);
    } });
    player.getPacketSender().sendEnterAmountPrompt("How many would you like to make?");
  } else if (amount !== undefined) {
    menu.amount = amount;
    player.getPacketSender().sendConfig(MAKE_QUANTITY_VARP, amount === 28 ? 0 : amount);
  } else {
    const typeIndex = JEWELLERY_FIRST_COMPONENTS.findIndex(first => component >= first && component < first + JEWELLERY_GEMS.length);
    if (typeIndex >= 0) startGoldJewellery(player, menu, JEWELLERY_TYPES[typeIndex], component - JEWELLERY_FIRST_COMPONENTS[typeIndex]);
  }
}

/** Gold bar on a furnace opens the cache's complete gold jewellery menu. */
function handleGoldJewellery(event) {
  const { player, object, itemId } = event;
  if (itemId !== ItemIds.GOLD_BAR || !FURNACE_NAMES.has(object?.getDefinition?.()?.getName?.())) return;
  event.handled = true;
  player.getAttribute(JEWELLERY_TASK_ATTRIBUTE)?.stop();
  player.setAttribute(JEWELLERY_MENU_ATTRIBUTE, { amount: 1, location: player.getLocation().clone() });
  player.setInterfaceId(GOLD_CRAFTING_INTERFACE);
  player.getPacketSender().sendConfig(MAKE_QUANTITY_VARP, 1).sendSubInterface(MAIN_MODAL_TARGET_UID, GOLD_CRAFTING_INTERFACE, 0);
}

/** A ball of wool used on an unstrung amulet, in either order. */
function stringAmulet(event) {
  const { player, usedItemId, usedWithItemId } = event;
  const unstrungId = usedItemId === ItemIds.BALL_OF_WOOL ? usedWithItemId : usedItemId;
  const woolId = usedItemId === ItemIds.BALL_OF_WOOL ? usedItemId : usedWithItemId;
  const strungId = STRUNG_AMULETS.get(unstrungId);
  if (woolId !== ItemIds.BALL_OF_WOOL || strungId === undefined) return;

  event.handled = true;
  const inventory = player.getInventory();
  if (!inventory.contains(ItemIds.BALL_OF_WOOL) || !inventory.contains(unstrungId)) return;
  inventory.deleteNumber(ItemIds.BALL_OF_WOOL, 1);
  inventory.deleteNumber(unstrungId, 1);
  inventory.addItem(new Item(strungId, 1));
  player.getSkillManager().addExperiences(Skill.CRAFTING, STRING_AMULET_XP);
  player.sendMessage("You put some string on your amulet.");
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
    api.persistAttribute(THREAD_USES_ATTRIBUTE, 0);
    api.onItemOnItem(cutGem, { noted: false });
    api.onItemOnItem(makeSoftClay, { noted: false });
    api.onItemOnItem(blowGlass, { noted: false });
    api.onItemOnItem(stringAmulet, { noted: false });
    api.onItemOnItem(handleNeedleOnLeather, { noted: false });
    api.onItemOnObject(handlePerfectJewellery, { noted: false });
    api.onItemOnObject(handleGoldJewellery, { noted: false });
    api.onInterfaceActionClick(handleGoldJewelleryButton);
    api.onItemOnObject(handleSilverSickle, { noted: false });
    api.onItemOnObject(handlePotteryItemOnObject, { noted: false });
    api.onObjectInteraction("Potter's Wheel", { Use: usePotterWheel });
    api.onObjectInteraction("Potter's wheel", { Use: usePotterWheel });
    api.onObjectInteraction("Pottery Oven", { Fire: usePotteryOven });

    api.onPlayerDisconnect(({ player }) => {
      stopCrafting(ACTIVE_CRAFTING_SESSIONS, player, false);
    });
    api.onCustomEvent("level-up:popup-opened", ({ player, skill }) => {
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
