/**
 * The side journal's Leagues tab: the client shows it once the league varbits are set, and a
 * click on it (629:34) mounts the league side panel (656) in the journal's content container,
 * as plugins/interface/SideJournalDefaults.plugin.js does for the other tabs. Its points bar
 * (656:23) is filled with script 3226, after every award as captured (227/00070).
 */
const Common = require("./Common.LeagueMode");

/** Players whose journal currently shows the league panel. */
const panelOpen = new WeakSet();

function uid(group, child) {
  return (group << 16) | child;
}

function points(player) {
  const query = { player, points: 0, tasks: 0 };
  Common.api.emitCustomEvent("league:points", query);
  return query.points | 0;
}

function fillPanel(player) {
  const { journal } = Common.data;
  player.getPacketSender().sendInterfaceScript(journal.fillScript, [uid(journal.sidePanel, journal.sidePanelFill), points(player)]);
}

function openLeagueTab({ player }) {
  if (!Common.isLeagueProfile(player)) return false;
  const { journal, varbits } = Common.data;
  const sender = player.getPacketSender();
  sender.sendSubInterface(uid(journal.group, journal.container), journal.sidePanel);
  sender.sendVarbit(varbits.journalTab, journal.tabIndex);
  panelOpen.add(player);
  fillPanel(player);
  return true;
}

/** Another journal tab (SideJournalDefaults' `journal:tab-mounted`) replaces the panel; later fills would address a missing component. */
function tabMounted({ player, groupId }) {
  if (groupId !== Common.data.journal.sidePanel) panelOpen.delete(player);
}

function pointsChanged({ player }) {
  if (panelOpen.has(player)) fillPanel(player);
}

module.exports = function attach(api) {
  const { journal } = Common.data;
  api.onInterfaceActionButton(uid(journal.group, journal.leagueTab), openLeagueTab);
  api.onCustomEvent("journal:tab-mounted", tabMounted);
  api.onCustomEvent("league:points-changed", pointsChanged);
};
