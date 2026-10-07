"use strict";

/**
 * FollowUpQuests — runtime logic for second-tier Mortal Age quests.
 *
 *   maybeStartFollowUps(player) — called on every quests-status poll when
 *     the player has no active quest: starts any follow-up quest whose
 *     prerequisites are met (a required starter is complete, and, for war
 *     quests, the player's kingdom is in an active war). Lazy evaluation
 *     means players who finished starters before this system deployed, or
 *     who log in mid-war, pick quests up automatically.
 *   onQuestCompleted(player, quest, api) — applies a quest's onComplete
 *     effects (standing, citizen befriending, journal entries) and emits
 *     the "mortal-quest:complete" custom event for other systems.
 *
 * Citizen binding: each bindCitizens entry picks a random ONLINE citizen
 * of the player's kingdom with the requested role; the username is stored
 * as a quest var so {var} substitution personalizes every line. Falls back
 * to the def's fallback name when no matching citizen is online.
 */

const Registry = require("./Data.QuestRegistry");
const QuestState = require("./QuestState");
const { playerKingdomId, playerName, substitute } = require("./QuestUtil");
const KingdomStore = require("../../kingdoms/KingdomStore");
const { siteTileByKingdom } = require("../../citizens/brain/CitizenSites");

function kingdomDisplayName(kingdomId) {
  try {
    const name = KingdomStore.getKingdom(kingdomId)?.name;
    if (typeof name === "string" && name) return name;
  } catch {
    // fall through to id prettification
  }
  // "misthalin" -> "Misthalin" when the store isn't loaded.
  return String(kingdomId).replace(/(^|[-_])(\w)/g, (_, s, c) => (s ? " " : "") + c.toUpperCase());
}

/** Is the player's kingdom currently in an active war? */
function kingdomAtWar(kingdomId) {
  try {
    return KingdomStore.getActiveWars().some(
      (w) => w.attackerId === kingdomId || w.defenderId === kingdomId
    );
  } catch {
    return false;
  }
}

/** Name of the kingdom on the other side of the player's war ("" if none). */
function warEnemyName(kingdomId) {
  try {
    const war = KingdomStore.getActiveWars().find(
      (w) => w.attackerId === kingdomId || w.defenderId === kingdomId
    );
    if (!war) return "";
    const foeId = war.attackerId === kingdomId ? war.defenderId : war.attackerId;
    return kingdomDisplayName(foeId);
  } catch {
    return "";
  }
}

/** Any-of semantics: at least one required quest must be complete. */
function requiresSatisfied(player, quest) {
  const req = quest.requires || [];
  if (!req.length) return true;
  return req.some((id) => QuestState.isComplete(player, id));
}

function eligible(player, quest) {
  if (QuestState.getStatus(player, quest.id)) return false; // started or done
  if (!requiresSatisfied(player, quest)) return false;
  if (quest.requiresWar && !kingdomAtWar(playerKingdomId(player))) return false;
  return true;
}

function pickOnlineCitizen(kingdomId, role) {
  try {
    const { getDirector } = require("../../citizens/director/CitizenDirector");
    const director = getDirector();
    if (!director) return null;
    const bots = director.onlineBotsForKingdom(kingdomId, role) || [];
    if (!bots.length) return null;
    const bot = bots[Math.floor(Math.random() * bots.length)];
    const name = bot?.getUsername?.();
    return typeof name === "string" && name ? name : null;
  } catch {
    return null;
  }
}

function bindCitizens(player, quest) {
  const kingdomId = playerKingdomId(player);
  for (const binding of quest.bindCitizens || []) {
    const name = pickOnlineCitizen(kingdomId, binding.role) || binding.fallback || "Someone";
    QuestState.setVar(player, quest.id, binding.var, name);
  }
  // Precompute the war-enemy name for war quests ("" otherwise).
  if (quest.requiresWar) {
    QuestState.setVar(player, quest.id, "enemy", warEnemyName(kingdomId));
  }
}

/** Start a follow-up quest for the player, binding citizens. Returns bool. */
function startFollowUp(player, quest) {
  if (!eligible(player, quest)) return false;
  if (!QuestState.startQuest(player, quest.id)) return false;
  try {
    bindCitizens(player, quest);
  } catch (e) {
    console.warn("[followup-quests] citizen binding failed", e?.message ?? e);
  }
  console.info(`[followup-quests] started '${quest.id}' for ${playerName(player)}`);
  return true;
}

/** Start every eligible follow-up quest (usually at most one qualifies). */
function maybeStartFollowUps(player) {
  if (!player) return;
  try {
    if (QuestState.activeQuest(player)) return;
    if (QuestState.undismissedCompleteQuest(player)) return;
    for (const quest of Registry.FOLLOW_UP_QUESTS) {
      if (eligible(player, quest)) startFollowUp(player, quest);
    }
  } catch (e) {
    console.warn("[followup-quests] maybe-start failed", e?.message ?? e);
  }
}

/** Built-in vars available for substitution in any quest text. */
function builtinVars(player) {
  const kingdomId = playerKingdomId(player);
  return {
    player: playerName(player),
    kingdom: kingdomDisplayName(kingdomId),
    enemy: warEnemyName(kingdomId),
  };
}

/** All substitution vars for a quest: persisted vars over built-ins. */
function questVars(player, quest) {
  return { ...builtinVars(player), ...QuestState.allVars(player, quest.id) };
}

function applyBefriend(player, quest, vars) {
  const names = quest.onComplete?.befriend || [];
  if (!names.length) return;
  try {
    const { addFriend } = require("../../citizens/lib/CitizenBonds");
    const playerUsername = playerName(player);
    for (const varName of names) {
      const citizenName = vars[varName];
      if (citizenName && citizenName !== playerUsername) {
        addFriend(citizenName, playerUsername);
      }
    }
  } catch (e) {
    console.warn("[followup-quests] befriend failed", e?.message ?? e);
  }
}

function applyJournal(player, quest, vars) {
  const entries = quest.onComplete?.journal || [];
  if (!entries.length) return;
  try {
    const { getJournal } = require("../../citizens/lib/CitizenJournal");
    const journal = getJournal();
    if (!journal) return;
    for (const entry of entries) {
      const citizenName = vars[entry.for];
      if (!citizenName) continue;
      journal.log(citizenName, "quest", substitute(entry.text, vars));
    }
  } catch (e) {
    console.warn("[followup-quests] journal failed", e?.message ?? e);
  }
}

/**
 * Apply a completed quest's onComplete effects: standing var, citizen
 * befriending, journal entries (so the citizen LLM remembers), then emit
 * "mortal-quest:complete" for any other interested system.
 */
function onQuestCompleted(player, quest, api) {
  try {
    const vars = questVars(player, quest);
    const standing = quest.onComplete?.standing;
    if (standing) QuestState.setVar(player, quest.id, "standing", standing);
    applyBefriend(player, quest, vars);
    applyJournal(player, quest, vars);
    try {
      api?.emitCustomEvent?.("mortal-quest:complete", { player, questId: quest.id });
    } catch {
      // Non-fatal.
    }
  } catch (e) {
    console.warn("[followup-quests] completion effects failed", e?.message ?? e);
  }
}

module.exports = {
  eligible,
  startFollowUp,
  maybeStartFollowUps,
  onQuestCompleted,
  questVars,
  builtinVars,
  kingdomAtWar,
  warEnemyName,
  playerKingdomId,
  siteTileByKingdom,
};
