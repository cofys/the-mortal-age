// Wiki Pet: a pet stuck behind an obstacle teleports close and continues following.
let api, services;

function catchUp({ entity: npc, following: player }) {
  if (!npc?.isNpc() || !npc.isPet() || !player?.isPlayer() || npc.getOwner() !== player
      || npc.getFollowing() !== player || player.getAttribute(services.currentAttribute) !== npc
      || !services.getPetByNpcId(npc.getId()) || !npc.isRegistered() || !npc.isVisible()
      || api.core.World.getRemoveNPCQueue().includes(npc) || !player.isRegistered()
      || player.getHitpoints() <= 0 || player.isDyingReturn() || player.isNeedsPlacement()
      || player.isTeleportingReturn() || !npc.getMovementQueue().getMobility().canMove()) return;
  if (npc.getPrivateArea() !== player.getPrivateArea() || npc.getLocation().getZ() !== player.getLocation().getZ()
      || !services.canSummonPetHere(player, false)) return;
  const region = api.core.RegionManager, here = player.getLocation();
  const tiles = player.outterTiles().filter(tile => !region.blocked(tile, player.getPrivateArea())
    && region.canMovestart(tile, here, npc.getSize(), npc.getSize(), player.getPrivateArea()));
  // Do not move into solid geometry just to satisfy a distance check.
  const destination = tiles.length ? tiles[api.core.Misc.getRandom(tiles.length - 1)]
    : !region.blocked(here, player.getPrivateArea()) ? here.clone() : null;
  if (!destination) return;
  npc.moveTo(destination);
  npc.setPositionToFace(here);
  npc.setMobileInteraction(player);
}

function attach(pluginApi, helpers) {
  api = pluginApi; services = helpers;
  api.onCustomEvent("movement:follow-blocked", catchUp);
}
module.exports = { attach };
