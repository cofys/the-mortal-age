/**
 * Cooking (https://oldschool.runescape.wiki/w/Cooking): fires, ranges and ovens, doughs, pies and
 * pizzas, and wine, from plugins/skills/data/cooking.json and rsprox captures. See
 * docs/cooking.md; the units are in cooking/.
 */
const Common = require("./cooking/Common.Cooking");
const Cookers = require("./cooking/Cookers.Cooking");
const Wine = require("./cooking/Wine.Cooking");

// --- Fork bot seam (citizens) -------------------------------------------------
// Object ids citizens can cook on: lit fires (from Firemaking) and permanent
// ranges. Exposed for the citizen cooking brain action's object search. Ids are
// the engine ObjectIds of the pre-split plugin (FIRE_5 5249, FORESTERS_CAMPFIRE
// 49927-49929, COOKING_RANGE 114, COOKING_RANGE_2 4172, RANGE 2859).
const COOK_OBJECT_IDS = Object.freeze([5249, 49927, 49928, 49929, 114, 4172, 2859]);

/**
 * Bot entry point — cook raw food for real Cooking XP, no interface clicking.
 * The citizen must already be standing at a real fire or range object; the
 * session (upstream Cookers' startCooking, the player path's own loop) drives
 * one cook per interval tick until the food runs out, the fire burns out, or
 * the citizen moves. Accepts a canonical cookable or a COOKING_RECIPES entry
 * (the rawId shape CitizenCook passes).
 */
function startBotCooking(player, object, cookable) {
  if (!player || !object || !cookable) return false;
  const recipe = Common.cookables().get(cookable.raw ?? cookable.rawId) ?? cookable;
  if (recipe.raw === undefined) return false;
  return Cookers._test.startCooking(player, object, recipe);
}

module.exports = {
  name: "Cooking",
  register(api) {
    require("./cooking/Cookers.Cooking")(api);
    require("./cooking/Recipes.Cooking")(api);
    require("./cooking/Wine.Cooking")(api);
  },
  isCookingActive: Cookers.isCookingActive,
  // Data-driven recipes for bots: derived from the same cookables table the
  // player path cooks from, so the hand-cook and bot paths never disagree.
  get COOKING_RECIPES() {
    return [...Common.cookables().values()].map((c) => ({
      name: `Cook ${c.name}`,
      rawId: c.raw,
      cookedId: c.cooked,
      burntId: c.burnt,
      level: c.level,
      xp: c.xp,
      stopBurn: c.stopBurn,
      rangeOnly: !!c.rangeOnly,
    }));
  },
  COOK_OBJECT_IDS,
  startBotCooking,
  /** Every food a fire or range cooks, by its raw item id (after register). */
  get COOKABLE_BY_RAW() { return Common.cookables(); },
  COOKABLE_OBJECT_NAMES: Cookers.COOKABLE_OBJECT_NAMES,
  FIRE_OBJECT_NAMES: Cookers.FIRE_OBJECT_NAMES,
  _test: {
    ...Cookers._test,
    wearsCookingCape: Common.wearsCookingCape,
    wine: Wine._test,
    get COOKABLE_BY_RAW() { return Common.cookables(); },
    setApi: (value) => Common.init(value),
  },
};
