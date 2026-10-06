/**
 * Wilderness mining: the risk/reward edge of the miner's game.
 *
 * The rocks in the contested Wilderness are rich and unwatched (+25% ore XP),
 * and every so often a load comes up prime (double XP and a bonus ore). The
 * price is the one the Wilderness always charges: anyone can kill you for
 * what you carry, and a share of everything destroyed in a PK death never
 * comes back (see the economy plugin's death-destruction sink). Vein nights
 * over wilderness runite are the richest - and most dangerous - mining in
 * the game.
 *
 * The contested zone is the economy plugin's own rect (server/plugins/economy/
 * constants.js): one definition of "the Wilderness", shared, never duplicated.
 */
const { WILDERNESS_SURFACE } = require("../../economy/constants");

const XP_MULTIPLIER = 1.25;
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

function onOreYield(event) {
  if (!(event.multiplier > 0)) return;
  if (isInWilderness(event.player)) {
    event.multiplier *= XP_MULTIPLIER;
  }
}

function onSuccess(event) {
  const { player } = event;
  if (!isInWilderness(player) || event.oreId == null) return;
  event.wilderness = true;
  if (Math.random() < PRIME_CHANCE) {
    event.prime = true;
    // Prime loads pay double on the yield's XP and drop a bonus ore alongside.
    player.getSkillManager().addExperiences(core.Skill.MINING, (event.xp ?? 0));
    const free = player.getInventory().getFreeSlots();
    if (free > 0) {
      player.getInventory().addItem(new core.Item(event.oreId, 1));
      player.sendMessage("A prime load! The wilds provide.");
    } else {
      player.sendMessage("A prime load! If only you had room for the extra ore.");
    }
  }
}

function attach(pluginApi) {
  api = pluginApi;
  core = api.core;
  api.onCustomEvent("mining:ore-yield", onOreYield);
  api.onCustomEvent("mining:success", onSuccess);
  api.log("registered", { zone: WILDERNESS_SURFACE });
}

module.exports = {
  attach, isInWilderness, XP_MULTIPLIER, PRIME_CHANCE,
  _test: { onOreYield, onSuccess },
};
