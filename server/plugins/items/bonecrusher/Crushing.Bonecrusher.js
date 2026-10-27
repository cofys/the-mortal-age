const { charges, active, setCharges, format } = require("./Charges.Bonecrusher");
const CHARGES_MESSAGE_EVERY = 100;
const HALF_EXPERIENCE = 0.5;
let api;
let core;

function experienceScale(player) {
  const request = { player, diary: "morytania", tier: "elite", complete: false };
  api.emitCustomEvent("diary:is-complete", request);
  return request.complete ? 1 : HALF_EXPERIENCE;
}

/** Crushes one bone; false when it isn't one the bonecrusher takes. */
function crush(player, itemId, scale) {
  const request = { player, itemId, scale, crushed: true, handled: false };
  api.emitCustomEvent("prayer:bury", request);
  if (!request.handled) return false;
  const left = charges(player) - 1;
  setCharges(player, left);
  if (left % CHARGES_MESSAGE_EVERY === 0) player.sendMessage(`Your bonecrusher has ${format(left)} charges left.`);
  return true;
}

/** "npc-drops:generated": the killer's bonecrusher takes the bones before the loot lands. */
function crushDrops({ player, drops }) {
  if (!player || !Array.isArray(drops) || charges(player) <= 0 || !active(player)) return;
  if (!player.getInventory().contains(core.ItemIdentifiers.BONECRUSHER)) return;
  let scale = null;
  for (const drop of drops) {
    if (drop.noted) continue;
    while (drop.amount > 0 && charges(player) > 0) {
      scale ??= experienceScale(player);
      if (!crush(player, drop.itemId, scale)) break;
      drop.amount--;
    }
  }
  for (let i = drops.length - 1; i >= 0; i--) if (drops[i].amount <= 0) drops.splice(i, 1);
}

module.exports = function registerCrushing(pluginApi) {
  api = pluginApi;
  core = api.core;
  api.onCustomEvent("npc-drops:generated", crushDrops);
};
