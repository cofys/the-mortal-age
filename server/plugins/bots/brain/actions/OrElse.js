"use strict";

const { playerState } = require("../ActionState");
const { clearMovementRequest } = require("../../behaviours/navigation/BotNavigation");

/**
 * Runs `primary`; if it fails, runs `fallback` instead. Chains, e.g. bank, else sell
 * at a general store, else drop:
 *
 * JSON: { "type": "bank", "itemIds": [...], "orElse": { "type": "sellItems", ..., "orElse": { ... } } }
 */
function createOrElseAction(primary, fallback) {
  const stateFor = (player) => playerState(action, player, () => ({ fallingBack: false }));
  const active = (player) => (stateFor(player).fallingBack ? fallback : primary);

  const action = {
    id: primary.id,
    update(ctx) {
      const bot = stateFor(ctx.player);
      if (!bot.fallingBack) {
        const result = primary.update(ctx);
        if (result !== "failed") return result;
        primary.stop?.(ctx);
        clearMovementRequest(ctx.player);
        bot.fallingBack = true;
      }
      const result = fallback.update(ctx);
      if (result !== "running") {
        fallback.stop?.(ctx);
        bot.fallingBack = false;
      }
      return result;
    },
    stop(ctx) {
      active(ctx.player).stop?.(ctx);
      stateFor(ctx.player).fallingBack = false;
    },
    madeProgress(ctx) {
      return active(ctx.player).madeProgress?.(ctx) === true;
    },
    describe(ctx) {
      const step = active(ctx.player);
      return step.describe?.(ctx) ?? step.id;
    },
  };
  return action;
}

module.exports = {
  createOrElseAction,
};
