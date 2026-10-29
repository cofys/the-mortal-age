const { Task } = require("../../src/main/typescript/elvarg/game/task/Task");
const { Skill } = require("../../src/main/typescript/elvarg/game/model/Skill");
const { Animation } = require("../../src/main/typescript/elvarg/game/model/Animation");
const { Item } = require("../../src/main/typescript/elvarg/game/model/Item");
const { ItemDefinition } = require("../../src/main/typescript/elvarg/game/definition/ItemDefinition");
const { MapObjects } = require("../../src/main/typescript/elvarg/game/entity/impl/object/MapObjects");
const { Sound } = require("../../src/main/typescript/elvarg/game/Sound");
const { Sounds } = require("../../src/main/typescript/elvarg/game/Sounds");
const { ItemIds, ObjectIds } = require("../../src/main/typescript/elvarg/util/IdEnums");
const { Equipment } = require("../../src/main/typescript/elvarg/game/model/container/impl/Equipment");
const { pauseForLevelUp } = require("./SkillActions");

/**
 * Cooking on fires, ranges and ovens, as rsprox captures show it (recordings 269, 1087, 1098,
 * 1102, 1718, 1723, 3270, 4103, 4283): more than one raw item opens the skillmulti menu; the
 * first food cooks 2 ticks after the choice, the second 3 ticks after that and the rest every 4.
 * Fires and a house's firepits and ovens play human_firecooking, other ranges and ovens
 * human_cooking. Lines go to the spam channel; refusals are message boxes. See docs/cooking.md.
 */
const COOK_SOUND = Sound.COOKING_COOK;
/** Ticks from the choice (or the arrival) to the first food, then to the second, then each after. */
const FIRST_COOK_TICKS = 2;
const SECOND_COOK_TICKS = 3;
const COOK_INTERVAL_TICKS = 4;
const ONE_TYPE_TITLE = "How many would you like to cook?";
const MANY_TYPES_TITLE = "What would you like to cook?";
/** clientscript skillmulti_setup's first argument on every captured cooking menu. */
const COOK_MENU_MODE = 6;
const NOTHING_TO_COOK_MESSAGE = "You haven't got anything to cook.";
const CANNOT_COOK_MESSAGE = "You can't cook that.";
const MEAT_MESSAGE = "You cook a piece of meat.";
/** One more for each food cooked in a row; a burn sets it back to 0 (rsprox captures). */
const SUCCESS_COUNT_VARBIT = "cooking_success_count";
const SUCCESS_COUNT_ATTRIBUTE = "cooking:success-count";
/** Set while the cook loop waits for its first food (rsprox captures). */
const BUSY_VARBIT = "busy";

// Object ids citizens can cook on: lit fires (from Firemaking) and permanent
// ranges. Exposed for the citizen cooking brain action's object search.
const COOK_OBJECT_IDS = Object.freeze([
  ObjectIds.FIRE_5, // 5249 — lit fire
  ObjectIds.FORESTERS_CAMPFIRE, // 49927
  ObjectIds.FORESTERS_CAMPFIRE_2, // 49928
  ObjectIds.FORESTERS_CAMPFIRE_3, // 49929
  ObjectIds.COOKING_RANGE, // 114
  ObjectIds.COOKING_RANGE_2, // 4172
  ObjectIds.RANGE, // 2859
]);

// Bot sessions live at module level so the bot entry point (startBotCooking)
// and the register()-submitted CookingTask share the same map — same shape
// as Crafting's ACTIVE_CRAFTING_SESSIONS.
const ACTIVE_COOKING_SESSIONS = new Map();

