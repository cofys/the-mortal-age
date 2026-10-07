"use strict";

/**
 * QuestState — per-player Mortal Age quest state, persisted via attributes.
 *
 * Attributes (kebab-case, namespaced per AGENTS.md):
 *   quest.<id>.status — "started" | "complete" (absent = not started)
 *   quest.<id>.stage  — integer stage index
 *
 * The plugin registers persistAttribute for each quest's keys at boot.
 */

const Data = require("./Data.StarterQuests");

const STATUS_STARTED = "started";
const STATUS_COMPLETE = "complete";

function statusKey(questId) {
  return `quest.${questId}.status`;
}

function stageKey(questId) {
  return `quest.${questId}.stage`;
}

function seenKey(questId) {
  return `quest.${questId}.seen`;
}

/** All attribute keys this system persists — registered at plugin boot. */
function allAttributeKeys() {
  const keys = [];
  for (const q of Data.STARTER_QUESTS) {
    keys.push(statusKey(q.id), stageKey(q.id), seenKey(q.id));
  }
  return keys;
}

function getStatus(player, questId) {
  return player.getAttribute(statusKey(questId)) || null;
}

function getStage(player, questId) {
  const v = player.getAttribute(stageKey(questId));
  return Number.isInteger(v) ? v : 0;
}

function isStarted(player, questId) {
  return getStatus(player, questId) === STATUS_STARTED;
}

function isComplete(player, questId) {
  return getStatus(player, questId) === STATUS_COMPLETE;
}

function startQuest(player, questId) {
  if (!Data.BY_ID.has(questId)) return false;
  if (getStatus(player, questId)) return false; // already started or done
  player.setAttribute(statusKey(questId), STATUS_STARTED);
  player.setAttribute(stageKey(questId), 0);
  return true;
}

function setStage(player, questId, stage) {
  player.setAttribute(stageKey(questId), stage);
}

function advanceStage(player, questId) {
  const quest = Data.BY_ID.get(questId);
  if (!quest) return false;
  const next = getStage(player, questId) + 1;
  if (next >= quest.stages.length) {
    completeQuest(player, questId);
    return "complete";
  }
  setStage(player, questId, next);
  return "advanced";
}

function completeQuest(player, questId) {
  player.setAttribute(statusKey(questId), STATUS_COMPLETE);
}

/** The player's currently active (started, not complete) quest, if any. */
function activeQuest(player) {
  for (const q of Data.STARTER_QUESTS) {
    if (isStarted(player, q.id) && !isComplete(player, q.id)) return q;
  }
  return null;
}

/** A completed quest whose completion overlay hasn't been dismissed yet. */
function undismissedCompleteQuest(player) {
  for (const q of Data.STARTER_QUESTS) {
    if (isComplete(player, q.id) && !player.getAttribute(seenKey(q.id))) return q;
  }
  return null;
}

function markSeen(player, questId) {
  player.setAttribute(seenKey(questId), 1);
}

module.exports = {
  STATUS_STARTED,
  STATUS_COMPLETE,
  allAttributeKeys,
  getStatus,
  getStage,
  isStarted,
  isComplete,
  startQuest,
  setStage,
  advanceStage,
  completeQuest,
  activeQuest,
  undismissedCompleteQuest,
  markSeen,
};
