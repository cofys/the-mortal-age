/**
 * Wilderness fishing: the risk/reward edge of the fisherman's game.
 *
 * The fish in the contested Wilderness are bold and hungry (+25% catch chance),
 * and every so often a catch comes up prime (double XP). The price is the one
 * the Wilderness always charges: anyone can kill you for what you carry, and a
 * share of everything destroyed in a PK death never comes back (see the economy
 * plugin's death-destruction sink). Stormy nights over dark-crab spots are the
 * richest - and most dangerous - fishing in the game.
 *
 * The contested zone is the economy plugin's own rect (server/plugins/economy/
 * constants.js): one definition of "the Wilderness", shared, never duplicated.
 */
const { WILDERNESS_SURFACE } = require("../../economy/constants");

const CATCH_MULTIPLIER = 1.25;
const PRIME_CHANCE = 0.08;

let api = null;
let core = null;

function isInWilderness(player) {
  const location = player.getLocation?.();
  if (!location) return false;
  const x = location.getX();
  const y = location.getY();
  return location.getZ() === WILDERNESS_SURFACE.z &&
    x >= WILDERNESS_SURFACE.x1 && x <= WILDERNESS_SURFACE.x2 &&
    y >= WILDERNESS_SURFACE.y1 && y <= WILDERNESS_SURFACE.y2;
}

function onCatchChance(event) {
  if (!(event.multiplier > 0)) return;
  if (isInWilderness(event.player)) {
    event.multiplier *= CATCH_MULTIPLIER;
  }
}

function onSuccess(event) {
  const { player } = event;
  if (!isInWilderness(player) || !event.fish) return;
  event.wilderness = true;
  if (Math.random() < PRIME_CHANCE) {
    event.prime = true;
    player.getSkillManager().addExperiences(core.Skill.FISHING, event.fish.experience);
    player.sendMessage("A prime catch! The wilds provide.");
  }
}

function attach(pluginApi) {
  api = pluginApi;
  core = api.core;
  api.onCustomEvent("fishing:catch-chance", onCatchChance);
  api.onCustomEvent("fishing:success", onSuccess);
  api.log("registered", { zone: WILDERNESS_SURFACE });
}

module.exports = {
  attach, isInWilderness, CATCH_MULTIPLIER, PRIME_CHANCE,
  _test: { onCatchChance, onSuccess },
};
