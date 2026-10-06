"use strict";

/**
 * goals — long-term goals so citizens are going somewhere, not looping.
 *
 * A goal is a small JSON blob on the citizens:goal attribute:
 *   { type, target, progress, startedAt, completedAt? }
 * The director samples progress on its slow tick (cheap, read-only) and
 * rotates to a harder goal on completion. Roles get role-flavoured goals.
 */

const GOAL_SAVE_GOLD = "save_gold";
const GOAL_RANK_UP = "rank_up";
const GOAL_MASTER_TRADE = "master_trade";

function coinWealth(player) {
  let total = 0;
  try {
    const inventory = player?.getInventory?.();
    // ItemIds.COINS = 995 (verified in ItemIdentifiers.ts).
    total += inventory?.getAmount?.(995) ?? 0;
    const bank = player?.getBank?.(0);
    total += bank?.getAmount?.(995) ?? 0;
  } catch (error) {
    // Read-only sampling must never break the director tick.
  }
  return total;
}

/** Fresh goal for a role; targets escalate with `tier` (0-based). */
function nextGoalForRole(role, tier = 0) {
  if (role === "guard") {
    return {
      type: GOAL_RANK_UP,
      target: 8 + tier * 8, // duty-hours before the next promotion review
      progress: 0,
      startedAt: Date.now(),
    };
  }
  if (role === "merchant") {
    return {
      type: GOAL_SAVE_GOLD,
      target: 10000 * (tier + 1),
      progress: 0,
      startedAt: Date.now(),
    };
  }
  return {
    type: GOAL_MASTER_TRADE,
    target: 500 * (tier + 1), // work cycles (chop/mine/smelt sessions banked)
    progress: 0,
    startedAt: Date.now(),
  };
}

/**
 * Sample progress for a goal. Returns { progress, complete }. Pure reads;
 * the director persists the blob.
 */
function sampleGoalProgress(goal, player, directorState = {}) {
  if (!goal || goal.completedAt) {
    return { progress: goal?.progress ?? 0, complete: false };
  }
  let progress = goal.progress ?? 0;
  if (goal.type === GOAL_SAVE_GOLD) {
    progress = coinWealth(player);
  } else if (goal.type === GOAL_RANK_UP) {
    progress = (goal.progress ?? 0) + (directorState.dutyHoursAccrued ?? 0);
  } else if (goal.type === GOAL_MASTER_TRADE) {
    progress = (goal.progress ?? 0) + (directorState.workCyclesBanked ?? 0);
  }
  return { progress, complete: progress >= (goal.target ?? Infinity) };
}

function isComplete(goal) {
  return !!goal?.completedAt;
}

module.exports = {
  GOAL_SAVE_GOLD,
  GOAL_RANK_UP,
  GOAL_MASTER_TRADE,
  coinWealth,
  nextGoalForRole,
  sampleGoalProgress,
  isComplete,
};
