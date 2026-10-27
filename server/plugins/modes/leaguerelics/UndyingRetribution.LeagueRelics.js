/**
 * Undying Retribution (https://oldschool.runescape.wiki/w/Undying_Retribution), Trailblazer
 * Reloaded's tier 8 relic: a death instead restores hitpoints and prayer, cures poison and venom
 * (and the immunity, as Mod Ash read the code), and strikes every enemy within three tiles for
 * up to twice the player's Prayer level (half of it for players), skipping NPCs immune to
 * recoil except Nex, the Hespori, Vorkath and the Wilderness bosses; NPCs that are attack-immune
 * or that the area's policy keeps the player from fighting are left alone. Once every three
 * minutes, reset by a real death. Works wherever a death would otherwise go ahead: a plugin that already
 * kept the player alive on this hook is honoured (and the cooldown kept), but every before-death
 * hook runs, so one that is attached later than this plugin would see the relic fire first.
 * A prevented death counts for nothing anywhere (Wiki: no raid death penalties): core never
 * starts the death task, so the raids' death handlers, which count deaths, take points, jail and
 * check wipes, never run for it.
 */
const Common = require("./Common.LeagueRelics");

/** When the relic may fire again (ms since the epoch); 0 when it may. */
const READY_AT_ATTRIBUTE = "league:undying-retribution-ready-at";

let api;
let core;
let effect;
let exceptions;

function active(player) {
  return Common.effectActive(player, effect);
}

function exceptionNames() {
  if (!exceptions) exceptions = new Set(effect.recoilImmuneExceptions);
  return exceptions;
}

function near(player, other) {
  const here = player.getLocation();
  const there = other.getLocation();
  return there.getZ() === here.getZ() && there.isWithinDistance(here, effect.radius) && other.getHitpoints() > 0;
}

/**
 * NPCs within reach the player could fight: attackable, not attack-immune (a boss between phases),
 * allowed by the area's policy, and recoil-immune only by exception; plus the players fighting them.
 */
function enemiesAround(player) {
  const { CombatFactory, CanAttackResponse, TimerKey } = core;
  const npcs = player.getLocalNpcs().filter((npc) => near(player, npc)
    && CombatFactory.validTarget(player, npc)
    && npc.getCurrentDefinition().isAttackable()
    && !npc.getTimers().has(TimerKey.ATTACK_IMMUNITY)
    && CombatFactory.canAttackByPolicy(player, npc) === CanAttackResponse.CAN_ATTACK
    && (CombatFactory.canReceiveRecoil(npc) || exceptionNames().has(npc.getDefinition().getName())));
  const players = player.getLocalPlayers().filter((other) => other !== player && near(player, other)
    && (other.getCombat().getAttacker() === player || player.getCombat().getAttacker() === other
      || other.getCombat().getTarget?.() === player));
  return [...npcs, ...players];
}

function strike(player, victim, prayer) {
  const { HitDamage, HitMask, Misc } = core;
  const most = Math.floor(prayer * (victim.isPlayer() ? effect.playerDamagePerPrayerLevel : effect.npcDamagePerPrayerLevel));
  victim.getCombat().getHitQueue().addPendingDamage([
    new HitDamage(Misc.randomInclusive(0, most), HitMask.RED).markReflected().setSource(player),
  ]);
}

function beforeDeath(event) {
  const { player } = event;
  if (event.preventDeath || !active(player)) return;
  const now = Date.now();
  if (now < (Number(player.getAttribute(READY_AT_ATTRIBUTE)) || 0)) return;
  event.preventDeath = true;
  const { Skill, Graphic } = core;
  const skills = player.getSkillManager();
  player.setHitpoints(skills.getMaxLevel(Skill.HITPOINTS));
  skills.setCurrentLevel(Skill.PRAYER, skills.getMaxLevel(Skill.PRAYER), true);
  player.setVenomed(false);
  player.setPoisonDamage(0);
  player.getCombat().getPoisonImmunityTimer().stop();
  player.performGraphic(new Graphic(effect.graphic));
  const prayer = skills.getMaxLevel(Skill.PRAYER);
  for (const victim of enemiesAround(player)) strike(player, victim, prayer);
  player.setAttribute(READY_AT_ATTRIBUTE, now + effect.cooldownMs);
  api.emitCustomEvent("league:relic-triggered", { player, relic: effect.key });
}

/** A real death (the player defeated, after every before-death hook let it go ahead) ends the cooldown (Wiki). */
function defeated({ victim }) {
  if (Number(victim?.getAttribute?.(READY_AT_ATTRIBUTE)) > 0) victim.setAttribute(READY_AT_ATTRIBUTE, 0);
}

module.exports = function attach(pluginApi) {
  api = pluginApi;
  core = api.core;
  effect = Common.data.effects.undyingRetribution;
  api.persistAttribute(READY_AT_ATTRIBUTE, 0);
  api.onPlayerBeforeDeath(beforeDeath);
  api.onPlayerDefeated(defeated);
};
