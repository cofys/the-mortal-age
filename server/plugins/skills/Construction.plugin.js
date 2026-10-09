"use strict";

/**
 * Construction plugin wrapper.
 *
 * The engine's ConstructionPlugin is TypeScript (player-owned houses:
 * hotspots, rooms, interfaces). It is re-exported here untouched — the
 * `default` export contract the plugin loader expects
 * (`imported.default ?? imported`) is preserved.
 *
 * Added on top: the bot entry point citizen carpenters use to build real
 * furniture for real Construction XP without a house instance. The recipe
 * table is derived from the engine's CONSTRUCTION_BUILDABLES
 * (ConstructionData.ts) — level, XP, materials and result item IDs are the
 * real engine values, so the bot path can never disagree with the hand
 * path on what a build costs or pays. The XP flows through SkillManager,
 * so citizen level-up celebrations fire exactly as they do for players.
 *
 * What a bot build does (mirrors buildFurniture's core, minus the house):
 *   1. Level check against the buildable's real level requirement.
 *   2. Hammer + saw must be in the inventory (the engine requires both).
 *   3. Materials deleted from the inventory (real planks, real nails).
 *   4. The furniture item lands in the inventory (real item ID).
 *   5. Real Construction XP via SkillManager.
 *   6. Build animation (3676, the engine's furniture build anim).
 */

const tsModule =
  require("../../src/main/typescript/elvarg/game/plugin/impl/construction/ConstructionPlugin");
const base = tsModule?.default ?? tsModule;

let Skill = null;
try {
  ({ Skill } = require("../../src/main/typescript/elvarg/game/model/Skill"));
} catch {
  // plain-node test env: constructionLevel falls back to 1, XP is guarded
}

let Item = null;
try {
  ({ Item } = require("../../src/main/typescript/elvarg/game/model/Item"));
} catch {
  // plain-node test env
}

let Animation = null;
try {
  ({ Animation } =
    require("../../src/main/typescript/elvarg/game/model/Animation"));
} catch {
  // plain-node test env
}

// --- item IDs (OSRS-standard, match the engine's CONSTRUCTION_BUILDABLES) ---
const HAMMER_ID = 2347;
const SAW_ID = 8794;
const NAIL_ID = 4819; // generic nails, per engine material source "NAILS"
const PLANK_IDS = Object.freeze([960, 8778, 8780, 8782]); // regular/oak/teak/mahogany
const BUILD_ANIMATION_ID = 3676; // engine furniture build anim

/**
 * Furniture recipes for bots. Derived from CONSTRUCTION_BUILDABLES in
 * server/src/main/typescript/elvarg/game/plugin/impl/construction/ConstructionData.ts:
 * key, level, experience, materials and menuItemId (result item) are copied
 * verbatim from the engine data. Curated to simple plank furniture a
 * carpenter can build anywhere — no room/hotspot upgrades, no gold leaf.
 */
const CONSTRUCTION_RECIPES = Object.freeze([
  { key: "CRUDE_WOODEN_CHAIR", name: "crude wooden chair", level: 1, xp: 58, itemId: 8309, materials: [[960, 2], [4819, 2]] },
  { key: "WOODEN_BOOKCASE", name: "wooden bookcase", level: 4, xp: 115, itemId: 8319, materials: [[960, 4], [4819, 4]] },
  { key: "WOODEN_CHAIR", name: "wooden chair", level: 8, xp: 87, itemId: 8310, materials: [[960, 3], [4819, 3]] },
  { key: "WOODEN_LARDER", name: "wooden larder", level: 9, xp: 228, itemId: 8233, materials: [[960, 8], [4819, 8]] },
  { key: "WOODEN_KITCHEN_TABLE", name: "wooden kitchen table", level: 12, xp: 87, itemId: 8246, materials: [[960, 3], [4819, 3]] },
  { key: "ROCKING_CHAIR", name: "rocking chair", level: 14, xp: 87, itemId: 8311, materials: [[960, 3], [4819, 3]] },
  { key: "OAK_CHAIR", name: "oak chair", level: 19, xp: 120, itemId: 8312, materials: [[8778, 2]] },
  { key: "OAK_BOOKCASE", name: "oak bookcase", level: 29, xp: 180, itemId: 8320, materials: [[8778, 3]] },
  { key: "OAK_KITCHEN_TABLE", name: "oak kitchen table", level: 32, xp: 180, itemId: 8247, materials: [[8778, 3]] },
  { key: "OAK_LARDER", name: "oak larder", level: 33, xp: 480, itemId: 8234, materials: [[8778, 8]] },
  { key: "TEAK_ARMCHAIR", name: "teak armchair", level: 35, xp: 180, itemId: 8314, materials: [[8780, 2]] },
  { key: "MAHOGANY_BOOKCASE", name: "mahogany bookcase", level: 40, xp: 420, itemId: 8321, materials: [[8782, 3]] },
  { key: "MAHOGANY_ARMCHAIR", name: "mahogany armchair", level: 50, xp: 280, itemId: 8315, materials: [[8782, 2]] },
  { key: "MAHOGANY_DINING_TABLE", name: "mahogany dining table", level: 52, xp: 840, itemId: 8120, materials: [[8782, 6]] },
]);

