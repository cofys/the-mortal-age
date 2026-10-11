/**
 * The island's skilling. The pond, the tree, the fire and the range are tutorial content in OSRS:
 * they give the tutorial's own logs (2511), raw shrimps (2514) and pot of flour (2516), always
 * succeed and report in an item box. Their animation, ticks and xp are the captured ones
 * (data `actions`), and so are the rocks' and the furnace's. The player can't walk away
 * mid-action, as on the island. Smithing runs through the Smithing plugin (its menu is the
 * captured one); this unit gates the anvil and moves the steps on.
 */
const T = require("./Common.TutorialIsland");
const Interface = require("./Interface.TutorialIsland");

const { STEP } = T;
const { actions } = T.data;

let Items, Objects, core;

/** Tutorial trees by the Survival Expert and the bank (cache locs newbietree/newbietree2/...). */
let TREES;

/** Player -> the action in progress; the player can't walk away until it's done. */
const busy = new WeakMap();

function setLocked(player, locked) {
  const queue = player.getMovementQueue();
  if (locked) queue.reset();
  queue.setBlockMovement(locked);
}

function begin(player, key, onDone, ticks, { animation, text, sound } = {}) {
  if (busy.has(player)) return false;
  const token = {};
  busy.set(player, token);
  setLocked(player, true);
  if (animation !== undefined) player.performAnimation(new core.Animation(animation));
  if (sound !== undefined) player.getPacketSender().sendSound(sound, 1, 0);
  if (text) Interface.showActionText(player, key);
  T.later(ticks, () => {
    if (busy.get(player) !== token) return;
    busy.delete(player);
    setLocked(player, false);
    onDone();
  });
  return true;
}

function xp(player, skill, amount) {
  player.getSkillManager().addExperiences(skill, amount);
}

/** Back to the step text after an action text, when the step didn't move on. */
function restoreText(player) {
  Interface.render(player, T.progress(player));
}

function fish(event) {
  const player = event.player;
  if (!player || !T.isActive(player) || !T.atTutorial(player)) return false;
  event.handled = true;
  if (T.progress(player) < STEP.FISH) {
    player.sendMessage("You cannot fish here yet. You must progress further in the tutorial.");
    return true;
  }
  if (!T.hasItem(player, Items.SMALL_FISHING_NET)) {
    player.sendMessage("You need a net to catch these fish.");
    return true;
  }
  if (player.getInventory().getFreeSlots() <= 0) {
    player.sendMessage("You don't have enough inventory space.");
    return true;
  }
  const action = actions.fishing;
  begin(player, "fishing", () => {
    player.getInventory().adds(action.product, 1);
    xp(player, core.Skill.FISHING, action.xp);
    player.performAnimation(new core.Animation(-1));
    if (!T.advanceFrom(player, STEP.FISH, STEP.OPEN_SKILLS)) restoreText(player);
    T.showBoxes(player, [{ item: action.product, text: action.message }]);
  }, action.ticks, { animation: action.animation, text: T.progress(player) === STEP.FISH });
  return true;
}

function chop(player, event) {
  const current = T.progress(player);
  event.handled = true;
  if (current < STEP.CHOP_TREE) {
    player.sendMessage("You cannot cut down this tree yet. You must progress further in the tutorial.");
    return;
  }
  if (current > STEP.SURVIVAL_GATE) {
    // Trees stay open until the survival section is done, so lost logs can be replaced.
    player.sendMessage("Perhaps you've done enough woodcutting now.");
    return;
  }
  if (!T.hasItem(player, Items.BRONZE_AXE)) {
    player.sendMessage("You do not have an axe which you have the woodcutting level to use.");
    return;
  }
  if (player.getInventory().getFreeSlots() <= 0) {
    player.sendMessage("Your inventory is too full to hold any more logs.");
    return;
  }
  const action = actions.woodcutting;
  begin(player, "woodcutting", () => {
    player.getInventory().adds(action.product, 1);
    xp(player, core.Skill.WOODCUTTING, action.xp);
    player.performAnimation(new core.Animation(-1));
    if (!T.advanceFrom(player, STEP.CHOP_TREE, STEP.LIGHT_FIRE)) restoreText(player);
    T.showBoxes(player, [{ item: action.product, text: action.message }]);
  }, action.ticks, { animation: action.animation, text: current === STEP.CHOP_TREE });
}

/** Steps west off the fire, as firemaking does (east, south or north when west is blocked). */
function stepOffFire(player) {
  const queue = player.getMovementQueue();
  for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
    if (queue.canWalk(dx, dy)) {
      queue.walkStep(dx, dy);
      return;
    }
  }
}

