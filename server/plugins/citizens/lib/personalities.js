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
    seed: Math.floor(rng() * 1_000_000_000),
  };
}

/** Short plain-English card for the llm-gateway (llm:citizen-register). */
function personalityCard(personality, kingdomName, kingdomSituation) {
  const traits = (personality.traits ?? []).join(" and ");
  return (
    `You are ${personality.name}, a ${personality.role} of ${kingdomName ?? "no kingdom"}. ` +
    `You are ${traits}. You ${personality.quirk}. ` +
    (kingdomSituation ? `Your land: ${kingdomSituation} ` : "") +
    (personality.secret
      ? `You carry a secret you almost never speak of: ${personality.secret} ` +
        "You deflect questions about it — change the subject, laugh it off, walk away. " +
        "You never blurt it out. You only hint at it if you truly trust the speaker, and trust is earned slowly. "
      : "") +
    "The gods are silent and no one knows why; you have your own theory but you are not sure. " +
    "You speak plainly and briefly, like a busy person with work to do. " +
    "You do not know everything and you say so. Never break character."
  ).slice(0, 2000);
}

module.exports = {
  TRAITS,
  QUIRKS,
  generatePersonality,
  generateName,
  personalityCard,
};
