"use strict";

/**
 * The Elite Karamja Diary's Fight Cave resurrection (Wiki: TzHaar Fight Cave, Karamja Diary): once
 * a day, on reaching 0 hitpoints in the cave, the player carries on with full hitpoints and
 * restored stats instead of dying.
 */

const RESURRECTED_ATTRIBUTE = "tzhaar:fight-cave-resurrected-on";
const DAY_MS = 24 * 60 * 60 * 1000;

let api;
let inRun;

/** OSRS resets daily limits at 00:00 UTC. */
const today = () => Math.floor(Date.now() / DAY_MS);

function eliteDiaryDone(player) {
  const request = { player, diary: "karamja", tier: "elite", complete: false };
  api.emitCustomEvent("diary:is-complete", request);
  return request.complete === true;
}

function resurrect(event) {
  const { player } = event;
  if (!inRun(player) || player.getAttribute(RESURRECTED_ATTRIBUTE) === today()) return;
  if (!eliteDiaryDone(player)) return;
  event.preventDeath = true;
  player.setAttribute(RESURRECTED_ATTRIBUTE, today());
  // Hits already on their way would kill the player again.
  player.getCombat().getHitQueue().clear();
  player.setPoisonDamage(0);
  player.setVenomed(false);
  const skills = player.getSkillManager();
  for (const skill of api.core.Skill.values()) {
    skills.setCurrentLevels(skill, skills.getMaxLevel(skill));
    player.getPacketSender().sendSkill(skill);
  }
}

module.exports = function attachResurrection(pluginApi, { inRun: isInRun }) {
  api = pluginApi;
  inRun = isInRun;
  pluginApi.persistAttribute(RESURRECTED_ATTRIBUTE, 0);
  pluginApi.onPlayerBeforeDeath(resurrect);
};
Object.assign(module.exports, { resurrect, today, RESURRECTED_ATTRIBUTE });
