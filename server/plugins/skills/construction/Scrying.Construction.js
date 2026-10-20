"use strict";

const { api, CountdownTask, DialogueChainBuilder, StatementDialogue, ActionDialogue, Location, TaskManager } = require("./Core.Construction");
const Ids = require("./Ids.Construction");
const Estate = require("./Estate.Construction");
const House = require("./House.Construction");
const Portals = require("./Portals.Construction");

// The scrying pool (rsprox captures): Scry asks "Observe which location?" with the room's directed
// portals and "Entrance portal" ("You cannot use the scrying pool while in building mode."), then
// moves the player's view there: the player is placed at the destination with the poh_scrying_pool
// overlay and "You view <place>..." until they continue, when they come back to the pool.
// Direct-portal is the portal chamber's (Portals). The live game hides the scrying player; this
// server has no hidden players, so they stand at the destination while they look.
const OVERLAY = Ids.iface("poh_scrying_pool");
const OVERLAY_ATMOSPHERE_UID = Ids.component("toplevel_osrs_stretch:overlay_atmosphere");
const LOOK_TICKS = 50;

/** player -> where to put them back */
const scrying = new WeakMap();

function poolAt(event) {
  const house = House.houseFor(event.player);
  const furniture = house?.getFurnitureAt(event.location, event.objectId, event.object?.getType() ?? 10);
  return furniture?.buildableKey === "SCRYING_POOL" ? house : null;
}

function title(name) {
  return name.replace(/ teleport$/, "").replace(/\b\w/g, letter => letter.toUpperCase());
}

function scry(event) {
  const house = poolAt(event);
  if (!house) return false;
  const player = event.player;
  if (house.buildingMode) return player.sendMessage("You cannot use the scrying pool while in building mode."), true;
  const position = house.getRoomPositionAt(event.location);
  const portals = Object.values(house.getRoom(position)?.furnitureByLocation ?? {})
    .filter(value => value.buildableKey.endsWith("_PORTAL_FRAME") && value.destinations?.[0]);
  const known = Portals.houseDestinations();
  const choices = portals.map(portal => known.find(data => data.name === portal.destinations[0]))
    .filter(Boolean).slice(0, 4).map(data => [title(data.name), data.destination]);
  choices.push(["Entrance portal", Estate.houseExit(house.save)]);
  api.sendMultiChatboxPrompt(player, "Observe which location?", ...choices.flatMap(([label, destination]) => [label, () => look(player, house, label, destination)]));
  return true;
}

function look(player, house, label, destination) {
  if (House.houseFor(player) !== house || house.buildingMode) return;
  const at = player.getLocation();
  const position = house.getRoomPositionAt({ x: at.getX(), y: at.getY(), z: at.getZ() });
  const corner = house.roomCorner(position);
  const back = { owner: house.owner.getUsername(), own: house.owner === player, position, dx: at.getX() - corner.getX(), dy: at.getY() - corner.getY(), exit: Estate.houseExit(house.save), houseLocation: Estate.houseLocation(house.save).id };
  scrying.set(player, back);
  house.exitHouse(player, destination.clone ? destination.clone() : new Location(destination.getX(), destination.getY(), destination.getZ()));
  player.getMovementQueue().setBlockMovement(true).reset();
  player.getPacketSender().sendSubInterface(OVERLAY_ATMOSPHERE_UID, OVERLAY, 1);
  const name = label === "Entrance portal" ? "the entrance to the house" : label;
  player.getDialogueManager().startDialogues(new DialogueChainBuilder().add(
    new StatementDialogue(0, `You view ${name}...`),
    new ActionDialogue(1, { execute: () => comeBack(player) }),
  ));
  TaskManager.submit(new CountdownTask(player, LOOK_TICKS, () => comeBack(player)));
}

/** Back to the pool: the owner's own house loads again; a guest visits the owner again if they can. */
function comeBack(player) {
  const back = scrying.get(player);
  if (!back || !player.isRegistered()) return;
  scrying.delete(player);
  player.getMovementQueue().setBlockMovement(false);
  player.getPacketSender().closeSubInterface(OVERLAY_ATMOSPHERE_UID);
  player.getPacketSender().sendInterfaceRemoval();
  if (back.own) House.enterHouse(player, false);
  else House.visitHouse(player, back.owner, back.houseLocation);
  const house = House.houseFor(player);
  if (!house) return player.moveTo(back.exit);
  TaskManager.submit(new CountdownTask(player, 1, () => {
    if (House.houseFor(player) !== house || !house.getRoom(back.position)) return;
    const corner = house.roomCorner(back.position);
    player.moveTo(new Location(corner.getX() + back.dx, corner.getY() + back.dy, corner.getZ()));
  }));
}

/** onPlayerLogout mid-scry: they log back in at the house's entrance. */
function loggedOut({ player }) {
  const back = scrying.get(player);
  if (!back) return;
  scrying.delete(player);
  player.moveTo(back.exit);
}

function attachScrying(api) {
  api.onObjectInteraction("Scrying pool", { Scry: scry });
  api.onPlayerLogout(loggedOut);
}

Object.assign(module.exports, { attachScrying });
