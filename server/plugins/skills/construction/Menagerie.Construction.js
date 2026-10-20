"use strict";

const { api, CacheDefinitions, PluginManager } = require("./Core.Construction");
const Ids = require("./Ids.Construction");
const House = require("./House.Construction");

// The menagerie (rsprox captures, cache scripts 639-643): using a pet on menagerie furniture
// stores it; the pet house's View opens interface 211, whose list shows slot i of enum 985 when
// bit i of varps 864 / 1416 / 4718 is set, and a click takes the pet back. Toggle sets varbit
// 2013 (poh_menagerie_closed); stored pets roam the menagerie rooms while it is 0 and the house
// isn't in building mode.
const MENAGERIE_INTERFACE = Ids.iface("poh_menagerie");
const LIST = 7;
const ROAM_TOGGLE = 9;
const PET_ENUM = 985;
// Which pets are stored, from slot 0, 32 and 63 of the enum on.
const STORED_VARPS = [["prayer20", 0], ["menagerie_contents2", 32], ["menagerie_contents3", 63]].map(([name, first]) => [Ids.varp(name), first]);
const CLOSED_VARBIT = Ids.varbit("poh_menagerie_closed");
const STORED_ATTRIBUTE = "construction:menagerie";
const CLOSED_ATTRIBUTE = "construction:menagerie-closed";
const MENAGERIE_ROOMS = new Set(["MENAGERIE_INDOORS", "MENAGERIE_OUTDOORS"]);
const MENAGERIE_FURNITURE = /HOUSE$|HABITAT$|SCRATCHING_POST$|ARENA$|FEEDER$|PET_LIST$/;
const ROAM_RADIUS = 3;
const MAX_ROAMING = 20;

let petsBySlot = null;
/** house -> Map(npc -> slot) */
const roaming = new WeakMap();

/** Slot -> { itemId, npcId } from the cache enum and the Pets plugin's definitions. */
function pets() {
  if (petsBySlot) return petsBySlot;
  const request = { pets: [] };
  api.emitCustomEvent("pets:definitions", request);
  const npcByItem = new Map(request.pets.map(pet => [pet.itemId, pet.petId]));
  petsBySlot = new Map([...CacheDefinitions.getEnumValues(PET_ENUM)].map(([slot, itemId]) => [slot, { itemId, npcId: npcByItem.get(itemId) ?? -1 }]));
  return petsBySlot;
}

function slotOf(itemId) {
  for (const [slot, pet] of pets()) if (pet.itemId === itemId) return slot;
  return -1;
}

function stored(player) {
  return new Set(player.getAttribute(STORED_ATTRIBUTE) ?? []);
}

function sendStored(player) {
  const slots = stored(player);
  for (const [varp, first] of STORED_VARPS) {
    let value = 0;
    for (let bit = 0; bit < 32; bit++) if (slots.has(first + bit)) value |= 1 << bit;
    player.getPacketSender().sendConfig(varp, value);
  }
  player.getPacketSender().sendVarbit(CLOSED_VARBIT, player.getAttribute(CLOSED_ATTRIBUTE) ? 1 : 0);
}

function inMenagerie(event) {
  const house = House.houseFor(event.player);
  const furniture = house?.getFurnitureAt(event.location, event.objectId, event.object?.getType() ?? 10);
  const room = furniture && house.getRoom(house.getRoomPositionAt(event.location));
  return room && MENAGERIE_ROOMS.has(room.roomKey) && MENAGERIE_FURNITURE.test(furniture.buildableKey) ? house : null;
}

function view(event) {
  if (!inMenagerie(event)) return false;
  sendStored(event.player);
  event.player.getPacketSender().sendInterface(MENAGERIE_INTERFACE);
  return true;
}

