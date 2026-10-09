"use strict";

/**
 * CitizenGuildChatter — scripted voice lines for guild hall sessions.
 *
 * The problem: guild brain actions walked members to the hall, stood them in
 * silence for 3 x 8s rounds, and walked them home. A human player at their
 * guild hall TALKS — shows off work, asks for critique, gossips, complains
 * about dues. Silence is the bot tell.
 *
 * Zero LLM. Lines come from seeded pools below and are voiced through the
 * existing personality system (voiceFor/voiceLine in citizenVoice.js), so a
 * gruff master sounds different from a chatty apprentice — same citizen,
 * same voice, every session.
 *
 * Line rules (from human-player-model.md):
 *   - 3-15 words, informal, reactive. Real RuneScape chat, not prose.
 *   - terse variants for gruff/taciturn speakers (shorter, blunter).
 *
 * Usage from a guild brain action session round:
 *   const line = chatterLine({ guild: "art", rank, personality, rng, roundIndex });
 *   if (line && shouldSpeak(rng, roundIndex)) sayPublic(player, line);
 *
 * Guilds: "art" | "music" | "cook". Extend by adding a key to POOLS and a
 * tier map in rankTier().
 */

const { voiceFor, voiceLine } = require("./citizenVoice");

// --- line pools -----------------------------------------------------------
// Categories:
//   greet    - session opener (round 0 only), anyone
//   critique - top rank teaches / reviews work
//   question - low rank asks for help
//   showoff  - mid/top share wins
//   gossip   - anyone, hall chatter
//   dues     - anyone, low weight, the universal complaint
// Each pool: { plain: [...], terse: [...] } — voiceLine picks the register.

const POOLS = Object.freeze({
  art: Object.freeze({
    greet: {
      plain: [
        "evening all",
        "hey everyone",
        "made it",
        "whos showing work today",
        "good session today?",
      ],
      terse: ["hey", "evening", "here"],
    },
    critique: {
      plain: [
        "that shading's off, try softer strokes",
        "composition's solid, watch the edges",
        "good start, push the contrast more",
        "your lines are getting cleaner",
        "step back and squint at it",
        "less is more on the background",
      ],
      terse: ["shading's off", "too flat", "better", "edges need work", "not bad"],
    },
    question: {
      plain: [
        "how do you mix that tone?",
        "is this brush ruined or fixable?",
        "master, quick look at this?",
        "whats the trick for straight lines?",
        "how long till im not terrible",
      ],
      terse: ["how?", "like this?", "is this right?", "tips?"],
    },
    showoff: {
      plain: [
        "finished a piece today, pretty happy",
        "sold one at the gallery!",
        "this ones my best yet",
        "check the new landscape when u can",
        "finally nailed that technique",
      ],
      terse: ["sold one", "new piece done", "my best yet"],
    },
    gossip: {
      plain: [
        "heard the gallery's buying again",
        "someone forged a master seal, wild",
        "the golden palette judging's soon",
        "new apprentice cant hold a brush",
        "patron paid double for a portrait",
      ],
      terse: ["heard the news?", "wild stuff today", "gallery's buying"],
    },
    dues: {
      plain: [
        "dues again already?",
        "25 coins every week smh",
        "worth it for the hall tho",
        "paid up, barely",
      ],
      terse: ["dues. again.", "paid", "25 coins..."],
    },
  }),
  music: Object.freeze({
    greet: {
      plain: [
        "evening all",
        "hey everyone",
        "made it",
        "whos playing tonight",
        "tune up, session time",
      ],
      terse: ["hey", "evening", "here"],
    },
    critique: {
      plain: [
        "your timing drifts in the chorus",
        "tune that string, its flat",
        "breathe before the high note",
        "slower on the bridge",
        "harmony was tight today",
        "feel the beat, dont chase it",
      ],
      terse: ["timing's off", "flat", "slower", "not bad", "again"],
    },
    question: {
      plain: [
        "how do you hit that note?",
        "is my lute in tune?",
        "maestro, hear my piece?",
        "whats the fingering for that part?",
        "how do you memorize long pieces",
      ],
      terse: ["how?", "in tune?", "hear this?", "tips?"],
    },
    showoff: {
      plain: [
        "nailed the solo tonight!",
        "played a wedding gig, good pay",
        "wrote a new ballad!",
        "crowd loved the encore!",
        "my new song's stuck in everyones head",
      ],
      terse: ["nailed it", "good gig", "new song done"],
    },
    gossip: {
      plain: [
        "heard theres a plagiarism case",
        "golden lyre voting soon",
        "the tavern wants live music",
        "someone played a forbidden tune lol",
        "new instrument shipment arrived",
      ],
      terse: ["heard the news?", "wild stuff today", "tavern wants music"],
    },
    dues: {
      plain: [
        "dues again already?",
        "25 coins every week smh",
        "worth it for the hall tho",
        "paid up, barely",
      ],
      terse: ["dues. again.", "paid", "25 coins..."],
    },
  }),
  cook: Object.freeze({
    greet: {
      plain: [
        "evening all",
        "hey everyone",
        "made it",
        "smells good in here",
        "whos cooking today",
      ],
      terse: ["hey", "evening", "here"],
    },
    critique: {
      plain: [
        "too much salt, start over",
        "that stew needs another hour",
        "knife work's improving",
        "taste as you go, always",
        "presentation matters too",
        "heat's too high, calm it down",
      ],
      terse: ["too salty", "needs time", "better", "taste it", "heat down"],
    },
    question: {
      plain: [
        "how long for the roast?",
        "is this stock ruined?",
        "chef, taste this?",
        "whats the secret spice?",
        "how do you keep it from burning",
      ],
      terse: ["how long?", "ruined?", "taste this?", "tips?"],
    },
    showoff: {
      plain: [
        "new recipe's a hit!",
        "catering a feast tomorrow",
        "my stew sold out!",
        "perfected the pie crust",
        "nobles asked for my dish by name",
      ],
      terse: ["sold out", "new recipe works", "feast tomorrow"],
    },
    gossip: {
      plain: [
        "golden ladle judging soon",
        "someone burned the feast lol",
        "new spice shipment arrived",
        "the inn needs a cook",
        "heard the cook-off prizes went up",
      ],
      terse: ["heard the news?", "wild stuff today", "spices arrived"],
    },
    dues: {
      plain: [
        "dues again already?",
        "25 coins every week smh",
        "worth it for the hall tho",
        "paid up, barely",
      ],
      terse: ["dues. again.", "paid", "25 coins..."],
    },
  }),
});

