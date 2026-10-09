const { Skill } = require("../../src/main/typescript/elvarg/game/model/Skill");
const { Item } = require("../../src/main/typescript/elvarg/game/model/Item");
const { Animation } = require("../../src/main/typescript/elvarg/game/model/Animation");
const { Sound } = require("../../src/main/typescript/elvarg/game/Sound");
const { Sounds } = require("../../src/main/typescript/elvarg/game/Sounds");
const { ItemIds } = require("../../src/main/typescript/elvarg/util/IdEnums");
const { Task } = require("../../src/main/typescript/elvarg/game/task/Task");

const HERB_CLEAN_DELAY_MS = 150;
const HERBLORE_ANIM = new Animation(363);

// Ticks between herb actions in a bot session (matches the hand-click pace).
const HERB_INTERVAL_TICKS = 4;
const HERB_INITIAL_DELAY_TICKS = 2;

// Active bot herblore sessions: player -> { recipe, remaining, nextActionTick }
const ACTIVE_HERBLORE_SESSIONS = new Map();
let pluginApi = null;
let TaskManager = null;
let herbloreTick = 0;

const CLEANABLE_HERBS = new Map([
  [ItemIds.GRIMY_GUAM_LEAF, { clean: ItemIds.GUAM_LEAF, level: 1, xp: 2 }],
  [ItemIds.GRIMY_MARRENTILL, { clean: ItemIds.MARRENTILL, level: 5, xp: 4 }],
  [ItemIds.GRIMY_TARROMIN, { clean: ItemIds.TARROMIN, level: 11, xp: 5 }],
  [ItemIds.GRIMY_HARRALANDER, { clean: ItemIds.HARRALANDER, level: 20, xp: 6 }],
  [ItemIds.GRIMY_RANARR_WEED, { clean: ItemIds.RANARR_WEED, level: 25, xp: 7 }],
  [ItemIds.GRIMY_IRIT_LEAF, { clean: ItemIds.IRIT_LEAF, level: 40, xp: 10 }],
  [ItemIds.GRIMY_AVANTOE, { clean: ItemIds.AVANTOE, level: 48, xp: 12 }],
  [ItemIds.GRIMY_KWUARM, { clean: ItemIds.KWUARM, level: 54, xp: 13 }],
  [ItemIds.GRIMY_CADANTINE, { clean: ItemIds.CADANTINE, level: 65, xp: 14 }],
  [ItemIds.GRIMY_DWARF_WEED, { clean: ItemIds.DWARF_WEED, level: 70, xp: 18 }],
  [ItemIds.GRIMY_TORSTOL, { clean: ItemIds.TORSTOL, level: 75, xp: 21 }],
]);

const UNFINISHED_POTIONS = new Map([
  [ItemIds.GUAM_LEAF, { potion: ItemIds.GUAM_POTION_UNF_, level: 1 }],
  [ItemIds.MARRENTILL, { potion: ItemIds.MARRENTILL_POTION_UNF_, level: 5 }],
  [ItemIds.TARROMIN, { potion: ItemIds.TARROMIN_POTION_UNF_, level: 12 }],
  [ItemIds.HARRALANDER, { potion: ItemIds.HARRALANDER_POTION_UNF_, level: 22 }],
  [ItemIds.RANARR_WEED, { potion: ItemIds.RANARR_POTION_UNF_, level: 30 }],
  [ItemIds.IRIT_LEAF, { potion: ItemIds.IRIT_POTION_UNF_, level: 45 }],
  [ItemIds.AVANTOE, { potion: ItemIds.AVANTOE_POTION_UNF_, level: 50 }],
  [ItemIds.KWUARM, { potion: ItemIds.KWUARM_POTION_UNF_, level: 55 }],
  [ItemIds.CADANTINE, { potion: ItemIds.CADANTINE_POTION_UNF_, level: 66 }],
  [ItemIds.DWARF_WEED, { potion: ItemIds.DWARF_WEED_POTION_UNF_, level: 72 }],
  [ItemIds.TORSTOL, { potion: ItemIds.TORSTOL_POTION_UNF_, level: 78 }],
]);

