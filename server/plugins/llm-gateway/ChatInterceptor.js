// ChatInterceptor -- the "ears". Routes player-initiated chat with a citizen bot
// into the gateway as an `llm:chat-request` custom event.
//
// What we intercept (via api.onSocialPacket):
//   - private_message packets to a citizen bot.
//     (FriendsList.plugin.js handles delivery as normal; we only observe.)
//   - public_chat packets: the citizens plugin emits `citizens:chat-heard`
//     for bots near the speaker (see citizens/chat/CitizenChat.js), which
//     forwards here as `llm:chat-request` with channel "public".
//
// Event contracts:
//   llm:citizen-register { username, personalityCard, replyCooldownMs? }
//       -> registers a citizen (the citizens plugin calls this on spawn)
//   llm:chat-request { citizenUsername, requesterUsername, text, channel }
//       -> emitted here; Gateway listens and replies via llm:chat-response

const BOT_HOST_ADDRESS = "bot"; // set by bots/behaviours/spawn/BotPlayerFactory.js

const DEFAULT_CARD =
  "You are an ordinary citizen of Gielinor going about your day. Friendly but " +
  "busy; you don't know everything and you say so.";

function isCitizenBot(player) {
  if (!player || typeof player.getHostAddress !== "function") return false;
  return player.getHostAddress() === BOT_HOST_ADDRESS;
}

class ChatInterceptor {
  constructor(api) {
    this.api = api;
    this.citizens = new Map(); // lowercased username -> { username, personalityCard, replyCooldownMs }
    this.lastReplyAt = new Map(); // lowercased username -> timestamp
  }

  get World() {
    return this.api.core.World;
  }

  registerCitizen({ username, personalityCard, replyCooldownMs }) {
    if (!username) return;
    this.citizens.set(String(username).toLowerCase(), {
      username: String(username),
      personalityCard: String(personalityCard ?? DEFAULT_CARD).slice(0, 2000),
      replyCooldownMs: Number(replyCooldownMs) || 8000,
    });
  }

  getCitizen(username) {
    return this.citizens.get(String(username ?? "").toLowerCase()) ?? null;
  }

  // True when the bot may answer (cooldown keeps one chatty player from
  // farming LLM calls). Updates the timestamp when allowed.
  checkCooldown(username) {
    const citizen = this.getCitizen(username);
    const cooldown = citizen?.replyCooldownMs ?? 8000;
    const key = String(username).toLowerCase();
    const last = this.lastReplyAt.get(key) ?? 0;
    if (Date.now() - last < cooldown) return false;
    this.lastReplyAt.set(key, Date.now());
    return true;
  }

  requestChat({ citizenUsername, requesterUsername, text, channel }) {
    const clean = String(text ?? "").trim().slice(0, 320);
    if (!clean || !citizenUsername || !requesterUsername) return;
    if (!this.checkCooldown(citizenUsername)) return; // silence is free
    this.api.emitCustomEvent("llm:chat-request", {
      citizenUsername: String(citizenUsername),
      requesterUsername: String(requesterUsername),
      text: clean,
      channel,
    });
  }

  // Module-level hook handler (wired by name from the plugin's register).
  onSocialPacket(event) {
    const { player, packet } = event ?? {};
    if (!packet || packet.type !== "private_message") return;
    if (isCitizenBot(player)) return; // bot->player PMs are ours already, not requests
    const recipient = this.World?.getPlayerByName?.(packet.recipient);
    if (!isCitizenBot(recipient)) return;
    this.requestChat({
      citizenUsername: recipient.getUsername(),
      requesterUsername: player.getUsername(),
      text: packet.text,
      channel: "private",
    });
  }

  onCitizenRegister(payload) {
    this.registerCitizen(payload ?? {});
  }
}

module.exports = { ChatInterceptor, isCitizenBot, DEFAULT_CARD };
