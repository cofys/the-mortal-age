/**
 * Developer commands for testing the Phantom Muspah: ::muspah enters the lair without Secrets of
 * the North; ::muspahhp <hitpoints> sets the player's own Muspah's hitpoints (636 or 424 for a
 * special at its next turn, 126 for the shockwave); ::muspahshield <points> sets the shield's;
 * ::muspahkill deals its remaining hitpoints, credited to the player.
 */
const Common = require("./Common.PhantomMuspah");
const Lair = require("./Lair.PhantomMuspah");

const fightOf = (player) => Lair.sessionOf(player)?.fight ?? null;

function enterLair({ player }) {
  if (Lair.sessionOf(player)) {
    player.sendMessage("You are already in the Phantom Muspah's lair.");
    return true;
  }
  Lair.enter(player);
  return true;
}

function setHitpoints({ player, parts }) {
  const fight = fightOf(player);
  const hitpoints = Number(parts?.[1]);
  if (!fight?.muspah || fight.over) {
    player.sendMessage("You are not fighting the Phantom Muspah.");
    return true;
  }
  if (!Number.isInteger(hitpoints) || hitpoints < 1 || hitpoints > Common.data.boss.hitpoints) {
    player.sendMessage("Use ::muspahhp <hitpoints>.");
    return true;
  }
  fight.muspah.setHitpoints(hitpoints);
  fight.showHitpoints();
  player.sendMessage(`The Phantom Muspah now has ${hitpoints} hitpoints.`);
  return true;
}

function setShield({ player, parts }) {
  const fight = fightOf(player);
  const points = Number(parts?.[1]);
  if (!fight || fight.form !== "shielded") {
    player.sendMessage("The Phantom Muspah's shield is not up.");
    return true;
  }
  if (!Number.isInteger(points) || points < 1 || points > Common.data.shield.points) {
    player.sendMessage("Use ::muspahshield <points>.");
    return true;
  }
  fight.shield = points;
  fight.showShield();
  player.sendMessage(`The prayer shield now has ${points} points.`);
  return true;
}

function kill({ player }) {
  const fight = fightOf(player);
  const muspah = fight?.muspah;
  if (!muspah || fight.over) {
    player.sendMessage("You are not fighting the Phantom Muspah.");
    return true;
  }
  const { HitDamage, HitMask } = Common.core;
  const hitpoints = muspah.getHitpoints();
  // Credited to the player, so the kill counts and drops its loot.
  muspah.getCombat().addDamage(player, hitpoints);
  muspah.getCombat().getHitQueue().addPendingDamage([new HitDamage(hitpoints, HitMask.RED)]);
  return true;
}

module.exports = function attachCommands(api) {
  const { DEVELOPER } = api.core.PlayerRights;
  api.registerCommand("muspah", enterLair, DEVELOPER, "Enter the Phantom Muspah's lair");
  api.registerCommand("muspahhp", setHitpoints, DEVELOPER, "Set your Phantom Muspah's hitpoints");
  api.registerCommand("muspahshield", setShield, DEVELOPER, "Set your Phantom Muspah's shield");
  api.registerCommand("muspahkill", kill, DEVELOPER, "Finish your Phantom Muspah off");
};
