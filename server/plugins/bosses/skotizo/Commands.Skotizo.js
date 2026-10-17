/**
 * Developer commands for testing Skotizo:
 * - ::skotizo puts the player straight into a lair of their own, no totem needed;
 * - ::skotizohp <hitpoints> sets their Skotizo's hitpoints (150 for the spawns, a few to finish);
 * - ::skotizoaltars [count] wakes that many altars in their lair (all four by default) and puts
 *   the rest to sleep.
 */
const Common = require("./Common.Skotizo");
const Lair = require("./Lair.Skotizo");

function enterLair({ player }) {
  Lair.arrive(player);
  Common.playMusic(player);
  Common.later(2, () => Lair.sessionOf(player)?.fight?.openHud());
  return true;
}

function fightOf(player) {
  const fight = Lair.sessionOf(player)?.fight;
  if (fight?.boss && fight.boss.getHitpoints() > 0) return fight;
  player.sendMessage("You are not in a lair with Skotizo.");
  return null;
}

function setHitpoints({ player, parts }) {
  const fight = fightOf(player);
  const hitpoints = Number(parts?.[1]);
  if (!fight) return true;
  if (!Number.isInteger(hitpoints) || hitpoints < 1) {
    player.sendMessage("Use ::skotizohp <hitpoints>.");
    return true;
  }
  fight.boss.setHitpoints(hitpoints);
  player.sendMessage(`Skotizo now has ${hitpoints} hitpoints.`);
  return true;
}

function wakeAltars({ player, parts }) {
  const fight = fightOf(player);
  if (!fight) return true;
  const count = parts?.[1] === undefined ? fight.altars.size : Number(parts[1]);
  if (!Number.isInteger(count) || count < 0 || count > fight.altars.size) {
    player.sendMessage(`Use ::skotizoaltars [0-${fight.altars.size}].`);
    return true;
  }
  [...fight.altars.values()].forEach((altar, index) => {
    if (index < count && !altar.awake) fight.wake(altar);
    if (index >= count && altar.awake) fight.sleep(altar);
  });
  player.sendMessage(`${fight.awakeCount()} altars are awake.`);
  return true;
}

module.exports = function attachCommands(api) {
  const { DEVELOPER } = api.core.PlayerRights;
  api.registerCommand("skotizo", enterLair, DEVELOPER, "Enter a Skotizo lair of your own");
  api.registerCommand("skotizohp", setHitpoints, DEVELOPER, "Set your Skotizo's hitpoints");
  api.registerCommand("skotizoaltars", wakeAltars, DEVELOPER, "Wake [count] altars in your Skotizo lair, the rest asleep");
};