const FINISHED_POTIONS = new Map([
  [`${ItemIds.GUAM_POTION_UNF_}:${ItemIds.EYE_OF_NEWT}`, { potion: ItemIds.ATTACK_POTION_3_, level: 1, xp: 25 }],
  [`${ItemIds.MARRENTILL_POTION_UNF_}:${ItemIds.UNICORN_HORN_DUST}`, { potion: ItemIds.ANTIPOISON_3_, level: 5, xp: 38 }],
  [`${ItemIds.TARROMIN_POTION_UNF_}:${ItemIds.LIMPWURT_ROOT}`, { potion: ItemIds.STRENGTH_POTION_3_, level: 12, xp: 50 }],
  [`${ItemIds.HARRALANDER_POTION_UNF_}:${ItemIds.RED_SPIDERS_EGGS}`, { potion: ItemIds.RESTORE_POTION_3_, level: 22, xp: 63 }],
  [`${ItemIds.RANARR_POTION_UNF_}:${ItemIds.SNAPE_GRASS}`, { potion: ItemIds.PRAYER_POTION_3_, level: 38, xp: 88 }],
  [`${ItemIds.IRIT_POTION_UNF_}:${ItemIds.EYE_OF_NEWT}`, { potion: ItemIds.SUPER_ATTACK_3_, level: 45, xp: 100 }],
  [`${ItemIds.KWUARM_POTION_UNF_}:${ItemIds.LIMPWURT_ROOT}`, { potion: ItemIds.SUPER_STRENGTH_3_, level: 55, xp: 125 }],
  [`${ItemIds.CADANTINE_POTION_UNF_}:${ItemIds.WHITE_BERRIES}`, { potion: ItemIds.SUPER_DEFENCE_3_, level: 66, xp: 150 }],
  [`${ItemIds.DWARF_WEED_POTION_UNF_}:${ItemIds.WINE_OF_ZAMORAK}`, { potion: ItemIds.RANGING_POTION_3_, level: 72, xp: 163 }],
]);

function finishedPotionKey(a, b) {
  return `${a}:${b}`;
}

// Recipe kinds, in the order a human works them: finishing a potion beats
// starting one, and starting one beats cleaning. Same level -> higher kind
// wins, so the "best recipe" is the highest-tier work the citizen can do.
const RECIPE_KIND_PRIORITY = { clean: 1, unfinished: 2, finished: 3 };

/**
 * Bot entry point — work herbs for real Herblore XP, no interface clicking.
 * Finds the best recipe the player's level allows that they actually hold
 * (finished potion > unfinished > cleaning at the same level) and works
 * `amount` items, one per interval tick. Same shape as upstream Smelt.js
 * and our Crafting startBotCrafting: the brain calls this once, the task
 * drives the session.
 */
function startBotHerblore(player, amount) {
  return startHerbloreSession(ACTIVE_HERBLORE_SESSIONS, player, amount);
}

function isHerbloreActive(player) {
  return player != null && ACTIVE_HERBLORE_SESSIONS.has(player);
}

function getHerbloreLevel(player) {
  try {
    return player.getSkillManager().getCurrentLevel(Skill.HERBLORE);
  } catch {
    return 1;
  }
}

/**
 * Best doable recipe: highest level at/below the player's level with the
 * input in the pack (plus the needs-item for unfinished/finished). A human
 * makes the best potion they've got the stuff for.
 */
function findBestHerbloreRecipe(player) {
  const inventory = player.getInventory?.();
  if (!inventory) return null;
  const level = getHerbloreLevel(player);
  let best = null;
  for (const recipe of HERBLORE_RECIPES) {
    if (recipe.level > level) continue;
    if (!inventory.contains(recipe.inputId)) continue;
    if (recipe.needsId && !inventory.contains(recipe.needsId)) continue;
    if (
      !best ||
      recipe.level > best.level ||
      (recipe.level === best.level &&
        RECIPE_KIND_PRIORITY[recipe.kind] > RECIPE_KIND_PRIORITY[best.kind])
    ) {
      best = recipe;
    }
  }
  return best;
}

