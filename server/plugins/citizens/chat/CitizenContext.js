"use strict";

/**
 * CitizenContext — the "right now" snapshot that grounds every LLM reply.
 *
 * A real player's words are shaped by their moment: are they tired, hungry,
 * in a good mood, busy at work, chasing a goal? This module reads the
 * citizen's live state (needs, goal, current activity, standing with the
 * speaker) and renders it as a short prompt section so the LLM mouth speaks
 * from inside the citizen's life, not from a generic personality card.
 *
 * Token-lean by design: the whole section is ~120 chars.
 */

const {
  ATTR_CITIZEN_NEEDS,
  ATTR_CITIZEN_GOAL,
  ACTIVITY_GUARD_PATROL,
  ACTIVITY_MERCHANT_TEND,
  ACTIVITY_CITIZEN_ROUTINE,
  ACTIVITY_COURTIER_ATTEND,
  ACTIVITY_TAVERN_SOCIAL,
  ACTIVITY_LEISURE_STROLL,
  ACTIVITY_PRIME_MERCHANT,
  ACTIVITY_REFUGEE_FLIGHT,
} = require("../constants");
const { getMemory } = require("../lib/CitizenMemory");
const { getJournal } = require("../lib/CitizenJournal");
const { emotionLine } = require("../lib/emotions");

const ACTIVITY_WORDS = Object.freeze({
  [ACTIVITY_GUARD_PATROL]: "on guard patrol",
  [ACTIVITY_MERCHANT_TEND]: "tending your market stall",
  [ACTIVITY_PRIME_MERCHANT]: "running your sword stall",
  [ACTIVITY_CITIZEN_ROUTINE]: "going about your day's work",
  [ACTIVITY_COURTIER_ATTEND]: "attending court",
  [ACTIVITY_TAVERN_SOCIAL]: "having a drink at the tavern",
  [ACTIVITY_LEISURE_STROLL]: "out for a stroll",
  [ACTIVITY_REFUGEE_FLIGHT]: "fleeing the war",
});

function moodWord(mood) {
  if (mood == null) return null;
  if (mood < 20) return "miserable";
  if (mood < 40) return "grumpy";
  if (mood < 60) return "okay";
  if (mood < 80) return "cheerful";
  return "elated";
}

function timeWord() {
  const hour = new Date().getHours();
  if (hour < 5) return "the dead of night";
  if (hour < 8) return "early morning";
  if (hour < 12) return "morning";
  if (hour < 14) return "midday";
  if (hour < 18) return "afternoon";
  if (hour < 22) return "evening";
  return "late at night";
}

function goalWords(goal) {
  if (!goal || goal.completedAt) return null;
  switch (goal.type) {
    case "save_gold":
      return `saving up (you have ${goal.progress ?? 0} of ${goal.target ?? "?"} coins)`;
    case "rank_up":
      return "working toward a promotion";
    case "master_trade":
      return "honing your craft";
    case "boss_slayer":
      return `proving yourself against the great beasts (${goal.progress ?? 0} of ${goal.target ?? "?"} hunts)`;
    case "make_friends":
      return `trying to make friends in this strange land (${goal.progress ?? 0} of ${goal.target ?? "?"} so far)`;
    default:
      return null;
  }
}

/**
 * One line of world news for the prompt, or null when nothing is happening.
 * Reads the kingdoms plugin's active wars — a citizen whose home is at war
 * talks like it. Token-lean: a single short sentence.
 */
function worldNewsLine(record) {
  const kingdomId = record?.kingdom;
  if (!kingdomId) return null;
  let wars = [];
  try {
    const KingdomStore = require("../../kingdoms/KingdomStore");
    wars = KingdomStore.getActiveWars?.() ?? [];
  } catch {
    return null;
  }
  const mine = wars.find(
    (w) => w.attackerId === kingdomId || w.defenderId === kingdomId
  );
  if (!mine) return null;
  const otherId =
    mine.attackerId === kingdomId ? mine.defenderId : mine.attackerId;
  let other = otherId;
  try {
    const KingdomStore = require("../../kingdoms/KingdomStore");
    other = KingdomStore.getKingdom?.(otherId)?.name ?? otherId;
  } catch {
    // Fall back to the raw id.
  }
  const attacking = mine.attackerId === kingdomId;
  return attacking
    ? `There is a war on — your kingdom marches against ${other}. Spirits are high but tense.`
    : `${other} has declared war on your kingdom. Everyone is on edge.`;
}

/** Lazy require — the director requires chat modules at boot. */
function getDirector() {
  try {
    return require("../director/CitizenDirector").getDirector();
  } catch {
    return null;
  }
}

/**
 * Build the "right now" context for a citizen about to reply to a speaker.
 * Returns a short string for the prompt, or "" when nothing notable.
 */
