"use strict";

const { api, Animation, GameObject, Location } = require("./Core.Construction");
const Ids = require("./Ids.Construction");
const Estate = require("./Estate.Construction");
const House = require("./House.Construction");
const Dungeon = require("./Dungeon.Construction");

// The throne room lever (rsprox captures): Pull plays human_pull_lever and works the room's
// floor trap on guests standing on it. The trapdoor drops them into the oubliette below
// ("The trapdoor opens!"); a cage holds them while the owner picks what to do ("Release|Cancel"
// for the steel cage, "Release|Drop into oubliette|Expel from house" for the magic cages). The
// second op turns challenge mode on and off (its message is this server's).
const PULL_LEVER = Ids.seq("human_pull_lever");
const FLOOR_TRAPS = {
  TRAP_TRAPDOOR: { trapdoor: true },
  STEEL_CAGE_TRAP: { cage: Ids.loc("poh_cage_throneroom"), options: ["Release", "Cancel"] },
  LESSER_MAGIC_CAGE: { cage: Ids.loc("poh_magic_cage_lesser"), options: ["Release", "Drop into oubliette", "Expel from house"] },
  GREATER_MAGIC_CAGE: { cage: Ids.loc("poh_magic_cage_greater"), options: ["Release", "Drop into oubliette", "Expel from house"] },
};
const OUBLIETTE = "OUBLIETTE";

/** house -> { cage: GameObject, prisoners: Player[] } */
const caged = new WeakMap();

function lever(event) {
  const house = House.houseFor(event.player);
  const furniture = house?.getFurnitureAt(event.location, event.objectId, event.object?.getType() ?? 10);
  if (!furniture || !furniture.buildableKey.endsWith("_LEVER")) return null;
  return { house, room: house.getRoomPositionAt(event.location) };
}

function pull(event) {
  const found = lever(event);
  if (!found) return false;
  const { house, room } = found;
  const player = event.player;
  if (house.owner !== player) {
    player.sendMessage("Only the owner of the house can pull the lever.");
    return true;
  }
  player.performAnimation(new Animation(PULL_LEVER));
  const floor = house.furnitureEntries().filter(entry => sameRoom(entry.position, room) && entry.furniture.hotspotKey === "FLOOR_SPACE");
  const trap = FLOOR_TRAPS[floor[0]?.furniture.buildableKey];
  if (!trap) {
    player.sendMessage("There is no fiendish mechanism for the lever to activate.");
    return true;
  }
  const held = caged.get(house);
  if (held) return ownerChoice(player, house, room, trap, held), true;
  const victims = house.getPlayers().filter(other => other !== player && floor.some(entry => entry.location.equals(other.getLocation())));
  if (trap.trapdoor) {
    player.sendMessage("The trapdoor opens!");
    if (!dropAll(house, room, victims)) player.sendMessage("You must build an oubliette below your throne room for the trapdoor to function.");
    return true;
  }
  if (!victims.length) return true;
  const corner = floor.map(entry => entry.location).sort((a, b) => a.getX() - b.getX() || a.getY() - b.getY())[0];
  const cage = new GameObject(trap.cage, corner, 10, 0, house);
  house.addExtraObject(cage);
  for (const victim of victims) victim.getMovementQueue().setBlockMovement(true).reset();
  const prisoners = { cage, prisoners: victims };
  caged.set(house, prisoners);
  ownerChoice(player, house, room, trap, prisoners);
  return true;
}

function ownerChoice(player, house, room, trap, held) {
  api.sendMultiChatboxPrompt(player, "Select an option", ...trap.options.flatMap(option => [option, () => {
    if (option === "Cancel") return;
    const prisoners = held.prisoners.filter(prisoner => prisoner.getPrivateArea() === house);
    release(house, held);
    if (option === "Drop into oubliette" && !dropAll(house, room, prisoners)) {
      player.sendMessage("You must build an oubliette below your throne room for the trapdoor to function.");
    } else if (option === "Expel from house") {
      for (const prisoner of prisoners) house.exitHouse(prisoner, Estate.houseExit(house.save));
    }
  }]));
}

function release(house, held) {
  caged.delete(house);
  house.removeExtraObject(held.cage);
  for (const prisoner of held.prisoners) prisoner.getMovementQueue().setBlockMovement(false);
}

/** Drops players straight down into the oubliette under the throne room; false when there is none. */
function dropAll(house, room, players) {
  const below = house.getRoom({ ...room, plane: room.plane - 1 });
  if (room.plane === 0 || below?.roomKey !== OUBLIETTE) return false;
  for (const victim of players) {
    const at = victim.getLocation();
    victim.moveTo(new Location(at.getX(), at.getY(), at.getZ() - 1));
    victim.sendMessage("You fall into the oubliette!");
  }
  return true;
}

function challengeMode(event) {
  const found = lever(event);
  if (!found) return false;
  const { house } = found;
  const player = event.player;
  if (house.owner !== player) return player.sendMessage("Only the owner of the house can pull the lever."), true;
  player.performAnimation(new Animation(PULL_LEVER));
  const on = !Dungeon.inChallengeMode(house);
  Dungeon.setChallengeMode(house, on);
  for (const occupant of house.getPlayers()) {
    occupant.sendMessage(on ? "The house is now in challenge mode: its dungeon is dangerous." : "The house is no longer in challenge mode.");
  }
  return true;
}

function sameRoom(a, b) {
  return a.x === b.x && a.y === b.y && a.plane === b.plane;
}

function attachThroneRoom(api) {
  api.onObjectInteraction("Lever", { Pull: pull, "Challenge-mode": challengeMode });
}

Object.assign(module.exports, { attachThroneRoom });
