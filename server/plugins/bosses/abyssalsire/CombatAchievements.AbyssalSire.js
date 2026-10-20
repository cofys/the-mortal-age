/**
 * The Abyssal Sire's Combat Achievements (plugins/achievements/combatachievements/): its kill
 * count is counted by event, so the kill-count message comes first (captured), and the fight's
 * tasks are judged here from what it saw (Wiki: Abyssal Sire, Combat Achievements):
 * - They Grow Up Too Fast: no scion matured.
 * - Don't Stop Moving: no damage from a miasma pool.
 * - Don't Whip Me: no damage from a tentacle.
 * - Respiratory Runner: the Sire stunned only once.
 * - Perfect Sire: none of that, nor the explosion, and no hit from the Sire taken without Protect
 *   from Melee.
 * - Demonic Rebound: Vengeance reflecting the explosion.
 * The kill-count tasks (Abyssal Adept, Abyssal Veteran) finish from the count.
 */
const Common = require("./Common.AbyssalSire");
const { EXPLOSION_HIT } = require("./Fight.AbyssalSire");

const MONSTER = "Abyssal Sire";

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

function judge(fight) {
  const { player, stats } = fight;
  const complete = (task) => Common.api.emitCustomEvent("combat-achievements:complete", { player, task });
  if (!stats.scionMatured) complete("They Grow Up Too Fast");
  if (stats.miasmaDamage === 0) complete("Don't Stop Moving");
  if (stats.tentacleDamage === 0) complete("Don't Whip Me");
  if (stats.stuns === 1) complete("Respiratory Runner");
  if (stats.miasmaDamage === 0 && stats.tentacleDamage === 0 && stats.explosionDamage === 0 && stats.unprayedSireDamage === 0) {
    complete("Perfect Sire");
  }
  if (stats.rebounded) complete("Demonic Rebound");
}

/** The explosion landing: its damage, and whether Vengeance sent it back. */
function explosionResolved({ attacker, target, hit }) {
  if (hit?.__sireHit !== EXPLOSION_HIT) return;
  const fight = attacker?.__sireFight;
  if (!fight || target !== fight.player) return;
  const damage = hit.getTotalDamage();
  fight.stats.explosionDamage += damage;
  if (damage > 0 && hit.__sireVengeance && fight.player.hasVengeanceReturn?.() !== true) fight.stats.rebounded = true;
}

function answerKillCount({ player, counts }) {
  const kills = Number(player.getAttribute(Common.KILLS_ATTRIBUTE)) || 0;
  if (kills > 0) counts[MONSTER] = kills;
}

function attachCombatAchievements(api) {
  api.onCombatHitResolved(explosionResolved);
  api.onCustomEvent("combat-achievements:kill-count", answerKillCount);
}

module.exports = { attachCombatAchievements, killed, judge };
