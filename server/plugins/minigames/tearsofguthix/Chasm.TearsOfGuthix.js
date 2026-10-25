"use strict";

// Wiki: Tears of Guthix, "The Light Creatures" and "The Bowl". Cache: tog_light_creature_op,
// tog_player_float_across (2048), tog_climb_slope_down (2050), south rocks 6672.
const FLOAT_ACROSS = 2048;
const CLIMB_DOWN = 2050;
const CREATURE_RANGE = 10;
const ROCK_SIDE = [3229, 9505];
const JUNA_SIDE = [3241, 9498];
let core;

function isCrossingCreature(npc) {
  const at = npc.getLocation();
  return npc.getId() === core.NpcIdentifiers.LIGHT_CREATURE_4 && at.getZ() === 2 &&
    at.getX() >= 3224 && at.getX() <= 3226 && at.getY() >= 9516 && at.getY() <= 9518;
}

function routeCreature(event) {
  if (!isCrossingCreature(event.npc)) return;
  event.range = CREATURE_RANGE;
  event.ignoreProjectileClip = true;
}

function carry(player, destination, animation, ticks) {
  const { ForceMovement, ForceMovementTask, Location, TaskManager } = core;
  const start = player.getLocation().clone();
  const dx = destination[0] - start.getX(), dy = destination[1] - start.getY();
  const direction = Math.abs(dx) > Math.abs(dy) ? dx > 0 ? 1 : 3 : dy > 0 ? 0 : 2;
  // shortcut: the landing is a connected cache floor and duration is estimated; refine from a live capture.
  TaskManager.submit(new ForceMovementTask(player, ticks,
    new ForceMovement(start, new Location(dx, dy), 0, ticks * 30, direction, animation)));
}

function attract({ player, npc }) {
  if (!isCrossingCreature(npc)) return false;
  if (!player.getInventory().contains(core.ItemIdentifiers.SAPPHIRE_LANTERN_3)) {
    player.sendMessage("You need a lit sapphire lantern to attract the creature.");
    return true;
  }
  carry(player, ROCK_SIDE, FLOAT_ACROSS, 6);
  player.sendMessage("The light creature carries you across the chasm.");
  return true;
}

function useLantern(event) {
  if (event.itemId !== core.ItemIdentifiers.SAPPHIRE_LANTERN_3 || !isCrossingCreature(event.target)) return;
  event.handled = attract({ player: event.player, npc: event.target });
}

function climbRocks({ player, objectId }) {
  if (objectId !== core.ObjectIdentifiers.ROCKS_27) return false;
  carry(player, JUNA_SIDE, CLIMB_DOWN, 2);
  return true;
}

module.exports = function registerChasm(api) {
  core = api.core;
  api.onNpcInteraction("Light creature", { Attract: attract });
  api.onNpcRoute(routeCreature);
  api.onItemOnNpc(useLantern, { noted: false });
  api.onObjectInteraction("Rocks", { Climb: climbRocks });
};