// Wiki Cooking range (Lumbridge Castle): only these recipes get its lower burn level.
const COOKABLES = Object.freeze([
  { raw: ItemIds.RAW_BEEF, cooked: ItemIds.COOKED_MEAT, burnt: ItemIds.BURNT_MEAT, level: 1, xp: 30, lumbridgeStopBurn: 31, stopBurn: 34, name: "meat", message: MEAT_MESSAGE },
  { raw: ItemIds.RAW_RAT_MEAT, cooked: ItemIds.COOKED_MEAT, burnt: ItemIds.BURNT_MEAT, level: 1, xp: 30, lumbridgeStopBurn: 31, stopBurn: 34, name: "meat", message: MEAT_MESSAGE },
  { raw: ItemIds.RAW_CHICKEN, cooked: ItemIds.COOKED_CHICKEN, burnt: ItemIds.BURNT_CHICKEN, level: 1, xp: 30, lumbridgeStopBurn: 31, stopBurn: 34, name: "chicken" },
  { raw: ItemIds.RAW_RABBIT, cooked: ItemIds.COOKED_RABBIT, burnt: ItemIds.BURNT_MEAT, level: 1, xp: 30, stopBurn: 37, name: "rabbit", message: "You cook the rabbit." },
  { raw: ItemIds.BREAD_DOUGH, cooked: ItemIds.BREAD, burnt: ItemIds.BURNT_BREAD, level: 1, xp: 40, lumbridgeStopBurn: 34, stopBurn: 38, name: "bread", rangeOnly: true, message: "You successfully bake some bread." },
  { raw: ItemIds.RAW_SHRIMPS, cooked: ItemIds.SHRIMPS, burnt: ItemIds.BURNT_SHRIMP, level: 1, xp: 30, lumbridgeStopBurn: 31, stopBurn: 34, name: "shrimps", article: "some" },
  { raw: ItemIds.RAW_ANCHOVIES, cooked: ItemIds.ANCHOVIES, burnt: ItemIds.BURNT_FISH, level: 1, xp: 30, lumbridgeStopBurn: 31, stopBurn: 34, name: "anchovies", article: "some" },
  { raw: ItemIds.RAW_SARDINE, cooked: ItemIds.SARDINE, burnt: ItemIds.BURNT_FISH_9, level: 1, xp: 40, lumbridgeStopBurn: 34, stopBurn: 38, name: "sardine" },
  { raw: ItemIds.RAW_KARAMBWANJI, cooked: ItemIds.POISON_KARAMBWAN, burnt: ItemIds.POISON_KARAMBWAN, level: 1, xp: 80, stopBurn: 1, name: "poison karambwan" },
  { raw: ItemIds.RAW_UGTHANKI_MEAT, cooked: ItemIds.UGTHANKI_MEAT, burnt: ItemIds.BURNT_MEAT, level: 1, xp: 40, stopBurn: 64, name: "ugthanki meat" },
  { raw: ItemIds.RAW_HERRING, cooked: ItemIds.HERRING, burnt: ItemIds.BURNT_FISH_5, level: 5, xp: 50, lumbridgeStopBurn: 38, stopBurn: 41, name: "herring" },
  { raw: ItemIds.RAW_GUPPY, cooked: ItemIds.GUPPY, burnt: ItemIds.RUINED_GUPPY, level: 7, xp: 12, stopBurn: 34, name: "guppy" },
  { raw: ItemIds.RAW_MACKEREL, cooked: ItemIds.MACKEREL, burnt: ItemIds.BURNT_FISH_5, level: 10, xp: 60, lumbridgeStopBurn: 41, stopBurn: 45, name: "mackerel" },
  { raw: ItemIds.RAW_BIRD_MEAT, cooked: ItemIds.ROAST_BIRD_MEAT, burnt: ItemIds.BURNT_BIRD_MEAT, level: 11, xp: 60, stopBurn: 47, name: "bird meat" },
  { raw: ItemIds.THIN_SNAIL, cooked: ItemIds.THIN_SNAIL_MEAT, burnt: ItemIds.BURNT_SNAIL, level: 12, xp: 70, lumbridgeStopBurn: 43, stopBurn: 47, name: "thin snail", message: "You cook the thin snail." },
  { raw: ItemIds.RAW_TROUT, cooked: ItemIds.TROUT, burnt: ItemIds.BURNT_FISH_3, level: 15, xp: 70, lumbridgeStopBurn: 45, stopBurn: 49, name: "trout" },
  { raw: ItemIds.SPIDER_ON_SHAFT, cooked: ItemIds.SPIDER_ON_SHAFT_5, burnt: ItemIds.BURNT_SPIDER, level: 16, xp: 80, stopBurn: 34, name: "spider on shaft" },
  { raw: ItemIds.LEAN_SNAIL, cooked: ItemIds.LEAN_SNAIL_MEAT, burnt: ItemIds.BURNT_SNAIL, level: 17, xp: 80, lumbridgeStopBurn: 46, stopBurn: 47, name: "lean snail", message: "You cook the lean snail." },
  { raw: ItemIds.RAW_COD, cooked: ItemIds.COD, burnt: ItemIds.BURNT_FISH_3, level: 18, xp: 75, lumbridgeStopBurn: 46, stopBurn: 51, name: "cod" },
  { raw: ItemIds.RAW_PIKE, cooked: ItemIds.PIKE, burnt: ItemIds.BURNT_FISH_3, level: 20, xp: 80, lumbridgeStopBurn: 49, stopBurn: 54, name: "pike" },
  { raw: ItemIds.RAW_CAVEFISH, cooked: ItemIds.CAVEFISH, burnt: ItemIds.RUINED_CAVEFISH, level: 20, xp: 23, stopBurn: 50, name: "cavefish" },
  { raw: ItemIds.RAW_BEAST_MEAT, cooked: ItemIds.ROAST_BEAST_MEAT, burnt: ItemIds.BURNT_BEAST_MEAT, level: 21, xp: 82.5, stopBurn: 58, name: "beast meat" },
  { raw: ItemIds.CRAB_MEAT, cooked: ItemIds.COOKED_CRAB_MEAT, burnt: ItemIds.BURNT_CRAB_MEAT, level: 21, xp: 100, stopBurn: 21, name: "crab meat" },
  { raw: ItemIds.FAT_SNAIL, cooked: ItemIds.FAT_SNAIL_MEAT, burnt: ItemIds.BURNT_SNAIL, level: 22, xp: 95, lumbridgeStopBurn: 51, stopBurn: 56, name: "fat snail", message: "You cook the fat snail." },
  { raw: ItemIds.RAW_SALMON, cooked: ItemIds.SALMON, burnt: ItemIds.BURNT_FISH_3, level: 25, xp: 90, lumbridgeStopBurn: 55, stopBurn: 58, name: "salmon" },
  { raw: ItemIds.RAW_SLIMY_EEL, cooked: ItemIds.COOKED_SLIMY_EEL, burnt: ItemIds.BURNT_EEL, level: 28, xp: 95, stopBurn: 58, name: "slimy eel" },
  { raw: ItemIds.RAW_TUNA, cooked: ItemIds.TUNA, burnt: ItemIds.BURNT_FISH_7, level: 30, xp: 100, stopBurn: 58, name: "tuna", message: "You manage to cook a tuna." },
  { raw: ItemIds.RAW_KARAMBWAN, cooked: ItemIds.COOKED_KARAMBWAN, burnt: ItemIds.BURNT_KARAMBWAN, level: 30, xp: 190, stopBurn: 99, name: "karambwan" },
  { raw: ItemIds.RAW_CHOMPY, cooked: ItemIds.COOKED_CHOMPY, burnt: ItemIds.BURNT_CHOMPY, level: 30, xp: 100, stopBurn: 46, name: "chompy" },
  { raw: ItemIds.RAW_TETRA, cooked: ItemIds.TETRA, burnt: ItemIds.RUINED_TETRA, level: 33, xp: 31, stopBurn: 58, name: "tetra" },
  { raw: ItemIds.RAW_RAINBOW_FISH, cooked: ItemIds.RAINBOW_FISH, burnt: ItemIds.BURNT_RAINBOW_FISH, level: 35, xp: 110, stopBurn: 65, name: "rainbow fish" },
  { raw: ItemIds.RAW_CAVE_EEL, cooked: ItemIds.CAVE_EEL, burnt: ItemIds.BURNT_CAVE_EEL, level: 38, xp: 115, stopBurn: 64, name: "cave eel" },
  { raw: ItemIds.RAW_LOBSTER, cooked: ItemIds.LOBSTER, burnt: ItemIds.BURNT_LOBSTER, level: 40, xp: 120, stopBurn: 74, name: "lobster" },
  { raw: ItemIds.RAW_JUBBLY, cooked: ItemIds.COOKED_JUBBLY, burnt: ItemIds.BURNT_JUBBLY, level: 41, xp: 160, stopBurn: 70, name: "jubbly" },
  { raw: ItemIds.RAW_BASS, cooked: ItemIds.BASS, burnt: ItemIds.BURNT_FISH_7, level: 43, xp: 130, stopBurn: 74, name: "bass", message: "You cook a bass." },
  { raw: ItemIds.RAW_SWORDFISH, cooked: ItemIds.SWORDFISH, burnt: ItemIds.BURNT_SWORDFISH, level: 45, xp: 140, stopBurn: 86, name: "swordfish" },
  { raw: ItemIds.RAW_CATFISH, cooked: ItemIds.CATFISH, burnt: ItemIds.RUINED_CATFISH, level: 46, xp: 43, stopBurn: 65, name: "catfish" },
  { raw: ItemIds.RAW_LAVA_EEL, cooked: ItemIds.LAVA_EEL, burnt: ItemIds.BURNT_EEL, level: 53, xp: 30, stopBurn: 53, name: "lava eel" },
  { raw: ItemIds.RAW_MONKFISH, cooked: ItemIds.MONKFISH, burnt: ItemIds.BURNT_MONKFISH, level: 62, xp: 150, stopBurn: 92, name: "monkfish" },
  { raw: ItemIds.RAW_SHARK, cooked: ItemIds.SHARK, burnt: ItemIds.BURNT_SHARK, level: 80, xp: 210, stopBurn: 94, name: "shark" },
  { raw: ItemIds.RAW_SEA_TURTLE, cooked: ItemIds.SEA_TURTLE, burnt: ItemIds.BURNT_SEA_TURTLE, level: 82, xp: 211.3, stopBurn: 99, name: "sea turtle" },
  { raw: ItemIds.RAW_ANGLERFISH, cooked: ItemIds.ANGLERFISH, burnt: ItemIds.BURNT_ANGLERFISH, level: 84, xp: 230, stopBurn: 98, name: "anglerfish" },
  { raw: ItemIds.RAW_DARK_CRAB, cooked: ItemIds.DARK_CRAB, burnt: ItemIds.BURNT_DARK_CRAB, level: 90, xp: 215, stopBurn: 99, name: "dark crab" },
  { raw: ItemIds.RAW_MANTA_RAY, cooked: ItemIds.MANTA_RAY, burnt: ItemIds.BURNT_MANTA_RAY, level: 91, xp: 216.2, stopBurn: 99, name: "manta ray" },
  // Chambers of Xeric fish and bats (Wiki levels and XP; burn levels not on the Wiki).
  { raw: 20855, cooked: 20856, burnt: 20854, level: 1, xp: 10, stopBurn: 21, name: "pysk fish" },
  { raw: 20857, cooked: 20858, burnt: 20854, level: 15, xp: 13, stopBurn: 35, name: "suphi fish" },
  { raw: 20859, cooked: 20860, burnt: 20854, level: 30, xp: 16, stopBurn: 50, name: "leckish fish" },
  { raw: 20861, cooked: 20862, burnt: 20854, level: 45, xp: 19, stopBurn: 65, name: "brawk fish" },
  { raw: 20863, cooked: 20864, burnt: 20854, level: 60, xp: 22, stopBurn: 75, name: "mycil fish" },
  { raw: 20865, cooked: 20866, burnt: 20854, level: 75, xp: 25, stopBurn: 85, name: "roqed fish" },
  { raw: 20867, cooked: 20868, burnt: 20854, level: 90, xp: 28, stopBurn: 97, name: "kyren fish" },
  { raw: 20870, cooked: 20871, burnt: 20869, level: 1, xp: 10, stopBurn: 21, name: "guanic bat" },
  { raw: 20872, cooked: 20873, burnt: 20869, level: 15, xp: 13, stopBurn: 35, name: "prael bat" },
  { raw: 20874, cooked: 20875, burnt: 20869, level: 30, xp: 16, stopBurn: 50, name: "giral bat" },
  { raw: 20876, cooked: 20877, burnt: 20869, level: 45, xp: 19, stopBurn: 65, name: "phluxia bat" },
  { raw: 20878, cooked: 20879, burnt: 20869, level: 60, xp: 22, stopBurn: 75, name: "kryket bat" },
  { raw: 20880, cooked: 20881, burnt: 20869, level: 75, xp: 25, stopBurn: 85, name: "murng bat" },
  { raw: 20882, cooked: 20883, burnt: 20869, level: 90, xp: 28, stopBurn: 97, name: "psykk bat" },
]);

