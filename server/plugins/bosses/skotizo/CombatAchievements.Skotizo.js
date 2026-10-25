/**
 * Skotizo's Combat Achievements (plugins/achievements/combatachievements/): his kill count is the
 * plugin's own (counted by event, so the kill-count message comes first, as captured), and the
 * fight's tasks are judged here from what the fight saw:
 * - Demonic Weakening: no altar awake at the kill.
 * - Demonbane Weaponry: a demonbane weapon equipped at the kill.
 * - Up for the Challenge: no demonbane weapon equipped at any point of the fight.
 * - Demon Evasion: no damage taken in the fight.
 * - Precise Positioning: the final hit from a chinchompa.
 * The kill-count tasks (Skotizo Champion, Skotizo Adept) finish from the count.
 */
const Common = require("./Common.Skotizo");
const { Fight } = require("./Fight.Skotizo");

const MONSTER = "Skotizo";

const hasDemonbane = (player) => Common.DATA.demonbaneWeapons.includes(Common.weaponName(player));
const isChinchompa = (player) => /chinchompa/i.test(Common.weaponName(player));

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

/** The fight's own tasks, judged at the kill. */
function judge(fight) {
  const { player, stats } = fight;
  const complete = (task) => Common.api.emitCustomEvent("combat-achievements:complete", { player, task });
  if (fight.awakeCount() === 0) complete("Demonic Weakening");
  if (hasDemonbane(player)) complete("Demonbane Weaponry");
  if (!stats.demonbaneSeen && !hasDemonbane(player)) complete("Up for the Challenge");
  if (stats.damageTaken === 0) complete("Demon Evasion");
  if (stats.lastHitChinchompa) complete("Precise Positioning");
}

/** Damage the player takes in their lair, from anything. */
function hitResolved({ target, hit }) {
  const fight = target?.isPlayer?.() ? target.getArea?.()?.session?.fight : null;
  if (fight instanceof Fight && !fight.stopped && target === fight.player && hit.getTotalDamage() > 0) fight.stats.damageTaken += hit.getTotalDamage();
}

/** The player's blows, before they land: demonbane weapons worn, and the last one's weapon. */
function hitModify({ npc, hit }) {
  const fight = npc?.__skotizoLair?.fight;
  if (!fight || fight.stopped || hit?.getAttacker?.() !== fight.player) return;
  if (hasDemonbane(fight.player)) fight.stats.demonbaneSeen = true;
  if (npc === fight.boss) fight.stats.lastHitChinchompa = isChinchompa(fight.player);
}

function answerKillCount({ player, counts }) {
  const kills = Number(player.getAttribute(Common.KILLS_ATTRIBUTE)) || 0;
  if (kills > 0) counts[MONSTER] = kills;
}

function attachCombatAchievements(api) {
  api.onCombatHitResolved(hitResolved);
  api.onNpcHitModify(hitModify);
  api.onCustomEvent("combat-achievements:kill-count", answerKillCount);
}

module.exports = { attachCombatAchievements, killed, judge };
