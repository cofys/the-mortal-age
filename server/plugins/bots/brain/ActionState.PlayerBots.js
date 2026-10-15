"use strict";

// A compiled activity action is shared by every bot running that activity, so
// per-bot data (current target, click cooldown, last production sample) must be
// keyed by player or bots overwrite each other's state.
const STATE_BY_ACTION = new WeakMap();

function playerState(action, player, create) {
  let byPlayer = STATE_BY_ACTION.get(action);
  if (!byPlayer) {
    byPlayer = new WeakMap();
    STATE_BY_ACTION.set(action, byPlayer);
  }
  let state = byPlayer.get(player);
  if (!state) {
    state = create();
    byPlayer.set(player, state);
  }
  return state;
}

/**
 * Stationary watchdog shared by the walking actions: tracks the last tile the bot stood
 * on and, once it has stood still there, when that began. Returns how long (ms) it has
 * been stationary - 0 on the tick it moves or has only just arrived.
 */
function stationaryFor(bot, player, nowMs) {
  const at = player.getLocation();
  const position = `${at.getX()},${at.getY()},${at.getZ()}`;
  if (position !== bot.lastPosition) {
    bot.lastPosition = position;
    bot.stillSince = 0;
  } else if (!bot.stillSince) {
    bot.stillSince = nowMs;
  }
  return bot.stillSince ? nowMs - bot.stillSince : 0;
}

module.exports = {
  playerState,
  stationaryFor,
};
