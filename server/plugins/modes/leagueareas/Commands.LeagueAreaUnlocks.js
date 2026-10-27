/**
 * Developer command: `::areas` lists your areas, the next unlock and where you stand;
 * `::areas <id|name>` unlocks one through the usual checks. (`::area` is AdminCommands' Area-class debug.)
 */
const Common = require("./Common.LeagueAreaUnlocks");
const Regions = require("./Regions.LeagueAreaUnlocks");
const Unlock = require("./Unlock.LeagueAreaUnlocks");

function areaCommand({ player, parts }) {
  const type = Common.leagueOf(player);
  if (type === null) {
    player.sendMessage(Common.message("notLeague"));
    return true;
  }
  const argument = parts.slice(1).join(" ").trim();
  if (!argument) {
    const at = player.getLocation();
    const here = Regions.areaAt(type, at.getX(), at.getY());
    const next = Common.nextSlot(type, player);
    player.sendMessage(Common.message(next ? "areaList" : "areaListFull", {
      league: Common.leagueInfo(type).shortName,
      areas: Common.unlocked(player).map((id) => Common.area(id).name).join(", "),
      next: next?.tasks,
      tasks: Common.tasks(player),
      here: here === null ? Common.message("openArea") : Common.area(here).name,
    }));
    return true;
  }
  const area = /^\d+$/.test(argument) ? Common.area(Number(argument)) : Common.areaByName(argument);
  if (!area) {
    player.sendMessage(Common.message("noArea", { name: argument }));
    return true;
  }
  Unlock.unlock(player, area.id);
  return true;
}

module.exports = function attach(api) {
  api.registerCommand("areas", areaCommand, api.core.PlayerRights.DEVELOPER, "List your league areas, or unlock one: ::areas [id or name]");
};
