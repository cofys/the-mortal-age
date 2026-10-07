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
  ROLE_MERCHANT,
  ATTR_CITIZEN_PERSONALITY,
} = require("../constants");
const { personalityCard } = require("../lib/personalities");
const { buildContext } = require("./CitizenContext");
const {
  getMemory,
  scoreTone,
  GRUDGE_INSULT,
  GOSSIP_INSULT,
} = require("../lib/CitizenMemory");
const { getJournal } = require("../lib/CitizenJournal");

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
  // Enemy cold shoulder: enemies get silence, not conversation. (Checked
  // before memory recording so enemies don't warm the relationship by
  // talking.)
  try {
    const { isEnemy } = require("../lib/CitizenBonds");
    if (isEnemy(citizenUsername, speakerUsername)) {
      return; // No reply. The street knows.
    }
  } catch {
    // Non-fatal — fall through to normal handling.
  }
  // Haggling: decided data-tier by the merchant's personality, voiced by
  // the LLM. Unlike social keywords this does NOT swallow the reply — the
  // decision rides along as prompt context and the LLM speaks it in voice.
  let haggleLine = "";
  try {
    haggleLine = handleHaggle(citizenUsername, speakerUsername, text) ?? "";
  } catch {
    haggleLine = "";
  }
  // Social keywords: player-initiated friend/party/invite actions. Handled
  // as data (zero LLM); the citizen's next LLM reply will reflect the new
  // relationship via context.
  try {
    if (handleSocialKeyword(citizenUsername, speakerUsername, text)) {
      return; // Handled — no LLM reply needed (the action speaks).
    }
  } catch {
    // Non-fatal — fall through to normal handling.
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
    // A haggle decision (if any) rides along as an extra prompt line.
    context: buildContext(citizenUsername, speakerUsername) + haggleLine,
  });
}

/** Lazy require — the director requires this module at boot. */
function getDirectorKingdom(citizenUsername) {
  try {
    const { getDirector } = require("../director/CitizenDirector");
    const { normalizeName } = require("../lib/CitizenBonds");
    return getDirector()?.roster.get(normalizeName(citizenUsername))?.kingdomId ?? null;
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
 * Haggling: a player asks a merchant citizen for a better price.
 * Decided data-tier (personality rules), voiced by the LLM.
 *
 * Returns a context line for the LLM prompt ("" when not a haggle or not
 * a merchant). The data-tier decision is recorded in memory + journal;
 * the stall consumes the granted discount at the next opening.
 *
 * Personality rules:
 *   greedy merchants refuse outright (haggleEdge > 1);
 *   timid / easygoing souls fold for 15%;
 *   bold merchants counter with a token 5%;
 *   everyone else meets in the middle at 10%.
 * A haggle attempt — granted or refused — starts a cooldown; repeat
 * asks inside it are refused without a new decision.
 */
const HAGGLE_KEYWORDS =
  /\b(haggle|discount|cheaper|lower (the )?price|better price|best price|cut me a deal|do (it|that) for less|knock .* off)\b/;

function handleHaggle(citizenUsername, speakerUsername, text) {
  const said = String(text ?? "").toLowerCase();
  if (!HAGGLE_KEYWORDS.test(said)) return "";
  let record = null;
  let director = null;
  try {
    const { getDirector } = require("../director/CitizenDirector");
    director = getDirector();
    record = director?.roster?.get?.(citizenUsername) ?? null;
  } catch {
    return "";
  }
  if (!record || record.role !== ROLE_MERCHANT) return "";
  const memory = getMemory();
  const now = Date.now();
  if (memory.hasHaggledRecently?.(citizenUsername, speakerUsername, now)) {
    try {
      getJournal().log(
        citizenUsername,
        "haggle",
        `${speakerUsername} pressed for another discount — refused, already had their chance.`,
        { with: speakerUsername }
      );
    } catch {
      // Non-fatal.
    }
    return " They already asked you for a better price recently. Hold firm and say so briefly, in your own voice.";
  }
  let pct = 10;
  try {
    const { humanizerProfile } = require("../lib/humanizer");
    const bot = director?.getBot?.(record);
    const personality =
      bot?.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? record.personality ?? {};
    const profile = humanizerProfile(personality);
    const demeanor = String(personality.demeanor ?? "");
    const traits = new Set(personality.traits ?? []);
    const timid =
      demeanor.includes("nervous") ||
      demeanor.includes("soft-spoken") ||
      traits.has("timid") ||
      traits.has("easygoing") ||
      traits.has("cheerful");
    const bold = demeanor.includes("bold") || demeanor.includes("brash");
    if ((profile.haggleEdge ?? 1) > 1.01) {
      pct = 0; // greedy: prices are prices
    } else if (timid) {
      pct = 15;
    } else if (bold) {
      pct = 5;
    }
  } catch {
    pct = 10;
  }
  memory.recordHaggleAttempt?.(citizenUsername, speakerUsername, now);
  if (pct > 0) {
    try {
      memory.recordHaggle?.(citizenUsername, speakerUsername, pct, now);
    } catch {
      // Non-fatal.
    }
    try {
      getJournal().log(
        citizenUsername,
        "haggle",
        `Haggled ${pct}% off for ${speakerUsername} — they asked, and it felt right.`,
        { with: speakerUsername, data: { pct } }
      );
    } catch {
      // Non-fatal.
    }
    return ` They just asked you for a better price and you agreed to ${pct}% off, one time only. Tell them the deal in your own voice — warm if you like them, grudging if you don't. Speak like a stallkeeper, not a system.`;
  }
  try {
    getJournal().log(
      citizenUsername,
      "haggle",
      `Refused ${speakerUsername}'s haggling — the prices are fair and that's final.`,
      { with: speakerUsername }
    );
  } catch {
    // Non-fatal.
  }
  return " They just asked you for a discount and you refused — your prices are fair and you know it. Say so briefly, in your own voice.";
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

  // "follow me" / "come with me" — player asks citizen to follow.
  if (/\b(follow me|come with me|walk with me|stay with me)\b/.test(said)) {
    if (SocialMechanics.requestFollow(citizenUsername, speakerUsername)) {
      notifyCitizenSpoke(citizenUsername, speakerUsername, "follow_start");
    }
    return true;
  }

  // "stop following" / "stay here" — player dismisses the follower.
  if (/\b(stop following|stay here|wait here|stop follow)\b/.test(said)) {
    if (SocialMechanics.requestStopFollow(citizenUsername, speakerUsername)) {
      notifyCitizenSpoke(citizenUsername, speakerUsername, "follow_stop");
    }
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
      activity_invite: `${display}: We've got company — ${speakerUsername}'s coming with us!`,
      follow_start: `${display}: Right behind you.`,
      follow_stop: `${display}: I'll wait here then.`,
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
