/**
 * Vardorvis' Combat Achievements (plugins/achievements/combatachievements/): his kill count is the
 * plugin's own (counted by event, so the kill-count message comes first and the tasks after the
 * fight's time, as captured), and the fight's tasks are judged here:
 * - Vardorvis Speed-Trialist / Speed-Chaser / Speed-Runner: under 1:15, 1:05 and 0:55, off a slayer
 *   task, timed like the "Fight duration" message.
 * - Vardorvis Sleeper: a kill of the awakened Vardorvis.
 * The kill-count tasks (Vardorvis Adept, Vardorvis Master) finish from the count. An awakened kill
 * has its own count (varp 3971) and isn't one of these.
 */
const Common = require("./Common.Vardorvis");

const MONSTER = "Vardorvis";
const SPEED_TASKS = [["Vardorvis Speed-Trialist", 75], ["Vardorvis Speed-Chaser", 65], ["Vardorvis Speed-Runner", 55]];
const SLEEPER = "Vardorvis Sleeper";

/** Counts the kill; `announce(kills)` tells the player the count before any task finishes. */
function killed(player, ownKills, announce) {
  let announced = false;
  const request = {
    player,
    monster: MONSTER,
    count: ownKills,
    announce: (kills) => {
      announced = true;
      announce(kills);
    },
  };
  Common.api.emitCustomEvent("combat-achievements:kill", request);
  if (!announced) announce(ownKills);
  return Number.isInteger(request.total) ? request.total : null;
}

function onSlayerTask(player, npc) {
  const request = { player, npc, onTask: false };
  Common.api.emitCustomEvent("slayer:on-task", request);
  return request.onTask === true;
}

/** The fight's own tasks, judged after the kill's messages. */
function judge(fight, ticks) {
  const { player } = fight;
  const complete = (task) => Common.api.emitCustomEvent("combat-achievements:complete", { player, task });
  if (fight.awakened) {
    complete(SLEEPER);
    return;
  }
  if (onSlayerTask(player, fight.boss)) return;
  for (const [task, seconds] of SPEED_TASKS) if (ticks * 0.6 < seconds) complete(task);
}

function answerKillCount({ player, counts }) {
  const kills = Common.count(player, Common.KILLS_ATTRIBUTE);
  if (kills > 0) counts[MONSTER] = kills;
}

function answerPersonalBest(request) {
  if (request.monster !== MONSTER) return;
  const best = Common.count(request.player, Common.BEST_TICKS_ATTRIBUTE);
  if (best > 0) request.best = best;
}

function attachCombatAchievements(api) {
  api.onCustomEvent("combat-achievements:kill-count", answerKillCount);
  api.onCustomEvent("combat-achievements:personal-best", answerPersonalBest);
}

module.exports = { attachCombatAchievements, killed, judge };