function buildContext(citizenUsername, speakerUsername) {
  const director = getDirector();
  const { normalizeName } = require("../lib/CitizenBonds");
  const record = director?.roster.get(normalizeName(citizenUsername));
  if (!record) return "";
  const bot = director.getBot(record);

  const parts = [];

  // What they're doing.
  const activity = ACTIVITY_WORDS[record.currentActivityId];
  if (activity) parts.push(`You are ${activity}.`);

  // How they feel — only when it's notable (not neutral).
  let needs = null;
  try {
    needs = bot?.getAttribute?.(ATTR_CITIZEN_NEEDS) ?? null;
  } catch {
    needs = null;
  }
  if (needs) {
    const mood = moodWord(needs.mood);
    // "okay" is the default; only mention mood when it colors speech.
    if (mood && mood !== "okay") parts.push(`You feel ${mood}.`);
    if (needs.hunger != null && needs.hunger < 25) parts.push("You are starving.");
    else if (needs.hunger != null && needs.hunger < 45) parts.push("Your stomach is growling.");
    if (needs.energy != null && needs.energy < 25) parts.push("You are exhausted.");
  }

  // Emotional weather: war news, arguments, festivals leave marks that fade.
  try {
    const feeling = emotionLine(record);
    if (feeling) parts.push(feeling);
  } catch {
    // Emotions must never break the chat path.
  }

  // World news: an active war involving your kingdom shapes everything —
  // what you talk about, what you worry about, what you hope for.
  try {
    const news = worldNewsLine(record);
    if (news) parts.push(news);
  } catch {
    // World news must never break the chat path.
  }

  // What they're working toward.
  let goal = null;
  try {
    goal = bot?.getAttribute?.(ATTR_CITIZEN_GOAL) ?? record.goal ?? null;
  } catch {
    goal = record.goal ?? null;
  }
  const goalText = goalWords(goal);
  if (goalText) parts.push(`Right now you are ${goalText}.`);

  // How they feel about THIS speaker — the relationship colors everything.
  // Opinion line carries the WHY (moments, grudges); the moment line adds
  // specific recall. The LLM speaks from these.
  try {
    const mem = getMemory();
    const opinion = mem.opinionLine?.(citizenUsername, speakerUsername);
    if (opinion) parts.push(opinion);
    else {
      const standing = mem.standing(citizenUsername, speakerUsername);
      if (standing === "hostile") parts.push("You dislike this person. Be curt.");
      else if (standing === "cold") parts.push("You are wary of this person.");
      else if (standing === "favorite") parts.push("This person is a favorite of yours. Warm to them.");
      else if (standing === "regular") parts.push("You know this person well. Be friendly.");
      else if (standing === "warm") parts.push("You like this person.");
    }
    const recall = mem.momentLine?.(citizenUsername, speakerUsername);
    if (recall) parts.push(recall);
  } catch {
    // Memory must never break the chat path.
  }

  // Kinship: spouses, sweethearts, close friends, feuds. Real people talk
  // about their own lives — the citizen's words stay consistent with the
  // relationships the background tier simulated.
  try {
    const { kinSummary } = require("../lib/CitizenKinship");
    const kin = kinSummary(citizenUsername, director?.roster);
    if (kin) parts.push(kin);
  } catch {
    // Kinship must never break the chat path.
  }

  // Offices: a seated citizen speaks as the office; everyone else knows
  // who holds the seals in their kingdom.
  try {
    const CitizenOffices = require("../lib/CitizenOffices");
    const held = CitizenOffices.officeOfCitizen(citizenUsername);
    if (held) {
      parts.push(`You hold the office of ${held.title} of your kingdom. Speak with its authority and its burdens.`);
    } else if (record.kingdomId) {
      const others = CitizenOffices.officesOfKingdom(record.kingdomId)
        .filter((o) => o.citizenName)
        .slice(0, 3);
      if (others.length > 0) {
        parts.push(
          "Your kingdom's officers: " +
            others.map((o) => `${o.citizenName} is the ${o.title}`).join("; ") +
            "."
        );
      }
    }
  } catch {
    // Offices must never break the chat path.
  }

  // Guild: player-founded guilds with citizen members. A member speaks as
  // one — loyalty, pride, and the hall are part of their identity now.
  try {
    const Registry = require("../../guilds/GuildRegistry");
    const g = Registry.memberGuild(citizenUsername);
    if (g) {
      const rank = Registry.memberRank(g, citizenUsername);
      parts.push(
        `You are ${rank === "officer" ? "an officer" : rank === "founder" ? "the founder" : "a member"} ` +
          `of the guild '${g.name}'. You are loyal to it and speak of it with pride.`
      );
    }
  } catch {
    // Guilds must never break the chat path.
  }

  parts.push(`It is ${timeWord()}.`);

  // Lately: the background tier's journal. This is what makes "what have
  // you been up to?" answerable — the data says what happened, the LLM
  // just speaks truthfully from it. Seamless handoff, zero extra tokens
  // beyond these few words.
  try {
    const lately = getJournal().latelyLine(citizenUsername, 3);
    if (lately) parts.push(`Lately: ${lately}`);
  } catch {
    // Journal must never break the chat path.
  }

  return parts.join(" ");
}

module.exports = { buildContext, moodWord, timeWord, goalWords };