function storePet(event) {
  const slot = slotOf(event.itemId);
  const house = slot >= 0 && inMenagerie(event);
  if (!house) return;
  event.handled = true;
  const player = event.player;
  if (house.owner !== player) return player.sendMessage("You can only keep pets in your own menagerie.");
  if (house.buildingMode) return player.sendMessage("You can't spawn pets unless they're permitted to roam the house, which they can't do in building mode.");
  const slots = stored(player);
  if (slots.has(slot)) return player.sendMessage("You already have that pet in your menagerie.");
  player.getInventory().delete(event.itemId, 1);
  slots.add(slot);
  player.setAttribute(STORED_ATTRIBUTE, [...slots]);
  sendStored(player);
  refreshPets(house);
}

function interfaceClick(event) {
  if (event.groupId !== MENAGERIE_INTERFACE) return;
  const player = event.player;
  const house = House.houseFor(player);
  if (!house || house.owner !== player) return;
  event.handled = true;
  if (event.childId === ROAM_TOGGLE) {
    player.setAttribute(CLOSED_ATTRIBUTE, !player.getAttribute(CLOSED_ATTRIBUTE));
    sendStored(player);
    refreshPets(house);
    return;
  }
  const slot = event.slot;
  const slots = stored(player);
  if (event.childId !== LIST || !slots.has(slot) || (event.opId ?? event.action ?? 1) > 1) return;
  if (player.getInventory().getFreeSlots() === 0) return player.sendMessage("You don't have enough inventory space.");
  slots.delete(slot);
  player.setAttribute(STORED_ATTRIBUTE, [...slots]);
  player.getInventory().adds(pets().get(slot).itemId, 1);
  sendStored(player);
  refreshPets(house);
}

/** Instance.rebuild: stored pets roam the menagerie rooms while the owner lets them. */
function refreshPets(house) {
  const out = roaming.get(house) ?? new Map();
  roaming.set(house, out);
  const owner0 = house.owner;
  const wanted = owner0 && !house.buildingMode && !owner0.getAttribute(CLOSED_ATTRIBUTE) ? [...stored(owner0)].slice(0, MAX_ROAMING) : [];
  // Each occupant's rebuild calls this; leave the pets alone unless what should roam changed.
  if (wanted.length === out.size && [...out].every(([npc, slot]) => npc.isRegistered() && wanted.includes(slot))) return;
  for (const npc of out.keys()) if (npc.isRegistered()) { house.leave(npc, false); PluginManager.removeNpc(npc); }
  out.clear();
  const owner = house.owner;
  if (!owner || house.buildingMode || owner.getAttribute(CLOSED_ATTRIBUTE)) return;
  const tiles = house.furnitureEntries().filter(entry => MENAGERIE_ROOMS.has(entry.room.roomKey)).map(entry => entry.location);
  if (!tiles.length) return;
  for (const slot of [...stored(owner)].slice(0, MAX_ROAMING)) {
    const pet = pets().get(slot);
    if (!pet || pet.npcId < 0) continue;
    const at = tiles[Math.floor(Math.random() * tiles.length)];
    const npc = PluginManager.spawnNpc({ id: pet.npcId, x: at.getX(), y: at.getY(), z: at.getZ(), wanderRadius: ROAM_RADIUS });
    if (!npc) continue;
    npc.__skipDefaultRespawn = true;
    house.enter(npc);
    out.set(npc, slot);
  }
}

/** `pets:held-elsewhere`: a pet kept in the owner's menagerie is still theirs. */
function heldInMenagerie(request) {
  const slot = slotOf(request.itemId);
  if (slot >= 0 && stored(request.player).has(slot)) request.held = true;
}

function attachMenagerie(api) {
  api.persistAttribute(STORED_ATTRIBUTE, []);
  api.persistAttribute(CLOSED_ATTRIBUTE, false);
  for (const name of ["Oak house", "Teak house", "Mahogany house", "Consecrated house", "Desecrated house", "Nature house"]) {
    api.onObjectInteraction(name, { View: view });
  }
  api.onItemOnObject(storePet, { noted: false });
  api.onInterfaceActionClick(interfaceClick);
  api.onCustomEvent("pets:held-elsewhere", heldInMenagerie);
}

Object.assign(module.exports, { attachMenagerie, refreshPets });
