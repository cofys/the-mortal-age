"use strict";

/**
 * QuestsApi — HTTP data layer for the web client's quest overlay.
 *
 *   GET /api/quests-status?player=<username>
 *     -> { quest: null | {
 *            id, name, blurb, stageIndex, stageTotal,
 *            objective, arrived: boolean,
 *            dialogue: null | { speaker, title, lines, choices: [{text}] | null },
 *            task: null | { verb, has, need },
 *            complete: boolean,
 *            rewards: null | { items: [[name, amount]...], xp: [[skill, amount]...], message }
 *          } }
 *
 *   Actions (same endpoint):
 *     &action=continue  — advance past current dialogue stage
 *     &action=choice&option=N — pick dialogue choice N (jumps to stage)
 *     &action=dismiss    — dismiss the completion overlay
 *
 * Proximity ("arrive") and item tasks are evaluated server-side on every
 * poll: when a task stage's condition is met it auto-advances. Dialogue
 * stages advance only via explicit continue/choice actions.
 */

const Data = require("./Data.StarterQuests");
const QuestState = require("./QuestState");

let apiRef = null;
let Items = null;
let Skill = null;

function playerPosition(player) {
  try {
    const loc = player.getLocation();
    return { x: loc.getX(), y: loc.getY(), z: loc.getZ() };
  } catch {
    return null;
  }
}

function within(pos, target) {
  if (!pos || !target) return false;
  const dx = Math.abs(pos.x - target.x);
  const dy = Math.abs(pos.y - target.y);
  return Math.max(dx, dy) <= (target.r || 8);
}

function checkTask(player, stage) {
  const task = stage.task;
  if (!task) return { done: true, has: 0, need: 0 };
  if (task.type === "item") {
    const id = Items[task.item];
    if (!Number.isInteger(id)) return { done: false, has: 0, need: task.amount };
    let has = 0;
    try {
      has = player.getInventory().getAmount(id);
    } catch {
      has = 0;
    }
    return { done: has >= task.amount, has, need: task.amount };
  }
  return { done: true, has: 0, need: 0 };
}

function itemDisplayName(key) {
  // "RAW_SHRIMPS" -> "Raw shrimps"
  return key.toLowerCase().replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function rewardsDisplay(quest) {
  const rewards = quest.rewards || {};
  return {
    items: (rewards.items || []).map(([key, amount]) => [itemDisplayName(key), amount]),
    xp: (rewards.xp || []).map(([skillName, amount]) => [skillName.toLowerCase(), amount]),
    message: rewards.message || "",
  };
}

function grantRewards(player, quest) {
  const rewards = quest.rewards || {};
  try {
    const inv = player.getInventory();
    for (const [key, amount] of rewards.items || []) {
      const id = Items[key];
      if (Number.isInteger(id)) inv.adds(id, amount);
    }
  } catch (e) {
    console.warn("[quests-api] reward items failed", e?.message ?? e);
  }
  try {
    const sm = player.getSkillManager();
    for (const [skillName, amount] of rewards.xp || []) {
      const skill = Skill[skillName];
      if (skill !== undefined && skill !== null) sm.addExperiences(skill, amount);
    }
  } catch (e) {
    console.warn("[quests-api] reward xp failed", e?.message ?? e);
  }
  return rewardsDisplay(quest);
}

function buildPayload(player) {
  const quest = QuestState.activeQuest(player);
  if (!quest) {
    // Completed but not yet dismissed — show the completion overlay once.
    const done = QuestState.undismissedCompleteQuest(player);
    if (!done) return { quest: null };
    return {
      quest: {
        id: done.id, name: done.name, blurb: done.blurb,
        stageIndex: done.stages.length - 1, stageTotal: done.stages.length,
        complete: true, rewards: rewardsDisplay(done),
      },
    };
  }

  let stageIndex = QuestState.getStage(player, quest.id);
  // Defensive clamp (data may have changed since state was written).
  if (stageIndex < 0) stageIndex = 0;
  if (stageIndex >= quest.stages.length) stageIndex = quest.stages.length - 1;
  const stage = quest.stages[stageIndex];
  const pos = playerPosition(player);

  const arrived = !stage.arrive || within(pos, stage.arrive);
  const taskCheck = checkTask(player, stage);

  // Auto-advance item tasks the moment their condition is met.
  if (stage.task && arrived && taskCheck.done) {
    const result = QuestState.advanceStage(player, quest.id);
    if (result === "complete") {
      const rewards = grantRewards(player, quest);
      try {
        player.sendMessage(`Quest complete: ${quest.name}`);
      } catch { /* non-fatal */ }
      return {
        quest: {
          id: quest.id, name: quest.name, blurb: quest.blurb,
          stageIndex, stageTotal: quest.stages.length,
          complete: true, rewards,
        },
      };
    }
    // Rebuild for the new stage.
    return buildPayload(player);
  }

  const dialogue = arrived && stage.dialogue
    ? {
        speaker: stage.dialogue.speaker,
        title: stage.dialogue.title || "",
        lines: stage.dialogue.lines,
        choices: (stage.dialogue.choices || []).map((c) => ({ text: c.text })),
      }
    : null;

  return {
    quest: {
      id: quest.id,
      name: quest.name,
      blurb: quest.blurb,
      stageIndex,
      stageTotal: quest.stages.length,
      objective: stage.objective,
      arrived,
      dialogue,
      task: stage.task
        ? { verb: stage.task.verb, has: taskCheck.has, need: taskCheck.need }
        : null,
      complete: false,
      rewards: null,
    },
  };
}

function handleAction(player, quest, action, query) {
  if (action === "dismiss") {
    // Dismiss the completion overlay for any undismissed completed quest.
    const done = QuestState.undismissedCompleteQuest(player);
    if (done) QuestState.markSeen(player, done.id);
    return;
  }
  if (!quest) return;
  const stageIndex = QuestState.getStage(player, quest.id);
  const stage = quest.stages[Math.min(stageIndex, quest.stages.length - 1)];
  const pos = playerPosition(player);
  const arrived = !stage.arrive || within(pos, stage.arrive);

  if (action === "continue") {
    if (!arrived) return; // can't skip travel
    if (stage.dialogue && stage.dialogue.choices && stage.dialogue.choices.length) return; // must pick
    const result = QuestState.advanceStage(player, quest.id);
    if (result === "complete") {
      grantRewards(player, quest);
      try {
        player.sendMessage(`Quest complete: ${quest.name}`);
      } catch { /* non-fatal */ }
    }
  } else if (action === "choice") {
    if (!arrived || !stage.dialogue || !stage.dialogue.choices) return;
    const idx = parseInt(query.get("option") || "-1", 10);
    const choice = stage.dialogue.choices[idx];
    if (!choice) return;
    QuestState.setStage(player, quest.id, choice.goto);
  }
}

function attach(api) {
  apiRef = api;
  Items = api.core.ItemIdentifiers;
  Skill = api.core.Skill;
  console.info("[quests-api] registering quests-status endpoint");
  api.registerContentEndpoint("quests-status", (query) => {
    const username = (query.get("player") || "").trim();
    let player = null;
    if (username) {
      try {
        player = api.core.World.getPlayerByName(username) || null;
      } catch {
        player = null;
      }
    }
    if (!player) return { quest: null };

    const quest = QuestState.activeQuest(player);
    const action = (query.get("action") || "").trim().toLowerCase();
    if (quest && action) {
      try {
        handleAction(player, quest, action, query);
      } catch (e) {
        console.warn("[quests-api] action failed", e?.message ?? e);
      }
    }
    return buildPayload(player);
  });
}

module.exports = { attach };
