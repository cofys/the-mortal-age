/**
 * Wilderness woodcutting: the risk/reward edge of the woodcutter's game.
 *
 * The timber in the contested Wilderness grows fast and straight (+25% cut
 * chance), and every so often a log comes down prime (double XP). The price is
 * the one the Wilderness always charges: anyone can kill you for what you
 * carry, and a share of everything destroyed in a PK death never comes back
 * (see the economy plugin's death-destruction sink). Stormy drives over
 * wilderness yews are the richest - and most dangerous - woodcutting in the
 * game.
 *
 * The contested zone is the economy plugin's own rect (server/plugins/economy/
 * constants.js): one definition of "the Wilderness", shared, never duplicated.
 */
const { WILDERNESS_SURFACE } = require("../../economy/constants");

const CUT_MULTIPLIER = 1.25;
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

function onCutChance(event) {
  if (!(event.multiplier > 0)) return;
  if (isInWilderness(event.player)) {
    event.multiplier *= CUT_MULTIPLIER;
  }
}

function onSuccess(event) {
  const { player } = event;
  if (!isInWilderness(player) || event.logId == null) return;
  event.wilderness = true;
  if (Math.random() < PRIME_CHANCE) {
    event.prime = true;
    player.getSkillManager().addExperiences(core.Skill.WOODCUTTING, event.xpReward ?? 0);
    player.sendMessage("A prime log! The wilds provide.");
  }
}

function attach(pluginApi) {
  api = pluginApi;
  core = api.core;
  api.onCustomEvent("woodcutting:cut-chance", onCutChance);
  api.onCustomEvent("woodcutting:success", onSuccess);
  api.log("registered", { zone: WILDERNESS_SURFACE });
}

module.exports = {
  attach, isInWilderness, CUT_MULTIPLIER, PRIME_CHANCE,
  _test: { onCutChance, onSuccess },
};
