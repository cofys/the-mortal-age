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
const { content, dockNear, dockById } = require("./SailingContent.Sailing");
const { teleportFocusOf } = require("./BoatFacilities.Sailing");
const { openBoatSelection, MODE } = require("./BoatSelection.plugin");

const NEAR_DOCK_RANGE = 16;
const PANDEMONIUM_DOCK = "the_pandemonium";

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

/**
 * "sailing:cape-teleport" `{ player, target, handled }`: the Sailing and max capes' teleports
 * (Wiki: Sailing cape). `target` is "pandemonium" (its gangplank), "boat" (pick a moored boat
 * with a greater teleport focus) or "last-boat" (the one at the player's last dock). They cast
 * as a standard teleport and use nothing up.
 */
function capeTeleport(request) {
  const { player, target } = request;
  if (!player || request.handled) return;
  request.handled = true;
  if (target === "pandemonium") {
    const { landing } = Sailing.getDock(PANDEMONIUM_DOCK);
    teleportTo(player, landing);
    return;
  }
  if (Sailing.instanceAboard(player)) {
    player.sendMessage("You're already on a boat.");
    return;
  }
  const boats = reachableBoats(player);
  if (boats.length === 0) {
    player.sendMessage("You need a moored boat with a greater teleport focus to do that.");
    return;
  }
  if (target === "last-boat") {
    const last = boats.find((boat) => boat.location.dock === player.getSailing().lastDock) ?? boats[0];
    teleportTo(player, Sailing.getDock(last.location.dock)?.landing);
    return;
  }
  const current = dockNear(player, NEAR_DOCK_RANGE) ?? dockById(player.getSailing().lastDock) ?? dockById(boats[0].location.dock);
  openBoatSelection(player, MODE.TELEPORT_TO_BOAT, current, (slot) => {
    const boat = reachableBoats(player).find((candidate) => candidate.slot === slot);
    if (boat) teleportTo(player, Sailing.getDock(boat.location.dock)?.landing);
  });
}

function teleportTo(player, landing) {
  if (!landing) return;
  const destination = new core.Location(landing.x, landing.y, landing.z);
  if (core.TeleportHandler.checkReqs(player, destination)) {
    core.TeleportHandler.teleport(player, destination, core.TeleportType.NORMAL, false);
  }
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
    api.onCustomEvent("sailing:cape-teleport", capeTeleport);
  },
  _test: { reachableBoats, hasGreaterFocus, teleportToBoat, capeTeleport },
};
