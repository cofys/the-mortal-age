/**
 * Farmer's Fortune (https://oldschool.runescape.wiki/w/Farmer's_Fortune_(Trailblazer_Reloaded_League)),
 * Trailblazer Reloaded's tier 6 relic: a 20% chance to keep the seed or sapling planted, patches
 * grow at once and never catch disease, harvesting is 25 times faster (25 picks an action), and
 * each pick gives triple the produce as bank notes (the usual Farming XP a pick: ours, the Wiki
 * gives no XP rule).
 */
const Common = require("./Common.LeagueRelics");

let core;
let effect;

function active(player) {
  return Common.effectActive(player, effect);
}

function planting(rules) {
  if (!active(rules.player)) return;
  rules.grown = true;
  rules.diseaseFree = true;
  if (!rules.keepSeed && Math.random() < effect.seedSaveChance) {
    rules.keepSeed = true;
    const seed = core.ItemDefinition.forId(rules.seedId)?.getName?.()?.toLowerCase?.() ?? "seed";
    rules.message = Common.message("seedKept", { seed });
  }
}

function faster(request) {
  if (active(request.player)) request.harvests = Math.max(request.harvests, effect.harvestsPerAction);
}

function picked(pick) {
  if (!active(pick.player)) return;
  pick.amount *= effect.yieldMultiplier;
  pick.itemId = Common.noted(pick.itemId);
}

module.exports = function attach(api) {
  core = api.core;
  effect = Common.data.effects.farmersFortune;
  api.onCustomEvent("farming:plant-rules", planting);
  api.onCustomEvent("farming:harvests-per-action", faster);
  api.onCustomEvent("farming:pick", picked);
};
