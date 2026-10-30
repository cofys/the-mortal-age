"use strict";

// Wiki: Castlewars cloak. Surrender is available below 15% of base Hitpoints.
let core;
let game;

function restoreAtSpawn(player) {
  if (!game.isPlaying(player)) return;
  const skills = player.getSkillManager();
  player.setHitpoints(skills.getMaxLevel(core.Skill.HITPOINTS));
  skills.setCurrentLevels(core.Skill.PRAYER, skills.getMaxLevel(core.Skill.PRAYER));
  player.setRunEnergy(100);
  player.getPacketSender().sendRunEnergy();
  game.resetIdleTicks(player);
}

function surrender({ player, interfaceId, slot, itemId }) {
  const team = game.getTeamData(game.getTeamId(player));
  if (!game.isPlaying(player) || player.getArea() !== game.gameArea || !team) {
    player.sendMessage("You can only surrender during a Castle Wars game.");
    return true;
  }
  if (interfaceId !== core.Equipment.INVENTORY_INTERFACE_ID || slot !== core.Equipment.CAPE_SLOT ||
      itemId !== team.capeId || player.getEquipment().getSlot(slot) !== itemId) return true;
  if (player.getHitpoints() <= 0 || player.isDyingReturn() || player.isTeleportingReturn()) return true;
  const maximum = player.getSkillManager().getMaxLevel(core.Skill.HITPOINTS);
  if (player.getHitpoints() * 100 >= maximum * 15) {
    player.sendMessage("You can only surrender when your Hitpoints are below 15%.");
    return true;
  }
  game.dropCarriedFlag(player);
  // This is an internal return to base; the area's ban applies to teleports out of the game.
  core.TeleportHandler.teleport(player, team.startRoom, core.TeleportType.NORMAL, false, () => restoreAtSpawn(player));
  return true;
}

module.exports = function attachCastleWarsCloaks(api, castleWars) {
  core = api.core;
  game = castleWars;
  api.onItemAction("Saradomin cloak", { Surrender: surrender });
  api.onItemAction("Zamorak cloak", { Surrender: surrender });
};
