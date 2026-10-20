/**
 * Developer commands for testing the Moons of Peril:
 * - ::moon <blood|blue|eclipse> enters that Moon's arena through its statue's portal, without the
 *   quest or the warning;
 * - ::moonphase <blood|blue|eclipse> <0-7> moves that Moon's loop to the segment for that focus
 *   (0 New Moon special, 4 Full Moon special, the rest glyphs), from the next tick;
 * - ::moonhp <hitpoints> sets the player's own Moon's health;
 * - ::moonreset clears the subdued Moons, as opening the Lunar Chest does;
 * - ::moondead [blood|blue|eclipse] marks that Moon (or all three) subdued, for the Lunar Chest.
 */
const Common = require("./Common.MoonsOfPeril");
const Cycle = require("./Cycle.MoonsOfPeril");
const Arena = require("./Arena.MoonsOfPeril");

const moonArg = (parts) => {
  const moon = String(parts?.[1] ?? "").toLowerCase();
  return Common.MOONS.includes(moon) ? moon : null;
};

function enterMoon({ player, parts }) {
  const moon = moonArg(parts);
  if (!moon) {
    player.sendMessage("Use ::moon <blood|blue|eclipse>.");
    return true;
  }
  Common.setDead(player, moon, false);
  Arena.enter(player, moon);
  return true;
}

function setPhase({ player, parts }) {
  const moon = moonArg(parts);
  const focus = Number(parts?.[2]);
  const arena = moon ? Cycle.arenaOf(moon) : null;
  const index = arena?.segments.findIndex((segment) => segment.focus === focus) ?? -1;
  if (!arena || index < 0) {
    player.sendMessage("Use ::moonphase <blood|blue|eclipse> <0-7>.");
    return true;
  }
  arena.jumpTo(index);
  const segment = arena.segments[index];
  player.sendMessage(`The ${arena.spec.name} moves to focus ${focus}${segment.special ? ` (${segment.special})` : ""}.`);
  return true;
}

function setHp({ player, parts }) {
  const arena = Arena.arenaOfPlayer(player);
  const fight = arena?.fights.get(player);
  const hitpoints = Number(parts?.[1]);
  if (!fight || fight.killed) {
    player.sendMessage("You are not fighting a Moon.");
    return true;
  }
  if (!Number.isInteger(hitpoints) || hitpoints < 1 || hitpoints > Common.data.hud.maxHitpoints) {
    player.sendMessage("Use ::moonhp <hitpoints>.");
    return true;
  }
  fight.setHp(hitpoints);
  player.sendMessage(`Your ${arena.spec.name} now has ${hitpoints} hitpoints.`);
  return true;
}

function reset({ player }) {
  for (const moon of Common.MOONS) Common.setDead(player, moon, false);
  player.sendMessage("The Moons are no longer subdued.");
  return true;
}

function markDead({ player, parts }) {
  const moon = moonArg(parts);
  for (const each of moon ? [moon] : Common.MOONS) Common.setDead(player, each, true);
  player.sendMessage(moon ? `The ${Common.data.moons[moon].name} is subdued.` : "All three Moons are subdued.");
  return true;
}

module.exports = function attachCommands(api) {
  const { PlayerRights } = api.core;
  api.registerCommand("moon", enterMoon, PlayerRights.DEVELOPER, "Enter a Moon of Peril's arena (blood|blue|eclipse)");
  api.registerCommand("moonphase", setPhase, PlayerRights.DEVELOPER, "Move a Moon's loop to a focus (moon 0-7)");
  api.registerCommand("moonhp", setHp, PlayerRights.DEVELOPER, "Set your Moon's hitpoints");
  api.registerCommand("moonreset", reset, PlayerRights.DEVELOPER, "Clear the subdued Moons");
  api.registerCommand("moondead", markDead, PlayerRights.DEVELOPER, "Mark a Moon (or all) subdued");
};
