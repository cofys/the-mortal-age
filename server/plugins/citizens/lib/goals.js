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
const GOAL_BOSS_SLAYER = "boss_slayer";
const GOAL_MAKE_FRIENDS = "make_friends";

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

/**
 * Count boss-run participations from the journal (boss kind events).
 * Read-only; never throws.
 */
function bossRunCount(citizenName) {
  try {
    const { getJournal } = require("./CitizenJournal");
    const events = getJournal().recent(citizenName, 200) ?? [];
    return events.filter((e) => {
      const kind = String(e?.kind ?? "").toLowerCase();
      const text = String(e?.text ?? "").toLowerCase();
      return kind === "boss" || text.includes("boss run") || text.includes("giant mole") ||
        text.includes("scurrius") || text.includes("obor");
    }).length;
  } catch {
    return 0;
  }
}

/** Count friends (players and citizens) from the bonds graph. Read-only. */
function friendCount(citizenName) {
  try {
    const { bonds } = require("./CitizenBonds");
    return (bonds(citizenName).friends ?? []).length;
  } catch {
    return 0;
  }
}

/** Fresh goal for a role; targets escalate with `tier` (0-based). */
function nextGoalForRole(role, tier = 0) {
  if (role === "guard") {
    // Guards rotate between promotion and proving themselves in boss hunts.
    if (tier % 2 === 1) {
      return {
        type: GOAL_BOSS_SLAYER,
        target: 3 + tier, // boss runs joined
        progress: 0,
        startedAt: Date.now(),
      };
    }
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
  // Commoners want connection as much as coin: alternate craft and friends.
  if (tier % 3 === 2) {
    return {
      type: GOAL_MAKE_FRIENDS,
      target: 5 + tier * 2,
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
  } else if (goal.type === GOAL_BOSS_SLAYER) {
    progress = bossRunCount(directorState.citizenName ?? "");
  } else if (goal.type === GOAL_MAKE_FRIENDS) {
    progress = friendCount(directorState.citizenName ?? "");
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
  GOAL_BOSS_SLAYER,
  GOAL_MAKE_FRIENDS,
  coinWealth,
  nextGoalForRole,
  sampleGoalProgress,
  isComplete,
  bossRunCount,
  friendCount,
};
