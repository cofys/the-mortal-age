/**
 * Amoxliatl's Combat Achievements (plugins/achievements/combatachievements/): her kill count is
 * the plugin's own (counted by event, so the kill-count message comes first, as captured), and
 * the fight's tasks are judged here from what the fight saw:
 * - Temotli Triumph: every hit of the player's in the chamber with the glacial temotli.
 * - Amoxliatl Speed-Trialist / Speed-Chaser: under 1 minute / 30 seconds, by the fight duration.
 * - Nagua Negation: no damage taken in the fight.
 * - Kemo Makti: 10 kills without leaving her chamber.
 * - Totally Shattered: none of her unstable ice shattered.
 * - Without Ralos' Light: no prayer points lost in the fight.
 * The kill-count tasks (Amoxliatl Champion, Amoxliatl Adept) finish from the count.
 */
const Common = require("./Common.Amoxliatl");

const MONSTER = "Amoxliatl";
const SPEED_TASKS = [["Amoxliatl Speed-Trialist", 100], ["Amoxliatl Speed-Chaser", 50]];
const KEMO_MAKTI_KILLS = 10;

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

/** The fight's own tasks, judged at the kill; `ticks` is the fight's length. */
function judge(fight, ticks) {
  const { player, stats, session } = fight;
  const complete = (task) => Common.api.emitCustomEvent("combat-achievements:complete", { player, task });
  if (stats.usedTemotli && !stats.otherWeapon) complete("Temotli Triumph");
  for (const [task, limit] of SPEED_TASKS) if (ticks < limit) complete(task);
  if (stats.damageTaken === 0) complete("Nagua Negation");
  if (session.kills >= KEMO_MAKTI_KILLS) complete("Kemo Makti");
  if (!stats.shattered) complete("Totally Shattered");
  if (!stats.prayerLost) complete("Without Ralos' Light");
}

/** The weapon behind each of the player's hits in the chamber, for Temotli Triumph. */
function weaponUsed({ npc, hit }) {
  const fight = npc?.__amoxliatlFight ?? npc?.__amoxliatlIce;
  const attacker = hit?.getAttacker?.();
  if (!fight || fight.stopped || attacker !== fight.player) return;
  const { Equipment, ItemIdentifiers } = Common.core;
  const weapon = attacker.getEquipment().getItems()[Equipment.WEAPON_SLOT];
  if (weapon?.getId?.() === ItemIdentifiers.GLACIAL_TEMOTLI) fight.stats.usedTemotli = true;
  else fight.stats.otherWeapon = true;
}

function answerKillCount({ player, counts }) {
  const kills = Number(player.getAttribute(Common.KILLS_ATTRIBUTE)) || 0;
  if (kills > 0) counts[MONSTER] = kills;
}

function answerPersonalBest(request) {
  const best = Number(request.player.getAttribute(Common.BEST_TICKS_ATTRIBUTE)) || 0;
  if (request.monster === MONSTER && best > 0) request.best = best;
}

function resetBest(request) {
  if (request.monster !== MONSTER) return;
  request.player.setAttribute(Common.BEST_TICKS_ATTRIBUTE, 0);
  request.handled = true;
}

function attachCombatAchievements(api) {
  api.onNpcHitModify(weaponUsed);
  api.onCustomEvent("combat-achievements:kill-count", answerKillCount);
  api.onCustomEvent("combat-achievements:personal-best", answerPersonalBest);
  api.onCustomEvent("combat-achievements:reset-best", resetBest);
}

module.exports = { attachCombatAchievements, killed, judge };
