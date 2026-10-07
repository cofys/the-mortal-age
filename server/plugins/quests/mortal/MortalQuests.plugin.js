"use strict";

/**
 * MortalQuests — data-driven Mortal Age quest framework with web overlays.
 *
 * Separate from the OSRS quest system (Quests.plugin.js): these are custom
 * Mortal Age quests defined in Data.StarterQuests, tracked via persisted
 * player attributes, and presented through the React quest overlay
 * (client/game/plugins/quests/QuestOverlay.tsx) served by QuestsApi.
 *
 * Starter quests start when the character is fully created
 * (character:created custom event) AND the player is actually in the world —
 * not on the welcome screen. Starting the quest on the welcome screen pops
 * the quest dialogue over the "welcome back" screen, which kills immersion.
 * So: if the player is still on the welcome screen (interface 378) when
 * their character is created, the quest is marked pending and starts when
 * they click Play. Mobile clients skip the welcome screen, so they start
 * immediately.
 *
 * Follow-up quests (Data.FollowUpQuests) auto-start lazily via
 * FollowUpQuests.maybeStartFollowUps when their prerequisites are met
 * (a starter complete; war quests additionally require the player's
 * kingdom to be in an active war).
 */

const Data = require("./Data.QuestRegistry");
const QuestState = require("./QuestState");
const QuestsApi = require("./QuestsApi");

const PENDING_QUEST_ATTRIBUTE = "quest:pending-starter";

// Welcome screen (plugins/interface/WelcomeScreen.plugin.js).
const WELCOME_SCREEN_GROUP_ID = 378;
const WELCOME_PLAY_BUTTON_UID = (WELCOME_SCREEN_GROUP_ID << 16) | 72;

let pluginApi = null;
let MOBILE_CLIENT_ATTRIBUTE = null;

function startStarterQuest(player, originId) {
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

function originIdOf(player) {
  try {
    return player.getAttribute?.("origin:id") || null;
  } catch {
    return null;
  }
}

function onWelcomeScreen(player) {
  try {
    return (player.getInterfaceId?.() | 0) === WELCOME_SCREEN_GROUP_ID;
  } catch {
    return false;
  }
}

function isMobile(player) {
  try {
    return player.getAttribute?.(MOBILE_CLIENT_ATTRIBUTE) === true;
  } catch {
    return false;
  }
}

/**
 * Character is fully formed (origin + background + name). Start the starter
 * quest — but only if the player can actually see the world. On the welcome
 * screen, defer until they click Play.
 */
function onCharacterCreated({ player, originId }) {
  if (!player || player.isPlayerBot?.() === true) return;
  const oid = originId || originIdOf(player);
  if (!oid) return;
  // Don't double-start.
  if (QuestState.activeQuest(player)) return;

  if (!isMobile(player) && onWelcomeScreen(player)) {
    // Still on the welcome screen — the quest dialogue would pop up over it.
    // Mark pending; onWelcomePlay starts it once they're in the world.
    try {
      player.setAttribute(PENDING_QUEST_ATTRIBUTE, oid);
    } catch {
      // Best-effort.
    }
    return;
  }
  // Already in the world (mobile, or creation finished in-world).
  startStarterQuest(player, oid);
}

/**
 * Welcome-screen Play button. If a starter quest is pending, start it now
 * that the player is entering the world. Never consumes the click.
 */
function onWelcomePlay({ player }) {
  if (!player || player.isPlayerBot?.() === true) return false;
  let oid = null;
  try {
    oid = player.getAttribute?.(PENDING_QUEST_ATTRIBUTE) || null;
    if (oid) player.setAttribute(PENDING_QUEST_ATTRIBUTE, null);
  } catch {
    // Best-effort.
  }
  if (!oid) return false;
  // Don't double-start (e.g. quest was started by another path).
  if (QuestState.activeQuest(player)) return false;
  // Let the gameframe land first so the player sees their surroundings
  // before the quest dialogue appears.
  queueMicrotask(() => {
    try {
      if (!QuestState.activeQuest(player)) startStarterQuest(player, oid);
    } catch (e) {
      console.warn("[mortal-quests] deferred start failed", e?.message ?? e);
    }
  });
  return false;
}

module.exports = {
  name: "MortalQuests",
  register(api) {
    pluginApi = api;
    MOBILE_CLIENT_ATTRIBUTE = api.core.MOBILE_CLIENT_ATTRIBUTE;
    for (const key of QuestState.allAttributeKeys()) api.persistAttribute(key);
    api.persistAttribute(PENDING_QUEST_ATTRIBUTE);
    QuestsApi.attach(api);
    api.onCustomEvent("character:created", onCharacterCreated);
    api.onInterfaceActionButton(WELCOME_PLAY_BUTTON_UID, onWelcomePlay);
  },
};