const COOKABLE_BY_RAW = new Map(COOKABLES.map((cookable) => [cookable.raw, cookable]));

/**
 * Wiki (Cooked meat): unlike other food it can be burnt on purpose on a fire or range, for no
 * XP. Kept apart from COOKABLES so content that cooks raw food leaves it alone.
 */
const DELIBERATE_BURNS = new Map([
  [ItemIds.COOKED_MEAT, { raw: ItemIds.COOKED_MEAT, cooked: ItemIds.BURNT_MEAT, burnt: ItemIds.BURNT_MEAT, level: 1, xp: 0, stopBurn: 1, name: "meat", deliberate: true, message: "You deliberately burn the nicely cooked meat." }],
]);

function cookableFor(itemId) {
  return COOKABLE_BY_RAW.get(itemId) ?? DELIBERATE_BURNS.get(itemId);
}

// Wiki: cooking a raw karambwan yields a poison karambwan until Tinsay teaches
// proper preparation after Tai Bwo Wannai Trio (post-quest Cooking training).
const KARAMBWAN_TAUGHT_ATTRIBUTE = "quest.tai_bwo_wannai_trio.tinsay";
const KARAMBWAN_TAUGHT_VALUE = 8;

function cookedResult(player, cookable) {
  if (cookable.raw !== ItemIds.RAW_KARAMBWAN) return cookable;
  if ((Number(player.getAttribute?.(KARAMBWAN_TAUGHT_ATTRIBUTE)) || 0) >= KARAMBWAN_TAUGHT_VALUE) {
    return cookable;
  }
  return { ...cookable, cooked: ItemIds.POISON_KARAMBWAN, xp: 80, message: "You cook the karambwan. It looks very dodgy." };
}

