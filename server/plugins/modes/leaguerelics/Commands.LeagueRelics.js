/** Developer commands: `::relic` lists the chosen relics; `::relic <tier> <slot>` chooses one through the usual checks. */
const Common = require("./Common.LeagueRelics");
const Unlock = require("./Unlock.LeagueRelics");

function relicCommand({ player, parts }) {
  const type = Common.leagueOf(player);
  if (type === null) {
    player.sendMessage(Common.message("notLeague"));
    return true;
  }
  if (parts.length < 3) {
    const picks = Common.chosen(player);
    const names = Object.entries(picks).map(([tier, slot]) => `T${Number(tier) + 1} ${Common.relic(type, Number(tier), slot)?.name ?? "?"}`);
    const extra = Common.reloadedPick(player);
    if (extra) names.push(`(Reloaded) ${extra.name}`);
    player.sendMessage(Common.message("relicList", {
      league: Common.league(type).shortName, relics: names.length ? names.join(", ") : Common.message("relicNone"),
    }));
    return true;
  }
  const tier = Number(parts[1]);
  const slot = Number(parts[2]);
  if (!Number.isInteger(tier) || tier < 1 || tier > 8 || !Number.isInteger(slot) || slot < 1 || slot > 3) {
    player.sendMessage(Common.message("relicUsage"));
    return true;
  }
  Unlock.unlock(player, tier - 1, slot);
  return true;
}

module.exports = function attach(api) {
  api.registerCommand("relic", relicCommand, api.core.PlayerRights.DEVELOPER, "List your relics, or choose one: ::relic [tier 1-8] [slot 1-3]");
};
