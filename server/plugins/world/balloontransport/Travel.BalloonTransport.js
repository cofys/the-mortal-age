/**
 * Flying the balloons after Enlightened Journey (Wiki: Balloon_transport_system; the
 * assistants' transcripts):
 * - Fly on Auguste or an assistant, Use on a station's basket, or "Yes." to an assistant's
 *   "Do you want to use the balloon?" opens the balloon map (zep_balloon_map);
 * - a trip to an opened station costs one log of its type ("You need 1 [type] logs to make this
 *   trip.") and needs its Firemaking level; to Entrana the player is searched first, and no
 *   weapons or armour may be worn;
 * - from Entrana a station not yet opened is opened by flying there with 10 of its logs (3
 *   magic), for 2,000 Firemaking XP - the Wiki's flight minigame for it is not played (as the
 *   quest's own flight); from anywhere else it is refused;
 * - no more than 40kg carried, the log aside, and no pet out (the quest's lines);
 * - the flight is a fade to the destination's basket, the player held still; one at a time; a
 *   logout mid-flight lands them, a death ends it where they are.
 * Opened routes are saved, and their baskets and assistants shown from the zep_multi_* varbits.
 */
const Common = require("./Common.BalloonTransport");

const OPEN_MAP_TARGET = "Balloon transport system";
const BALLOONISTS = ["Auguste", "Assistant Stan", "Assistant Brock", "Assistant Serf", "Assistant Marrow", "Assistant Le Smith", "Assistant Lori"];
const BASKET = "Basket";
const ENTRANA = "entrana";
const WORN_CONTRABAND = ["HEAD_SLOT", "WEAPON_SLOT", "BODY_SLOT", "SHIELD_SLOT", "LEG_SLOT"];
const GRAMS_PER_KG = 1000;
/** The Pets plugin's follower, readable by other plugins. */
const PET_ATTRIBUTE = "pets:current";

/** Players with the map open -> { from, npcId }. */
const openMaps = new WeakMap();
/** Players mid-flight -> their flight. */
const flights = new WeakMap();

function flying(player) {
  return flights.has(player);
}

function say(player, npcId, text, then = null) {
  const { DialogueChainBuilder, NpcDialogue, StatementDialogue, ActionDialogue } = Common.core;
  const chain = new DialogueChainBuilder();
  chain.add(npcId ? new NpcDialogue(0, npcId, text) : new StatementDialogue(0, text));
  if (then) chain.add(new ActionDialogue(1, { execute: then }));
  player.getDialogueManager().startDialogues(chain);
}

function fill(text, values) {
  return text.replace(/\[(\w+)\]/g, (whole, key) => (values[key] !== undefined ? String(values[key]) : whole));
}

function logsHeld(player, station) {
  return player.getInventory().getAmount(Common.ids.objs[station.log]);
}

function firemaking(player) {
  return player.getSkillManager().getMaxLevel(Common.core.Skill.FIREMAKING);
}

/** Carried and worn weight in kg, one log of the fare aside. */
function weightKg(player, station) {
  let grams = 0;
  for (const item of [...player.getInventory().getItems(), ...player.getEquipment().getItems()]) {
    if (!item || item.getId() <= 0 || item.getAmount() <= 0) continue;
    grams += (Number(item.getDefinition().getWeight()) || 0) * (item.getDefinition().isStackable?.() ? 1 : item.getAmount());
  }
  const log = Common.core.ItemDefinition.forId(Common.ids.objs[station.log]);
  grams -= Number(log?.getWeight?.()) || 0;
  return grams / GRAMS_PER_KG;
}

function hasPet(player) {
  return player.getAttribute?.(PET_ATTRIBUTE)?.isRegistered?.() === true;
}

function wearsContraband(player) {
  const { Equipment } = Common.core;
  const equipment = player.getEquipment();
  return WORN_CONTRABAND.some((slot) => (equipment.get(Equipment[slot])?.getId?.() ?? -1) > 0);
}

/** The balloon map, from the station the player is at - one that is open to them. */
function openMap(player, from, npcId = null) {
  if (flying(player) || !Common.questComplete(player) || !from || !Common.opened(player, from)) return false;
  const sender = player.getPacketSender();
  sender.sendInterfaceRemoval();
  sender.sendInterface(Common.ids.map);
  openMaps.set(player, { from, npcId });
  return true;
}

/** Fly on Auguste or an assistant (the speaker is the NPC as the player sees it). */
function flyNpc({ player, npc, npcId }) {
  if (!Common.questComplete(player)) return false;
  return openMap(player, Common.stationAt(npc?.getLocation?.() ?? player.getLocation()), npcId ?? npc?.getId?.() ?? null);
}

/** Use on a station's basket: travel at once (the 2018 change), not the assistant's talk. */
function useBasket({ player, location }) {
  if (!Common.questComplete(player)) return false;
  const at = location ? Common.tile([location.x, location.y]) : player.getLocation();
  const station = Common.stationAt(at);
  if (!station) return false;
  return openMap(player, station);
}

/** "(open_interface Balloon transport system)" in an assistant's talk. */
function onAction(event) {
  if (event.action !== "open_interface" || event.target !== OPEN_MAP_TARGET) return;
  event.handled = true;
  event.end = true;
  const { player, npc, npcId } = event;
  // The conversation closes its window as it ends; the map opens on the next tick.
  Common.later(1, () => openMap(player, Common.stationAt(npc?.getLocation?.() ?? player.getLocation()), npcId ?? null));
}