function lightFire({ player, usedItemId, usedWithItemId }) {
  if (!player || !T.isActive(player) || !T.atTutorial(player)) return false;
  if (usedItemId !== Items.LOGS_3 && usedWithItemId !== Items.LOGS_3) return false;
  if (T.progress(player) < STEP.LIGHT_FIRE) return true;
  const at = player.getLocation().clone();
  if (core.ObjectManager.existsLocation(at)) {
    player.sendMessage("You can't light a fire here.");
    return true;
  }
  const action = actions.firemaking;
  if (busy.has(player)) return true;
  player.getInventory().deleteNumber(Items.LOGS_3, 1);
  begin(player, "firemaking", () => {
    const fire = new core.GameObject(action.fire, at, 10, 0, player.getPrivateArea());
    core.ObjectManager.register(fire, true);
    T.later(action.fireTicks, () => core.ObjectManager.deregister(fire, true));
    player.getPacketSender().sendSound(action.sound, 1, 0);
    xp(player, core.Skill.FIREMAKING, action.xp);
    player.performAnimation(new core.Animation(-1));
    stepOffFire(player);
    if (!T.advanceFrom(player, STEP.LIGHT_FIRE, STEP.COOK_SHRIMP)) restoreText(player);
  }, action.ticks, { animation: action.animation, text: T.progress(player) === STEP.LIGHT_FIRE });
  return true;
}

function cookShrimp(event) {
  const player = event.player;
  if (!player || !T.isActive(player) || !T.atTutorial(player)) return false;
  if (event.itemId !== Items.RAW_SHRIMPS_3) return false;
  if (T.progress(player) < STEP.COOK_SHRIMP) return true;
  const action = actions.cooking;
  begin(player, "cooking", () => {
    if (player.getInventory().getAmount(Items.RAW_SHRIMPS_3) <= 0) return;
    player.getInventory().deleteNumber(Items.RAW_SHRIMPS_3, 1);
    player.getInventory().adds(action.product, 1);
    xp(player, core.Skill.COOKING, action.xp);
    if (!T.advanceFrom(player, STEP.COOK_SHRIMP, STEP.SURVIVAL_GATE)) restoreText(player);
    T.showBoxes(player, [{ item: action.product, text: action.message }]);
  }, action.ticks, { animation: action.animation, sound: action.sound, text: T.progress(player) === STEP.COOK_SHRIMP });
  return true;
}

function makeDough({ player, usedItemId, usedWithItemId }) {
  if (!player || !T.isActive(player) || !T.atTutorial(player)) return false;
  if (usedItemId !== Items.POT_OF_FLOUR_3 && usedWithItemId !== Items.POT_OF_FLOUR_3) return false;
  if (T.progress(player) < STEP.MAKE_DOUGH) return false;
  const inv = player.getInventory();
  if (inv.getAmount(Items.BUCKET_OF_WATER) <= 0) return false;
  inv.deleteNumber(Items.POT_OF_FLOUR_3, 1);
  inv.deleteNumber(Items.BUCKET_OF_WATER, 1);
  inv.adds(actions.dough.product, 1);
  inv.adds(Items.POT, 1);
  inv.adds(Items.BUCKET, 1);
  T.advanceFrom(player, STEP.MAKE_DOUGH, STEP.BAKE_BREAD);
  T.showBoxes(player, [{ item: actions.dough.product, text: actions.dough.message }]);
  return true;
}

function bake(player, event) {
  event.handled = true;
  if (T.progress(player) < STEP.BAKE_BREAD || player.getInventory().getAmount(Items.BREAD_DOUGH) <= 0) {
    player.sendMessage("You haven't got anything suitable for cooking! The master chef can help you out with that.");
    return true;
  }
  const action = actions.baking;
  begin(player, "baking", () => {
    if (player.getInventory().getAmount(Items.BREAD_DOUGH) <= 0) return;
    player.getInventory().deleteNumber(Items.BREAD_DOUGH, 1);
    player.getInventory().adds(action.product, 1);
    xp(player, core.Skill.COOKING, action.xp);
    if (!T.advanceFrom(player, STEP.BAKE_BREAD, STEP.CHEF_EXIT)) restoreText(player);
    T.showBoxes(player, [{ item: action.product, text: action.message }]);
  }, action.ticks, { animation: action.animation, sound: action.sound, text: T.progress(player) === STEP.BAKE_BREAD });
  return true;
}

function mine(player, event) {
  const current = T.progress(player);
  event.handled = true;
  if (current < STEP.MINE_TIN || !T.hasItem(player, Items.BRONZE_PICKAXE)) {
    player.sendMessage("You are not ready to mine yet. Please follow the tutorial and you'll be mining in no time.");
    return;
  }
  if (player.getInventory().getFreeSlots() <= 0) {
    player.sendMessage("Your inventory is too full to hold any more ore.");
    return;
  }
  const action = actions.mining;
  const tin = event.objectId === Objects.TIN_ROCKS;
  const ore = tin ? action.tin : action.copper;
  begin(player, "mining", () => {
    player.getInventory().adds(ore, 1);
    xp(player, core.Skill.MINING, action.xp);
    player.performAnimation(new core.Animation(-1));
    player.getPacketSender().sendSound(action.sound, 1, 0);
    onMined(player, tin);
  }, action.ticks, { animation: action.animation, text: current === STEP.MINE_TIN || current === STEP.MINE_COPPER });
}

