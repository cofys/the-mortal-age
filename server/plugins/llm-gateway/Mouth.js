// Mouth -- the "mouth". Speaks a citizen bot's reply through the bot entity.
//
// Listens for `llm:chat-response` { citizenUsername, requesterUsername, text, channel }
// and delivers it:
//   - public: forceChat bubble + sendPublicChat to nearby players, mirroring
//     ChatPacketListener.handleText's broadcast loop. Capped at 80 chars per
//     line (OSRS public-chat limit); longer replies are chunked.
//   - private: a real private message to the requester via their PacketSender.
//   - friends_chat: treated like public (nearby channel members see it).
//
// Bots have no ClientConnection, so MCP-style message injection
// (core.dispatchClientMessages) cannot drive them -- hence forceChat.
// Disable the default mouth with LLM_GATEWAY_MOUTH=0 if the citizens plugin
// wants to speak replies itself.

const PUBLIC_CHAT_MAX_CHARS = 80;

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

function recipientsFor(bot, World) {
  const recipients = new Set();
  if (typeof bot.getLocalPlayers === "function") {
    for (const p of bot.getLocalPlayers()) recipients.add(p);
  }
  if (typeof World?.getNearbyPlayersForUpdate === "function") {
    for (const p of World.getNearbyPlayersForUpdate(bot)) recipients.add(p);
  }
  return recipients;
}

function speakPublic(api, bot, text) {
  const World = api.core.World;
  // Defense in depth: no line breaks, one flowing message (chunking below
  // handles the 80-char OSRS limit).
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  for (const line of chunk(clean, PUBLIC_CHAT_MAX_CHARS)) {
    bot.forceChat(line);
    const username = bot.getUsername();
    const index = bot.getIndex();
    for (const recipient of recipientsFor(bot, World)) {
      if (recipient === bot) continue;
      if (recipient?.getRelations?.().canReceivePublicChatFrom?.(bot) === false) continue;
      recipient?.getPacketSender?.().sendPublicChat?.(line, username, index);
    }
  }
}

function speakPrivate(api, bot, requester, text) {
  const Misc = api.core.Misc;
  const clean = String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 160); // PM cap, like the client
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

module.exports = { onChatResponse, speakPublic, speakPrivate, chunk, PUBLIC_CHAT_MAX_CHARS };
