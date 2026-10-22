"use strict";

/** Developer commands for testing The Fractured Archive. */

const Shared = require("./Shared.FracturedArchive");
const Parties = require("./Parties.FracturedArchive");
const Raid = require("./RaidState.FracturedArchive");
const Entry = require("./Entry.FracturedArchive");
const Guardian = require("./Guardian.FracturedArchive");

/** ::tfa - to the lobby, where crawling in from the Chasm puts you. */
function toLobby({ player }) {
  player.moveTo(Shared.loc(Shared.TILE.LOBBY_ARRIVAL));
  return true;
}

/** ::tfaguardian - straight into the Archive Guardian's room, with a party of your own if need be. */
function toGuardian({ player }) {
  let party = Parties.partyOf(player);
  if (!party) party = Parties.create(player);
  if (!party.isLeader(player) && !party.raid) {
    player.sendMessage("Your party's leader has to go in first.");
    return true;
  }
  const raid = party.raid ?? Raid.begin(player);
  raid?.enter(player);
  return true;
}

/** ::tfaintro - forget the opening cutscene (tfa_miniquest back to 0), to see it again. */
function resetIntro({ player }) {
  player.setAttribute(Entry.ATTR.MINIQUEST, Entry.STAGE.NOT_STARTED);
  player.getPacketSender().sendVarbit(Shared.id("varbit", "MINIQUEST"), 0);
  player.sendMessage("The Fractured Archive's opening cutscene will play on your next crawl in.");
  return true;
}

/** ::tfacomplete - wins the challenge your party is in. */
function completeRoom({ player }) {
  const raid = Raid.raidOf(player);
  if (!raid?.room) {
    player.sendMessage("You're not in the Fractured Archive.");
    return true;
  }
  if (!raid.room.isStarted()) raid.room.start();
  raid.room.complete();
  return true;
}

/** ::tfahp <amount> - sets the Guardian's current pool: its shield in the air, its health on the ground. */
function setGuardianHitpoints({ player, parts }) {
  const room = Raid.raidOf(player)?.room;
  const amount = Number(parts?.[1]);
  if (!room?.guardian || !Number.isFinite(amount)) {
    player.sendMessage("Use ::tfahp <amount> in the Archive Guardian's room once the challenge has started.");
    return true;
  }
  room.guardian.setHitpoints(Math.max(1, Math.floor(amount)));
  if (room.phase === Guardian.PHASE.GROUNDED) room.health = Math.max(1, Math.floor(amount));
  player.sendMessage(`The Archive Guardian is on ${room.guardian.getHitpoints()} (${room.phase}).`);
  return true;
}

module.exports = function registerCommands(api) {
  const { DEVELOPER } = api.core.PlayerRights;
  api.registerCommand("tfa", toLobby, DEVELOPER, "To the Fractured Archive's lobby");
  api.registerCommand("tfaguardian", toGuardian, DEVELOPER, "Into the Archive Guardian's room");
  api.registerCommand("tfaintro", resetIntro, DEVELOPER, "Replay the Fractured Archive's opening cutscene");
  api.registerCommand("tfacomplete", completeRoom, DEVELOPER, "Win the current Fractured Archive challenge");
  api.registerCommand("tfahp", setGuardianHitpoints, DEVELOPER, "Set the Archive Guardian's shield or health");
};
