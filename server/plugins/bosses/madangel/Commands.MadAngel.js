/**
 * Developer commands for testing the Mad Angel: ::madangelhp <hitpoints> sets the player's
 * own angel's hitpoints (360 to see the enrage, a few to finish it off); ::madangelspecial
 * <sweep|blast|smite> has the woken angel use that special now.
 */
const Instance = require("./Instance.MadAngel");

function setAngelHitpoints({ player, parts }) {
  const angel = Instance.sessionOf(player)?.boss;
  const hitpoints = Number(parts?.[1]);
  if (!angel || angel.getHitpoints() <= 0) {
    player.sendMessage("You are not in a cathedral with the Mad Angel.");
    return true;
  }
  if (!Number.isInteger(hitpoints) || hitpoints < 1) {
    player.sendMessage("Use ::madangelhp <hitpoints>.");
    return true;
  }
  angel.setHitpoints(hitpoints);
  player.sendMessage(`The Mad Angel now has ${hitpoints} hitpoints.`);
  return true;
}

const SPECIALS = ["sweep", "blast", "smite"];

function startAngelSpecial({ player, parts }) {
  const fight = Instance.sessionOf(player)?.fight;
  const kind = parts?.[1];
  if (!fight || fight.startTick < 0 || fight.dying || fight.stopped) {
    player.sendMessage("Wake your Mad Angel first.");
    return true;
  }
  if (!SPECIALS.includes(kind)) {
    player.sendMessage("Use ::madangelspecial <sweep|blast|smite>.");
    return true;
  }
  if (fight.special) {
    player.sendMessage("It's already in the middle of a special.");
    return true;
  }
  fight.startSpecial(kind);
  return true;
}

module.exports = function attachCommands(api) {
  api.registerCommand("madangelhp", setAngelHitpoints, api.core.PlayerRights.DEVELOPER, "Set your Mad Angel's hitpoints");
  api.registerCommand("madangelspecial", startAngelSpecial, api.core.PlayerRights.DEVELOPER, "Have your Mad Angel use a special now");
};