function recipeByKey(key) {
  return CONSTRUCTION_RECIPES.find((r) => r.key === String(key)) ?? null;
}

/** Construction level, 1 when unreadable (crude-chair-only — safe fallback). */
function constructionLevel(player) {
  try {
    if (Skill && player?.getSkillManager) {
      return player.getSkillManager().getCurrentLevel(Skill.CONSTRUCTION);
    }
  } catch {
    // fall through
  }
  return 1;
}

function invAmount(player, itemId) {
  try {
    return player?.getInventory?.()?.getAmount?.(itemId) ?? 0;
  } catch {
    return 0;
  }
}

function hasTools(player) {
  try {
    const inv = player?.getInventory?.();
    return inv?.contains?.(HAMMER_ID) === true && inv?.contains?.(SAW_ID) === true;
  } catch {
    return false;
  }
}

function hasMaterials(player, recipe) {
  for (const [itemId, amount] of recipe.materials) {
    if (invAmount(player, itemId) < amount) return false;
  }
  return true;
}

/**
 * Best buildable furniture: highest level at/below the player's
 * Construction level whose materials AND tools are in the inventory.
 * What a human carpenter picks — the best work they can do right now.
 */
function findBestBuildable(player) {
  const level = constructionLevel(player);
  if (!hasTools(player)) return null;
  let best = null;
  for (const recipe of CONSTRUCTION_RECIPES) {
    if (recipe.level > level) continue;
    if (!hasMaterials(player, recipe)) continue;
    if (!best || recipe.level > best.level) best = recipe;
  }
  return best;
}

/** How many of this recipe the inventory materials cover. */
function buildableCount(player, recipe) {
  let n = Infinity;
  for (const [itemId, amount] of recipe.materials) {
    n = Math.min(n, Math.floor(invAmount(player, itemId) / amount));
  }
  return n === Infinity ? 0 : n;
}

/**
 * Bot entry point — build one piece of furniture for real Construction
 * XP, no house instance, no interface clicking. Mirrors the core of the
 * engine's buildFurniture: level check, tool check, material check,
 * delete materials, add the furniture item, award real XP, play the
 * build animation. Returns { ok, xp, itemId } or { ok: false, reason }.
 */
function buildFurnitureBot(player, buildableKey) {
  const recipe = recipeByKey(buildableKey);
  if (!recipe) return { ok: false, reason: "unknown-recipe" };
  if (!player) return { ok: false, reason: "no-player" };
  if (constructionLevel(player) < recipe.level) {
    return { ok: false, reason: "level" };
  }
  if (!hasTools(player)) {
    return { ok: false, reason: "tools" };
  }
  if (!hasMaterials(player, recipe)) {
    return { ok: false, reason: "materials" };
  }
  try {
    const inv = player.getInventory();
    for (const [itemId, amount] of recipe.materials) {
      inv.deleteNumber(itemId, amount);
    }
    if (Item) inv.addItem(new Item(recipe.itemId, 1));
    if (Skill) {
      player.getSkillManager().addExperiences(Skill.CONSTRUCTION, recipe.xp);
    }
    if (Animation) {
      try {
        player.performAnimation(new Animation(BUILD_ANIMATION_ID));
      } catch {
        // animation is cosmetic
      }
    }
    return { ok: true, xp: recipe.xp, itemId: recipe.itemId };
  } catch {
    return { ok: false, reason: "error" };
  }
}

function register(api) {
  // The engine's own registration — houses, hotspots, interfaces.
  if (typeof base?.register === "function") {
    base.register(api);
  }
  try {
    api?.log?.("registered", { botRecipes: CONSTRUCTION_RECIPES.length });
  } catch {
    // best effort
  }
}

module.exports = {
  // Everything the TypeScript module exported, untouched.
  ...tsModule,
  // The plugin the loader boots (default ?? imported) — same name and
  // registration as the engine, so house behavior is unchanged.
  default: {
    ...base,
    register,
  },
  // Bot entry points for citizen carpenters.
  CONSTRUCTION_RECIPES,
  HAMMER_ID,
  SAW_ID,
  NAIL_ID,
  PLANK_IDS,
  BUILD_ANIMATION_ID,
  recipeByKey,
  constructionLevel,
  findBestBuildable,
  buildableCount,
  buildFurnitureBot,
  // Alias matching the startBot* naming the other skill plugins use.
  startBotConstruction: buildFurnitureBot,
  isConstructionActive: () => false, // builds are instant; no session to track
};
