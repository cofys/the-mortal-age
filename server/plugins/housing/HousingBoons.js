"use strict";

/**
 * HousingBoons — room boons tick.
 *
 * A claimed housing plot plus real engine rooms makes housing USEFUL, not
 * just cosmetic. Every ~30s, each real player standing in their OWN house
 * (private area owned by them) with a plot claimed gets:
 *   - CHAPEL:   +2 prayer points (up to max) — "You feel blessed."
 *   - WORKSHOP: +20 Crafting XP — "You tinker at your workbench."
 *   - KITCHEN:  +20 Cooking XP — "You practice recipes at your stove."
 *
 * All effects go through the real SkillManager. No LLM, no sim: the rooms
 * are read from the real `construction:house` save, ownership from the
 * private area's owner, plot from the real attribute.
 *
 * Follows the CitizenDirector Task pattern: a server Task submitted to the
 * TaskManager on plugin attach.
 */

const { hasRoom } = require("./lib/house-value");

let Task = null;
try {
  ({ Task } = require("../../src/main/typescript/elvarg/game/task/Task"));
} catch {
  // plain-node test env: start() no-ops without Task
}

let Skill = null;
try {
  ({ Skill } = require("../../src/main/typescript/elvarg/game/model/Skill"));
} catch {
  // plain-node test env: tick functions no-op without Skill
}

const HOUSE_ATTRIBUTE = "construction:house";
const HOUSING_PLOT_ATTRIBUTE = "housing:plot";

// ~30s at 600ms/tick.
const BOON_TICK_TICKS = 50;

const CHAPEL_PRAYER_RESTORE = 2;
const WORKSHOP_CRAFT_XP = 20;
const KITCHEN_COOK_XP = 20;

function isRealPlayer(p) {
  try {
    return !!p && p.isPlayer?.() === true && p.isPlayerBot?.() !== true;
  } catch {
    return false;
  }
}

/** True when the player stands in a private area they own (their house). */
function inOwnHouse(player) {
  try {
    const area = player.getPrivateArea?.();
    return !!area && area.owner === player;
  } catch {
    return false;
  }
}

function hasPlot(player) {
  try {
    return !!player.getAttribute?.(HOUSING_PLOT_ATTRIBUTE);
  } catch {
    return false;
  }
}

function houseSaveOf(player) {
  try {
    return player.getAttribute?.(HOUSE_ATTRIBUTE) || null;
  } catch {
    return null;
  }
}

function applyBoons(player, save) {
  if (!Skill) return;
  const sm = player.getSkillManager?.();
  if (!sm) return;
  try {
    if (hasRoom(save, "CHAPEL")) {
      const max = sm.getMaxLevel(Skill.PRAYER);
      sm.increaseCurrentLevel(Skill.PRAYER, CHAPEL_PRAYER_RESTORE, max);
    }
    if (hasRoom(save, "WORKSHOP")) {
      sm.addExperience(Skill.CRAFTING, WORKSHOP_CRAFT_XP);
    }
    if (hasRoom(save, "KITCHEN")) {
      sm.addExperience(Skill.COOKING, KITCHEN_COOK_XP);
    }
  } catch {
    // One bad player must never break the tick.
  }
}

function tickHousingBoons(api) {
  let world = null;
  try {
    world = api.core?.World;
  } catch {
    return;
  }
  const players = world?.players;
  if (!players || typeof players.forEach !== "function") return;
  players.forEach((p) => {
    try {
      if (!isRealPlayer(p)) return;
      if (!hasPlot(p)) return;
      if (!inOwnHouse(p)) return;
      const save = houseSaveOf(p);
      if (!save) return;
      applyBoons(p, save);
    } catch {
      // Per-player isolation.
    }
  });
}

function start(api) {
  try {
    if (!Task) return;
    const tm = api.getTaskManager?.();
    if (!tm) return;
    const taskApi = api;
    class HousingBoonTask extends Task {
      execute() {
        try {
          tickHousingBoons(taskApi);
        } catch {
          // Never kill the task on a bad tick.
        }
      }
    }
    tm.submit(new HousingBoonTask(BOON_TICK_TICKS));
  } catch {
    // TaskManager unavailable (tests) — tick functions stay testable.
  }
}

module.exports = { start, tickHousingBoons };
module.exports._test = {
  isRealPlayer,
  inOwnHouse,
  hasPlot,
  applyBoons,
  BOON_TICK_TICKS,
  CHAPEL_PRAYER_RESTORE,
  WORKSHOP_CRAFT_XP,
  KITCHEN_COOK_XP,
};
