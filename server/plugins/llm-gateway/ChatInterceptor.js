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

const { PlayerThrottles } = require("./PlayerThrottles");

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
    this.lastPublicReplyAt = new Map(); // lowercased username -> timestamp (public-path cap)
    // Per-PLAYER throttles: one player can never farm the daily call budget
    // (see PlayerThrottles.js). Independent of the per-citizen cooldowns
    // above, which rotate across the citizen pool and don't bound the input.
    this.throttles = new PlayerThrottles();
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
    this.lastPublicReplyAt.delete(key);
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

  // Public-chat cap: the public path (citizens:chat-heard -> llm:chat-request,
  // emitted directly by the citizens plugin) bypasses requestChat's
  // checkCooldown, so without this a player spamming public chat in a crowd
  // could trigger up to 2 LLM calls per utterance with no bound — on a free
  // tier, spam burns quota. Per-citizen minimum gap between public replies.
  // Private-message requests already passed checkCooldown, so the gateway
  // only calls this for channel === "public". Updates the timestamp when
  // allowed. Silence is free.
  checkPublicCooldown(username) {
    const cooldown = Number(process.env.LLM_GATEWAY_PUBLIC_CHAT_COOLDOWN_MS) || 30_000;
    const key = String(username).toLowerCase();
    const last = this.lastPublicReplyAt.get(key) ?? 0;
    if (Date.now() - last < cooldown) return false;
    this.lastPublicReplyAt.set(key, Date.now());
    return true;
  }

  requestChat({ citizenUsername, requesterUsername, text, channel }) {
    const clean = String(text ?? "").trim().slice(0, 320);
    if (!clean || !citizenUsername || !requesterUsername) return;
    if (!this.checkCooldown(citizenUsername)) return; // silence is free
    // Per-player PM budget (default 200 LLM replies/day/player): the
    // per-citizen 8s cooldown above rotates across citizens, so without this
    // one player cycling PMs could sustain ~7 calls/min with no bound.
    // Only GRANTED replies consume budget — the 8s denials don't punish.
    if (!this.throttles.checkPmReply(requesterUsername)) return; // silence is free
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

  // Public-path per-PLAYER throttle (the gateway calls this for channel
  // === "public" AFTER checkPublicCooldown passes). A player spamming
  // public chat near a crowd could otherwise trigger 2 LLM calls per
  // utterance with no bound — the per-citizen 30s cooldown rotates across
  // the pool. Default: 4 LLM replies per 5 minutes per player (~48/hr,
  // under the research's ~50/hr bar). The window slides: five quiet minutes
  // restore the full allowance, so a throttled player is never silenced
  // forever. Only granted replies consume budget. Silence is free.
  checkPublicRateLimit(requesterUsername) {
    return this.throttles.checkPublicReply(requesterUsername);
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
