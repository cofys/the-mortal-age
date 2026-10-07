"use strict";

/**
 * CitizenBackground — the cheap tier of Jon's two-tier simulation.
 *
 * "They don't need to literally be talking if no one is near, but the data
 * needs to say they were."
 *
 * Every director tick (~60s), for EVERY roster citizen (online or off), this
 * module advances their life as pure data: RNG + templates, zero LLM calls.
 *   - Social: chatted with X, argued with Y, met Z, shared a drink
 *   - Work: sold goods, stood watch, worked a shift, earned coins
 *   - Personal: ate, rested, heard a rumor, worked toward a goal
 *
 * Each event lands in the CitizenJournal. Relationship tones drift from the
 * events (chatting warms, arguing cools). When a player later asks "what
 * have you been up to?", the foreground LLM reads the journal and answers
 * truthfully — the data said it happened.
 *
 * Offline citizens live too, just quieter (they're home/asleep — fewer,
 * domestic-flavored events).
 */

const { getJournal } = require("./CitizenJournal");
const { getMemory } = require("./CitizenMemory");
const { agentRng, chance } = require("./humanizer");
const { shiftEmotion, decayEmotion } = require("./emotions");

function pick(rng, list) {
  return list[Math.floor(rng() * list.length)];
}

const ROLE_GUARD = "guard";
const ROLE_MERCHANT = "merchant";
const ROLE_COMMONER = "commoner";
const ROLE_COURTIER = "courtier";

// --- event templates (personality-flavored by role) -------------------------

const WORK_EVENTS = {
  [ROLE_GUARD]: [
    "Stood watch at the {place}. Quiet shift.",
    "Walked the walls. Nothing but wind and pigeons.",
    "Broke up a shouting match near the {place}. No blood.",
    "Checked the gate roster. All accounted for.",
    "Drilled with the spear for an hour. Arm aches.",
  ],
  [ROLE_MERCHANT]: [
    "Sold {n} {goods} for {coins} coins.",
    "Haggled with a tight-fisted customer over {goods}. Won.",
    "Restocked the stall. {goods} piled high.",
    "A regular bought {goods} without even asking the price.",
    "Counted the day's take: {coins} coins. Not bad.",
  ],
  [ROLE_COMMONER]: [
    "Put in a shift at the {place}. Back aches.",
    "Gathered a bundle of {goods}. Sold half.",
    "Mended nets by the {place}. Mindless work.",
    "Carried crates for a merchant. Earned {coins} coins.",
    "Swept the front step and watched the street.",
  ],
  [ROLE_COURTIER]: [
    "Attended court. Smiled at the right people.",
    "Heard the most interesting gossip at the {place}.",
    "Wrote a letter. Sealed it twice.",
    "Dined with {other}. Politics over roast.",
    "Studied the {place} ledgers. Numbers don't lie.",
  ],
};

const SOCIAL_EVENTS = [
  "Shared a drink with {other} at the {place}.",
  "Chatted with {other} about the price of bread.",
  "Listened to {other}'s troubles for a while.",
  "Laughed with {other} until it hurt.",
  "Played dice with {other}. Lost {coins} coins.",
  "Walked with {other} to the {place}.",
  "Gossiped with {other} about the court.",
];

const ARGUE_EVENTS = [
  "Argued with {other} about {topic}. Still simmering.",
  "Had words with {other}. It got loud.",
  "Disagreed with {other} over {topic}. Walked away.",
];

const ARGUE_TOPICS = [
  "the gods going silent",
  "taxes",
  "the war",
  "who makes the best ale",
  "the king's decisions",
  "bread prices",
];

const QUIET_EVENTS = [
  "Ate a quiet meal. Bread and cheese.",
  "Rested. Dreamed of somewhere else.",
  "Sat by the window and watched the rain.",
  "Mended clothes by lamplight.",
  "Wrote in a journal. Then tore the page out.",
  "Fed the pigeons. Named a new one.",
];

const PLACES = ["market", "tavern", "square", "docks", "gate", "court"];
const GOODS = {
  [ROLE_MERCHANT]: ["loaves", "swords", "potions", "cloth"],
  [ROLE_COMMONER]: ["firewood", "fish", "herbs", "pebbles"],
  [ROLE_GUARD]: ["spears", "shields"],
  [ROLE_COURTIER]: ["letters", "seals"],
};

function fill(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] ?? `{${key}}`);
}

