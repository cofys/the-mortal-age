"use strict";

/**
 * The Ruins of Unkah: the ferries, the waiting ship's rope ladder and its departures.
 *
 * Captures (lobby and ferries from ordinary worlds; the ladder's Solo-start from 552/1858/3275):
 * - Climb / Quick-climb: `human_reachforladder` and the player is on the ship at (3134, 2840);
 *   the first aboard starts the departure: "The mission will begin in the next 30 seconds...".
 * - The lobby HUD (687) in the ruins: "Players Ready<br><col=ffffff>None</col>" or the count,
 *   "Next Departure<br><col=ffffff>Awaiting players</col>" or "<n> seconds" in steps of five.
 * - Departure / Solo-start: "The Spirit Anglers weigh anchor and sail you out to face
 *   Tempoross.", jingle 171, sound 2163, the lobby HUD closes and the screen fades; 7 ticks
 *   later the player is aboard the cove's west ship.
 * - Ferries: Sathwood "You ride the little boat south to the Ruins of Unkah.", Nathwood "You ride
 *   the little boat north to Al Kharid.", each with the fade, jingle 171 and sound 2163.
 * Wiki: 35 Fishing; the ship leaves 30 seconds after the first player boards, or at 40 aboard.
 */

const Shared = require("./Shared.Tempoross");
const { Cove } = require("./Cove.Tempoross");
const { Fight } = require("./Fight.Tempoross");

const { DATA, LOC, INTERFACE, LOBBY_HUD, JINGLE, SOUND, ANIM } = Shared;
const LOBBY = DATA.lobby;

const SAIL_TICKS = 7;
const FERRY_TICKS = 3;
const PUDI = 10583;

const lobby = {
  /** Players aboard the waiting ship. */
  aboard: new Set(),
  /** Players in the ruins, who see the lobby HUD. */
  watching: new Set(),
  departAt: -1,
  ticks: 0,
  task: null,
};

// ------------------------------------------------------------------ the lobby HUD

function departureText() {
  if (lobby.departAt < 0) return "Awaiting players";
  const seconds = Math.max(0, (lobby.departAt - lobby.ticks) * 0.6);
  return `${Math.max(5, Math.ceil(seconds / 5) * 5)} seconds`;
}

function sendLobbyHud(player) {
  const sender = player.getPacketSender();
  const ready = lobby.aboard.size === 0 ? "None" : String(lobby.aboard.size);
  sender.sendString(`Players Ready<br><col=ffffff>${ready}</col>`, LOBBY_HUD.PLAYERS);
  sender.sendString(`Next Departure<br><col=ffffff>${departureText()}</col>`, LOBBY_HUD.DEPARTURE);
}

function openLobbyHud({ player }) {
  lobby.watching.add(player);
  player.getPacketSender().sendSubInterface(Shared.OVERLAY_HUD_UID, INTERFACE.LOBBY_HUD, 1);
  sendLobbyHud(player);
  ensureTicking();
}

function closeLobbyHud({ player }) {
  lobby.watching.delete(player);
  lobby.aboard.delete(player);
  if (player.isRegistered() && player.getPacketSender().isSubInterfaceOpen(INTERFACE.LOBBY_HUD)) {
    player.getPacketSender().closeSubInterface(Shared.OVERLAY_HUD_UID);
  }
}

function ensureTicking() {
  if (lobby.task) return;
  lobby.task = Shared.repeat(lobby, 1, tickLobby);
}

function tickLobby() {
  lobby.ticks += 1;
  for (const player of [...lobby.aboard]) {
    if (!player.isRegistered() || !Shared.inBox(LOBBY.boat, player.getLocation())) lobby.aboard.delete(player);
  }
  if (lobby.aboard.size === 0) lobby.departAt = -1;
  if (lobby.departAt >= 0 && (lobby.ticks >= lobby.departAt || lobby.aboard.size >= LOBBY.maxPlayers)) {
    lobby.departAt = -1;
    depart([...lobby.aboard]);
    lobby.aboard.clear();
  }
  for (const player of [...lobby.watching]) {
    if (player.isRegistered()) sendLobbyHud(player);
    else lobby.watching.delete(player);
  }
  if (lobby.watching.size === 0 && lobby.aboard.size === 0) {
    lobby.task = null;
    return false;
  }
  return true;
}

// ------------------------------------------------------------------ boarding

function canBoard(player) {
  if (Shared.baseLevel(player, "FISHING") >= DATA.fishingLevel) return true;
  const { DialogueChainBuilder, NpcDialogue, StatementDialogue, EndDialogue } = Shared.core();
  player.getDialogueManager().startDialogues(new DialogueChainBuilder().add(
    new NpcDialogue(0, PUDI, "Sorry, it's pretty rough out there and you look like you could do with more experience."),
    new StatementDialogue(1, `You need a Fishing level of ${DATA.fishingLevel} to fight Tempoross.`),
    new EndDialogue(2),
  ));
  return false;
}

function onBoat(player) {
  return Shared.inBox(LOBBY.boat, player.getLocation());
}

