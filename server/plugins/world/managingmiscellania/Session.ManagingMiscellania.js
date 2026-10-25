"use strict";

/**
 * Keeps the kingdom current: on login and on every map square change the owed days are paid and,
 * on Miscellania or Etceteria, the visit is recorded (no collection after 30 days without one).
 * All of it is worked out from saved days, so nothing runs per player between visits.
 */

const Common = require("./Common.ManagingMiscellania");

function onLogin({ player }) {
  Common.catchUp(player);
}

function onMapSquareChange({ player }) {
  if (player && Common.onIslands(player)) Common.catchUp(player);
}

/** agent:advance-time: the kingdom's last pay day and visit move back by the whole days skipped. */
function advanceTime(event) {
  const days = Math.floor(event.ms / Common.DAY_MS);
  const player = event.player;
  if (days <= 0 || !player || !Common.ruler(player)) return;
  const kingdom = Common.kingdomOf(player);
  Common.save(player, { ...kingdom, lastDay: kingdom.lastDay - days, lastVisitDay: kingdom.lastVisitDay - days });
  Common.catchUp(player);
  event.handledBy.push("ManagingMiscellania");
}

module.exports = function registerSession(api) {
  Common.bind(api);
  api.persistAttribute(Common.KINGDOM_ATTRIBUTE, null);
  api.onPlayerLogin(onLogin);
  api.onPlayerMapSquareChange(onMapSquareChange);
  api.onCustomEvent("agent:advance-time", advanceTime);
};

module.exports._test = { onLogin, onMapSquareChange, advanceTime };
