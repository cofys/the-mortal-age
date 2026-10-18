/**
 * Developer commands for testing Vardorvis: ::vardorvishp <hitpoints> sets the player's own
 * Vardorvis' hitpoints (below 570 for his specials, 231 to enrage him); ::vardorvisforce
 * <axes|head|dash|strangle> has him use that attack now.
 */
const Common = require("./Common.Vardorvis");
const Site = require("./Site.Vardorvis");
const Axes = require("./Axes.Vardorvis");
const Head = require("./Head.Vardorvis");
const Dash = require("./Dash.Vardorvis");
const Strangle = require("./Strangle.Vardorvis");

function fightOf(player) {
  const fight = Site.sessionOf(player)?.fight;
  if (!fight || !fight.alive()) {
    player.sendMessage("You are not fighting Vardorvis.");
    return null;
  }
  return fight;
}

function setHitpoints({ player, parts }) {
  const fight = fightOf(player);
  const hitpoints = Number(parts?.[1]);
  if (!fight) return true;
  if (!Number.isInteger(hitpoints) || hitpoints < 1) {
    player.sendMessage("Use ::vardorvishp <hitpoints>.");
    return true;
  }
  fight.boss.setHitpoints(Math.min(hitpoints, fight.boss.getMaxHitpoints()));
  player.sendMessage(`Vardorvis now has ${fight.boss.getHitpoints()} hitpoints.`);
  return true;
}

const FORCED = {
  axes: (fight) => Axes.throwSet(fight),
  head: (fight) => Head.gaze(fight),
  dash: (fight) => Dash.start(fight),
  strangle: (fight) => {
    fight.strangles++;
    Strangle.start(fight);
  },
};

function force({ player, parts }) {
  const fight = fightOf(player);
  const attack = FORCED[String(parts?.[1] ?? "").toLowerCase()];
  if (!fight) return true;
  if (!attack) {
    player.sendMessage(`Use ::vardorvisforce <${Object.keys(FORCED).join("|")}>.`);
    return true;
  }
  if (!fight.engaged) fight.engage();
  attack(fight);
  return true;
}

module.exports = function attachCommands(api) {
  const { DEVELOPER } = Common.core.PlayerRights;
  api.registerCommand("vardorvishp", setHitpoints, DEVELOPER, "Set your Vardorvis' hitpoints");
  api.registerCommand("vardorvisforce", force, DEVELOPER, "Make your Vardorvis use an attack now");
};
