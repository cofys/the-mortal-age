/**
 * Developer commands for testing Amoxliatl: ::amoxliatlhp <hitpoints> sets the player's own
 * Amoxliatl's hitpoints (a few to finish her off), ::amoxliatlspecial <icicle|ice> makes her
 * next attack that special, ::amoxliatl puts the player outside her door.
 */
const Common = require("./Common.Amoxliatl");
const Chamber = require("./Chamber.Amoxliatl");

function setHitpoints({ player, parts }) {
  const boss = Chamber.sessionOf(player)?.boss;
  const hitpoints = Number(parts?.[1]);
  if (!boss || boss.getHitpoints() <= 0) {
    player.sendMessage("You are not in a chamber with Amoxliatl.");
    return true;
  }
  if (!Number.isInteger(hitpoints) || hitpoints < 1) {
    player.sendMessage("Use ::amoxliatlhp <hitpoints>.");
    return true;
  }
  boss.setHitpoints(hitpoints);
  player.sendMessage(`Amoxliatl now has ${hitpoints} hitpoints.`);
  return true;
}

const SPECIALS = { icicle: "icicle", ice: "unstableIce" };

function forceSpecial({ player, parts }) {
  const fight = Chamber.sessionOf(player)?.fight;
  const kind = SPECIALS[String(parts?.[1] ?? "").toLowerCase()];
  if (!fight || fight.stopped || fight.over) {
    player.sendMessage("You are not fighting Amoxliatl.");
    return true;
  }
  if (!kind) {
    player.sendMessage("Use ::amoxliatlspecial <icicle|ice>.");
    return true;
  }
  fight.nextSpecial = kind;
  fight.attacks = fight.attacksBeforeSpecial;
  player.sendMessage(`Amoxliatl's next attack is her ${kind === "icicle" ? "Icicle Crash" : "Unstable Ice"}.`);
  return true;
}

function toDoor({ player }) {
  player.moveTo(Common.toLocation(Common.data.door.outside));
  return true;
}

module.exports = function attachCommands(api) {
  const { DEVELOPER } = api.core.PlayerRights;
  api.registerCommand("amoxliatlhp", setHitpoints, DEVELOPER, "Set your Amoxliatl's hitpoints");
  api.registerCommand("amoxliatlspecial", forceSpecial, DEVELOPER, "Make Amoxliatl's next attack a special (icicle or ice)");
  api.registerCommand("amoxliatl", toDoor, DEVELOPER, "Teleport outside Amoxliatl's door");
};