function chooseDestination(event) {
  if (event.groupId !== Common.ids.map) return;
  const pending = openMaps.get(event.player);
  const to = Common.ids.buttons.get(event.childId);
  if (!pending || !to) return;
  event.handled = true;
  openMaps.delete(event.player);
  event.player.getPacketSender().sendInterfaceRemoval();
  travel(event.player, pending.from, to, pending.npcId);
}

/** The checks for a trip, then the flight (opening the route first from Entrana). */
function travel(player, from, to, npcId = null) {
  if (flying(player) || !from || from.key === to.key) return false;
  const { messages, unlockXp } = Common.data;
  const opening = !Common.opened(player, to);
  if (opening && from.key !== ENTRANA) {
    say(player, npcId, messages.locked);
    return false;
  }
  if (firemaking(player) < to.level) {
    say(player, npcId, fill(messages.level, { level: to.level }));
    return false;
  }
  const cost = opening ? to.unlockLogs : 1;
  if (logsHeld(player, to) < cost) {
    const type = to.logName ?? "normal";
    say(player, npcId, opening ? fill(messages.unlockLogs, { count: cost, type }) : fill(messages.needLog, { type }));
    return false;
  }
  const refusal = () => {
    if (logsHeld(player, to) < cost) return opening ? fill(messages.unlockLogs, { count: cost, type: to.logName ?? "normal" }) : fill(messages.needLog, { type: to.logName ?? "normal" });
    if (hasPet(player)) return messages.pet;
    if (weightKg(player, to) > Common.data.maxWeightKg) return messages.weight;
    return null;
  };
  const before = refusal();
  if (before) {
    say(player, npcId, before);
    return false;
  }
  const go = () => fly(player, to, cost, opening ? () => {
    Common.openRoute(player, to);
    player.getSkillManager().addExperience(Common.core.Skill.FIREMAKING, unlockXp, false);
    player.sendMessage(fill(messages.unlocked, { place: to.label }));
  } : null);
  if (to.key !== ENTRANA) return go();
  // Entrana: searched first (the assistants' transcript); the trip is checked again after it.
  say(player, npcId, messages.entranaSearch, () => {
    player.sendMessage(messages.searched);
    if (wearsContraband(player)) return say(player, npcId, messages.entranaRefused);
    const after = refusal();
    if (after) return say(player, npcId, after);
    go();
  });
  return true;
}

/**
 * The flight: the logs taken as the screen fades, the player at the destination's basket
 * `flightTicks` later. `arrived` runs as they land (a route opened).
 */
function fly(player, to, logs, arrived = null) {
  if (flying(player)) return false;
  const { flightTicks, closeTicks } = Common.data;
  const movement = player.getMovementQueue?.();
  const inventory = player.getInventory();
  const logId = Common.ids.objs[to.log];
  if (inventory.getAmount(logId) < logs) return false;
  inventory.delete(logId, logs);
  inventory.refreshItems?.();
  const from = player.getLocation();
  const departed = { x: from.getX(), y: from.getY(), z: from.getZ() };
  movement?.setBlockMovement?.(true);
  movement?.reset?.();
  Common.fade(player, true);
  const flight = { done: false };
  flights.set(player, flight);
  const finish = () => {
    if (flight.done) return;
    flight.done = true;
    flights.delete(player);
    movement?.setBlockMovement?.(false);
  };
  flight.land = () => {
    if (flight.done) return;
    player.moveTo(Common.tile(to.land));
    arrived?.();
    finish();
  };
  /** No flight after all: the logs back, the player where they are. */
  flight.abort = () => {
    if (flight.done) return;
    inventory.adds?.(logId, logs) ?? inventory.add?.(new Common.core.Item(logId, logs));
    inventory.refreshItems?.();
    Common.closeFade(player);
    finish();
  };
  Common.later(flightTicks, () => {
    if (flight.done) return;
    const at = player.getLocation();
    const moved = at.getX() !== departed.x || at.getY() !== departed.y || at.getZ() !== departed.z;
    // A death, a teleport out of the basket, or armour put on for Entrana on the way: no flight.
    if (player.isDyingReturn?.() === true || player.getHitpoints?.() <= 0 || moved
      || (to.key === ENTRANA && wearsContraband(player))) return flight.abort();
    flight.land();
    Common.fade(player, false);
    Common.later(closeTicks, () => Common.closeFade(player));
  });
  return true;
}

/** Logging out mid-flight lands the player (the save is at the destination). */
function logout({ player }) {
  openMaps.delete(player);
  flights.get(player)?.land();
}

function login({ player }) {
  Common.sendRoutes(player);
}

/** Any close of the map: its pick is gone. */
function mapClosed({ player, interfaceId }) {
  if (interfaceId === Common.ids.map) openMaps.delete(player);
}

function attach(api) {
  api.persistAttribute(Common.ROUTES_ATTRIBUTE, 0);
  api.onNpcsInteraction(BALLOONISTS, { Fly: flyNpc });
  api.onObjectInteraction(BASKET, { Use: useBasket });
  api.onCustomEvent("npc-dialogue:action", onAction);
  api.onInterfaceActionClick(chooseDestination);
  api.onCustomEvent("interface:closed", mapClosed);
  api.onPlayerLogin(login);
  api.onPlayerLogout(logout);
}

module.exports = {
  attach, openMap, flyNpc, useBasket, onAction, chooseDestination, travel, fly, logout, login, flying, weightKg,
};