function randomOther(rng, director, record) {
  const candidates = [];
  for (const other of director.roster.values()) {
    if (other.username === record.username) continue;
    if (other.kingdomId !== record.kingdomId) continue;
    candidates.push(other);
  }
  if (candidates.length === 0) return null;
  return candidates[Math.floor(rng() * candidates.length)];
}

/**
 * One background step for a citizen. Called on the director tick.
 * `online` = whether the bot is currently spawned (offline = quieter life).
 */
function backgroundStep(record, director, online) {
  const rng = agentRng(`bg:${record.username}:${Math.floor(Date.now() / 3600000)}`);
  const journal = getJournal();
  const memory = getMemory();
  const traits = new Set(record.personality?.traits ?? []);

  // Emotional gravity: feelings fade every tick unless refreshed.
  try {
    decayEmotion(record);
  } catch {
    // Emotions must never break the background tick.
  }

  // Offline citizens: mostly quiet domestic life, occasional event.
  if (!online) {
    if (chance(rng, 0.25)) {
      journal.log(record.username, "rested", pick(rng, QUIET_EVENTS));
    }
    return;
  }

  // Online: 0-2 events per tick, weighted by personality.
  const chatty = traits.has("chatty") ? 1.6 : 1;
  const gruff = traits.has("gruff") ? 0.5 : 1;

  // Work event (most common — they're living their job).
  if (chance(rng, 0.45)) {
    const templates = WORK_EVENTS[record.role] ?? WORK_EVENTS[ROLE_COMMONER];
    const other = randomOther(rng, director, record);
    const coins = 10 + Math.floor(rng() * 200);
    const goods = pick(rng, GOODS[record.role] ?? GOODS[ROLE_COMMONER]);
    journal.log(
      record.username,
      "worked",
      fill(pick(rng, templates), {
        place: pick(rng, PLACES),
        goods,
        n: 1 + Math.floor(rng() * 8),
        coins,
        other: other?.personality?.name ?? other?.username ?? "a stranger",
      }),
      other ? { with: other.username } : {}
    );
    // A fat sale day makes a merchant walk tall.
    if (record.role === ROLE_MERCHANT && coins >= 150) {
      shiftEmotion(record, "proud", 45, "after a fat sale");
    }
  }

  // Social event (the lifeblood — relationships evolve from these).
  if (chance(rng, 0.30 * chatty * gruff)) {
    const other = randomOther(rng, director, record);
    if (other) {
      const text = fill(pick(rng, SOCIAL_EVENTS), {
        other: other.personality?.name ?? other.username,
        place: pick(rng, PLACES),
        coins: 5 + Math.floor(rng() * 50),
      });
      journal.log(record.username, "chatted", text, { with: other.username });
      journal.log(other.username, "chatted", text, { with: record.username });
      // A good laugh lifts the mood.
      if (/[Ll]augh|drink/.test(text)) {
        shiftEmotion(record, "excited", 30, "after a good laugh");
      }
      // Warm the relationship both ways (small, data-only).
      try {
        memory.recordTone(record.username, other.username, 1);
        memory.recordTone(other.username, record.username, 1);
        memory.recordMeeting(record.username, other.username);
        memory.recordMeeting(other.username, record.username);
      } catch {
        // Memory must never break the background tick.
      }
    }
  }

  // Argument (rare — but grudges between citizens make the world real).
  if (chance(rng, 0.06)) {
    const other = randomOther(rng, director, record);
    if (other) {
      const topic = pick(rng, ARGUE_TOPICS);
      const text = fill(pick(rng, ARGUE_EVENTS), {
        other: other.personality?.name ?? other.username,
        topic,
      });
      journal.log(record.username, "argued", text, { with: other.username });
      journal.log(other.username, "argued", text, { with: record.username });
      // Arguments leave people angry; talk of war leaves them scared.
      const otherName = other.personality?.name ?? other.username;
      if (/war|gods/.test(topic)) {
        shiftEmotion(record, "scared", 50, `after arguing about ${topic}`);
      } else {
        shiftEmotion(record, "angry", 55, `after arguing with ${otherName}`);
      }
      try {
        memory.recordTone(record.username, other.username, -2);
        memory.recordTone(other.username, record.username, -2);
      } catch {
        // Memory must never break the background tick.
      }
    }
  }

  // Quiet personal moment (everyone has an inner life).
  if (chance(rng, 0.15)) {
    journal.log(record.username, "rested", pick(rng, QUIET_EVENTS));
  }
}

module.exports = { backgroundStep };
