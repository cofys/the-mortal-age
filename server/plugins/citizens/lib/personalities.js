"use strict";

/**
 * personalities — small seed objects that make a citizen someone.
 *
 * Personality = { name, role, kingdomId, traits, quirk, seed }. Deterministic
 * per username so a citizen is the same person across logins. Also builds the
 * personality card the llm-gateway uses when a real player talks to them.
 */

const path = require("path");
const fs = require("fs");
const { agentRng, chance } = require("./humanizer");
const { ROLES } = require("../constants");

const NAMES = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "data", "names.json"), "utf8")
);

const TRAITS = Object.freeze([
  "chatty",
  "taciturn",
  "gruff",
  "cheerful",
  "dutiful",
  "daydreamer",
  "suspicious",
  "easygoing",
  "methodical",
  "fidgety",
  "devout",
  "greedy",
  "clumsy",
  "proud",
]);

const QUIRKS = Object.freeze([
  "hums old marching songs while walking",
  "counts coins twice before every trade",
  "nods at every stranger, then looks away",
  "taps their foot when standing still",
  "mutters about the price of bread",
  "straightens their belt before speaking",
  "collects interesting pebbles",
  "is afraid of the dark and hurries home at dusk",
  "names the pigeons in the market square",
  "polishes their boots every morning",
  "talks to their tools like old friends",
  "keeps a lucky rabbit's foot",
]);

// --- voice: how a citizen SOUNDS. Seeded like traits, so the same citizen
// always talks the same way. A gruff guard and a chatty merchant should be
// unmistakable in chat even without their names attached. -------------------

const SPEECH_STYLES = Object.freeze([
  "short clipped sentences",
  "long winding sentences",
  "plain blunt words",
  "colorful flowery words",
  "a slow drawl",
  "rapid-fire chatter",
  "careful formal phrasing",
  "rough street slang",
]);

const HUMOR_STYLES = Object.freeze([
  "dry understatement",
  "bawdy jokes",
  "deadpan one-liners",
  "terrible puns",
  "dark gallows humor",
  "warm teasing",
  "no humor at all — everything is serious",
  "sarcasm",
]);

const VOCABULARIES = Object.freeze([
  "simple everyday words",
  "colorful vivid words",
  "educated precise words",
  "rough coarse words",
]);

const DEMEANORS = Object.freeze([
  "warm and open",
  "guarded and watchful",
  "bold and brash",
  "nervous and fidgety",
  "haughty and proud",
  "gentle and soft-spoken",
  "weary and world-tired",
  "mischievous and sly",
]);

const MANNERISMS = Object.freeze([
  "clear your throat before speaking",
  "speak through a half-smile",
  "gesture broadly with both hands",
  "mumble the ends of your sentences",
  "raise one eyebrow when amused",
  "spit to the side when annoyed",
  "laugh a little too loud",
  "pause a long moment before answering",
]);

function pick(rng, list) {
  return list[Math.floor(rng() * list.length)];
}

function pickUnique(rng, list, count) {
  const pool = list.slice();
  const chosen = [];
  while (chosen.length < count && pool.length > 0) {
    const index = Math.floor(rng() * pool.length);
    chosen.push(pool.splice(index, 1)[0]);
  }
  return chosen;
}

function generateName(rng, usedNames) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const female = chance(rng, 0.5);
    const first = pick(rng, female ? NAMES.first_female : NAMES.first_male);
    const name = `${first} ${pick(rng, NAMES.surnames)}`;
    if (!usedNames.has(name)) {
      usedNames.add(name);
      return name;
    }
  }
  const fallback = `Citizen ${Math.floor(rng() * 90000) + 10000}`;
  usedNames.add(fallback);
  return fallback;
}

/**
 * Deterministic personality for a username. `role`/`kingdomId` may be forced
 * by the director; traits and quirk come from the seed.
 */
function generatePersonality(username, { role, kingdomId, usedNames } = {}) {
  const rng = agentRng(`citizen:${username}`);
  const finalRole = ROLES.includes(role) ? role : pick(rng, ROLES);
  return {
    name: generateName(rng, usedNames ?? new Set()),
    role: finalRole,
    kingdomId: kingdomId ?? null,
    traits: pickUnique(rng, TRAITS, 2),
    quirk: pick(rng, QUIRKS),
    // Voice — deterministic per username, so the citizen always sounds
    // like themselves across sessions.
    speechStyle: pick(rng, SPEECH_STYLES),
    humorStyle: pick(rng, HUMOR_STYLES),
    vocabulary: pick(rng, VOCABULARIES),
    demeanor: pick(rng, DEMEANORS),
    mannerism: pick(rng, MANNERISMS),
    seed: Math.floor(rng() * 1_000_000_000),
  };
}

/** The "how you talk" line — the part that makes two citizens sound different.
 * Kept to ~2 short sentences so the card stays under the gateway's 480-char
 * clamp with the behavioral core intact. */
function voiceLine(personality) {
  const speech = personality.speechStyle ?? "plain blunt words";
  const vocab = personality.vocabulary ?? "simple everyday words";
  const humor = personality.humorStyle ?? "no humor at all — everything is serious";
  const demeanor = personality.demeanor ?? "guarded and watchful";
  return (
    `You talk in ${speech}, using ${vocab}. ` +
    `Your humor is ${humor}; you come across ${demeanor}.`
  );
}

/** Short plain-English card for the llm-gateway (llm:citizen-register).
 * Stays under the gateway's 480-char clamp: the behavioral core ("Never
 * break character") sits before the optional secret so clamping can only
 * ever trim secret detail, never instructions. */
function personalityCard(personality, kingdomName, kingdomSituation) {
  const traits = (personality.traits ?? []).join(" and ");
  return (
    `You are ${personality.name}, a ${personality.role} of ${kingdomName ?? "no kingdom"}. ` +
    `You are ${traits}. Quirk: ${personality.quirk}. ` +
    `How you talk: ${voiceLine(personality)} ` +
    (kingdomSituation ? `Your land: ${kingdomSituation} ` : "") +
    "Speak plainly and briefly, like a busy person with work to do. " +
    "You do not know everything and you say so. Never break character. " +
    (personality.secret
      ? `You carry a secret you almost never speak of: ${personality.secret} ` +
        "You deflect questions about it — change the subject, laugh it off, walk away. " +
        "You never blurt it out. You only hint at it if you truly trust the speaker, and trust is earned slowly. "
      : "")
  ).slice(0, 2000);
}

module.exports = {
  TRAITS,
  QUIRKS,
  SPEECH_STYLES,
  HUMOR_STYLES,
  VOCABULARIES,
  DEMEANORS,
  MANNERISMS,
  generatePersonality,
  generateName,
  voiceLine,
  personalityCard,
};
