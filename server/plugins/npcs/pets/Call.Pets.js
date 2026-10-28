// Wiki Call_follower: non-interrupting; recall at >=5 tiles or across static collision.
let api, services;
const CALL_COMPONENT = "wornitems:call_follower";
const CLOSE_DISTANCE = 4;
const BUSY_MESSAGE = "Please finish what you're doing before calling your follower.";

function callFollower(event) {
  const { player, packet, handled } = event;
  if (handled || !player || packet.widgetId !== api.core.CacheDefinitions.getComponentId(CALL_COMPONENT)) return;
  // Handle before NetworkBuilder's generic widget-to-dialogue fallback: a whistle
  // must never select an option in an unrelated dialogue, even on a forged op.
  event.handled = true;
  if (packet.buttonNum !== 1) return;
  if (!player.isRegistered() || player.getHitpoints() <= 0) return;
  if (player.isDyingReturn() || player.isNeedsPlacement() || player.isTeleportingReturn()
      || player.getForceMovement() || player.getStatus() === api.core.PlayerStatus.TRADING
      || player.getStatus() === api.core.PlayerStatus.DUELING) {
    player.sendMessage(BUSY_MESSAGE);
    return;
  }
  const npc = player.getAttribute(services.currentAttribute);
  if (!npc || !npc.isRegistered() || !npc.isPet() || npc.getOwner() !== player
      || !services.getPetByNpcId(npc.getId()) || api.core.World.getRemoveNPCQueue().includes(npc)) {
    player.sendMessage("You do not have a follower.");
    return;
  }
  // Do not turn a hidden or area-restricted follower into a visible one.
  if (!npc.isVisible() || !services.canSummonPetHere(player, false)) return;
  const region = api.core.RegionManager, here = player.getLocation(), there = npc.getLocation();
  const sameContext = player.getPrivateArea() === npc.getPrivateArea() && here.getZ() === there.getZ();
  if (sameContext && here.isWithinDistance(there, CLOSE_DISTANCE)
      && region.canMovestart(there, here, npc.getSize(), npc.getSize(), player.getPrivateArea())) {
    player.sendMessage("Your follower is already close enough.");
    return;
  }
  // Occupying players/NPCs are deliberately excluded: only static clipping counts.
  const tiles = player.outterTiles().filter(tile => !region.blocked(tile, player.getPrivateArea())
    && region.canMovestart(tile, here, 1, 1, player.getPrivateArea()));
  const destination = tiles.length ? tiles[api.core.Misc.getRandom(tiles.length - 1)] : here.clone();
  services.replaceFollowerNpc(player, npc, npc.getId(), services.getPetByNpcId(npc.getId()).itemId, destination);
}

function attach(pluginApi, helpers) {
  api = pluginApi; services = helpers;
  api.onCustomEvent("player:widget-action", callFollower);
}
module.exports = { attach };
