// Teleport to boat tablets (https://oldschool.runescape.wiki/w/Teleport_to_boat): "teleports the
// caster to the mooring point where their player-owned boat is currently located", for a moored
// boat with a greater teleport focus built. The player picks the boat in the boat selection's
// Teleport to Boat mode (8; table 149 `requires_greater_teleport_focus`, which the client checks
// against each boat's `teleport_focus` varbit), and lands at its dock without boarding it.
// ponytail: not captured; the tablet plays the standard teleport tab, and the refusals are ours.
// The interface needs a current dock (varp 5005) or every boat is "Boat Unavailable" (cache script
// 8997); which one live sends here isn't captured: the dock the player is near, else their last
// dock, else the first boat's.
const { Sailing } = require("../../../src/main/typescript/elvarg/game/content/sailing/Sailing");
const { content, dockNear, dockById } = require("./sailingContent");
const { teleportFocusOf } = require("./boatFacilities");
const { openBoatSelection, MODE } = require("./BoatSelection.plugin");

const NEAR_DOCK_RANGE = 16;

let core;

function hasGreaterFocus(boat) {
  return teleportFocusOf(boat) === 2;
}

/** The player's moored boats with a greater teleport focus. */
function reachableBoats(player) {
  return player.getSailing().boats.filter((boat) => boat.location.kind === "docked" && hasGreaterFocus(boat));
}

/** Teleports to the dock where the boat in `slot` is moored, using up one tablet. */
function teleportToBoat(player, itemId, slot) {
  const boat = reachableBoats(player).find((candidate) => candidate.slot === slot);
  if (!boat) {
    player.sendMessage("You can't choose that boat at the moment.");
    return;
  }
  const dock = Sailing.getDock(boat.location.dock);
  if (!dock) return;
  const landing = new core.Location(dock.landing.x, dock.landing.y, dock.landing.z);
  if (!player.getInventory().contains(itemId) || !core.TeleportHandler.checkReqs(player, landing)) return;
  const useTablet = () => player.getInventory().deleteNumber(itemId, 1);
  core.TeleportHandler.teleport(player, landing, core.TeleportType.TELE_TAB, false, undefined, useTablet);
}

function breakTablet({ player, itemId }) {
  if (Sailing.instanceAboard(player)) {
    player.sendMessage("You're already on a boat.");
    return true;
  }
  if (reachableBoats(player).length === 0) {
    player.sendMessage("You need a moored boat with a greater teleport focus to use this tablet.");
    return true;
  }
  const boats = reachableBoats(player);
  const current = dockNear(player, NEAR_DOCK_RANGE) ?? dockById(player.getSailing().lastDock) ?? dockById(boats[0].location.dock);
  openBoatSelection(player, MODE.TELEPORT_TO_BOAT, current, (slot) => teleportToBoat(player, itemId, slot));
  return true;
}

module.exports = {
  name: "SailingBoatTeleport",
  members: true,
  register(api) {
    core = api.core;
    content();
    api.onItemAction("Teleport to boat", { Break: breakTablet });
  },
  _test: { reachableBoats, hasGreaterFocus, teleportToBoat },
};
