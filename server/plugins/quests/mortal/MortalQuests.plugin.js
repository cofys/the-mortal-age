"use strict";

/**
 * MortalQuests — data-driven Mortal Age quest framework with web overlays.
 *
 * Separate from the OSRS quest system (Quests.plugin.js): these are custom
 * Mortal Age quests defined in Data.StarterQuests, tracked via persisted
 * player attributes, and presented through the React quest overlay
 * (client/game/plugins/quests/QuestOverlay.tsx) served by QuestsApi.
 *
 * Starter quests auto-start when a player claims their origin
 * (origins:selected custom event).
 */

const Data = require("./Data.StarterQuests");
const QuestState = require("./QuestState");
const QuestsApi = require("./QuestsApi");

function onOriginSelected({ player, originId }) {
  const quest = Data.BY_ORIGIN.get(originId);
  if (!quest || !player) return;
  try {
    if (QuestState.startQuest(player, quest.id)) {
      console.info(`[mortal-quests] started '${quest.id}' for ${player.getUsername()}`);
    }
  } catch (e) {
    console.warn("[mortal-quests] auto-start failed", e?.message ?? e);
  }
}

module.exports = {
  name: "MortalQuests",
  register(api) {
    for (const key of QuestState.allAttributeKeys()) api.persistAttribute(key);
    QuestsApi.attach(api);
    api.onCustomEvent("origins:selected", onOriginSelected);
  },
};