function startHerbloreSession(activeSessions, player, amount) {
  if (!player || !Number.isInteger(amount) || amount <= 0) {
    return false;
  }

  const recipe = findBestHerbloreRecipe(player);
  if (!recipe) {
    return false;
  }

  stopHerblore(activeSessions, player, false);
  activeSessions.set(player, {
    recipe,
    remaining: amount,
    nextActionTick: herbloreTick + HERB_INITIAL_DELAY_TICKS,
  });
  if (recipe.kind !== "clean") {
    player.performAnimation(HERBLORE_ANIM);
  }
  return true;
}

function stopHerblore(activeSessions, player, sendMessage = true) {
  if (activeSessions.delete(player) && sendMessage) {
    player.sendMessage("You stop mixing herbs.");
  }
}

class HerbloreTask extends Task {
  constructor(activeSessions) {
    super(1);
    this.activeSessions = activeSessions;
  }

  execute() {
    herbloreTick++;

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
          stopHerblore(this.activeSessions, player, false);
          continue;
        }
      } catch {
        // engine read failed; try next tick
      }

      if (this.herbloreTickGuard(session)) continue;

      // Work one item: the same inventory/XP/animation/sound writes as the
      // hand-click paths, so bot and player results never disagree.
      try {
        const inventory = player.getInventory();
        const { recipe } = session;
        if (!inventory.contains(recipe.inputId)) {
          stopHerblore(this.activeSessions, player, false);
          continue;
        }
        if (recipe.needsId && !inventory.contains(recipe.needsId)) {
          stopHerblore(this.activeSessions, player, false);
          continue;
        }
        if (recipe.kind === "clean") {
          inventory.deleteNumber(recipe.inputId, 1);
          inventory.addItem(new Item(recipe.outputId, 1));
          player.getSkillManager().addExperiences(Skill.HERBLORE, recipe.xp);
        } else {
          player.performAnimation(HERBLORE_ANIM);
          Sounds.sendSound(player, Sound.POTION_MIX);
          inventory.deleteNumber(recipe.inputId, 1);
          inventory.deleteNumber(recipe.needsId, 1);
          inventory.addItem(new Item(recipe.outputId, 1));
          player.getSkillManager().addExperiences(Skill.HERBLORE, recipe.xp);
        }
        session.remaining -= 1;
        if (session.remaining <= 0) {
          stopHerblore(this.activeSessions, player, false);
        }
      } catch {
        stopHerblore(this.activeSessions, player, false);
      }
    }
  }

  herbloreTickGuard(session) {
    if (herbloreTick < session.nextActionTick) return true;
    session.nextActionTick = herbloreTick + HERB_INTERVAL_TICKS;
    return false;
  }
}

