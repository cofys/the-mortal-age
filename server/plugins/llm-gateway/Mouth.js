// Mouth -- the "mouth". Speaks a citizen bot's reply through the bot entity.
//
// Listens for `llm:chat-response` { citizenUsername, requesterUsername, text, channel }
// and delivers it:
//   - public: delegates to CitizenSayPublic.sayPublic — the overhead bubble +
//     chat-box line for nearby players, <=80-char word-boundary chunking (the
//     OSRS public-chat limit), the speaker's voice backstop, the anti-repeat
//     memory, and the per-citizen chat-box throttle.
//   - private: a real private message to the requester via their PacketSender.
//   - friends_chat: treated like public (nearby channel members see it).
//
// Bots have no ClientConnection, so MCP-style message injection
// (core.dispatchClientMessages) cannot drive them -- hence forceChat.
// Disable the default mouth with LLM_GATEWAY_MOUTH=0 if the citizens plugin
// wants to speak replies itself.

// Shared with the template chat path: strip a leading self-name prefix
// ("Ora Nettle: ...") that the LLM adds when roleplaying with name tags.
// Public delivery funnels through CitizenSayPublic.sayPublic (voice backstop,
// anti-repeat memory, 80-char word-boundary chunking, chat-box throttle).
// CitizenSayPublic only requires lib/citizenVoice + constants — no cycle.
const { stripSelfNamePrefix, sayPublic } = require("../citizens/chat/CitizenSayPublic");

const MOUTH_ENABLED = (process.env.LLM_GATEWAY_MOUTH ?? "1") === "1";

function chunk(text, size) {
  const chunks = [];
  let rest = String(text ?? "").trim();
  while (rest.length > size) {
    let cut = rest.lastIndexOf(" ", size);
    if (cut <= 0) cut = size;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

function displayNameOf(bot) {
  try {
    const name = bot?.getAttribute?.("character:display-name");
    if (typeof name === "string" && name.trim().length > 0) return name.trim();
  } catch {
    // fall through
  }
  try {
    return bot?.getUsername?.() ?? "";
  } catch {
    return "";
  }
}

/**
 * Public delivery — a thin wrapper over the canonical
 * CitizenSayPublic.sayPublic choke point, which handles the overhead bubble +
 * chat-box send, <=80-char word-boundary chunking with a fixed 800ms
 * inter-line gap, the speaker's voice backstop, the anti-repeat memory, and
 * the per-citizen 8s chat-box throttle. The Mouth used to re-implement all of
 * that here (60-char chunks, own pacing, own recipient loop); the duplicate
 * path is gone, so LLM replies behave exactly like template speech.
 */
function speakPublic(api, bot, text) {
  // Defense in depth: no line breaks, one flowing message — sayPublic's
  // chunker splits at word boundaries on whole lines only.
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  return sayPublic(bot, clean);
}

function speakPrivate(api, bot, requester, text) {
  const Misc = api.core.Misc;
  const stripped = stripSelfNamePrefix(String(text ?? ""), displayNameOf(bot));
  const clean = stripped.replace(/\s+/g, " ").trim().slice(0, 160); // PM cap, like the client
  if (!clean) return;
  const packed = Misc.textPack(clean);
  requester.getPacketSender().sendPrivateMessage(bot, packed, packed.length);
}

function onChatResponse(api, payload) {
  if (!MOUTH_ENABLED) return;
  const { citizenUsername, requesterUsername, text, channel } = payload ?? {};
  if (!citizenUsername || !text) return;
  const World = api.core.World;
  const bot = World?.getPlayerByName?.(citizenUsername);
  if (!bot) return;
  try {
    if (channel === "private") {
      const requester = World.getPlayerByName(requesterUsername);
      if (!requester) return;
      // Only PM back if they can still receive one from the bot.
      if (requester.getRelations?.().canReceivePrivateMessageFrom?.(bot) === false) return;
      speakPrivate(api, bot, requester, text);
    } else {
      speakPublic(api, bot, text);
    }
  } catch (error) {
    console.warn(`[llm-gateway] mouth failed for ${citizenUsername}`, error?.message ?? error);
  }
}

module.exports = { onChatResponse, speakPublic, speakPrivate, chunk };
