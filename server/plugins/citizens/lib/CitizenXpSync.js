/**
 * CitizenXpSync — single source of truth for citizen skill XP.
 *
 * Jon's call (2026-10-12): the engine's SkillManager is the source of truth
 * for citizen skills (RuneScape's actual skill system). The data-tier
 * skillStore is a persistence snapshot, not a parallel system.
 *
 * The contract:
 * - On materialize (spawnCitizen): hydrate SkillManager from skillStore (one-time).
 * - While materialized: ALL XP grants go through SkillManager (engine).
 * - On dematerialize (logoutCitizen): persist SkillManager XP back to skillStore.
 * - While not materialized: XP grants go to skillStore (background sim).
 *
 * This eliminates the dual-XP divergence where data-tier and engine XP
 * could disagree on a citizen's stats.
 */

"use strict";

// skillStore lowercase IDs -> Skill enum member names.
// The Skill enum lives at server/src/main/typescript/elvarg/game/model/Skill.ts
// and is exposed to plugins as api.core.Skill.
const SKILL_ID_TO_ENUM = {
  attack: "ATTACK",
  defence: "DEFENCE",
  strength: "STRENGTH",
  hitpoints: "HITPOINTS",
  ranged: "RANGED",
  prayer: "PRAYER",
  magic: "MAGIC",
  cooking: "COOKING",
  woodcutting: "WOODCUTTING",
  fletching: "FLETCHING",
  fishing: "FISHING",
  firemaking: "FIREMAKING",
  crafting: "CRAFTING",
  smithing: "SMITHING",
  mining: "MINING",
  herblore: "HERBLORE",
  agility: "AGILITY",
  thieving: "THIEVING",
  slayer: "SLAYER",
  farming: "FARMING",
  runecrafting: "RUNECRAFTING",
  construction: "CONSTRUCTION",
  hunter: "HUNTER",
};

/**
 * Resolve a skillStore skill ID to a Skill enum value.
 * Returns null when the ID is unknown or the enum member is missing.
 */
function getSkillEnum(Skill, skillId) {
  if (!Skill || !skillId) return null;
  const enumName = SKILL_ID_TO_ENUM[String(skillId).toLowerCase()];
  if (!enumName) return null;
  return Skill[enumName] ?? null;
}

/**
 * Hydrate a freshly materialized bot's SkillManager from the data-tier
 * skillStore. Called once from CitizenDirector.spawnCitizen, after the bot
 * Player exists. Uses setExperience (absolute) so the engine starts from
 * exactly the persisted values — no additive drift.
 */
function hydrateSkillsFromStore(bot, username, Skill, skillStore) {
  try {
    const sm = bot?.getSkillManager?.();
    if (!sm?.setExperience || !Skill || !skillStore?.getXp) return;
    const key = String(username ?? "");
    if (!key) return;
    for (const skillId of Object.keys(SKILL_ID_TO_ENUM)) {
      const xp = skillStore.getXp(key, skillId);
      if (xp > 0) {
        const skill = getSkillEnum(Skill, skillId);
        if (skill) {
          sm.setExperience(skill, Math.floor(xp));
        }
      }
    }
  } catch {
    // Non-fatal: a bot with default stats is better than a failed spawn.
  }
}

/**
 * Persist a dematerializing bot's SkillManager XP back to the data-tier
 * skillStore. Called once from CitizenDirector.logoutCitizen, before the
 * bot's Player object is destroyed. Uses absolute set (not additive) so
 * the store matches the engine exactly.
 */
function persistSkillsToStore(bot, username, Skill, skillStore) {
  try {
    const sm = bot?.getSkillManager?.();
    if (!sm?.getExperience || !Skill || !skillStore?.setXp) return;
    const key = String(username ?? "");
    if (!key) return;
    for (const skillId of Object.keys(SKILL_ID_TO_ENUM)) {
      const skill = getSkillEnum(Skill, skillId);
      if (!skill) continue;
      const xp = sm.getExperience(skill);
      if (xp > 0) {
        skillStore.setXp(key, skillId, Math.floor(xp));
      }
    }
  } catch {
    // Non-fatal: stale store data is better than a failed logout.
  }
}

/**
 * Grant XP to a citizen, routing to the source of truth.
 *
 * - If the citizen is materialized (bot Player exists): grants via the
 *   engine SkillManager (addExperiences). Returns { leveled, level } using
 *   the engine's XP values.
 * - If not materialized: grants via skillStore (data tier).
 *
 * levelForXp is injected (CitizenSkilling's OSRS table) for level detection.
 */
function grantXp(director, username, skillId, amount, Skill, skillStore, levelForXp) {
  const bot = director?.getBot?.({ username });
  const skill = getSkillEnum(Skill, skillId);
  if (bot && skill) {
    try {
      const sm = bot.getSkillManager?.();
      if (sm?.getExperience && sm?.addExperiences) {
        const before = sm.getExperience(skill);
        const beforeLevel = levelForXp ? levelForXp(before) : 1;
        sm.addExperiences(skill, amount);
        const after = sm.getExperience(skill);
        const afterLevel = levelForXp ? levelForXp(after) : beforeLevel;
        return { leveled: afterLevel > beforeLevel, level: afterLevel, via: "engine" };
      }
    } catch {
      // Fall through to skillStore.
    }
  }
  // Not materialized (or engine grant failed): data tier.
  if (skillStore?.addXp) {
    const result = skillStore.addXp(username, skillId, amount);
    return { ...result, via: "store" };
  }
  return { leveled: false, level: 1, via: "none" };
}

module.exports = {
  SKILL_ID_TO_ENUM,
  getSkillEnum,
  hydrateSkillsFromStore,
  persistSkillsToStore,
  grantXp,
};
