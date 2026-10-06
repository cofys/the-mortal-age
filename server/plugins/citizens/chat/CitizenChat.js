"use strict";

/**
 * CitizenChat — the citizens plugin's side of the chat contract.
 *
 * The LLM mouth lives in the llm-gateway plugin (scripted body + LLM mouth,
 * per the world bible). The contract, owned by llm-gateway:
 *
 *   llm:citizen-register  (out) { username, personalityCard, replyCooldownMs? }
 *   llm:chat-request       (out) { citizenUsername, requesterUsername, text, channel }
 *   llm:chat-response      (in)  { citizenUsername, requesterUsername, text, channel, ... }
 *                                 -> spoken by llm-gateway's Mouth (forceChat + packets)
 *
 * Private messages to a citizen bot are already intercepted by llm-gateway's
 * ChatInterceptor (api.onSocialPacket). Public chat near a bot is intercepted
 * through the core's public_chat social-packet hook (ChatPacketListener emits
 * it after the chat filter passes): the handler below finds citizen bots in
 * the speaker's local players and forwards each as:
 *
 *   citizens:chat-heard    (out) { citizenUsername, speakerUsername, text }
 *
 * which onCitizenChatHeard forwards to llm:chat-request with channel "public".
 */

const {
  EVENT_LLM_CITIZEN_REGISTER,
  EVENT_LLM_CHAT_REQUEST,
  EVENT_CITIZEN_CHAT_HEARD,
} = require("../constants");
const { personalityCard } = require("../lib/personalities");
const {
  getMemory,
  scoreTone,
  GRUDGE_INSULT,
  GOSSIP_INSULT,
} = require("../lib/CitizenMemory");

const BOT_HOST_ADDRESS = "bot"; // set by bots/behaviours/spawn/BotPlayerFactory.js

function isCitizenBot(player) {
  return player?.getHostAddress?.() === BOT_HOST_ADDRESS;
}

let pluginApi = null;

function initCitizenChat(api) {
  pluginApi = api;
}

/** Called by the director right after a citizen spawns. */
function registerCitizenForChat(username, personality, kingdomName, kingdomSituation) {
  if (!pluginApi || !username) {
    return;
  }
  pluginApi.emitCustomEvent(EVENT_LLM_CITIZEN_REGISTER, {
    username,
    personalityCard: personalityCard(personality, kingdomName, kingdomSituation),
    // Chatty citizens answer faster; taciturn ones let messages sit.
    replyCooldownMs: (personality?.traits ?? []).includes("chatty") ? 5000 : 12000,
  });
}

/**
 * Forwards heard public chat to the gateway — and remembers it. Every heard
 * line counts as a meeting; the heuristic tone feeds the citizen's lasting
 * impression (friendly chatter warms, outright insults make a grudge).
 */
function onCitizenChatHeard(event) {
  if (!pluginApi) {
    return;
  }
  const { citizenUsername, speakerUsername, text } = event ?? {};
  if (!citizenUsername || !speakerUsername || !text) {
    return;
  }
  try {
    const memory = getMemory();
    const said = String(text).slice(0, 320);
    memory.recordMeeting(citizenUsername, speakerUsername);
    const tone = scoreTone(said);
    if (tone !== 0) {
      memory.recordTone(citizenUsername, speakerUsername, tone);
    }
    if (tone <= -2) {
      // Insulted to their face: remembered, and the street hears about it.
      memory.addGrudge(citizenUsername, speakerUsername, GRUDGE_INSULT, "insult");
      const kingdomId = getDirectorKingdom(citizenUsername);
      memory.seedGossip({
        kingdomId,
        kind: GOSSIP_INSULT,
        subject: speakerUsername,
        text: `insulted ${citizenUsername} to their face.`,
        holder: citizenUsername,
      });
      pluginApi.log?.("[citizens] citizen insulted", {
        citizen: citizenUsername,
        speaker: speakerUsername,
      });
    }
  } catch (error) {
    // Memory must never break the chat path.
  }
  pluginApi.emitCustomEvent(EVENT_LLM_CHAT_REQUEST, {
    citizenUsername,
    requesterUsername: speakerUsername,
    text: String(text).slice(0, 320),
    channel: "public",
  });
}

/** Lazy require — the director requires this module at boot. */
function getDirectorKingdom(citizenUsername) {
  try {
    const { getDirector } = require("../director/CitizenDirector");
    return getDirector()?.roster.get(citizenUsername)?.kingdomId ?? null;
  } catch (error) {
    return null;
  }
}

/**
 * Social-packet hook: public chat near citizen bots. Finds citizens in the
 * speaker's local players and emits citizens:chat-heard for each, which
 * onCitizenChatHeard forwards to the LLM gateway.
 */
function onSocialPacket(event) {
  const { player, packet } = event ?? {};
  if (!packet || packet.type !== "public_chat") return;
  if (!pluginApi || !player) return;
  if (isCitizenBot(player)) return; // citizens don't trigger each other
  const text = String(packet.text ?? "").trim();
  if (!text) return;
  let heard = 0;
  for (const local of player.getLocalPlayers?.() ?? []) {
    if (!isCitizenBot(local)) continue;
    pluginApi.emitCustomEvent(EVENT_CITIZEN_CHAT_HEARD, {
      citizenUsername: local.getUsername(),
      speakerUsername: player.getUsername(),
      text: text.slice(0, 320),
    });
    heard++;
  }
  if (heard > 0) {
    pluginApi.log?.("[citizens] public chat heard", {
      speaker: player.getUsername(),
      citizens: heard,
    });
  }
}

function chatHeardEventName() {
  return EVENT_CITIZEN_CHAT_HEARD;
}

module.exports = {
  initCitizenChat,
  registerCitizenForChat,
  onCitizenChatHeard,
  onSocialPacket,
  chatHeardEventName,
};
