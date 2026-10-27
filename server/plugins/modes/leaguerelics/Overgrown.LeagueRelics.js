/**
 * Overgrown (https://oldschool.runescape.wiki/w/Overgrown), Raging Echoes' tier 7 relic: the
 * Leprechaun's vault opens the seed vault anywhere, crops never die (a diseased one waits for a
 * cure), and planting has a 75% chance to keep the seed, with live's message. The relic's other
 * perks need only the relic, not the vault carried (Wiki).
 * Not here: the automatic harvest and replanting of a grown patch from the vault's seeds, which
 * needs a Farming replant path (pets, Hespori and contract rules, compost memory) of its own.
 */
const Common = require("./Common.LeagueRelics");

let api;
let core;
let effect;

function active(player) {
  return Common.effectActive(player, effect);
}

function planting(rules) {
  if (!active(rules.player)) return;
  rules.undying = true;
  if (!rules.keepSeed && Math.random() < effect.seedSaveChance) {
    rules.keepSeed = true;
    const seed = core.ItemDefinition.forId(rules.seedId)?.getName?.()?.toLowerCase?.() ?? "seed";
    rules.message = Common.message("overgrownSeedKept", { seed });
  }
}

function open({ player }) {
  if (!active(player)) return;
  api.emitCustomEvent("farming:open-seed-vault", { player, opened: false });
}

module.exports = function attach(pluginApi) {
  api = pluginApi;
  core = api.core;
  effect = Common.data.effects.overgrown;
  api.onCustomEvent("farming:plant-rules", planting);
  api.onItemAction(effect.toolName, { Open: open });
};