/** "a shark", "an anglerfish", "some shrimps". */
function withArticle(cookable) {
  const article = cookable.article ?? (/^[aeiou]/i.test(cookable.name) ? "an" : "a");
  return `${article} ${cookable.name}`;
}

function successMessage(cookable) {
  return cookable.message ?? `You successfully cook ${withArticle(cookable)}.`;
}

function burnMessage(cookable) {
  return `You accidentally burn the ${cookable.name}.`;
}

// Fires and a house's firepits cook with human_firecooking, and so do the house's ovens and
// ranges (rsprox captures 269: "Firepit with hook" and "Small oven"). Every other range and
// oven, such as the main-game "Range" and "Oven", cooks with human_cooking.
const FIRE_OBJECT_NAMES = new Set(["Fire", "Forester's Campfire", "Firepit", "Firepit with hook", "Firepit with pot"]);
const HOUSE_RANGE_NAMES = new Set(["Small oven", "Large oven", "Steel range", "Fancy range"]);
const RANGE_OBJECT_NAMES = new Set(["Cooking range", "Range", "Stove", "Oven"]);
const COOKABLE_OBJECT_NAMES = new Set([...RANGE_OBJECT_NAMES, ...HOUSE_RANGE_NAMES, ...FIRE_OBJECT_NAMES]);

