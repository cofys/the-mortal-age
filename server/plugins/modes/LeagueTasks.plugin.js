/**
 * League tasks (https://oldschool.runescape.wiki/w/Trailblazer_Reloaded_League/Tasks,
 * https://oldschool.runescape.wiki/w/Raging_Echoes_League/Tasks): the catalog each league's
 * characters complete for League Points, awarded from the game by data-driven triggers, and the
 * cache's task list interface opened from the league side panel. The catalog
 * (data/league-tasks.json) is generated from the Wiki by scripts/generate-league-tasks.ts and sent
 * to the client as enum and DB row overrides, since the cache only carries the current league's.
 * Points and the award itself are LeaguePoints'; other plugins complete a task with
 * `league:complete-task` { player, id } (docs/leagues.md).
 */
const Common = require("./leaguetasks/Common.LeagueTasks");

module.exports = {
  name: "LeagueTasks",
  members: true,
  dependsOn: ["LeagueMode", "LeaguePoints"],
  register(api) {
    Common.init(api);
    require("./leaguetasks/Catalog.LeagueTasks")(api);
    require("./leaguetasks/Complete.LeagueTasks")(api);
    require("./leaguetasks/Interface.LeagueTasks")(api);
    require("./leaguetasks/Triggers.LeagueTasks")(api);
    require("./leaguetasks/Commands.LeagueTasks")(api);
  },
};
