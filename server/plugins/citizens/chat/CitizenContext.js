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
    default:
      return null;
  }
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
  const record = director?.roster.get(citizenUsername);
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
  try {
    const standing = getMemory().standing(citizenUsername, speakerUsername);
    if (standing === "hostile") parts.push("You dislike this person. Be curt.");
    else if (standing === "cold") parts.push("You are wary of this person.");
    else if (standing === "favorite") parts.push("This person is a favorite of yours. Warm to them.");
    else if (standing === "regular") parts.push("You know this person well. Be friendly.");
    else if (standing === "warm") parts.push("You like this person.");
  } catch {
    // Memory must never break the chat path.
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