function cookAnimationFor(name) {
  const seq = FIRE_OBJECT_NAMES.has(name) || HOUSE_RANGE_NAMES.has(name) ? "human_firecooking" : "human_cooking";
  return new Animation(pluginApi.core.CacheDefinitions.getSeqId(seq));
}

/**
 * Wiki: cooking gauntlets only affect lobster, swordfish, kyatt, monkfish,
 * shark and anglerfish, lowering the level at which they stop burning.
 */
const GAUNTLETS_STOP_BURN = new Map([
  [ItemIds.RAW_LOBSTER, 64],
  [ItemIds.RAW_SWORDFISH, 80],
  [ItemIds.RAW_KYATT, 80],
  [ItemIds.RAW_MONKFISH, 86],
  [ItemIds.RAW_SHARK, 89],
  [ItemIds.RAW_ANGLERFISH, 93],
]);

function stopBurnLevel(player, cookable, objectId) {
  if (objectId !== undefined && objectId === pluginApi?.core?.ObjectIdentifiers.COOKING_RANGE && cookable.lumbridgeStopBurn !== undefined) {
    return cookable.lumbridgeStopBurn;
  }
  const hands = player.getEquipment?.()?.getItems?.()[Equipment.HANDS_SLOT]?.getId?.();
  if (hands !== ItemIds.COOKING_GAUNTLETS) {
    return cookable.stopBurn;
  }
  return GAUNTLETS_STOP_BURN.get(cookable.raw) ?? cookable.stopBurn;
}

/** Wiki: a worn Cooking cape (or max cape) never burns food, and supersedes the gauntlets. */
function wearingCookingCape(player) {
  const request = { player, skill: "COOKING", result: false };
  pluginApi?.emitCustomEvent("skillcape:has-perk", request);
  return request.result === true;
}

/** The Cooking level the skill checks: the current level, raised by content ("skills:level-boost", a league relic's invisible +12). */
function cookingLevelOf(player) {
  const request = { player, skill: Skill.COOKING, boost: 0 };
  pluginApi?.emitCustomEvent("skills:level-boost", request);
  return player.getSkillManager().getCurrentLevel(Skill.COOKING) + Math.max(0, request.boost | 0);
}

/** How many items one cooking cycle cooks ("skills:actions-per-cycle", a league relic's all at once); 1 unless content says more. */
function actionsPerCycle(player) {
  const request = { player, skill: Skill.COOKING, kind: "cook", actions: 1 };
  pluginApi?.emitCustomEvent("skills:actions-per-cycle", request);
  return Math.max(1, request.actions | 0);
}

function isSuccess(player, cookable, objectId) {
  const cookingLevel = cookingLevelOf(player);
  if (wearingCookingCape(player)) {
    return true;
  }
  const stopBurn = stopBurnLevel(player, cookable, objectId);
  if (cookingLevel >= stopBurn) {
    return true;
  }
  if (stopBurn <= cookable.level) {
    return true;
  }

  const burnBonus = 3;
  let burnChance = 45.0 - burnBonus;
  const burnDec = burnChance / (stopBurn - cookable.level);
  burnChance -= (cookingLevel - cookable.level) * burnDec;
  const roll = Math.random() * 100.0;
  return burnChance <= roll;
}

function stopCooking(activeSessions, player, resetAnimation = true) {
  const session = activeSessions.get(player);
  if (!session) {
    return;
  }
  activeSessions.delete(player);
  if (session.cooked === 0) sendVarbit(player, BUSY_VARBIT, 0);
  if (resetAnimation) {
    player.performAnimation(Animation.DEFAULT_RESET_ANIMATION);
  }
}

function spam(player, text) {
  player.getPacketSender().sendTypedMessage(pluginApi.core.ChatType.SPAM, text);
}

