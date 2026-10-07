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

  registerCitizen({ username, personalityCard, replyCooldownMs, buildContext }) {
    if (!username) return;
    this.citizens.set(String(username).toLowerCase(), {
      username: String(username),
      personalityCard: String(personalityCard ?? DEFAULT_CARD).slice(0, 2000),
      replyCooldownMs: Number(replyCooldownMs) || 8000,
      // Optional: the owning plugin's live-context builder (citizenUsername,
      // speakerUsername) => string. Grounds private-message replies in the
      // citizen's current mood/activity/goal without the gateway reaching
      // into plugin state.
      buildContext: typeof buildContext === "function" ? buildContext : null,
    });
  }

  getCitizen(username) {
    return this.citizens.get(String(username ?? "").toLowerCase()) ?? null;
  }

  /**
   * Drop a citizen who no longer exists (refugee column stood down, war
   * casualty). Prevents the registration/cooldown maps from growing across
   * wars. Memory-leak plug, 2026-10-07.
   */
  unregisterCitizen(username) {
    const key = String(username ?? "").toLowerCase();
    if (!key) return;
    this.citizens.delete(key);
    this.lastReplyAt.delete(key);
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
    // Live context for the reply (private messages don't pass through the
    // citizens plugin's chat module, so the gateway asks the registered
    // builder). Failures fall back to no context, never break the path.
    let context = null;
    try {
      const builder = this.getCitizen(citizenUsername)?.buildContext;
      if (builder) context = builder(requesterUsername) || null;
    } catch {
      context = null;
    }
    this.api.emitCustomEvent("llm:chat-request", {
      citizenUsername: String(citizenUsername),
      requesterUsername: String(requesterUsername),
      text: clean,
      channel,
      context,
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
