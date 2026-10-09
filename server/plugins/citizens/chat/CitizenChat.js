"use strict";
const { voiceFor, voiceLine } = require("../lib/citizenVoice");
const { sayPublic } = require("./CitizenSayPublic");


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
 *   citizens:chat-heard    (out) { citizenUsername, speakerUsername, text, shouldReply }
 *
 * ALL nearby citizens hear (shouldReply=false for the crowd — they remember
 * and their mood shifts, but they don't speak); the top-2 selected repliers
 * get shouldReply=true. onCitizenChatHeard tries a zero-LLM scripted reaction
 * first (CitizenHeardReactions: "gz!", greetings, farewells...); if none fires
 * it forwards to llm:chat-request with channel "public".
 */

const {
  EVENT_LLM_CITIZEN_REGISTER,
  EVENT_LLM_CITIZEN_UNREGISTER,
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

/** Called by the director when a citizen is permanently removed. */
function unregisterCitizenForChat(username) {
  if (!pluginApi || !username) {
    return;
  }
  pluginApi.emitCustomEvent(EVENT_LLM_CITIZEN_UNREGISTER, { username });
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
  const { citizenUsername, speakerUsername, text, shouldReply } = event ?? {};
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
    // Friendly chatter warms the mood a little — being around people feels good.
    if (tone > 0) {
      try {
        const { addMood } = require("../brain/CitizenNeeds");
        const bot = findPlayerByName(citizenUsername);
        if (bot) addMood(bot, 2);
      } catch {
        // Cosmetic only.
      }
    }
  } catch (error) {
    // Memory must never break the chat path.
  }
  // Crowd members (shouldReply=false) heard it and remember it, but don't speak.
  if (shouldReply === false) {
    return;
  }
  // Scripted reactions: fast zero-LLM reflexes for common patterns ("gz!",
  // greetings, "thanks!"). If one fires, skip the LLM — the moment is handled.
  try {
    const { tryScriptedReaction } = require("./CitizenHeardReactions");
    const bot = findPlayerByName(citizenUsername);
    if (bot && tryScriptedReaction(citizenUsername, speakerUsername, text, bot)) {
      pluginApi.log?.("[citizens] scripted chat reaction", {
        citizen: citizenUsername,
        speaker: speakerUsername,
      });
      return; // Handled — no LLM needed.
    }
  } catch {
    // Non-fatal — fall through to the LLM path.
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
 * Social-packet hook: public chat near citizen bots. Selects up to 2
 * citizens to reply — not all of them. Real players don't all answer at
 * once; neither do citizens.
 *
 * Selection:
 *   1. A citizen addressed by name in the message always replies (priority).
 *   2. Otherwise, score by proximity + relationship warmth + randomness,
 *      pick the top 2. The randomness means different citizens speak up
 *      each time, like a real crowd.
 */
const MAX_PUBLIC_REPLIERS = 2;
// Track who replied to whom recently so the same citizens don't dominate
// every exchange. username -> Map(speakerUsername -> timestamp)
const recentRepliers = new Map();
const REPLIER_MEMORY_MS = 90 * 1000; // 90s before a citizen can reply to the same player again

function pruneReplierMemory(nowMs) {
  try {
    for (const [citizen, speakers] of recentRepliers) {
      for (const [speaker, at] of speakers) {
        if (nowMs - at > REPLIER_MEMORY_MS) speakers.delete(speaker);
      }
      if (speakers.size === 0) recentRepliers.delete(citizen);
    }
  } catch {
    // Non-fatal.
  }
}

function citizenTileOf(p) {
  try {
    const loc = p.getLocation?.();
    if (!loc) return null;
    return { x: loc.getX(), y: loc.getY() };
  } catch {
    return null;
  }
}

function selectRepliers(citizens, speaker, speakerName, text) {
  const nowMs = Date.now();
  pruneReplierMemory(nowMs);
  const lowered = String(text ?? "").toLowerCase();
  const speakerTile = citizenTileOf(speaker);

  // 1. Direct address: "hey Petra" / "Petra, what..." — that citizen replies.
  const addressed = [];
  const unaddressed = [];
  for (const bot of citizens) {
    const name = String(bot.getUsername?.() ?? "");
    if (!name) continue;
    // Match first name or full name as a word in the message.
    const firstName = name.split(" ")[0].toLowerCase();
    const pattern = new RegExp(`\\b${firstName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (pattern.test(lowered)) addressed.push(bot);
    else unaddressed.push(bot);
  }
  if (addressed.length > 0) {
    // The addressed citizen replies; at most one unaddressed joins in.
    const rest = scoreCandidates(unaddressed, speaker, speakerName, speakerTile, nowMs);
    return [...addressed.slice(0, MAX_PUBLIC_REPLIERS), ...rest.slice(0, Math.max(0, MAX_PUBLIC_REPLIERS - addressed.length))];
  }

  // 2. No direct address: score and pick top 2.
  return scoreCandidates(unaddressed, speaker, speakerName, speakerTile, nowMs).slice(0, MAX_PUBLIC_REPLIERS);
}

function scoreCandidates(candidates, speaker, speakerName, speakerTile, nowMs) {
  const scored = [];
  for (const bot of candidates) {
    const name = String(bot.getUsername?.() ?? "");
    if (!name) continue;
    let score = Math.random() * 0.5; // base randomness: different citizens each time

    // Proximity: closer citizens are more likely to respond.
    try {
      const tile = citizenTileOf(bot);
      if (tile && speakerTile) {
        const dist = Math.max(Math.abs(tile.x - speakerTile.x), Math.abs(tile.y - speakerTile.y));
        score += Math.max(0, 0.4 - dist * 0.03); // +0.4 at 0 tiles, fades by ~13
      }
    } catch {
      // Non-fatal.
    }

    // Relationship: citizens who like the speaker chime in more.
    try {
      const { getMemory } = require("../lib/CitizenMemory");
      const opinion = getMemory().getOpinion?.(name, speakerName);
      if (opinion && typeof opinion.score === "number") {
        score += Math.max(-0.2, Math.min(0.3, opinion.score * 0.1));
      }
    } catch {
      // Non-fatal.
    }

    // Recency penalty: just replied to this player? Sit this one out.
    try {
      const speakers = recentRepliers.get(name);
      if (speakers?.has(speakerName)) score -= 0.6;
    } catch {
      // Non-fatal.
    }

    scored.push({ bot, name, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.bot);
}

function markReplied(citizenName, speakerName) {
  try {
    const nowMs = Date.now();
    if (!recentRepliers.has(citizenName)) recentRepliers.set(citizenName, new Map());
    recentRepliers.get(citizenName).set(speakerName, nowMs);
  } catch {
    // Non-fatal.
  }
}

function onSocialPacket(event) {
  const { player, packet } = event ?? {};
  if (!packet || packet.type !== "public_chat") return;
  if (!pluginApi || !player) return;
  if (isCitizenBot(player)) return; // citizens don't trigger each other
  const text = String(packet.text ?? "").trim();
  if (!text) return;
  const nearby = [];
  for (const local of player.getLocalPlayers?.() ?? []) {
    if (!isCitizenBot(local)) continue;
    nearby.push(local);
  }
  if (nearby.length === 0) return;
  const speakerName = player.getUsername();
  const repliers = selectRepliers(nearby, player, speakerName, text);
  const replierSet = new Set(repliers.map((b) => b.getUsername?.()));
  // ALL nearby citizens hear (for memory/mood/reactions); only the selected
  // repliers may speak (shouldReply). The rest are the crowd — they heard it,
  // they remember it, but they don't all chime in.
  for (const bot of nearby) {
    const citizenUsername = bot.getUsername?.();
    if (!citizenUsername) continue;
    const shouldReply = replierSet.has(citizenUsername);
    if (shouldReply) markReplied(citizenUsername, speakerName);
    pluginApi.emitCustomEvent(EVENT_CITIZEN_CHAT_HEARD, {
      citizenUsername,
      speakerUsername: speakerName,
      text: text.slice(0, 320),
      shouldReply,
    });
  }
  if (repliers.length > 0) {
    pluginApi.log?.("[citizens] public chat heard", {
      speaker: speakerName,
      citizens: nearby.length,
      repliers: repliers.length,
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
  let SocialMechanics, Bonds, Favors;
  try {
    SocialMechanics = require("../lib/CitizenSocialMechanics");
    Bonds = require("../lib/CitizenBonds");
    Favors = require("../lib/CitizenFavors");
  } catch {
    return false;
  }

  // Favor responses: "yes" accepts a pending favor ask from this citizen,
  // "no" declines it, "here"/"done" hands over the goods. Checked before
  // invites so a "yes" lands on the favor the citizen just asked for.
  if (/^(yes|yeah|yep|accept|sure|ok|okay)$/.test(said)) {
    const favor = Favors.acceptFavor(citizenUsername, speakerUsername);
    if (favor) {
      notifyCitizenSpoke(citizenUsername, speakerUsername, "favor_accept");
      return true;
    }
  }

  // "no" / "decline" — decline a pending favor ask from this citizen.
  if (/^(no|nah|nope|decline|pass)$/.test(said)) {
    const favor = Favors.declineFavor(citizenUsername, speakerUsername);
    if (favor) {
      notifyCitizenSpoke(citizenUsername, speakerUsername, "favor_decline");
      return true;
    }
    // No pending favor — check for a pending companion invite from this citizen.
    try {
      const Companions = require("../lib/CitizenCompanions");
      const invite = Companions.declineCompanionInvite(speakerUsername, citizenUsername);
      if (invite) {
        notifyCitizenSpoke(citizenUsername, speakerUsername, "companion_decline");
        return true;
      }
    } catch {
      // Non-fatal — fall through to LLM.
    }
    // No pending companion invite — check for a pending spy invite.
    try {
      const Spies = require("../lib/CitizenSpies");
      const invite = Spies.declineSpyInvite(speakerUsername, citizenUsername);
      if (invite) {
        notifyCitizenSpoke(citizenUsername, speakerUsername, "spy_decline");
        return true;
      }
    } catch {
      // Non-fatal — fall through to LLM.
    }
    return false; // No pending favor or invite — let the LLM handle the "no".
  }

  // "here" / "done" — hand over the goods for an accepted favor.
  if (/^(here|done|deliver|delivering|take them|take it)$/.test(said)) {
    let bot = null;
    try {
      const { getDirector } = require("../director/CitizenDirector");
      const director = getDirector();
      bot = director?.getBot?.(director?.roster?.get?.(citizenUsername)) ?? null;
    } catch {
      // Non-fatal — attemptComplete degrades gracefully without live objects.
    }
    const favor = Favors.attemptComplete(
      citizenUsername,
      speakerUsername,
      bot,
      findPlayerByName(speakerUsername)
    );
    if (favor) {
      // attemptComplete returns the favor even when it only left a hint
      // message (goods missing / guard still running), so only celebrate
      // an actual completion.
      if (favor.state === Favors.DONE) {
        notifyCitizenSpoke(citizenUsername, speakerUsername, "favor_done");
      }
      return true;
    }
    return false; // No favor in progress — let the LLM handle it.
  }

  // "yes" / "accept" — accept a pending invite from this citizen.
  if (/^(yes|yeah|yep|accept|sure|ok|okay)$/.test(said)) {
    // Spy network invites (asset recruitment, dossier purchase). Lazy
    // require; the player object is passed so dossiers can be charged.
    try {
      const Spies = require("../lib/CitizenSpies");
      const spyInvite = Spies.acceptSpyInvite(
        speakerUsername,
        citizenUsername,
        findPlayerByName(speakerUsername)
      );
      if (spyInvite) {
        notifyCitizenSpoke(citizenUsername, speakerUsername, spyInvite.kind);
        return true;
      }
    } catch {
      // Non-fatal — fall through to the generic invite path.
    }
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

  // "who is the mayor" — player asks about the town council.
  if (/\b(who is the mayor|who runs this town|who is on the council|town council)\b/.test(said)) {
    try {
      const Gov = require("../lib/CitizenGovernment");
      const { normalizeName } = require("../lib/CitizenBonds");
      const { getDirector } = require("../director/CitizenDirector");
      const director = getDirector();
      const record = director?.roster?.get?.(normalizeName(citizenUsername));
      if (!record?.kingdomId) return false;
      const d = Gov.describeCouncil(record.kingdomId);
      if (!d) return false;
      notifyCitizenSpoke(citizenUsername, speakerUsername, "gov_mayor", d);
    } catch {
      return false;
    }
    return true;
  }

  // "cook-off" / "cooking competition" / "recipe" — player asks about the
  // cooking circuit. (CitizenCuisine owns the monthly best-dish showcases;
  // this owns live cook-offs, judging panels, and recipes.)
  if (/\b(cook-off|cookoff|cooking competition|mystery ingredient|iron chef)\b/.test(said)) {
    try {
      const CookOffs = require("../lib/CitizenCookOffs");
      const kingdomId = ctx?.kingdomId ?? "unknown";
      const open = CookOffs.openCookOff(kingdomId);
      const season = CookOffs.seasonOf(Date.now());
      notifyCitizenSpoke(citizenUsername, speakerUsername, "cookoff", {
        open: open ? { theme: open.theme, mystery: open.mystery, entries: open.entries.length, pot: open.pot } : null,
        leaders: CookOffs.rankingsFor(kingdomId, season, 3).map((r) => ({ name: r.name, points: r.points })),
      });
    } catch {
      return false;
    }
    return true;
  }

  // "athlete" / "stadium" / "training" — player asks about athletics.
  // (CitizenSports owns the leagues and fixtures; this owns athletes,
  // training, stadiums, and records.)
  if (/\b(athlete|athletes|stadium|stadiums|training|fitness|sports record)\b/.test(said)) {
    try {
      const Athletics = require("../lib/CitizenAthletics");
      const kingdomId = ctx?.kingdomId ?? "unknown";
      const stadium = Athletics.stadiumFor(kingdomId);
      const athletes = Athletics.athletesIn(kingdomId, 3);
      notifyCitizenSpoke(citizenUsername, speakerUsername, "athletics", {
        stadium: stadium ? { capacity: stadium.capacity, condition: stadium.condition } : null,
        athletes: athletes.map((a) => ({ name: a.name, sport: a.sport, fitness: a.fitness })),
      });
    } catch {
      return false;
    }
    return true;
  }

  // "playwright" / "troupe" / "touring" — player asks about theater
  // production. (The entertainment theater block owns the house shows;
  // this owns playwrights, troupes, and touring.)
  if (/\b(playwright|playwrights|troupe|troupes|touring company|who wrote that play|standing ovation)\b/.test(said)) {
    try {
      const Theater = require("../lib/CitizenTheater");
      const kingdomId = ctx?.kingdomId ?? "unknown";
      const troupes = Theater.troupesIn(kingdomId);
      const plays = Theater.playsIn(kingdomId);
      const upcoming = Theater.upcomingPerformances(kingdomId);
      notifyCitizenSpoke(citizenUsername, speakerUsername, "theater_production", {
        troupes: troupes.slice(0, 3).map((t) => ({ name: t.name, members: t.members.length })),
        plays: plays.slice(0, 3).map((p) => ({ title: p.title, genre: p.genre })),
        upcoming: upcoming.slice(0, 3).map((p) => ({ title: p.playTitle, troupe: p.troupe, price: p.ticketPrice })),
      });
    } catch {
      return false;
    }
    return true;
  }

  // "any treaties" / "embassy" / "summit" / "ambassador" — citizen treaties.
  // (Excludes "marriage alliance" — that belongs to the dynastic block below.)
  if (/\b(any treaties?|peace treaty|trade treaty|any embass|ambassador|summit|foreign relations)\b/.test(said) ||
      (/\balliance\b/.test(said) && !/\bmarriage alliance\b/.test(said))) {
    try {
      const Treaties = require("../lib/CitizenTreaties");
      let kingdomId = null;
      try {
        const { kingdomIdOf } = require("../brain/CitizenSites");
        kingdomId = kingdomIdOf(citizenUsername);
      } catch { /* no sites */ }
      const desc = kingdomId ? Treaties.describe(kingdomId) : null;
      notifyCitizenSpoke(citizenUsername, speakerUsername, "treaty_status", {
        username: citizenUsername,
        treaties: desc?.treaties ?? [],
        embassies: desc?.embassies ?? [],
        pendingProposals: desc?.pendingProposals ?? [],
      });
    } catch {
      return false;
    }
    return true;
  }

  // "any spies" / "covert" / "infiltrate" — citizen espionage.
  // (Passive "what news from <kingdom>" stays with CitizenDiplomacy.)
  if (/\b(any sp(y|ies)|covert ops?|infiltrat\w*|spymaster|caught.*spy|spy network)\b/.test(said)) {
    try {
      const Espionage = require("../lib/CitizenEspionage");
      let kingdomId = null;
      try {
        const { kingdomIdOf } = require("../brain/CitizenSites");
        kingdomId = kingdomIdOf(citizenUsername);
      } catch { /* no sites */ }
      const net = kingdomId ? Espionage.networkFor(kingdomId) : null;
      notifyCitizenSpoke(citizenUsername, speakerUsername, "espionage_status", {
        username: citizenUsername,
        hasNetwork: !!net,
        spies: net?.spies?.length ?? 0,
        handlers: net?.handlers?.length ?? 0,
        liveOps: kingdomId ? Espionage.pendingOperationsFor(kingdomId).length : 0,
      });
    } catch {
      return false;
    }
    return true;
  }

  // "any news" / "what's the news" / "is there a paper" — journalism.
  if (/\b(any news|what'?s the news|latest news|is there a paper|buy a paper|any papers|subscribe|any journalists?|any reporters?)\b/.test(said)) {    try {
      const Press = require("../lib/CitizenPress");
      let kingdomId = null;
      try {
        const { kingdomIdOf } = require("../brain/CitizenSites");
        kingdomId = kingdomIdOf(citizenUsername);
      } catch { /* no sites */ }
      const desc = kingdomId ? Press.describe(kingdomId) : null;
      const ed = kingdomId ? Press.latestEdition(kingdomId) : null;
      notifyCitizenSpoke(citizenUsername, speakerUsername, "press_status", {
        username: citizenUsername,
        hasPress: desc?.hasPress ?? false,
        journalistCount: desc?.journalistCount ?? 0,
        subscriberCount: desc?.subscriberCount ?? 0,
        latestEdition: ed ? { beat: ed.beat, storyCount: ed.storyIds.length, price: ed.price } : null,
        isJournalist: citizenUsername ? Press.isJournalist(citizenUsername) : false,
        subscriptionPrice: Press.SUBSCRIPTION_PRICE,
      });
    } catch {
      return false;
    }
    return true;
  }

  // "press guild" / "press association" / "inkwell" / "press pass" — the
  // press association (guild layer). Placed after the journalism block;
  // keywords are distinct from it ("any news", "subscribe", ...).
  if (/\b(press guild|press association|inkwell|press award|press pass|journalism school|press code)\b/.test(said)) {    try {
      const Guilds = require("../lib/CitizenPressGuilds");
      let kingdomId = null;
      try {
        const { kingdomIdOf } = require("../brain/CitizenSites");
        kingdomId = kingdomIdOf(citizenUsername);
      } catch { /* no sites */ }
      const desc = kingdomId ? Guilds.describe(kingdomId) : null;
      notifyCitizenSpoke(citizenUsername, speakerUsername, "pressguild_status", {
        username: citizenUsername,
        members: desc?.members ?? 0,
        editors: desc?.editors ?? 0,
        treasury: desc?.treasury ?? 0,
        openCases: desc?.openCases ?? 0,
        awards: desc?.awards ?? 0,
        isMember: citizenUsername ? Guilds.isGuildMember(citizenUsername) : false,
        rank: citizenUsername ? Guilds.guildRankOf(citizenUsername) : null,
        hasPass: citizenUsername ? Guilds.hasPressPass(citizenUsername) : false,
      });
    } catch {
      return false;
    }
    return true;
  }

  // "bankers guild" / "bank guild" / "deposit insurance" / "bank audit" —
  // the bankers' association (guild layer). Placed before the banking
  // block; keywords are distinct from it ("my balance", "borrow coins", ...).
  if (/\b(bankers'? guild|bank guild|deposit insurance|bank audit|banking standards|insured deposit)\b/.test(said)) {
    try {
      const Guilds = require("../lib/CitizenBankGuilds");
      let kingdomId = null;
      try {
        const { kingdomIdOf } = require("../brain/CitizenSites");
        kingdomId = kingdomIdOf(citizenUsername);
      } catch { /* no sites */ }
      const desc = kingdomId ? Guilds.describe(kingdomId) : null;
      notifyCitizenSpoke(citizenUsername, speakerUsername, "bankguild_status", {
        username: citizenUsername,
        members: desc?.members ?? 0,
        auditors: desc?.auditors ?? 0,
        treasury: desc?.treasury ?? 0,
        insuranceFund: desc?.insuranceFund ?? 0,
        branchStatus: desc?.branchStatus ?? "unknown",
        openClaims: desc?.openClaims ?? 0,
        isMember: citizenUsername ? Guilds.isGuildMember(citizenUsername) : false,
        rank: citizenUsername ? Guilds.guildRankOf(citizenUsername) : null,
        isCovered: citizenUsername ? Guilds.isCovered(citizenUsername) : false,
      });
    } catch {
      return false;
    }
    return true;
  }

  // "is there a bank" / "my balance" / "open account" — banking.
  if (/\b(is there a bank|any bankers?|my balance|open an? account|bank balance|any loans?|borrow coins|deposit coins|withdraw coins)\b/.test(said)) {
    try {
      const Banking = require("../lib/CitizenBanking");
      let kingdomId = null;
      try {
        const { kingdomIdOf } = require("../brain/CitizenSites");
        kingdomId = kingdomIdOf(citizenUsername);
      } catch { /* no sites */ }
      const desc = kingdomId ? Banking.describe(kingdomId) : null;
      notifyCitizenSpoke(citizenUsername, speakerUsername, "banking_status", {
        username: citizenUsername,
        hasBranch: !!desc,
        branchName: desc?.name ?? null,
        bankerCount: desc?.bankerCount ?? 0,
        yourBalance: citizenUsername ? Banking.balanceOf(citizenUsername) : 0,
        yourLoan: citizenUsername ? (Banking.loanFor(citizenUsername)?.owed ?? 0) : 0,
        isBanker: citizenUsername ? !!Banking.bankerFor(citizenUsername) : false,
        moneySupply: Banking.moneySupply(),
      });
    } catch {
      return false;
    }
    return true;
  }

  // "insurance" / "buy a policy" / "file a claim" / "my policies" — insurance.
  if (/\b(any insurance|buy (a|an) policy|insurance (policy|policies|quote|office)|file a claim|my polic(ies|y)|any insurers?)\b/.test(said)) {
    try {
      const Insurance = require("../lib/CitizenInsurance");
      let kingdomId = null;
      try {
        const { kingdomIdOf } = require("../brain/CitizenSites");
        kingdomId = kingdomIdOf(citizenUsername);
      } catch { /* no sites */ }
      const desc = kingdomId ? Insurance.describe(kingdomId) : null;
      const mine = citizenUsername ? Insurance.policiesOf(citizenUsername) : [];
      notifyCitizenSpoke(citizenUsername, speakerUsername, "insurance_status", {
        username: citizenUsername,
        hasOffice: !!desc,
        insurerCount: desc?.insurerCount ?? 0,
        pool: desc?.pool ?? 0,
        yourPolicies: mine.map((p) => ({ type: p.type, faceValue: p.faceValue, premium: p.premium })),
        isInsurer: citizenUsername ? !!Insurance.insurerFor(citizenUsername) : false,
        types: desc?.types ?? [],
      });
    } catch {
      return false;
    }
    return true;
  }

  // "court" / "sue" / "contract" / "will" / "dispute" — civil law.
  if (/\b(any contracts?|make a (will|contract)|i want to sue|file a dispute|my (will|contracts?|disputes?)|any lawyers?|civil court|courthouse)\b/.test(said)) {
    try {
      const CivilLaw = require("../lib/CitizenCivilLaw");
      let kingdomId = null;
      try {
        const { kingdomIdOf } = require("../brain/CitizenSites");
        kingdomId = kingdomIdOf(citizenUsername);
      } catch { /* no sites */ }
      const desc = kingdomId ? CivilLaw.describe(kingdomId) : null;
      const mine = citizenUsername ? CivilLaw.disputesOf(citizenUsername) : [];
      const myContracts = citizenUsername ? CivilLaw.contractsOf(citizenUsername) : [];
      const myWill = citizenUsername ? CivilLaw.willFor(citizenUsername) : null;
      notifyCitizenSpoke(citizenUsername, speakerUsername, "civillaw_status", {
        username: citizenUsername,
        hasCourthouse: !!desc?.courthouse,
        openDisputes: desc?.openDisputes ?? 0,
        activeContracts: desc?.activeContracts ?? 0,
        willsRegistered: desc?.willsRegistered ?? 0,
        yourDisputes: mine.map((d) => ({ id: d.id, type: d.type, status: d.status, claim: d.claim })),
        yourContracts: myContracts.filter((c) => c.status === "active").map((c) => ({ id: c.id, type: c.type, amount: c.amount })),
        hasWill: !!myWill,
        filingFee: CivilLaw.DISPUTE_FILING_FEE,
        witnessFee: CivilLaw.CONTRACT_WITNESS_FEE,
      });
    } catch {
      return false;
    }
    return true;
  }

  // "publish: <headline>" — a real player files a story.
  if (/^publish:\s*/.test(said)) {
    try {
      const Press = require("../lib/CitizenPress");
      let kingdomId = null;
      try {
        const { kingdomIdOf } = require("../brain/CitizenSites");
        kingdomId = kingdomIdOf(speakerUsername) ?? kingdomIdOf(citizenUsername);
      } catch { /* no sites */ }
      const headline = said.replace(/^publish:\s*/, "");
      // Beat guess from keywords, default culture.
      let beat = Press.BEAT_CULTURE;
      if (/\b(war|siege|battle|army)\b/.test(headline)) beat = Press.BEAT_WAR;
      else if (/\b(crime|theft|murder|trial|court|jail)\b/.test(headline)) beat = Press.BEAT_CRIME;
      else if (/\b(council|election|law|vote|king|queen|mayor)\b/.test(headline)) beat = Press.BEAT_POLITICS;
      else if (/\b(discover|found|ruin|dungeon|expedition)\b/.test(headline)) beat = Press.BEAT_DISCOVERY;
      const res = Press.submitPlayerStory(speakerUsername, kingdomId, beat, headline);
      notifyCitizenSpoke(citizenUsername, speakerUsername, "player_story", {
        username: citizenUsername,
        ok: res.ok,
        reason: res.ok ? null : res.reason,
        storyId: res.ok ? res.id : null,
        beat,
      });
    } catch {
      return false;
    }
    return true;
  }

  // "when is the election" — player asks about the next election.
  if (/\b(when is the election|next election|when do we vote)\b/.test(said)) {
    try {
      const Gov = require("../lib/CitizenGovernment");
      const { normalizeName } = require("../lib/CitizenBonds");
      const { getDirector } = require("../director/CitizenDirector");
      const director = getDirector();
      const record = director?.roster?.get?.(normalizeName(citizenUsername));
      if (!record?.kingdomId) return false;
      const council = Gov.getCouncil(record.kingdomId);
      if (!council) return false;
      const days = Math.max(0, Math.ceil((council.nextElectionAtMs - Date.now()) / 86400000));
      notifyCitizenSpoke(citizenUsername, speakerUsername, "gov_election", { days });
    } catch {
      return false;
    }
    return true;
  }

  // "when is the next festival" — player asks about upcoming festivals.
  if (/\b(when is the next festival|next festival|what festivals are coming|any festivals soon|upcoming festivals)\b/.test(said)) {
    try {
      const Fest = require("../lib/CitizenFestivalLife");
      const upcoming = Fest.festivalsComing(3, Date.now());
      if (!upcoming.length) return false;
      const first = upcoming[0];
      const days = Fest.daysUntil(first, Date.now());
      notifyCitizenSpoke(citizenUsername, speakerUsername, "festival_next", {
        name: first.name,
        days,
        blurb: first.blurb,
        more: upcoming.length - 1,
      });
    } catch {
      return false;
    }
    return true;
  }

  // "i want to run for mayor" — player nominates themselves.
  if (/\b(i want to run|nominate me|put me on the ballot|i'll run for)\b/.test(said)) {
    try {
      const Gov = require("../lib/CitizenGovernment");
      const { normalizeName } = require("../lib/CitizenBonds");
      const { getDirector } = require("../director/CitizenDirector");
      const director = getDirector();
      const record = director?.roster?.get?.(normalizeName(citizenUsername));
      if (!record?.kingdomId) return false;
      // The citizen must know the player (friend) to vouch for them.
      const Bonds = require("../lib/CitizenBonds");
      if (!Bonds.isFriend(citizenUsername, speakerUsername)) return false;
      const ok = Gov.nominateCandidate(
        record.kingdomId,
        speakerUsername,
        speakerUsername,
        true,
        Date.now()
      );
      notifyCitizenSpoke(citizenUsername, speakerUsername, ok ? "gov_nominated" : "gov_nomination_failed");
    } catch {
      return false;
    }
    return true;
  }

  // "i endorse Alice" — player endorses a candidate.
  const endorseMatch = said.match(/\bi endorse ([a-z0-9 _-]{2,20})\b/);
  if (endorseMatch) {
    try {
      const Gov = require("../lib/CitizenGovernment");
      const { normalizeName } = require("../lib/CitizenBonds");
      const { getDirector } = require("../director/CitizenDirector");
      const director = getDirector();
      const record = director?.roster?.get?.(normalizeName(citizenUsername));
      if (!record?.kingdomId) return false;
      const ok = Gov.endorseCandidate(record.kingdomId, endorseMatch[1].trim(), speakerUsername);
      if (ok) notifyCitizenSpoke(citizenUsername, speakerUsername, "gov_endorsed", { name: endorseMatch[1].trim() });
      else return false;
    } catch {
      return false;
    }
    return true;
  }

  // "what god do you worship" — player asks about the citizen's faith.
  if (/\b(what god do you worship|who do you worship|what is your faith|do you believe in|are you religious)\b/.test(said)) {
    try {
      const Faith = require("../lib/CitizenFaith");
      const s = Faith.faithSummary(citizenUsername);
      if (!s) return false;
      notifyCitizenSpoke(citizenUsername, speakerUsername, "faith_describe", s);
    } catch {
      return false;
    }
    return true;
  }

  // "pray with me" — player asks the citizen to pray together.
  if (/\b(pray with me|let us pray|say a prayer)\b/.test(said)) {
    try {
      const Faith = require("../lib/CitizenFaith");
      const s = Faith.faithSummary(citizenUsername);
      if (!s) return false;
      Faith.adjustDevotion(citizenUsername, 2);
      notifyCitizenSpoke(citizenUsername, speakerUsername, "faith_pray", s);
    } catch {
      return false;
    }
    return true;
  }

  // "is there a school" — player asks about the town schoolhouse.
  if (/\b(is there a school|where is the school|schoolhouse|where do children learn)\b/.test(said)) {
    try {
      const Schools = require("../lib/CitizenSchools");
      const { normalizeName } = require("../lib/CitizenBonds");
      const { getDirector } = require("../director/CitizenDirector");
      const director = getDirector();
      const record = director?.roster?.get?.(normalizeName(citizenUsername));
      if (!record?.kingdomId) return false;
      const school = Schools.schoolOfKingdom(record.kingdomId);
      if (!school) return false;
      const pupils = Schools.pupilsOfKingdom(record.kingdomId).length;
      notifyCitizenSpoke(citizenUsername, speakerUsername, "school_describe", {
        name: school.name,
        pupils,
        teacher: school.teacher ?? null,
      });
    } catch {
      return false;
    }
    return true;
  }

  // "did you go to school" — player asks about the citizen's own schooling.
  if (/\b(did you go to school|are you educated|were you schooled|can you read)\b/.test(said)) {
    try {
      const Schools = require("../lib/CitizenSchools");
      const bonus = Schools.xpBonusFor(citizenUsername);
      notifyCitizenSpoke(citizenUsername, speakerUsername, "school_educated", {
        educated: bonus > 0,
        bonus: Math.round(bonus * 100),
      });
    } catch {
      return false;
    }
    return true;
  }

  // "where is the temple" — player asks about the local temple.
  if (/\b(where is the temple|is there a temple|where do you pray|where is the chapel)\b/.test(said)) {
    try {
      const Faith = require("../lib/CitizenFaith");
      const { normalizeName } = require("../lib/CitizenBonds");
      const { getDirector } = require("../director/CitizenDirector");
      const director = getDirector();
      const record = director?.roster?.get?.(normalizeName(citizenUsername));
      const bonus = record?.kingdomId ? Faith.templeBonus(record.kingdomId) : 0;
      const s = Faith.faithSummary(citizenUsername) ?? {};
      notifyCitizenSpoke(citizenUsername, speakerUsername, "faith_temple", {
        ...s,
        templeTier: bonus,
      });
    } catch {
      return false;
    }
    return true;
  }

  // "are you sick" — player asks about the citizen's health.
  if (/\b(are you sick|are you ill|are you feeling well|are you healthy|how is your health)\b/.test(said)) {
    try {
      const Health = require("../lib/CitizenHealth");
      const s = Health.sicknessSummary(citizenUsername);
      notifyCitizenSpoke(citizenUsername, speakerUsername, "health_status", {
        sick: !!s,
        illness: s?.label ?? null,
        symptom: s?.symptom ?? null,
        inHospital: s?.inHospital ?? false,
      });
    } catch {
      return false;
    }
    return true;
  }

  // "where is the healer" — player asks about healers / the infirmary.
  if (/\b(where is the healer|is there a healer|where is the infirmary|is there a hospital|i need healing|i am sick)\b/.test(said)) {
    try {
      const Health = require("../lib/CitizenHealth");
      const { normalizeName } = require("../lib/CitizenBonds");
      const { getDirector } = require("../director/CitizenDirector");
      const director = getDirector();
      const record = director?.roster?.get?.(normalizeName(citizenUsername));
      const kingdomId = record?.kingdomId ?? null;
      const hospital = kingdomId ? Health.hospitalOfKingdom(kingdomId) : null;
      const sickCount = kingdomId ? Health.sickOfKingdom(kingdomId).length : 0;
      notifyCitizenSpoke(citizenUsername, speakerUsername, "health_healer", {
        hasInfirmary: !!hospital,
        infirmaryName: hospital?.name ?? null,
        bedsFree: hospital ? hospital.beds - hospital.patients.length : 0,
        sickCount,
      });
    } catch {
      return false;
    }
    return true;
  }

  // "what season is it" — player asks about the season / weather.
  if (/\b(what season is it|is it winter|is it summer|is it spring|is it autumn|is it fall|what's the weather|how's the weather|is it cold|is it raining|is it storming)\b/.test(said)) {
    try {
      const Seasons = require("../lib/CitizenSeasons");
      const nowMs = Date.now();
      const season = Seasons.seasonOf(nowMs);
      let weather = "clear";
      try {
        weather = String(require("../../skills/fishing/Conditions.Fishing").getWeather?.() ?? "clear").toLowerCase();
      } catch {
        weather = "clear";
      }
      notifyCitizenSpoke(citizenUsername, speakerUsername, "season_status", {
        season,
        description: Seasons.describe(nowMs),
        weather,
        warmClothes: Seasons.warmClothesNeeded(nowMs),
        festival: Seasons.seasonalFestival(season),
      });
    } catch {
      return false;
    }
    return true;
  }

  // "what time is it" — player asks about the time of day / night.
  if (/\b(what time is it|is it night|is it day|is it dark|is it dawn|is it dusk|what's the time|are the lamps lit)\b/.test(said)) {
    try {
      const DayNight = require("../lib/CitizenDayNight");
      const nowMs = Date.now();
      notifyCitizenSpoke(citizenUsername, speakerUsername, "time_status", {
        timeOfDay: DayNight.timeOfDay(nowMs),
        description: DayNight.describe(nowMs),
        isNight: DayNight.isNight(nowMs),
        lampsLit: DayNight.lampsLit(nowMs),
      });
    } catch {
      return false;
    }
    return true;
  }

  // "are you a criminal" — player asks about the citizen's record.
  if (/\b(are you a criminal|have you committed crimes|are you wanted|do you have a record|are you a thief)\b/.test(said)) {
    try {
      const Crime = require("../lib/CitizenCrime");
      const s = Crime.criminalSummary(citizenUsername);
      notifyCitizenSpoke(citizenUsername, speakerUsername, "crime_status", {
        offenses: s?.offenses ?? 0,
        convictions: s?.convictions ?? 0,
        notoriety: s?.notoriety ?? 0,
        jailed: s?.jailed ?? false,
        exiled: s?.exiled ?? false,
        lastCrime: s?.lastCrime ?? null,
      });
    } catch {
      return false;
    }
    return true;
  }

  // "am i famous" / "who is famous" — player asks about reputation and fame.
  if (/\b(am i famous|what is my reputation|whats my reputation|who is famous|who is the most famous|is anyone famous|am i well known|what is my fame)\b/.test(said)) {
    try {
      const Rep = require("../lib/CitizenReputation");
      const aboutSelf = /\b(am i|my)\b/.test(said);
      if (aboutSelf) {
        const s = Rep.reputationSummary(speakerUsername);
        notifyCitizenSpoke(citizenUsername, speakerUsername, "fame_status", {
          username: speakerUsername,
          score: s?.score ?? 0,
          tier: s?.tier ?? "unknown",
          tierLabel: s?.tierLabel ?? "unknown",
        });
      } else {
        const top = Rep.topFamous(3);
        notifyCitizenSpoke(citizenUsername, speakerUsername, "fame_leaders", {
          leaders: top.map((r) => ({ username: r.username, tier: r.tier, score: r.score })),
        });
      }
    } catch {
      return false;
    }
    return true;
  }

  // "are you famous" — player asks about THIS citizen's renown.
  if (/\b(are you famous|are you well known|what is your reputation|have you heard of yourself)\b/.test(said)) {
    try {
      const Rep = require("../lib/CitizenReputation");
      const s = Rep.reputationSummary(citizenUsername);
      notifyCitizenSpoke(citizenUsername, speakerUsername, "fame_status", {
        username: citizenUsername,
        score: s?.score ?? 0,
        tier: s?.tier ?? "unknown",
        tierLabel: s?.tierLabel ?? "unknown",
        recentDeeds: (s?.recentDeeds ?? []).slice(0, 3),
      });
    } catch {
      return false;
    }
    return true;
  }

  // "any marriages" / "marriage alliance" — player asks about dynastic diplomacy.
  if (/\b(any marriages|marriage alliance|royal marriage|dynastic marriage|are we allied by marriage)\b/.test(said)) {
    try {
      const Dip = require("../lib/CitizenDiplomacy");
      const { getDirector } = require("../director/CitizenDirector");
      const { normalizeName } = require("../lib/CitizenBonds");
      const director = getDirector();
      const record = director?.roster?.get?.(normalizeName(citizenUsername));
      const kingdomId = record?.kingdomId ?? null;
      const nowMs = Date.now();
      const summary = kingdomId ? Dip.summaryFor(kingdomId, nowMs) : { marriages: [], pending: [] };
      notifyCitizenSpoke(citizenUsername, speakerUsername, "diplomacy_marriages", {
        username: citizenUsername,
        kingdomId,
        marriages: summary.marriages,
        pending: summary.pending,
      });
    } catch {
      return false;
    }
    return true;
  }

  // "what news from <kingdom>" — player asks for spy intelligence.
  if (/\b(what news from|news from|how is|what's happening in|any word from)\b/.test(said)) {
    try {
      const Dip = require("../lib/CitizenDiplomacy");
      let target = null;
      for (const k of Dip.kingdoms()) {
        if (new RegExp(`\\b${k}\\b`, "i").test(said)) {
          target = k;
          break;
        }
      }
      if (!target) return false;
      const intel = Dip.describeIntel(target);
      notifyCitizenSpoke(citizenUsername, speakerUsername, "diplomacy_intel", {
        username: citizenUsername,
        kingdomId: target,
        report: intel, // null when no spy has reported — honest
      });
    } catch {
      return false;
    }
    return true;
  }

  // "who is the spymaster" — player asks about the covert layer.
  // (Stationed ambassadors belong to CitizenDiplomats' overt layer.)
  if (/\b(who is the spymaster|spies|our spies|the spies)\b/.test(said)) {
    try {
      notifyCitizenSpoke(citizenUsername, speakerUsername, "diplomacy_spies", {
        username: citizenUsername,
        answer: "We don't speak of such things in the open. But word travels.",
      });
    } catch {
      return false;
    }
    return true;
  }

  // "what was invented" / "is there an inventor" — player asks about inventions.
  if (/\b(what was invented|what inventions|any inventions|is there an inventor|who invented|the workshop|inventions)\b/.test(said)) {
    try {
      const Inv = require("../lib/CitizenInventions");
      const inventions = Inv.allInventions().slice(-5); // most recent 5
      notifyCitizenSpoke(citizenUsername, speakerUsername, "invention_status", {
        username: citizenUsername,
        count: Inv.allInventions().length,
        recent: inventions.map((inv) => ({ label: inv.label, inventor: inv.inventor })),
      });
    } catch {
      return false;
    }
    return true;
  }

  // "what's being built" / "is there a landmark" — player asks about construction.
  if (/\b(what'?s being built|any construction|under construction|is there a landmark|any landmarks|what districts|the building site|new buildings)\b/.test(said)) {    try {
      const Con = require("../lib/CitizenConstruction");
      // Aggregate across kingdoms — the citizen reports what they know.
      const allActive = [];
      const allLandmarks = [];
      // Active projects: scan via the data tier's project list.
      const st = Con.load();
      for (const p of Object.values(st.projects ?? {})) {
        if (p.status !== "complete") {
          allActive.push({ type: p.type, kingdomId: p.kingdomId, status: p.status });
        }
      }
      for (const b of Object.values(st.built ?? {})) {
        if (b.isLandmark) allLandmarks.push({ type: b.type, kingdomId: b.kingdomId });
      }
      notifyCitizenSpoke(citizenUsername, speakerUsername, "construction_status", {
        username: citizenUsername,
        active: allActive.slice(0, 5),
        landmarks: allLandmarks.slice(0, 5),
      });
    } catch {
      return false;
    }
    return true;
  }

  // "is there an observatory" / "what's in the sky" / "read my stars" — astronomy.
  if (/\b(observatory|any astronomers?|is there an astronomer|what'?s in the sky|tonight'?s sky|read my stars|my horoscope|celestial event|any eclipse|any comet|meteor shower|star chart)\b/.test(said)) {
    try {
      const Astro = require("../lib/CitizenAstronomy");
      let kingdomId = null;
      try {
        const { kingdomIdOf } = require("../brain/CitizenSites");
        kingdomId = kingdomIdOf(citizenUsername);
      } catch { /* no sites */ }
      const desc = kingdomId ? Astro.describe(kingdomId, Date.now()) : null;
      const reading = citizenUsername
        ? Astro.readOmen(citizenUsername, kingdomId, Date.now()) : null;
      notifyCitizenSpoke(citizenUsername, speakerUsername, "astronomy_status", {
        username: citizenUsername,
        observatory: desc ? { chartCount: desc.chartCount, chartBonus: desc.chartBonus } : null,
        activeEvent: desc?.activeEvent ?? null,
        eventLabel: desc?.eventLabel ?? null,
        omen: desc?.omen ?? null,
        yourOmen: reading?.omen ?? null,
        astronomerCount: desc?.astronomerCount ?? 0,
      });
    } catch {
      return false;
    }
    return true;
  }

  // "telescope" / "sky tour" / "viewing party" / "buy a chart" — public observatory visits.
  // (The astronomy block above owns "observatory"/"star chart"/omens; this owns the visitor layer.)
  if (/\b(telescope|sky tour|stargazing tour|guided tour|viewing party|buy a chart|star chart copy|visit the observatory|look through the telescope)\b/.test(said)) {
    try {
      const Obs = require("../lib/CitizenObservatories");
      let kingdomId = null;
      try {
        const { kingdomIdOf } = require("../brain/CitizenSites");
        kingdomId = kingdomIdOf(citizenUsername);
      } catch { /* no sites */ }
      const desc = kingdomId ? Obs.describe(kingdomId, Date.now()) : null;
      notifyCitizenSpoke(citizenUsername, speakerUsername, "observatory_visit", {
        username: citizenUsername,
        open: desc?.open ?? false,
        entryFee: desc?.entryFee ?? 0,
        sky: desc?.sky ?? null,
        eventActive: desc?.eventActive ?? null,
        upcomingTours: desc?.upcomingTours ?? 0,
        partyLive: desc?.partyLive ?? false,
      });
    } catch {
      return false;
    }
    return true;
  }

  // "map guild" / "certify my map" / "guild hall" — cartographers' guild.
  if (/\b(map guild|cartographers'? guild|guild hall|certify|certification|guild seal|surveyor|guildmaster)\b/.test(said)) {
    try {
      const Guilds = require("../lib/CitizenMapGuilds");
      let kingdomId = null;
      try {
        const { kingdomIdOf } = require("../brain/CitizenSites");
        kingdomId = kingdomIdOf(citizenUsername);
      } catch { /* no sites */ }
      const desc = kingdomId ? Guilds.describe(kingdomId) : { exists: false };
      notifyCitizenSpoke(citizenUsername, speakerUsername, "guild_status", {
        username: citizenUsername,
        exists: desc.exists ?? false,
        memberCount: desc.memberCount ?? 0,
        masters: desc.masters ?? 0,
        certified: desc.certified ?? 0,
        bounties: desc.bounties ?? 0,
        prestige: desc.prestige ?? 0,
        isMember: citizenUsername ? Guilds.isGuildMember(citizenUsername) : false,
        rank: citizenUsername ? Guilds.guildRankOf(citizenUsername) : null,
      });
    } catch {
      return false;
    }
    return true;
  }

  // "is there a map shop" / "do you have a map" / "treasure map" — cartography.
  if (/\b(map shop|any maps?|buy a map|world map|city map|dungeon map|treasure map|any treasure|cartographer|mapmaker)\b/.test(said)) {
    try {
      const Maps = require("../lib/CitizenMaps");
      let kingdomId = null;
      try {
        const { kingdomIdOf } = require("../brain/CitizenSites");
        kingdomId = kingdomIdOf(citizenUsername);
      } catch { /* no sites */ }
      const desc = kingdomId ? Maps.describe(kingdomId) : null;
      const listings = kingdomId ? Maps.listingsFor(kingdomId).slice(0, 5).map((l) => ({
        type: l.map?.type, price: l.price, quality: l.map?.quality, creator: l.map?.creator,
      })) : [];
      notifyCitizenSpoke(citizenUsername, speakerUsername, "maps_status", {
        username: citizenUsername,
        mapCount: desc?.mapCount ?? 0,
        listingCount: desc?.listingCount ?? 0,
        cheapest: desc?.cheapest ?? null,
        treasureRumors: desc?.treasureRumors ?? 0,
        cartographerCount: desc?.cartographerCount ?? 0,
        listings,
        isCartographer: citizenUsername ? Maps.isCartographer(citizenUsername) : false,
      });
    } catch {
      return false;
    }
    return true;
  }

  // "any bridges" / "is there an engineer" — player asks about infrastructure.
  if (/\b(any bridges|new bridge|is there an engineer|any engineers|public works|new road|any roads|watchtower|border fort|the reservoir|infrastructure)\b/.test(said)) {
    try {
      const Infra = require("../lib/CitizenInfrastructure");
      const st = Infra.load();
      const active = Object.values(st.projects ?? {}).map((p) => ({
        type: p.type, kingdomId: p.kingdomId, from: p.from, to: p.to,
      }));
      const built = Object.values(st.built ?? {}).slice(-5).map((b) => ({
        type: b.type, kingdomId: b.kingdomId, from: b.from, to: b.to,
      }));
      const rec = citizenUsername ? Infra.engineerFor(citizenUsername) : null;
      notifyCitizenSpoke(citizenUsername, speakerUsername, "infrastructure_status", {
        username: citizenUsername,
        isEngineer: !!rec,
        active: active.slice(0, 5),
        built: built,
      });
    } catch {
      return false;
    }
    return true;
  }

  // "is there a philosopher" / "what is your philosophy" — player asks about philosophy.
  if (/\b(is there a philosopher|any philosophers|what is your philosophy|what do you believe|philosophy|the academy|schools of thought|are you a philosopher)\b/.test(said)) {
    try {
      const Phil = require("../lib/CitizenPhilosophy");
      const isPhil = Phil.isPhilosopher(citizenUsername);
      const phil = Phil.philosopherFor(citizenUsername);
      const school = phil ? Phil.schoolFor(phil.school) : null;
      const sages = Phil.topSages(3);
      notifyCitizenSpoke(citizenUsername, speakerUsername, "philosophy_status", {
        username: citizenUsername,
        isPhilosopher: isPhil,
        school: school ? school.name : null,
        wisdom: phil ? phil.wisdom : 0,
        topSages: sages.map((s) => ({ username: s.username, wisdom: s.wisdom })),
      });
    } catch {
      return false;
    }
    return true;
  }

  // "what are the laws" / "i need a lawyer" — player asks about law and order.
  if (/\b(what are the laws|the law|is there a lawyer|i need a lawyer|any lawyers|who is the judge|is there a judge|the court|courthouse)\b/.test(said)) {
    try {
      const LegalCode = require("../lib/CitizenLegalCode");
      const Gov = require("../lib/CitizenGovernment");
      const now = Date.now();
      // Find the citizen's kingdom for the judge lookup.
      let kingdomId = null;
      try {
        const { kingdomIdOf } = require("../brain/CitizenSites");
        kingdomId = kingdomIdOf({ getUsername: () => citizenUsername, username: citizenUsername });
      } catch {
        // best-effort
      }
      const judge = kingdomId ? LegalCode.judgeFor(kingdomId, now) : null;
      const justiceLaws = ["harsh-justice", "restorative-justice", "trial-by-jury"].filter(
        (id) => {
          try {
            return Gov.hasLaw(kingdomId, id, now);
          } catch {
            return false;
          }
        }
      );
      notifyCitizenSpoke(citizenUsername, speakerUsername, "legal_status", {
        username: citizenUsername,
        judge: judge ? judge.username : null,
        justiceLaws,
        lawyerFee: LegalCode.LAWYER_FEE,
      });
    } catch {
      return false;
    }
    return true;
  }

  // "is there a surgeon" / "i need surgery" — player asks about advanced medicine.
  if (/\b(is there a surgeon|any surgeons|i need surgery|need an operation|the hospital|is there a hospital|surgery wing)\b/.test(said)) {
    try {
      const Surgery = require("../lib/CitizenSurgery");
      let kingdomId = null;
      try {
        const { kingdomIdOf } = require("../brain/CitizenSites");
        kingdomId = kingdomIdOf({ getUsername: () => citizenUsername, username: citizenUsername });
      } catch {
        // best-effort
      }
      const wing = kingdomId ? Surgery.wingOf(kingdomId) : null;
      const need = Surgery.needsSurgery(speakerUsername);
      notifyCitizenSpoke(citizenUsername, speakerUsername, "surgery_status", {
        username: citizenUsername,
        hasWing: !!wing,
        needsSurgery: !!need,
        procedure: need?.procedure ?? null,
      });
    } catch {
      return false;
    }
    return true;
  }

  // "is there a guild" / "what guild am i in" — player asks about trade guilds.
  if (/\b(is there a guild|what guilds are there|are there guilds|tell me about guilds|what guild am i in|am i in a guild|what is my guild)\b/.test(said)) {
    try {
      const G = require("../lib/CitizenGuilds");
      const aboutSelf = /\b(am i|my)\b/.test(said);
      if (aboutSelf) {
        const m = G.membershipFor(speakerUsername);
        notifyCitizenSpoke(citizenUsername, speakerUsername, "guild_status", {
          username: speakerUsername,
          member: !!m,
          guildId: m?.guildId ?? null,
          guildName: m ? G.guildFor(m.guildId)?.name : null,
          rank: m?.rank ?? null,
          rankLabel: m ? G.rankLabel(m.rank) : null,
          favor: m?.favor ?? 0,
        });
      } else {
        const list = Object.values(G.guilds()).map((g) => ({ id: g.id, name: g.name }));
        notifyCitizenSpoke(citizenUsername, speakerUsername, "guild_list", { guilds: list });
      }
    } catch {
      return false;
    }
    return true;
  }

  // "are you in a guild" — player asks about THIS citizen's guild.
  if (/\b(are you in a guild|what guild are you in|do you belong to a guild)\b/.test(said)) {
    try {
      const G = require("../lib/CitizenGuilds");
      const m = G.membershipFor(citizenUsername);
      notifyCitizenSpoke(citizenUsername, speakerUsername, "guild_status", {
        username: citizenUsername,
        member: !!m,
        guildId: m?.guildId ?? null,
        guildName: m ? G.guildFor(m.guildId)?.name : null,
        rank: m?.rank ?? null,
        rankLabel: m ? G.rankLabel(m.rank) : null,
        favor: m?.favor ?? 0,
      });
    } catch {
      return false;
    }
    return true;
  }

  // "trade charter" / "monopoly" / "who holds the charter" — player asks
  // about guild trade monopolies.
  if (/\b(trade charter|charters|monopoly|monopolies|who holds the charter|chartered goods)\b/.test(said)) {
    try {
      const C = require("../lib/CitizenTradeCharters");
      const active = C.activeCharters();
      notifyCitizenSpoke(citizenUsername, speakerUsername, "charter_status", {
        count: active.length,
        charters: active.slice(0, 5).map((c) => ({
          kingdomId: c.kingdomId,
          category: c.category,
          categoryLabel: C.categoryFor(c.category)?.label ?? c.category,
          guildId: c.guildId,
          daysLeft: Math.max(0, Math.ceil((c.expiresAt - Date.now()) / 86400000)),
        })),
      });
    } catch {
      return false;
    }
    return true;
  }

  // "dig site" / "excavation" / "artifact" / "archaeologist" — player asks
  // about archaeology. (The art gallery block below owns bare "museum".)
  if (/\b(dig site|dig sites|excavation|excavations|artifact|artifacts|archaeologist|archaeologists|archaeology)\b/.test(said)) {
    try {
      const Arch = require("../lib/CitizenArchaeology");
      const kingdomId = ctx?.kingdomId ?? "unknown";
      const sites = Arch.activeSites(kingdomId);
      const museum = Arch.museumStatus(kingdomId);
      notifyCitizenSpoke(citizenUsername, speakerUsername, "archaeology_status", {
        openSites: sites.length,
        sites: sites.slice(0, 3).map((s) => ({ name: s.name, richness: s.richness })),
        museumPrestige: museum.prestige,
        displayed: museum.displayed,
      });
    } catch {
      return false;
    }
    return true;
  }

  // "is there a gallery" / "where is the gallery" — player asks about art.
  if (/\b(is there a gallery|where is the gallery|art gallery|museum)\b/.test(said)) {
    try {
      const Art = require("../lib/CitizenArt");
      const kingdomId = ctx?.kingdomId ?? "unknown";
      const gallery = Art.galleryFor(kingdomId);
      const displayed = (gallery.displayed ?? []).length;
      notifyCitizenSpoke(citizenUsername, speakerUsername, "art_gallery", {
        username: citizenUsername,
        galleryName: gallery.name,
        displayed,
        kingdomId,
      });
    } catch {
      return false;
    }
    return true;
  }

  // "do you make art" / "are you an artist" — player asks about the citizen's art.
  if (/\b(do you make art|are you an artist|what art do you make|show me your art)\b/.test(said)) {
    try {
      const Art = require("../lib/CitizenArt");
      const works = Art.artworksOf(citizenUsername);
      notifyCitizenSpoke(citizenUsername, speakerUsername, "art_status", {
        username: citizenUsername,
        count: works.length,
        works: works.slice(0, 5).map((a) => ({
          title: a.title,
          medium: a.mediumLabel,
          quality: a.quality,
          forSale: a.forSale,
          price: a.price,
        })),
      });
    } catch {
      return false;
    }
    return true;
  }

  // "do you have a pet" / "what pets do you have" — player asks about pets.
  if (/\b(do you have a pet|what pets do you have|do you own a pet|tell me about your pet|what is your pet|do you have any pets)\b/.test(said)) {
    try {
      const Pets = require("../lib/CitizenPets");
      const pets = Pets.petsOf(citizenUsername);
      notifyCitizenSpoke(citizenUsername, speakerUsername, "pet_status", {
        username: citizenUsername,
        hasPets: pets.length > 0,
        count: pets.length,
        pets: pets.map((p) => ({
          type: p.type,
          name: p.name,
          happiness: Math.round(p.happiness),
          hunger: Math.round(p.hunger),
        })),
        hasMount: pets.some((p) => Pets.PET_CATALOG[p.type]?.mount),
      });
    } catch {
      return false;
    }
    return true;
  }

  // "where is the prison" — player asks about the gaol.
  if (/\b(where is the prison|is there a jail|where is the gaol|who is in jail|is there a prison)\b/.test(said)) {
    try {
      const Crime = require("../lib/CitizenCrime");
      const { normalizeName } = require("../lib/CitizenBonds");
      const { getDirector } = require("../director/CitizenDirector");
      const director = getDirector();
      const record = director?.roster?.get?.(normalizeName(citizenUsername));
      const kingdomId = record?.kingdomId ?? null;
      const prison = kingdomId ? Crime.prisonOfKingdom(kingdomId) : null;
      const inmates = kingdomId ? Crime.inmatesOfKingdom(kingdomId).length : 0;
      notifyCitizenSpoke(citizenUsername, speakerUsername, "crime_prison", {
        hasPrison: !!prison,
        prisonName: prison?.name ?? null,
        cellsFree: prison ? prison.cells - prison.inmates.length : 0,
        inmates,
      });
    } catch {
      return false;
    }
    return true;
  }

  // "is there a tavern" — player asks about drinking and fun.
  if (/\b(is there a tavern|where is the tavern|where can i drink|is there a bar|where is the bar)\b/.test(said)) {
    try {
      const Entertain = require("../lib/CitizenEntertainment");
      const { normalizeName } = require("../lib/CitizenBonds");
      const { getDirector } = require("../director/CitizenDirector");
      const director = getDirector();
      const record = director?.roster?.get?.(normalizeName(citizenUsername));
      const kingdomId = record?.kingdomId ?? null;
      const tavern = kingdomId ? Entertain.tavernOfKingdom(kingdomId) : null;
      notifyCitizenSpoke(citizenUsername, speakerUsername, "entertain_tavern", {
        hasTavern: !!tavern,
        tavernName: tavern?.name ?? null,
        drinkPrice: Entertain.DRINK_PRICE,
      });
    } catch {
      return false;
    }
    return true;
  }

  // "play dice" — player wants to gamble.
  if (/\b(play dice|roll dice|gamble|bet on dice|dice game)\b/.test(said)) {
    try {
      const Entertain = require("../lib/CitizenEntertainment");
      notifyCitizenSpoke(citizenUsername, speakerUsername, "entertain_dice", {
        minBet: Entertain.DICE_MIN_BET,
        maxBet: Entertain.DICE_MAX_BET,
        winChance: Entertain.DICE_WIN_CHANCE,
      });
    } catch {
      return false;
    }
    return true;
  }

  // "is there a theater" — player asks about plays.
  if (/\b(is there a theater|where is the theater|any plays|what is playing|theatre)\b/.test(said)) {
    try {
      const Entertain = require("../lib/CitizenEntertainment");
      const theater = Entertain.theater();
      const shows = Entertain.recentShows(1);
      notifyCitizenSpoke(citizenUsername, speakerUsername, "entertain_theater", {
        theaterName: theater?.name ?? null,
        ticketPrice: Entertain.THEATER_PRICE,
        nowPlaying: shows[0]?.title ?? null,
      });
    } catch {
      return false;
    }
    return true;
  }

  // "is there a concert" — player asks about concerts, dance halls, lessons.
  if (/\b(is there a concert|any concerts|when is the concert|dance hall|is there dancing|music lesson|learn music|learn to dance|who is in the orchestra)\b/.test(said)) {
    try {
      const MD = require("../lib/CitizenMusicDance");
      const { normalizeName } = require("../lib/CitizenBonds");
      const { getDirector } = require("../director/CitizenDirector");
      const director = getDirector();
      const record = director?.roster?.get?.(normalizeName(citizenUsername));
      const kingdomId = record?.kingdomId ?? null;
      const hall = kingdomId ? MD.danceHallOfKingdom(kingdomId) : null;
      const concert = kingdomId ? MD.concertFor(kingdomId) : null;
      const ensembles = MD.ensembles();
      notifyCitizenSpoke(citizenUsername, speakerUsername, "musicdance_status", {
        hasHall: !!hall,
        hallName: hall?.name ?? null,
        concertScheduled: !!concert,
        ensembleName: concert?.ensembleName ?? null,
        ticketPrice: concert ? concert.ticketPrice : MD.TICKET_PRICE,
        lessonPrice: MD.LESSON_PRICE,
        ensembleCount: ensembles.length,
      });
    } catch {
      return false;
    }
    return true;
  }

  // "designer" / "runway" / "fashion week" / "collection" — player asks about
  // runway fashion-show production. (The fashion block owns trends, clothing
  // shops, and style competitions; this owns designers, houses, collections,
  // runway shows, and ateliers.)
  if (/\b(fashion designer|runway show|fashion week|new collection|atelier|who designed|catwalk)\b/.test(said)) {
    try {
      const Runways = require("../lib/CitizenRunways");
      const { normalizeName } = require("../lib/CitizenBonds");
      const { getDirector } = require("../director/CitizenDirector");
      const director = getDirector();
      const record = director?.roster?.get?.(normalizeName(citizenUsername));
      const kingdomId = record?.kingdomId ?? "unknown";
      notifyCitizenSpoke(citizenUsername, speakerUsername, "runway_status", {
        houses: Runways.housesIn(kingdomId).slice(0, 3).map((h) => ({ name: h.name, members: h.members.length })),
        collections: Runways.collectionsIn(kingdomId).slice(0, 3).map((c) => ({ name: c.name, theme: c.theme })),
        upcoming: Runways.upcomingShows(kingdomId).slice(0, 3).map((s) => ({ collection: s.collectionName, house: s.houseName, price: s.ticketPrice })),
        ateliers: Runways.ateliersIn(kingdomId).slice(0, 3).map((a) => a.owner),
      });
    } catch {
      return false;
    }
    return true;
  }
  // "music festival" / "promoter" / "festival ground" — player asks about
  // music-festival production. (CitizenMusicDance owns ensembles/concerts/
  // lessons; CitizenBards owns minstrels; CitizenFestivals owns the seasonal
  // calendar; this owns promoter-run music festival productions.)
  if (/\b(music festival|festival promoter|festival ground|who is playing|lineup|headliner|festival tickets)\b/.test(said)) {
    try {
      const MF = require("../lib/CitizenMusicFestivals");
      const { normalizeName } = require("../lib/CitizenBonds");
      const { getDirector } = require("../director/CitizenDirector");
      const director = getDirector();
      const record = director?.roster?.get?.(normalizeName(citizenUsername));
      const kingdomId = record?.kingdomId ?? "unknown";
      const upcoming = MF.upcomingFestivals(kingdomId).slice(0, 3).map((f) => ({
        name: f.name,
        days: f.days,
        acts: Object.values(f.lineup || {}).flat().length,
      }));
      const ground = MF.groundFor(kingdomId);
      notifyCitizenSpoke(citizenUsername, speakerUsername, "festival_status", {
        upcoming,
        ground: ground ? { capacity: ground.capacity, condition: ground.condition } : null,
      });
    } catch {
      return false;
    }
    return true;
  }

  // "auction" / "curator" / "art commission" / "traveling exhibition" — player
  // asks about gallery operations. (CitizenArt owns artwork creation, display
  // galleries, the fixed-price market, and exhibitions; this owns auctions,
  // curators, commissions, appraisals, and traveling exhibitions.)
  if (/\b(art auction|auction house|curator|art commission|commission art|appraise my art|traveling exhibition|gallery prestige)\b/.test(said)) {
    try {
      const G = require("../lib/CitizenGalleries");
      const { normalizeName } = require("../lib/CitizenBonds");
      const { getDirector } = require("../director/CitizenDirector");
      const director = getDirector();
      const record = director?.roster?.get?.(normalizeName(citizenUsername));
      const kingdomId = record?.kingdomId ?? ctx?.kingdomId ?? "unknown";
      notifyCitizenSpoke(citizenUsername, speakerUsername, "gallery_ops", {
        username: citizenUsername,
        prestige: G.prestigeFor(kingdomId),
        openAuctions: G.openAuctions(kingdomId).slice(0, 3).map((a) => ({
          title: a.title,
          highBid: a.bids.length ? a.bids[a.bids.length - 1].amount : a.reserve,
        })),
        openCommissions: G.openCommissions(kingdomId).slice(0, 3).map((c) => ({
          medium: c.medium,
          theme: c.theme,
          escrow: c.escrow,
        })),
        stats: G.stats(kingdomId),
      });
    } catch {
      return false;
    }
    return true;
  }

  // "library" / "librarian" / "borrow book" / "research room" — player asks
  // about library operations. (CitizenLibrarians owns hash-derived librarian
  // flavor; CitizenScholars owns the researcher profession; this owns the
  // library operations layer: books, lending, research rooms, archives.)
  if (/\b(library|librarian|borrow (a )?book|return (a )?book|research room|kingdom archives|write (a )?book)\b/.test(said)) {
    try {
      const Lib = require("../lib/CitizenLibraries");
      const { normalizeName } = require("../lib/CitizenBonds");
      const { getDirector } = require("../director/CitizenDirector");
      const director = getDirector();
      const record = director?.roster?.get?.(normalizeName(citizenUsername));
      const kingdomId = record?.kingdomId ?? ctx?.kingdomId ?? "unknown";
      notifyCitizenSpoke(citizenUsername, speakerUsername, "library_ops", {
        username: citizenUsername,
        knowledge: Lib.knowledgeFor(kingdomId),
        availableBooks: Lib.availableBooks(kingdomId).slice(0, 3).map((b) => ({
          title: b.title,
          subject: b.subject,
          quality: b.quality,
        })),
        archives: Lib.archivesIn(kingdomId).slice(-3).map((a) => ({
          subject: a.subject,
          event: a.event,
        })),
      });
    } catch {
      return false;
    }
    return true;
  }

  // "what's in fashion" — player asks about trends, shops, competitions.
  if (/\b(what.s in fashion|fashion trend|what.s trendy|is there a tailor|clothing shop|buy clothes|style competition|best dressed|what.s the style)\b/.test(said)) {
    try {
      const Fashion = require("../lib/CitizenFashion");
      const { normalizeName } = require("../lib/CitizenBonds");
      const { getDirector } = require("../director/CitizenDirector");
      const director = getDirector();
      const record = director?.roster?.get?.(normalizeName(citizenUsername));
      const kingdomId = record?.kingdomId ?? null;
      const trend = Fashion.currentTrend();
      const shop = kingdomId ? Fashion.shopFor(kingdomId) : null;
      notifyCitizenSpoke(citizenUsername, speakerUsername, "fashion_status", {
        trendColor: trend.color,
        trendStyle: trend.style,
        trendFormality: trend.formality,
        shopInventory: shop ? shop.inventory.length : 0,
        garmentTypes: Fashion.GARMENT_TYPES,
      });
    } catch {
      return false;
    }
    return true;
  }

  // "is there a restaurant" — player asks about restaurants, menus, chefs.
  if (/\b(is there a restaurant|any restaurants|what.s on the menu|what.s for dinner|who is the chef|master chef|culinary competition|best dish|i.m hungry|order food)\b/.test(said)) {
    try {
      const Cuisine = require("../lib/CitizenCuisine");
      const { normalizeName } = require("../lib/CitizenBonds");
      const { getDirector } = require("../director/CitizenDirector");
      const director = getDirector();
      const record = director?.roster?.get?.(normalizeName(citizenUsername));
      const kingdomId = record?.kingdomId ?? "varrock";
      const rest = Cuisine.restaurantFor(kingdomId);
      const menu = Cuisine.menuFor(kingdomId);
      const comp = Cuisine.openCompetition(kingdomId);
      const chefs = Cuisine.masterChefs();
      notifyCitizenSpoke(citizenUsername, speakerUsername, "cuisine_status", {
        restaurantName: rest?.name ?? null,
        menuCount: menu.length,
        menu: menu.slice(0, 5).map((d) => ({ name: d.name, price: d.value, heal: d.heal, chef: d.chef })),
        competitionOpen: !!comp,
        masterChefCount: chefs.length,
        dishTypes: Cuisine.DISH_TYPES,
      });
    } catch {
      return false;
    }
    return true;
  }

  // "is there a festival" — player asks about custom festivals, parades, fireworks.
  if (/\b(is there a festival|any festivals|when is the parade|is there a parade|fireworks tonight|any fireworks|what.s celebrating|custom festival|who plans festivals|carnival games)\b/.test(said)) {
    try {
      const C = require("../lib/CitizenCelebrations");
      const { normalizeName } = require("../lib/CitizenBonds");
      const { getDirector } = require("../director/CitizenDirector");
      const director = getDirector();
      const record = director?.roster?.get?.(normalizeName(citizenUsername));
      const kingdomId = record?.kingdomId ?? "varrock";
      const now = Date.now();
      const active = C.activeCustom(kingdomId, now);
      const upcoming = C.upcomingCustoms(kingdomId, now);
      const planner = C.plannerFor(kingdomId);
      const parades = C.activeParades(kingdomId, now);
      const fireworks = C.tonightFireworks(kingdomId, now);
      notifyCitizenSpoke(citizenUsername, speakerUsername, "celebration_status", {
        activeFestival: active?.name ?? null,
        activeTheme: active?.theme ?? null,
        upcomingCount: upcoming.length,
        upcoming: upcoming.slice(0, 3).map((f) => ({ name: f.name, theme: f.theme })),
        planner: planner?.username ?? null,
        paradeActive: parades.length > 0,
        fireworksTonight: fireworks.length > 0,
        boothTypes: C.BOOTH_TYPES,
      });
    } catch {
      return false;
    }
    return true;
  }

  // "is there a league" — player asks about team sports leagues.
  if (/\b(is there a league|any leagues|what teams|join a team|i want to join|league standings|who won the league|when is the final|championship final|fan club|become a fan|buy merch|team scarf)\b/.test(said)) {
    try {
      const L = require("../lib/CitizenLeagues");
      const { normalizeName } = require("../lib/CitizenBonds");
      const { getDirector } = require("../director/CitizenDirector");
      const director = getDirector();
      const record = director?.roster?.get?.(normalizeName(citizenUsername));
      const kingdomId = record?.kingdomId ?? null;
      const username = speakerUsername ?? "";
      // Default to the first sport for the summary.
      const sportId = "football";
      const summary = kingdomId ? L.leagueSummary(kingdomId, sportId) : null;
      const myTeam = username && kingdomId ? L.teamOf(username, kingdomId, sportId) : null;
      const fanOf = username ? L.fanTeamOf(username) : null;
      notifyCitizenSpoke(citizenUsername, speakerUsername, "league_status", {
        hasLeague: !!summary,
        sport: summary?.sport ?? null,
        table: summary?.table ?? [],
        champion: summary?.champion ?? null,
        organizer: summary?.organizer ?? null,
        myTeam: myTeam ? L.describeTeam(myTeam)?.name ?? null : null,
        fanOf: fanOf ? fanOf.name : null,
        sports: Object.keys(L.TEAM_SPORTS),
      });
    } catch {
      return false;
    }
    return true;
  }

  // "what was discovered" / "is there a scientist" — player asks about science.
  if (/\b(what was discovered|any discoveries|is there a scientist|any scientists|what are you researching|the laboratory|is there a lab)\b/.test(said)) {
    try {
      const S = require("../lib/CitizenScience");
      const { normalizeName } = require("../lib/CitizenBonds");
      const { getDirector } = require("../director/CitizenDirector");
      const director = getDirector();
      const record = director?.roster?.get?.(normalizeName(citizenUsername));
      const kingdomId = record?.kingdomId ?? null;
      const st = S.load();
      const discoveries = Object.values(st.discoveries ?? {})
        .filter((d) => !kingdomId || String(d.kingdomId) === String(kingdomId))
        .slice(-5)
        .map((d) => ({ name: d.name, field: d.field, verified: d.verified }));
      const pubs = S.recentPublications(3).map((p) => ({ title: p.title, scientist: p.scientist }));
      const rec = citizenUsername ? S.scientistFor(citizenUsername) : null;
      notifyCitizenSpoke(citizenUsername, speakerUsername, "science_status", {
        discoveries,
        publications: pubs,
        myField: rec?.field ?? null,
        labLevel: kingdomId ? S.labFor(kingdomId).level : null,
      });
    } catch {
      return false;
    }
    return true;
  }

  // "where can I travel" / "take me to X" — player asks about ships/caravans.
  if (/\b(where can i travel|how do i travel|is there a ship|is there a caravan|take me to|i want to travel|can you take me)\b/.test(said)) {
    try {
      const Travel = require("../lib/CitizenTravel");
      const { normalizeName } = require("../lib/CitizenBonds");
      const { getDirector } = require("../director/CitizenDirector");
      const { kingdomIdOf } = require("../brain/CitizenSites");
      const director = getDirector();
      const record = director?.roster?.get?.(normalizeName(citizenUsername));
      const kingdomId = record?.kingdomId ?? kingdomIdOf(player) ?? null;
      const routes = kingdomId
        ? Travel.routesFrom(kingdomId).filter((r) => Travel.routeOpen(r.from, r.to))
        : [];
      const destinations = routes.map((r) => ({
        name: Travel.kingdomName(r.to),
        fare: r.fare,
        mode: r.mode,
      }));
      notifyCitizenSpoke(citizenUsername, speakerUsername, "travel_routes", {
        destinations,
        closedCount: kingdomId ? Travel.routesFrom(kingdomId).length - routes.length : 0,
      });
    } catch {
      return false;
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
function notifyCitizenSpoke(citizenUsername, speakerUsername, kind, extra) {
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
      favor_accept: `${display}: Deal — bring what I asked and I'll make it worth your while.`,
      favor_decline: `${display}: Ah, that's a shame. Never mind then.`,
      favor_done: `${display}: Much appreciated, truly.`,
      companion_accept: `${display}: Wonderful! Let's go — right now, while the mood's right.`,
      companion_decline: `${display}: Ah, that's a shame. Maybe another time.`,
      companion_invite: `${display}: Wonderful! Let's go — right now, while the mood's right.`,
      gov_mayor: extra
        ? `${display}: ${extra.mayor} is our mayor${extra.councilors.length ? `, with ${extra.councilors.join(", ")} on the council` : ""}${extra.laws.length ? `. Current laws: ${extra.laws.join(", ")}` : ""}.`
        : `${display} nods.`,
      gov_election: `${display}: The next election is in ${extra?.days ?? "?"} days. Make your voice heard!`,
      gov_nominated: `${display}: Done — your name's on the ballot. Good luck!`,
      gov_nomination_failed: `${display}: Hmm, that didn't go through. Maybe you're already running.`,
      gov_endorsed: `${display}: Noted — I'll remember you spoke well of ${extra?.name ?? "them"}.`,
      faith_describe: extra
        ? `${display}: I follow ${extra.godName}${extra.epithet ? ` ${extra.epithet}` : ""}${extra.priest ? " — I serve as a priest" : ""}.`
        : `${display} shrugs.`,
      faith_pray: extra
        ? `${display}: ${extra.godName === "The Silent One" ? "..." : "Aye, let's pray together."}`
        : `${display} nods.`,
      faith_temple: extra?.templeTier > 0
        ? `${display}: We have a fine chapel here — tier ${extra.templeTier}. Come pray with us sometime.`
        : `${display}: No grand temple here, but any quiet corner will do for prayer.`,
      festival_next: extra
        ? `${display}: ${extra.days === 0 ? `${extra.name} is happening right now` : `${extra.name} starts in ${extra.days} day${extra.days === 1 ? "" : "s"}`} — ${extra.blurb}${extra.more > 0 ? `, and ${extra.more} more after that` : ""}.`
        : `${display} shrugs.`,
      school_describe: extra
        ? `${display}: The ${extra.name} — ${extra.pupils} young ones learning their letters${extra.teacher ? ` under ${extra.teacher}` : ""}.`
        : `${display} shrugs.`,
      school_educated: extra?.educated
        ? `${display}: Aye, I went to school as a child. It serves me well — I pick things up ${extra.bonus}% faster.`
        : `${display}: No schooling for me, I'm afraid. I learned what I know the hard way.`,
      philosophy_status: extra?.isPhilosopher
        ? `${display}: I walk the path of the ${extra.school} — my wisdom stands at ${extra.wisdom}.${extra.topSages?.length ? ` The wisest among us: ${extra.topSages.map((s) => s.username).join(", ")}.` : ""}`
        : `${display}: Philosophy? The academy welcomes all curious minds. Come contemplate with us.`,
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
      { const _cvp = bot?.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(bot, voiceLine(voiceFor(_cvp), { plain: [msg.split(": ").slice(1).join(": ") || msg] })); }
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
  unregisterCitizenForChat,
  onCitizenChatHeard,
  onSocialPacket,
  chatHeardEventName,
};
