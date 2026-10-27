/**
 * Developer commands. `::leaguetasks <search>` finds a league's tasks by name or id, with their
 * tier, points and whether the character has them, so `::leaguetask <id>` (LeagueMode) can
 * complete a real one.
 */
const Common = require("./Common.LeagueTasks");

const MAX_RESULTS = 10;

function searchCommand({ player, parts }) {
  const search = parts.slice(1).join(" ").trim().toLowerCase();
  const type = Common.leagueOf(player);
  if (!search || type === null) {
    player.sendMessage(Common.message("searchUsage"));
    return true;
  }
  const completed = new Set(Common.completedIds(player));
  const matches = Common.catalog(type).tasks.filter((task) => task.id.includes(search.replace(/\s+/g, "-")) || task.name.toLowerCase().includes(search));
  if (!matches.length) {
    player.sendMessage(Common.message("searchNone", { league: Common.league(type).shortName, search }));
    return true;
  }
  for (const task of matches.slice(0, MAX_RESULTS)) {
    player.sendMessage(Common.message("searchResult", {
      id: task.id, name: task.name, tier: Common.tierName(task.tier), points: task.points, done: completed.has(task.id) ? ", done" : "",
    }));
  }
  if (matches.length > MAX_RESULTS) player.sendMessage(Common.message("searchMore", { count: matches.length - MAX_RESULTS }));
  return true;
}

module.exports = function attach(api) {
  api.registerCommand("leaguetasks", searchCommand, api.core.PlayerRights.DEVELOPER, "Find league tasks by name or id: ::leaguetasks <search>");
};