function mesbox(player, text) {
  const { DialogueChainBuilder, StatementDialogue } = pluginApi.core;
  player.getDialogueManager().startDialogues(new DialogueChainBuilder().add(new StatementDialogue(0, text)));
}

function sendVarbit(player, name, value) {
  const id = pluginApi.core.CacheDefinitions.getVarbitId(name);
  if (Number.isInteger(id)) player.getPacketSender().sendVarbit(id, value);
}

/** cooking_success_count: up one for a cooked food, back to 0 on a burn (rsprox captures 1098, 1102, 4103). */
function countCook(player, burnt) {
  const count = burnt ? 0 : (Number(player.getAttribute(SUCCESS_COUNT_ATTRIBUTE)) || 0) + 1;
  player.setAttribute(SUCCESS_COUNT_ATTRIBUTE, count);
  sendVarbit(player, SUCCESS_COUNT_VARBIT, count);
}

/** "cooking:count" `{ player, burnt }`: a cook made elsewhere (the Gauntlet's range) moves the same count. */
function countCookEvent(event) {
  if (event?.player) countCook(event.player, event.burnt === true);
}

function sendSuccessCount({ player }) {
  const count = Number(player.getAttribute(SUCCESS_COUNT_ATTRIBUTE)) || 0;
  if (count > 0) sendVarbit(player, SUCCESS_COUNT_VARBIT, count);
}

/** Whether the player may cook this here; says why not in a message box. */
function canCook(player, object, cookable) {
  if (object.getId() === pluginApi.core.ObjectIdentifiers.COOKING_RANGE) {
    const request = { player, key: "cooks_assistant", complete: null };
    pluginApi.emitCustomEvent("quest:is-complete", request);
    if (request.complete !== true) {
      player.sendMessage("You need to complete Cook's Assistant to use this range.");
      return false;
    }
  }
  if (cookingLevelOf(player) < cookable.level) {
    mesbox(player, `You need a Cooking level of ${cookable.level} to cook ${withArticle(cookable)}.`);
    return false;
  }
  return true;
}

/**
 * Cooks `amount` of the food (all of it by default), the first FIRST_COOK_TICKS after this tick.
 * Clicks are handled after the tick's tasks, so the cooking task has already run this tick.
 */
function startCooking(player, object, cookable, activeSessions, amount = Infinity) {
  if (!canCook(player, object, cookable)) return false;
  if (!player.getInventory().contains(cookable.raw)) {
    return false;
  }

  stopCooking(activeSessions, player, false);
  activeSessions.set(player, {
    cookable,
    animation: cookAnimationFor(object.getDefinition().getName()),
    objectId: object.getId(),
    location: object.getLocation().clone(),
    privateArea: object.getPrivateArea(),
    nextCookTick: (cookingTask?.cycle ?? 0) + FIRST_COOK_TICKS,
    cooked: 0,
    remaining: amount,
  });
  sendVarbit(player, BUSY_VARBIT, 1);

  return true;
}

/**
 * Bot entry point — cook raw food for real Cooking XP, no interface
 * clicking. The citizen must already be standing at a real fire or range
 * object (found via object search); the session drives one cook per
 * interval tick until the food runs out, the fire burns out, or the
 * citizen moves. Same shape as upstream Smelt.js: the brain calls this
 * once, the task drives the session.
 */
function startBotCooking(player, object, cookable) {
  if (!player || !object || !cookable) {
    return false;
  }
  const recipe = COOKABLE_BY_RAW.get(cookable.raw ?? cookable.rawId) ?? cookable;
  return startCooking(player, object, recipe, ACTIVE_COOKING_SESSIONS);
}

/** The raw foods in the inventory this cooker takes, once each, in inventory order. */
function carriedCookables(player, onFire) {
  const found = new Map();
  for (const item of player.getInventory().getItems()) {
    if (!item || ItemDefinition.forId(item.getId()).isNoted()) continue;
    const cookable = COOKABLE_BY_RAW.get(item.getId());
    if (cookable && !(cookable.rangeOnly && onFire) && !found.has(cookable.raw)) found.set(cookable.raw, cookable);
  }
  return [...found.values()];
}

/**
 * The cook menu (rsprox captures): one food is "How many would you like to cook?" showing the raw
 * item, several are "What would you like to cook?" showing what they cook into. The most it
 * offers is the most carried of one food. One raw item on its own cooks without a menu.
 */
