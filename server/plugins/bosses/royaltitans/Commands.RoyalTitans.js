/**
 * Developer commands for testing the Royal Titans, following Commands.Araxxor.
 * ::royalkill leaves both titans at 1 HP: the engine only reports deaths (and rolls
 * drops) with a killer, so anonymous queue damage would skip the corpse flow — the
 * player lands the final hit. ::royalhp sets HP (210 or less arms the teleport pair).
 */
const Shared = require("./Shared.RoyalTitans");
const Area = require("./Area.RoyalTitans");
const Specials = require("./Specials.RoyalTitans");

let core = null;

function liveTitans(player) {
  const session = Area.sessionOfPlayer(player);
  if (!session) return [];
  return [session.branda, session.eldric].filter((npc) => npc && Shared.isLiveTitan(npc.getId()) && Shared.alive(npc));
}

function killTitans({ player }) {
  const titans = liveTitans(player);
  if (titans.length === 0) {
    player.sendMessage("You have no active Royal Titans.");
    return true;
  }
  for (const npc of titans) npc.setHitpoints(1);
  player.sendMessage("The Royal Titans are down to their last hitpoint. Finish them.");
  return true;
}

function setTitanHitpoints({ player, parts }) {
  const titans = liveTitans(player);
  if (titans.length === 0) {
    player.sendMessage("You have no active Royal Titans.");
    return true;
  }
  const hitpoints = Number(parts?.[1]);
  if (!Number.isInteger(hitpoints) || hitpoints < 1 || hitpoints > Shared.MAX_HITPOINTS) {
    player.sendMessage(`Use ::royalhp <hitpoints 1-${Shared.MAX_HITPOINTS}>.`);
    return true;
  }
  for (const npc of titans) npc.setHitpoints(hitpoints);
  // Setting HP at or below the threshold by hand must teleport exactly like a real hit.
  Specials.teleportTitans(titans[0]);
  const teleported = titans[0].getAttribute(Shared.TELEPORTED_ATTRIBUTE) === true ? " (teleported)" : "";
  player.sendMessage(`The Royal Titans now have ${hitpoints} hitpoints${teleported}.`);
  return true;
}

function forceBlast({ player }) {
  const titans = liveTitans(player);
  if (titans.length === 0) {
    player.sendMessage("You have no active Royal Titans.");
    return true;
  }
  for (const npc of titans) npc.setAttribute(Shared.BLAST_AT_ATTRIBUTE, core.World.getProcessCycle());
  player.sendMessage("The next attack will charge the Elemental Blast.");
  return true;
}

module.exports = function attachCommands(api) {
  core = api.core;
  api.registerCommand("royalkill", killTitans, api.core.PlayerRights.DEVELOPER, "Defeat your active Royal Titans");
  api.registerCommand("royalhp", setTitanHitpoints, api.core.PlayerRights.DEVELOPER, "Set your Royal Titans' hitpoints");
  api.registerCommand("royalblast", forceBlast, api.core.PlayerRights.DEVELOPER, "Force the next Elemental Blast");
};