module.exports = {
  name: "Herblore",
  members: true,
  // Data-driven recipes for bots: derived from the hand-path tables so the
  // hand-clean/unf/finish and bot paths never disagree on level/xp.
  HERBLORE_RECIPES: [
    ...[...CLEANABLE_HERBS.entries()].map(([grimyId, herb]) => ({
      kind: "clean",
      name: "Clean herb",
      inputId: grimyId,
      needsId: null,
      outputId: herb.clean,
      level: herb.level,
      xp: herb.xp,
    })),
    ...[...UNFINISHED_POTIONS.entries()].map(([herbId, unf]) => ({
      kind: "unfinished",
      name: "Mix unfinished potion",
      inputId: herbId,
      needsId: ItemIds.VIAL_OF_WATER,
      outputId: unf.potion,
      level: unf.level,
      xp: 10,
    })),
    ...[...FINISHED_POTIONS.entries()].map(([key, fin]) => {
      const [inputId, needsId] = key.split(":").map(Number);
      return {
        kind: "finished",
        name: "Mix potion",
        inputId,
        needsId,
        outputId: fin.potion,
        level: fin.level,
        xp: fin.xp,
      };
    }),
  ],
  startBotHerblore,
  isHerbloreActive,
  register(api) {
    pluginApi = api;
    TaskManager = api.getTaskManager();
    TaskManager.submit(new HerbloreTask(ACTIVE_HERBLORE_SESSIONS));

    api.onPlayerDisconnect(({ player }) => {
      stopHerblore(ACTIVE_HERBLORE_SESSIONS, player, false);
    });
    api.onPlayerLevelUp(({ player, skill }) => {
      if (skill === Skill.HERBLORE) {
        stopHerblore(ACTIVE_HERBLORE_SESSIONS, player, false);
      }
    });

    api.onItemFirstAction((event) => {
      const { player, itemId, slot } = event;
      const herb = CLEANABLE_HERBS.get(itemId);
      if (!herb) {
        return false;
      }

      if (!player.getClickDelay().elapsedTime(HERB_CLEAN_DELAY_MS)) {
        return true;
      }

      if (player.getSkillManager().getCurrentLevel(Skill.HERBLORE) < herb.level) {
        player.sendMessage(
          `You need a Herblore level of at least ${herb.level} to clean this leaf.`
        );
        return true;
      }

      player.getInventory().deleteAtSlot(slot, 1);
      player.getInventory().addItem(new Item(herb.clean, 1));
      player.getSkillManager().addExperiences(Skill.HERBLORE, herb.xp);
      player.sendMessage("You clean the dirt off the leaf.");
      player.getClickDelay().reset();
      return true;
    });

    api.onItemOnItem((event) => {
      const { player, usedItemId, usedWithItemId } = event;
      const hasVialWater =
        usedItemId === ItemIds.VIAL_OF_WATER ||
        usedWithItemId === ItemIds.VIAL_OF_WATER;
      if (hasVialWater) {
        const herbId =
          usedItemId === ItemIds.VIAL_OF_WATER ? usedWithItemId : usedItemId;
        const unfinished = UNFINISHED_POTIONS.get(herbId);
        if (!unfinished) {
          return;
        }

        if (
          player.getSkillManager().getCurrentLevel(Skill.HERBLORE) <
          unfinished.level
        ) {
          player.sendMessage(
            `You need a Herblore level of at least ${unfinished.level} to do this.`
          );
          event.handled = true;
          return;
        }

        player.performAnimation(HERBLORE_ANIM);
        Sounds.sendSound(player, Sound.POTION_MIX);
        player.getInventory().deleteNumber(ItemIds.VIAL_OF_WATER, 1);
        player.getInventory().deleteNumber(herbId, 1);
        player.getInventory().addItem(new Item(unfinished.potion, 1));
        player.getSkillManager().addExperiences(Skill.HERBLORE, 10);
        event.handled = true;
        return;
      }

      const key1 = finishedPotionKey(usedItemId, usedWithItemId);
      const key2 = finishedPotionKey(usedWithItemId, usedItemId);
      const finished = FINISHED_POTIONS.get(key1) || FINISHED_POTIONS.get(key2);
      if (!finished) {
        return;
      }

      if (player.getSkillManager().getCurrentLevel(Skill.HERBLORE) < finished.level) {
        player.sendMessage(
          `You need a Herblore level of at least ${finished.level} to do this.`
        );
        event.handled = true;
        return;
      }

      player.performAnimation(HERBLORE_ANIM);
      Sounds.sendSound(player, Sound.POTION_MIX);
      player.getInventory().deleteNumber(usedItemId, 1);
      player.getInventory().deleteNumber(usedWithItemId, 1);
      player.getInventory().addItem(new Item(finished.potion, 1));
      player.getSkillManager().addExperiences(Skill.HERBLORE, finished.xp);
      event.handled = true;
    }, { noted: false });

    api.log("registered", {
      cleanables: CLEANABLE_HERBS.size,
      unfinisheds: UNFINISHED_POTIONS.size,
      finisheds: FINISHED_POTIONS.size,
    });
  },
};
