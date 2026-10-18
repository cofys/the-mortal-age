"use strict";

/**
 * Developer commands:
 *   ::tempoross              solo-start a cove from wherever you are
 *   ::tempoross lobby        to the Ruins of Unkah's dock
 *   ::tempoross info         the fight's phase, energy, essence and storm
 *   ::tempoross surface      end the intro now
 *   ::tempoross energy <n>   set Tempoross' energy (ten times the Wiki's)
 *   ::tempoross essence <n>  set its essence
 *   ::tempoross storm <n>    set the storm (out of 350)
 *   ::tempoross wave|lightning|torrent   start that attack
 *   ::tempoross points <n>   set your points
 *   ::tempoross permits <n>  set your unclaimed reward permits
 */

const Shared = require("./Shared.Tempoross");
const { coveOf } = require("./Cove.Tempoross");
const { depart } = require("./Lobby.Tempoross");
const Records = require("./Records.Tempoross");

const USAGE = "Usage: ::tempoross [lobby|info|surface|energy n|essence n|storm n|wave|lightning|torrent|points n|permits n]";

function tempoross({ player, parts }) {
  const [, what, value] = parts ?? [];
  const number = Math.max(0, Math.trunc(Number(value) || 0));
  if (!what) {
    depart([player]);
    return true;
  }
  if (what === "lobby") {
    player.moveTo(Shared.loc(Shared.DATA.lobby.dockTile));
    return true;
  }
  if (what === "permits") {
    Records.setPermits(player, number);
    player.sendMessage(`Reward permits: ${Records.permits(player)}.`);
    return true;
  }
  const fight = coveOf(player)?.fight;
  if (!fight) {
    player.sendMessage("You need to be at Tempoross Cove for that.");
    return true;
  }
  switch (what) {
    case "info":
      player.sendMessage(`Tempoross: ${fight.phase}, energy ${fight.energy}/${fight.maxEnergy}, essence ${fight.essence}/${fight.maxEssence}, storm ${fight.storm}/${Shared.DATA.fight.stormMax}, submerged ${fight.submerges} times.`);
      return true;
    case "surface":
      if (fight.phase === "intro") fight.surface(true);
      break;
    case "energy":
      fight.energy = Math.min(fight.maxEnergy, number);
      if (fight.energy === 0) fight.submerge();
      break;
    case "essence":
      fight.essence = Math.min(fight.maxEssence, number);
      if (fight.essence === 0) fight.win();
      break;
    case "storm":
      fight.storm = Math.min(Shared.DATA.fight.stormMax, number);
      break;
    case "wave":
      fight.attacks.wave();
      break;
    case "lightning":
      fight.attacks.lightning();
      break;
    case "torrent":
      fight.attacks.torrent();
      break;
    case "points":
      player.getPacketSender().sendVarbit(Shared.VARBIT.POINTS, Math.min(Shared.DATA.points.max, number));
      break;
    default:
      player.sendMessage(USAGE);
      return true;
  }
  fight.sendHud(player);
  return true;
}

function attachCommands(api) {
  api.registerCommand("tempoross", tempoross, api.core.PlayerRights.DEVELOPER, "Tempoross: solo-start, or set up the fight");
}

module.exports = { attachCommands };
