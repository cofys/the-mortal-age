"use strict";

/**
 * Castle Wars flags: take the enemy standard, score it at your own stand while your flag is home,
 * return your own, pick up a dropped one, and drop the banner when swapping weapons.
 * Flag state itself (carry, drop, restore) lives in Game.CastleWars.js; deaths and the end of a
 * game use it too.
 */

let game;
let core;
let data;

function freeHands(player) {
  if (game.getCarriedFlagTeam(player)) {
    player.sendMessage("You are already carrying a standard.");
    return false;
  }
  const equipment = player.getEquipment();
  const slots = [core.Equipment.WEAPON_SLOT, core.Equipment.SHIELD_SLOT]
    .filter((slot) => equipment.getSlot(slot) > 0);
  if (player.getInventory().getFreeSlots() < slots.length) {
    player.sendMessage(`You need ${slots.length === 1 ? "one free inventory space" : "two free inventory spaces"} to take the standard.`);
    return false;
  }
  for (const slot of slots) {
    player.getInventory().addItem(equipment.getItems()[slot]);
    equipment.setItem(slot, new core.Item(-1, 0));
  }
  return true;
}

function captureFlag(player, flagTeam) {
  if (game.flagStatus[flagTeam] !== 0 || !freeHands(player)) {
    return;
  }
  game.updateFlagStand(flagTeam, game.getTeamData(flagTeam).emptyStandId);
  game.carryFlag(player, flagTeam);
}

function returnCarriedFlag(player) {
  const teamId = game.getTeamId(player);
  const carriedFlagTeam = game.getCarriedFlagTeam(player);
  if (!teamId || !carriedFlagTeam) {
    if (teamId) player.sendMessage(`${game.getTeamData(teamId).name} wants the other team's standard!`);
    return;
  }
  if (carriedFlagTeam === teamId) {
    game.restoreFlagToBase(carriedFlagTeam, "return");
    game.clearWeaponSlot(player);
    player.sendMessage(`Returned the ${game.getTeamData(carriedFlagTeam).name.toLowerCase()} flag!`);
    return;
  }
  // Scoring does not require the team's own flag to be home: capture is judged on the
  // enemy standard alone.
  game.restoreFlagToBase(carriedFlagTeam, "score");
  game.clearWeaponSlot(player);
  game.score[teamId] += 1;
  player.sendMessage(`The team of ${game.getTeamData(teamId).name} scores 1 point!`);
  if (process.env.CW_BOT_DEBUG === "1") {
    console.log(`[cw_flag] score ${teamId} by ${player.getUsername?.()}`);
  }
}

function pickupDroppedFlag(player, flagTeam) {
  if (game.flagStatus[flagTeam] !== 2) {
    return;
  }
  if (flagTeam === game.getTeamId(player) && game.isInsideCastle(player, flagTeam)) {
    game.restoreFlagToBase(flagTeam, "return");
    player.sendMessage(`Returned the ${game.getTeamData(flagTeam).name.toLowerCase()} flag!`);
    return;
  }
  if (!freeHands(player)) return;
  game.removeDroppedFlagObject(flagTeam);
  game.carryFlag(player, flagTeam);
}

/** Own standards go home as soon as their carrier enters the castle, including tunnel exits. */
function returnOwnFlagInCastle(player) {
  const flagTeam = game.getCarriedFlagTeam(player);
  if (flagTeam && flagTeam === game.getTeamId(player) && game.isInsideCastle(player, flagTeam)) {
    returnCarriedFlag(player);
  }
}

function useFlagObject(event) {
  const { player, object } = event;
  const id = object.getId();
  const standTeam = data.STAND_TEAMS[id];
  const droppedTeam = data.DROPPED_FLAG_TEAMS[id];
  if (!standTeam && !droppedTeam) {
    return;
  }
  event.handled = true;
  if (!game.isPlaying(player)) {
    return;
  }
  if (droppedTeam) {
    pickupDroppedFlag(player, droppedTeam);
  } else if (game.getTeamId(player) === standTeam) {
    returnCarriedFlag(player);
  } else {
    captureFlag(player, standTeam);
  }
}

/** Swapping the banner out of the hands drops it where the carrier stands. */
function dropFlagForWeapon({ player, slot }) {
  const { WEAPON_SLOT, SHIELD_SLOT } = core.Equipment;
  if (player?.getArea?.() !== game.gameArea || (slot !== WEAPON_SLOT && slot !== SHIELD_SLOT) || !game.getCarriedFlagTeam(player)) {
    return false;
  }
  game.dropCarriedFlag(player);
  return true;
}

function dropFlagOnUnequip(event) {
  if (dropFlagForWeapon(event)) {
    event.allow = false;
  }
}

module.exports = function attachCastleWarsFlags(api, castleWars) {
  game = castleWars;
  core = api.core;
  data = castleWars.data;
  api.onObjectInteraction(useFlagObject);
  api.onCanEquip(dropFlagForWeapon);
  api.onCanUnequip(dropFlagOnUnequip);
  game.inGameProcessors.push(returnOwnFlagInCastle);
};