// Rank -> speaker tier. Top ranks critique, low ranks ask, mid shows off.
const TIER_BY_GUILD = Object.freeze({
  art: Object.freeze({ master: "top", artist: "mid", apprentice: "low" }),
  music: Object.freeze({ maestro: "top", minstrel: "mid", novice: "low" }),
  cook: Object.freeze({ chefdecuisine: "top", souschef: "mid", apprentice: "low" }),
});

// Category weights per tier (round 1+; round 0 is always greet).
// Top: mostly critique, some showoff. Low: mostly questions. Mid: showoff + gossip.
// Everyone gossips a little and complains about dues a little.
const CATEGORY_WEIGHTS = Object.freeze({
  top: Object.freeze([
    ["critique", 5],
    ["showoff", 2],
    ["gossip", 2],
    ["dues", 1],
  ]),
  mid: Object.freeze([
    ["showoff", 4],
    ["gossip", 3],
    ["critique", 1],
    ["dues", 1],
    ["question", 1],
  ]),
  low: Object.freeze([
    ["question", 5],
    ["gossip", 2],
    ["showoff", 1],
    ["dues", 1],
  ]),
});

function rankTier(guild, rank) {
  const map = TIER_BY_GUILD[guild];
  if (!map) return "mid";
  return map[rank] ?? "mid"; // unknown rank: talk like a mid
}

function pickWeighted(weighted, rng) {
  let total = 0;
  for (const [, w] of weighted) total += w;
  let roll = (rng ? rng() : Math.random()) * total;
  for (const [cat, w] of weighted) {
    roll -= w;
    if (roll <= 0) return cat;
  }
  return weighted[weighted.length - 1][0];
}

/**
 * Pick a voiced line for one session round.
 * Returns "" when the guild has no pools (caller stays silent, never throws).
 */
function chatterLine(opts = {}) {
  try {
    const { guild, rank, personality, rng, roundIndex } = opts ?? {};
    const pools = POOLS[guild];
    if (!pools) return "";
    let category;
    if (roundIndex === 0) {
      category = "greet";
    } else {
      const tier = rankTier(guild, rank);
      category = pickWeighted(CATEGORY_WEIGHTS[tier], rng);
    }
    const pool = pools[category];
    if (!pool) return "";
    const voice = voiceFor(personality ?? {});
    return voiceLine(voice, pool, rng ?? Math.random) ?? "";
  } catch {
    return "";
  }
}

/**
 * Should this round produce speech? Greeting round always talks; other
 * rounds talk ~70% of the time — humans don't narrate every 8 seconds.
 */
function shouldSpeak(rng, roundIndex) {
  try {
    if (roundIndex === 0) return true;
    return (rng ? rng() : Math.random()) < 0.7;
  } catch {
    return false;
  }
}

/**
 * One call for the session loop: pick a voiced line and say it.
 * Never throws; speech failure is never fatal to the tick.
 * Returns true when a line was spoken.
 */
function speakInSession(opts = {}) {
  try {
    const { player, personality, rng, rank, roundIndex, guild, sayPublic } = opts ?? {};
    if (typeof sayPublic !== "function") return false;
    if (!shouldSpeak(rng, roundIndex)) return false;
    const line = chatterLine({ guild, rank, personality, rng, roundIndex });
    if (!line) return false;
    sayPublic(player, line);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  chatterLine,
  shouldSpeak,
  speakInSession,
  rankTier,
  POOLS, // exported for tests
};
