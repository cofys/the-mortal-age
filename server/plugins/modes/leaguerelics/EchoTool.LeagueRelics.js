/**
 * Shared by the Echo tool relics (Power Miner, Lumberjack, Animal Wrangler): the tool's Toggle
 * cycles its modes (the data's `modes`, the first the default), kept in one attribute a tool, and
 * whether the player holds the tool (the Wiki: the effects work with it carried or wielded).
 */
const Common = require("./Common.LeagueRelics");

function modeAttribute(effect) {
  return `league:${effect.key}-mode`;
}

function mode(player, effect) {
  const current = player.getAttribute(modeAttribute(effect));
  return effect.modes.includes(current) ? current : effect.modes[0];
}

function holdsTool(core, player, effect) {
  const id = core.ItemIdentifiers[effect.tool];
  return player.getInventory().contains(id) || player.getEquipment().contains(id);
}

/** The Toggle option: the next mode round, told in the data's words. */
function toggle(core, effect, { player }) {
  const modes = effect.modes;
  const next = modes[(modes.indexOf(mode(player, effect)) + 1) % modes.length];
  player.setAttribute(modeAttribute(effect), next);
  player.sendMessage(Common.message("echoToggle", { tool: effect.toolName, mode: effect.modeText[next] }));
}

function attach(api, effect) {
  api.persistAttribute(modeAttribute(effect), effect.modes[0]);
  api.onItemAction(effect.toolName, { Toggle: toggle.bind(null, api.core, effect) });
}

module.exports = { attach, mode, holdsTool };