function offerCook(player, object, cookables, activeSessions) {
  const inventory = player.getInventory();
  if (cookables.length === 1) {
    const [cookable] = cookables;
    if (!canCook(player, object, cookable)) return;
    const carried = inventory.getAmount(cookable.raw);
    if (carried <= 1) {
      startCooking(player, object, cookable, activeSessions, 1);
      return;
    }
    openCookMenu(player, ONE_TYPE_TITLE, [cookable.raw], carried, (id, amount) => {
      startCooking(player, object, cookable, activeSessions, amount);
    });
    return;
  }
  // Keyed by what this player gets (a karambwan is poison until Tinsay's training), valued by the recipe.
  const byProduct = new Map();
  for (const cookable of cookables) {
    const product = cookedResult(player, cookable).cooked;
    if (!byProduct.has(product)) byProduct.set(product, cookable);
  }
  const most = Math.max(...cookables.map((cookable) => inventory.getAmount(cookable.raw)));
  openCookMenu(player, MANY_TYPES_TITLE, [...byProduct.keys()], most, (id, amount) => {
    const cookable = byProduct.get(id);
    if (cookable) startCooking(player, object, cookable, activeSessions, amount);
  });
}

function openCookMenu(player, title, items, most, choose) {
  const { CreationMenu } = pluginApi.core;
  player.getPacketSender().sendCreationMenu(new CreationMenu(title, items, { execute: choose },
    { mode: COOK_MENU_MODE, maxAmount: most, lastAmount: most }));
}

class CookingTask extends Task {
  constructor(activeSessions) {
    super(1);
    this.activeSessions = activeSessions;
    this.cycle = 0;
  }

  execute() {
    this.cycle++;

    for (const [player, session] of this.activeSessions) {
      if (!player || !player.isRegistered() || player.getHitpoints() <= 0) {
        this.activeSessions.delete(player);
        continue;
      }

      if (player.getMovementQueue().size() > 0 || player.getForceMovement() != null) {
        stopCooking(this.activeSessions, player);
        continue;
      }
      if (session.levelUpPaused) continue;

      if (session.remaining <= 0 || !player.getInventory().contains(session.cookable.raw)) {
        stopCooking(this.activeSessions, player);
        continue;
      }

      const object = MapObjects.get(
        session.objectId,
        session.location,
        session.privateArea
      );
      if (!object) {
        stopCooking(this.activeSessions, player);
        continue;
      }

      if (!player.getLocation().isWithinInteractionDistance(object.getLocation())) {
        stopCooking(this.activeSessions, player);
        continue;
      }

      if (this.cycle < session.nextCookTick) {
        continue;
      }
      session.nextCookTick = this.cycle + (session.cooked === 0 ? SECOND_COOK_TICKS : COOK_INTERVAL_TICKS);
      if (session.cooked === 0) sendVarbit(player, BUSY_VARBIT, 0);
      session.cooked++;
      session.remaining--;
      Sounds.sendSound(player, COOK_SOUND);
      player.performAnimation(session.animation);

      // Content may cook several in the one cycle ("skills:actions-per-cycle", a league relic's all at once).
      const actions = actionsPerCycle(player);
      for (let done = 0; done < actions && player.getInventory().contains(session.cookable.raw); done++) {
        cookOne(player, session);
      }
    }
  }
}

function cookOne(player, session) {
  const cookable = cookedResult(player, session.cookable);
  player.getInventory().deleteNumber(session.cookable.raw, 1);
  if (cookable.deliberate) {
    player.getInventory().addItem(new Item(cookable.cooked, 1));
    spam(player, successMessage(cookable));
    return;
  }
  const burnRequest = {
    player,
    rawId: session.cookable.raw,
    itemId: cookable.cooked,
    burn: !isSuccess(player, session.cookable, session.objectId),
  };
  pluginApi.emitCustomEvent("cooking:burn", burnRequest);
  if (!burnRequest.burn) {
    player.getInventory().addItem(new Item(cookable.cooked, 1));
    spam(player, successMessage(cookable));
    countCook(player, false);
    pluginApi.emitCustomEvent("cooking:success", {
      player,
      skill: Skill.COOKING,
      itemId: cookable.cooked,
    });
    player.getSkillManager().addExperiences(Skill.COOKING, cookable.xp);
    pluginApi.emitCustomEvent("skills:produced", { player, skill: Skill.COOKING, itemId: cookable.cooked, amount: 1, xp: cookable.xp, kind: "cook" });
  } else {
    player.getInventory().addItem(new Item(session.cookable.burnt, 1));
    spam(player, burnMessage(cookable));
    countCook(player, true);
  }
}

let TaskManager;
let pluginApi;
let activeSessionsRef = null;
let cookingTask = null;

function isCookingActive(player) {
  return activeSessionsRef?.has(player) === true;
}

/** A cooker this use or click reaches: a fire, or a range or oven with a Cook option. */
function isCooker(definition) {
  const actions = definition.getInteractions() ?? [];
  // A Forester's Campfire has no Cook action; food is used on it directly.
  return COOKABLE_OBJECT_NAMES.has(definition.getName())
    && (!actions.some(Boolean) || actions.includes("Cook") || FIRE_OBJECT_NAMES.has(definition.getName()));
}