function climbLadder(player, after) {
  Shared.stopAction(player);
  player.getMovementQueue().reset();
  Shared.later(player, 1, () => Shared.animate(player, ANIM.LADDER));
  Shared.later(player, 2, () => {
    if (player.isRegistered()) after();
  });
}

function board(player, announce) {
  climbLadder(player, () => {
    player.moveTo(Shared.loc(LOBBY.boatTile));
    lobby.aboard.add(player);
    ensureTicking();
    if (lobby.departAt < 0) lobby.departAt = lobby.ticks + LOBBY.departureTicks;
    if (!announce) return;
    Shared.later(player, 1, () => {
      player.getPacketSender().sendSound(SOUND.LADDER_WAIT, 100, 0);
      const seconds = Math.max(5, Math.ceil(((lobby.departAt - lobby.ticks) * 0.6) / 5) * 5);
      player.sendMessage(`The mission will begin in the next ${seconds} seconds...`);
    });
  });
}

function climb({ player, objectId }) {
  if (objectId !== LOC.LADDER) return false;
  if (onBoat(player)) {
    climbLadder(player, () => {
      lobby.aboard.delete(player);
      player.moveTo(Shared.loc(LOBBY.dockTile));
    });
    return true;
  }
  if (canBoard(player)) board(player, true);
  return true;
}

function quickClimb({ player, objectId }) {
  if (objectId !== LOC.LADDER) return false;
  if (onBoat(player)) return climb({ player, objectId });
  if (canBoard(player)) board(player, false);
  return true;
}

function soloStart({ player, objectId }) {
  if (objectId !== LOC.LADDER) return false;
  if (!canBoard(player)) return true;
  lobby.aboard.delete(player);
  climbLadder(player, () => depart([player]));
  return true;
}

/** The ship weighs anchor with everyone aboard; seven ticks later they're in a new cove. */
function depart(players) {
  const crew = players.filter((player) => player.isRegistered());
  if (crew.length === 0) return;
  for (const player of crew) {
    lobby.aboard.delete(player);
    player.sendMessage("The Spirit Anglers weigh anchor and sail you out to face Tempoross.");
    player.getPacketSender().sendJingle(JINGLE.BOAT, 0);
    player.getPacketSender().sendSound(SOUND.BOAT, 100, 10);
    closeLobbyHud({ player });
    Shared.fade(player, true);
  }
  Shared.later(lobby, SAIL_TICKS, () => {
    const sailing = crew.filter((player) => player.isRegistered());
    if (sailing.length === 0) return;
    const cove = new Cove();
    sailing.forEach((player, index) => cove.arrive(player, index));
    cove.fight = new Fight(cove);
    cove.fight.setUp();
    for (const player of sailing) Shared.fade(player, false);
  });
}

/** The ladder is climbed from the dock or from the ship's deck beside it. */
function routeToLadder(event) {
  if (event.objectId !== LOC.LADDER) return;
  const { x, y } = event.sourceLocation;
  const tile = Shared.inBox(LOBBY.boat, Shared.loc([x, y, 0])) ? LOBBY.boatTile : LOBBY.dockTile;
  event.destination = { x: tile[0], y: tile[1], z: 0 };
}

// ------------------------------------------------------------------ ferries

function ferry(player, tile, message) {
  Shared.stopAction(player);
  Shared.fade(player, true);
  Shared.later(player, FERRY_TICKS, () => {
    if (!player.isRegistered()) return;
    player.moveTo(Shared.loc(tile));
    player.sendMessage(message);
    player.getPacketSender().sendJingle(JINGLE.BOAT, 0);
    player.getPacketSender().sendSound(SOUND.BOAT, 100, 10);
    Shared.fade(player, false);
  });
}

function toRuins({ player }) {
  ferry(player, LOBBY.ferryArrival, "You ride the little boat south to the Ruins of Unkah.");
  return true;
}

function toAlKharid({ player }) {
  ferry(player, LOBBY.alKharidArrival, "You ride the little boat north to Al Kharid.");
  return true;
}

/** The little boats: the one at Al Kharid goes south, the one in the ruins north. */
function boardFerry(event) {
  if (event.objectId !== LOC.FERRY) return false;
  if (Shared.inBox(LOBBY.zone, event.object.getLocation())) return toAlKharid(event);
  return toRuins(event);
}

function attachLobby(api) {
  api.onObjectInteraction("Rope ladder", { Climb: climb, "Quick-climb": quickClimb, "Solo-start": soloStart });
  api.onObjectInteraction("Ferry", { Board: boardFerry });
  api.onObjectRoute(routeToLadder);
  api.onNpcInteraction("Ferryman Sathwood", { Ferry: toRuins });
  api.onNpcInteraction("Ferryman Nathwood", { Ferry: toAlKharid });
  api.onZoneEnter(LOBBY.zone, openLobbyHud);
  api.onZoneExit(LOBBY.zone, closeLobbyHud);
}

module.exports = { attachLobby, depart, lobby };
