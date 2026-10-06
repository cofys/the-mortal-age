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
const { buildContext } = require("./CitizenContext");
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
    // The gateway calls this to ground each reply in the citizen's live moment.
    // (Functions cross the in-process event boundary fine.)
    buildContext: (speakerUsername) => buildContext(username, speakerUsername),
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
    // Ground the reply in the citizen's live moment (mood, activity, goal,
    // relationship with this speaker). Built here, not in the gateway, so
    // the gateway never reaches into the citizens plugin's state.
    context: buildContext(citizenUsername, speakerUsername),
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

/**
 * Social keywords: player says something like "be my friend" or "yes" to a
 * pending invite. Returns true if handled (no LLM reply needed).
 */
function handleSocialKeyword(citizenUsername, speakerUsername, text) {
  const said = String(text ?? "").toLowerCase().trim();
  if (!said) return false;
  let SocialMechanics, Bonds;
  try {
    SocialMechanics = require("../lib/CitizenSocialMechanics");
    Bonds = require("../lib/CitizenBonds");
  } catch {
    return false;
  }

  // "yes" / "accept" — accept a pending invite from this citizen.
  if (/^(yes|yeah|yep|accept|sure|ok|okay)$/.test(said)) {
    const invite = SocialMechanics.acceptInvite(speakerUsername, citizenUsername);
    if (invite) {
      notifyCitizenSpoke(citizenUsername, speakerUsername, invite.kind);
      return true;
    }
    return false; // No pending invite — let the LLM handle the "yes".
  }

  // "be my friend" / "let's be friends" — player requests friendship.
  if (/\b(be my friend|let'?s be friends|add me as friend|friend me)\b/.test(said)) {
    const result = SocialMechanics.requestFriend(speakerUsername, citizenUsername);
    if (result.already) return false; // Already friends — LLM can riff.
    if (result.enemy) return false; // Enemies — cold shoulder already handled.
    // Citizen decides: befriendable ones accept immediately, others get a request.
    if (SocialMechanics.citizenAcceptFriend(citizenUsername, speakerUsername)) {
      notifyCitizenSpoke(citizenUsername, speakerUsername, "friend_accept");
    } else {
      // Not ready — the request is pending; citizen will decide later.
      notifyCitizenSpoke(citizenUsername, speakerUsername, "friend_pending");
    }
    return true;
  }

  // "join my party" / "party up" — player invites citizen to party.
  if (/\b(join my party|party up|join us|come with (me|us))\b/.test(said)) {
    const party = Bonds.getParty(speakerUsername);
    if (party) {
      SocialMechanics.joinParty(citizenUsername, party);
      notifyCitizenSpoke(citizenUsername, speakerUsername, "party_join");
    } else {
      const newParty = SocialMechanics.createParty(speakerUsername, [citizenUsername]);
      notifyCitizenSpoke(citizenUsername, speakerUsername, "party_create");
    }
    return true;
  }

  // "leave party" / "disband" — player leaves or disbands.
  if (/\b(leave party|disband( party)?)\b/.test(said)) {
    SocialMechanics.leaveParty(speakerUsername);
    return true;
  }

  return false;
}

/**
 * Tell the player what happened, via the citizen's "voice" (a game message
 * from the citizen). The LLM will pick up the new relationship in context
 * on the next exchange.
 */
function notifyCitizenSpoke(citizenUsername, speakerUsername, kind) {
  if (!pluginApi) return;
  try {
    const { getDirector } = require("../director/CitizenDirector");
    const director = getDirector();
    const bot = director?.getBot?.(director?.roster?.get?.(citizenUsername));
    const display = director?.roster?.get?.(citizenUsername)?.displayName ?? citizenUsername;
    const messages = {
      friend_request: `${display}: I'd like that. We're friends now.`,
      friend_accept: `${display}: Friends! I won't forget this.`,
      friend_pending: `${display}: Hmm... give me some time. Let's see how it goes.`,
      party_join: `${display}: I'm with you. Lead on.`,
      party_create: `${display}: A party! I'm in. Where to?`,
      clan_invite: `${display}: Join my clan chat — we'd be glad to have you.`,
      boss_trip: `${display}: A boss trip? I'm in. Let's go.`,
    };
    const msg = messages[kind] ?? `${display} nods.`;
    // Send as a game message "from" the citizen (the citizen's next LLM
    // reply will be in their real voice).
    const { getMemory } = require("../lib/CitizenMemory");
    // Find the speaker's player to message them.
    const speaker = findPlayerByName(speakerUsername);
    if (speaker) speaker.sendMessage(msg);
    // Also force-chat on the bot so nearby players see it.
    try {
      bot?.forceChat?.(msg.split(": ").slice(1).join(": ") || msg);
    } catch {
      // Non-fatal.
    }
  } catch {
    // Non-fatal.
  }
}

function findPlayerByName(username) {
  try {
    return pluginApi?.core?.World?.getPlayerByName?.(username) ?? null;
  } catch {
    return null;
  }
}

module.exports = {
  initCitizenChat,
  registerCitizenForChat,
  onCitizenChatHeard,
  onSocialPacket,
  chatHeardEventName,
};