function handleCook(event) {
  const definition = event.object.getDefinition();
  if (!isCooker(definition)) return;

  const cookable = cookableFor(event.itemId);
  if (!cookable || (cookable.rangeOnly && FIRE_OBJECT_NAMES.has(definition.getName()))) {
    return;
  }

  event.handled = true;
  offerCook(event.player, event.object, [cookable], activeSessionsRef);
}

/** Anything else used on a cooker, when no other content takes it (rsprox captures 269, 1718). */
function refuseCook(event) {
  if (!isCooker(event.object.getDefinition())) return;
  event.handled = true;
  mesbox(event.player, CANNOT_COOK_MESSAGE);
}

function handleRangeCook(event) {
  const cookables = carriedCookables(event.player, false);
  if (cookables.length === 0) {
    mesbox(event.player, NOTHING_TO_COOK_MESSAGE);
    return;
  }
  offerCook(event.player, event.object, cookables, activeSessionsRef);
}

/** "cooking:cooked": what request.rawId cooks into and the XP, for content that cooks as it gathers (a league relic). */
function answerCooked(request) {
  const cookable = COOKABLE_BY_RAW.get(request.rawId);
  if (cookable) {
    request.cookedId = cookable.cooked;
    request.xp = cookable.xp;
  }
}

/** "cooking:raw-xp": the Cooking XP for cooking request.rawId, e.g. for the infernal harpoon. */
function answerRawXp(request) {
  const cookable = COOKABLE_BY_RAW.get(request.rawId);
  if (cookable) {
    request.xp = cookable.xp;
  }
}

function pauseCooking(event) {
  pauseForLevelUp(event, activeSessionsRef, (player) => stopCooking(activeSessionsRef, player, false));
}

function stopOnDisconnect({ player }) {
  stopCooking(activeSessionsRef, player, false);
}

module.exports = {
  name: "Cooking",
  // Data-driven recipes for bots: derived from the COOKABLES table so the
  // hand-cook and bot paths never disagree on level/xp.
  COOKING_RECIPES: COOKABLES.map((c) => ({
    name: `Cook ${c.name}`,
    rawId: c.raw,
    cookedId: c.cooked,
    burntId: c.burnt,
    level: c.level,
    xp: c.xp,
    stopBurn: c.stopBurn,
    rangeOnly: !!c.rangeOnly,
  })),
  COOK_OBJECT_IDS,
  startBotCooking,
  isCookingActive,
  register(api) {
    pluginApi = api;
    TaskManager = api.getTaskManager();
    // One session map for every path: upstream's register-owned ref IS the
    // fork's module map, so bot sessions (startBotCooking) and the player
    // path share the CookingTask's sessions.
    activeSessionsRef = ACTIVE_COOKING_SESSIONS;
    cookingTask = new CookingTask(activeSessionsRef);
    TaskManager.submit(cookingTask);

    api.persistAttribute(SUCCESS_COUNT_ATTRIBUTE, 0);
    api.onPlayerLogin(sendSuccessCount);
    api.onPlayerDisconnect(stopOnDisconnect);
    api.onCustomEvent("level-up:popup-opened", pauseCooking);
    api.onCustomEvent("cooking:count", countCookEvent);

    api.onItemOnObject(handleCook, { noted: false });
    api.onItemOnObject(refuseCook, { noted: false, fallback: true });
    api.onObjectInteraction("Range", { Cook: handleRangeCook });
    api.onObjectInteraction("Cooking range", { Cook: handleRangeCook });
    api.onObjectInteraction("Stove", { Cook: handleRangeCook });
    api.onObjectInteraction("Oven", { Cook: handleRangeCook });
    api.onObjectInteraction("Small oven", { Cook: handleRangeCook });
    api.onObjectInteraction("Large oven", { Cook: handleRangeCook });
    api.onObjectInteraction("Steel range", { Cook: handleRangeCook });
    api.onObjectInteraction("Fancy range", { Cook: handleRangeCook });
    api.onCustomEvent("cooking:raw-xp", answerRawXp);
    api.onCustomEvent("cooking:cooked", answerCooked);

    api.log("registered", {
      cookables: COOKABLES.length,
      cookObjectNames: COOKABLE_OBJECT_NAMES.size,
    });
  },
  isCookingActive,
  COOKABLE_BY_RAW,
  COOKABLE_OBJECT_NAMES,
  FIRE_OBJECT_NAMES,
  _test: {
    startCooking, offerCook, isSuccess, stopBurnLevel, wearingCookingCape, successMessage, burnMessage, cookAnimationFor,
    GAUNTLETS_STOP_BURN, COOKABLE_BY_RAW, DELIBERATE_BURNS, setApi: (value) => { pluginApi = value; },
  },
};
