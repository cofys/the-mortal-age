"use strict";

const { playerState } = require("../ActionState");
const { clearMovementRequest } = require("../../behaviours/navigation/BotNavigation");

/**
 * Weighted choice between short action lists, re-rolled every time the action
 * starts, then run in order. Lets one activity vary what a bot does at a step,
 * e.g. on a full inventory: bank, drop, sell, or smelt then bank/sell/drop.
 *
 * JSON: { "type": "choose", "options": [ { "weight": 2, "actions": [ ... ] }, ... ] }
 */
function createChooseAction(spec, compileAction) {
  const options = (spec.options ?? [])
    .map((option) => ({
      weight: Math.max(0, Number(option.weight ?? 1)),
      actions: (option.actions ?? []).map(compileAction),
    }))
    .filter((option) => option.weight > 0 && option.actions.length > 0);
  if (!options.length) {
    throw new Error("[bot activities] choose needs options with a weight and actions");
  }
  const totalWeight = options.reduce((sum, option) => sum + option.weight, 0);
  const stateFor = (player) => playerState(action, player, () => ({ option: null, index: 0 }));
  const current = (bot) => bot.option?.actions[bot.index] ?? null;

  const action = {
    id: "choose",
    update(ctx) {
      const bot = stateFor(ctx.player);
      if (!bot.option) {
        let roll = Math.random() * totalWeight;
        bot.option = options.find((option) => (roll -= option.weight) < 0) ?? options[options.length - 1];
        bot.index = 0;
      }
      const step = current(bot);
      const result = step.update(ctx);
      if (result === "success") {
        step.stop?.(ctx);
        // As between brain actions: the next step must not inherit this one's walk,
        // nor an interface it left open (busy() would stall it).
        clearMovementRequest(ctx.player);
        if (Number(ctx.player.getInterfaceId?.() ?? -1) > 0) ctx.player.getPacketSender?.()?.sendInterfaceRemoval?.();
        bot.index += 1;
        if (bot.index < bot.option.actions.length) {
          return "running";
        }
        bot.option = null;
        return "success";
      }
      if (result === "failed") {
        step.stop?.(ctx);
        bot.option = null;
      }
      return result;
    },
    stop(ctx) {
      const bot = stateFor(ctx.player);
      current(bot)?.stop?.(ctx);
      bot.option = null;
    },
    madeProgress(ctx) {
      return current(stateFor(ctx.player))?.madeProgress?.(ctx) === true;
    },
    describe(ctx) {
      const step = current(stateFor(ctx.player));
      return step?.describe?.(ctx) ?? `choose -> ${step?.id ?? "next roll"}`;
    },
  };
  return action;
}

module.exports = {
  createChooseAction,
};