/** The furnace smelts the bronze bar straight away, as captured (no smelting menu on the island). */
function smelt(player, event) {
  if (T.progress(player) < STEP.SMELT) {
    player.sendMessage("This is a furnace for smelting metal. You'll learn how to use it soon.");
    event.handled = true;
    return;
  }
  const inv = player.getInventory();
  if (inv.getAmount(Items.TIN_ORE) <= 0 || inv.getAmount(Items.COPPER_ORE) <= 0) return;
  event.handled = true;
  const action = actions.smelting;
  begin(player, "smelting", () => {
    if (inv.getAmount(Items.TIN_ORE) <= 0 || inv.getAmount(Items.COPPER_ORE) <= 0) return;
    player.performAnimation(new core.Animation(action.animation));
    inv.deleteNumber(Items.TIN_ORE, 1);
    inv.deleteNumber(Items.COPPER_ORE, 1);
    inv.adds(action.product, 1);
    xp(player, core.Skill.SMITHING, action.xp);
    T.advance(player, STEP.BAR_SMELTED);
  }, action.ticks, { animation: action.animation, sound: action.sound });
}

function smith(player, event) {
  const current = T.progress(player);
  if (current < STEP.USE_ANVIL || !T.hasItem(player, Items.HAMMER)) {
    player.sendMessage(current < STEP.BAR_SMELTED
      ? "This is an anvil used for smithing. You'll learn how to use it soon."
      : "You need a hammer to work the metal with. Talk to the mining instructor to get one.");
    event.handled = true;
    return;
  }
  // The smithing menu opens through the Smithing plugin; highlight its dagger once it is up.
  if (T.advanceFrom(player, STEP.USE_ANVIL, STEP.SMITH_DAGGER) || current === STEP.SMITH_DAGGER) {
    T.later(1, () => Interface.showComponentHighlight(player, T.step(STEP.SMITH_DAGGER)));
  }
}

function onObject(event) {
  const player = event.player;
  if (!player || !T.isActive(player) || !T.inTutorial(event.location)) return;
  const id = event.objectId;
  if (TREES.has(id)) return chop(player, event);
  if (id === Objects.OAK_TREE_9) {
    player.sendMessage("You won't be able to chop oak trees until you have a Woodcutting level of 15.");
    event.handled = true;
    return;
  }
  if (id === Objects.RANGE_5) return bake(player, event);
  if (id === Objects.COPPER_ROCKS || id === Objects.TIN_ROCKS) return mine(player, event);
  if (id === Objects.FURNACE_7) return smelt(player, event);
  if (id === Objects.ANVIL_2) return smith(player, event);
}

function onBreadDoughRange(event) {
  const player = event.player;
  if (!player || !T.isActive(player) || !T.atTutorial(player)) return false;
  return bake(player, event);
}

/** Tin, then copper (in either order), then the furnace; each ore in a captured item box. */
function onMined(player, tin) {
  const current = T.progress(player);
  const inv = player.getInventory();
  if (current === STEP.MINE_TIN || current === STEP.MINE_COPPER) {
    const haveTin = inv.getAmount(Items.TIN_ORE) > 0;
    const haveCopper = inv.getAmount(Items.COPPER_ORE) > 0;
    const next = haveTin && haveCopper ? STEP.SMELT : haveTin ? STEP.MINE_COPPER : STEP.MINE_TIN;
    if (next !== current) T.setProgress(player, next);
    else Interface.render(player, current);
  }
  T.showBoxes(player, [{ item: tin ? Items.TIN_ORE : Items.COPPER_ORE, text: `You manage to mine some ${tin ? "tin" : "copper"}.` }]);
}

function onSmeltingSuccess({ player, itemId }) {
  if (itemId === Items.BRONZE_BAR && T.isActive(player)) T.advance(player, STEP.BAR_SMELTED);
}

function onSmithingSuccess({ player, itemId }) {
  if (itemId === Items.BRONZE_DAGGER && T.isActive(player) && T.progress(player) >= STEP.USE_ANVIL) {
    T.advance(player, STEP.MINING_GATE);
  }
}

module.exports = function attach(api) {
  core = api.core;
  Items = core.ItemIdentifiers;
  Objects = core.ObjectIdentifiers;
  TREES = new Set([Objects.TREE_46, Objects.TREE_47, Objects.TREE_49]);
  api.onObjectInteraction(onObject);
  api.onNpcClick([T.IDS.FISHING_SPOT], 1, fish);
  api.onNpcClick([T.IDS.FISHING_SPOT], 2, fish);
  api.onItemOnItem("Tinderbox", "Logs", lightFire, { noted: false });
  api.onItemOnItem("Pot of flour", "Bucket of water", makeDough, { noted: false });
  api.onItemOnObject("Raw shrimps", "Fire", cookShrimp, { noted: false });
  api.onItemOnObject("Bread dough", "Range", onBreadDoughRange, { noted: false });
  api.onCustomEvent("smelting:success", onSmeltingSuccess);
  api.onCustomEvent("smithing:success", onSmithingSuccess);
};
