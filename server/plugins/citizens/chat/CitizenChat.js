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
 * ChatInterceptor (api.onSocialPacket). Public chat near a bot cannot be
 * intercepted today — core broadcasts it without a plugin hook (see
 * llm-gateway/ChatInterceptor.js). Until a generic hook exists, nearby public
 * chat reaches citizens through the stub below:
 *
 *   citizens:chat-heard    (in)  { citizenUsername, speakerUsername, text }
 *
 * Nothing emits it in v1 (stubbed by design); when the hook lands, the
 * handler forwards to llm:chat-request with channel "public".
 */

const {
  EVENT_LLM_CITIZEN_REGISTER,
  EVENT_LLM_CHAT_REQUEST,
  EVENT_CITIZEN_CHAT_HEARD,
} = require("../constants");
const { personalityCard } = require("../lib/personalities");

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
 * Stubbed v1: forwards heard public chat to the gateway. Wire the emitter
 * when core grows a public-chat hook; the payload shape is already fixed.
 */
function onCitizenChatHeard(event) {
  if (!pluginApi) {
    return;
  }
  const { citizenUsername, speakerUsername, text } = event ?? {};
  if (!citizenUsername || !speakerUsername || !text) {
    return;
  }
  pluginApi.emitCustomEvent(EVENT_LLM_CHAT_REQUEST, {
    citizenUsername,
    requesterUsername: speakerUsername,
    text: String(text).slice(0, 320),
    channel: "public",
  });
}

function chatHeardEventName() {
  return EVENT_CITIZEN_CHAT_HEARD;
}

module.exports = {
  initCitizenChat,
  registerCitizenForChat,
  onCitizenChatHeard,
  chatHeardEventName,
};
