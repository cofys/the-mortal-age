// Each player's charts: saved with the player and sent to the client at login, where the Captain's
// log (interface 935, script 8706) and the seas' rapids (multilocs on sea completion) read them.
const common = require("./Common.Charting");

function onLogin({ player }) {
  common.sendProgress(player);
}

/** `charting:mark` { player, spot }: a task charted elsewhere (a quest's own flag), silently. */
function onMark({ player, spot }) {
  const task = common.spotByKey(spot);
  if (task) common.mark(player, task);
}

/** `charting:chart` { player, spot }: a task charted by another plugin's own action (a quest's), with the usual messages. */
function onChart({ player, spot }) {
  const task = common.spotByKey(spot);
  if (task) common.complete(player, task, { lines: [] });
}

function attach(api) {
  common.init(api);
  api.persistAttribute(common.PROGRESS_ATTRIBUTE, {});
  api.onPlayerLogin(onLogin);
  api.onCustomEvent("charting:mark", onMark);
  api.onCustomEvent("charting:chart", onChart);
}

module.exports = attach;
