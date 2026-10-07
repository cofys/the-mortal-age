// LlmGateway -- the "mouth" of the AI citizens.
//
// Scripted bodies play the game; the LLM only wakes up when a real player talks
// to a citizen bot. Boots fine with zero API keys configured -- bots just stay
// silent. See DESIGN.md for the chain, the token math, and what Jon needs to do.
//
// Events (plugins talk to each other through custom events, never new core hooks):
//   llm:citizen-register  (in)  { username, personalityCard, replyCooldownMs? }
//   llm:speak-request     (in)  { citizenUsername, toUsername, toRole?, toMemory?,
//                                 context?, threadId? } — citizen speaks first
//                                 (citizen-to-citizen openers, lite tier only)
//   llm:chat-response     (out) { citizenUsername, requesterUsername, text, channel,
//                                 provider, tokensUsed, latencyMs }
// Chat to a citizen bot arrives via api.onSocialPacket (private_message); the
// citizens plugin can also emit llm:chat-request directly (e.g. nearby public chat,
// which core currently broadcasts without a plugin hook -- see DESIGN.md).

const { Gateway } = require("./Gateway");

let gateway = null;

function initGateway(api) {
  gateway = new Gateway(api);
  return gateway;
}

function onGatewaySocialPacket(event) {
  gateway?.handleSocialPacket(event);
}

function onGatewayChatRequest(payload) {
  // Fire-and-forget: do the async work, the response event lands later.
  gateway?.handleChatRequest(payload).catch((error) =>
    console.warn("[llm-gateway] chat request failed", error?.message ?? error)
  );
}

function onGatewaySpeakRequest(payload) {
  // Citizen-to-citizen opener. Fire-and-forget like chat requests.
  gateway?.handleSpeakRequest(payload).catch((error) =>
    console.warn("[llm-gateway] speak request failed", error?.message ?? error)
  );
}

function onGatewayChatResponse(payload) {
  gateway?.handleChatResponse(payload);
}

function onGatewayCitizenRegister(payload) {
  gateway?.handleCitizenRegister(payload);
}

function onGatewayCitizenUnregister(payload) {
  gateway?.handleCitizenUnregister(payload);
}

function shutdownGateway() {
  gateway?.shutdown();
  gateway = null;
}

function gatewayStatus() {
  return gateway?.status() ?? { error: "llm-gateway not initialized" };
}

module.exports = {
  name: "LlmGateway",
  gatewayStatus,
  register(api) {
    initGateway(api);
    api.onSocialPacket(onGatewaySocialPacket);
    api.onCustomEvent("llm:chat-request", onGatewayChatRequest);
    api.onCustomEvent("llm:speak-request", onGatewaySpeakRequest);
    api.onCustomEvent("llm:chat-response", onGatewayChatResponse);
    api.onCustomEvent("llm:citizen-register", onGatewayCitizenRegister);
    api.onCustomEvent("llm:citizen-unregister", onGatewayCitizenUnregister);
    api.onServerShutdown(shutdownGateway);
  },
};
