"use strict";

/**
 * CitizenWeatherReactions — citizens react to weather and time of day.
 *
 * WHAT IT DOES (data tier, free):
 *   Watches the world's one Sky (weather machine + server clock). On every
 *   transition (clear->rain, day->dusk, night->dawn) it notes the moment; the
 *   visible reaction fires only for citizens near a real player, and each
 *   reaction is journaled so the LLM mouth can reference it later
 *   ("got soaked in that storm yesterday").
 *
 * WHAT THE PLAYER SEES (interaction tier, only near real players):
 *   - Rain starts: rain-haters complain and hurry home; rain-lovers cheer
 *     and stay out; everyone runs when a full storm hits.
 *   - Dusk/night falls: the afraid-of-the-dark hurry home, the devout head
 *     for evening prayers, everyone else drifts homeward.
 *   - Dawn breaks: dutiful and methodical early risers greet the morning.
 *
 * Zero LLM: scripted line pools gated by personality traits and quirks.
 * Movement is bot.moveTo toward record.home (always a valid walkable tile).
 *
 * Wired into the slow director tick (transitions are rare: weather rolls
 * ~every 30 min, time of day changes 4x daily). Plain-node testable.
 */

// === Tuning: all magic numbers here ===
const REACTION_RADIUS = 16; // tiles — close enough to see/hear the reaction
const REACTION_CITIZEN_COOLDOWN_MS = 45 * 60 * 1000; // a citizen reacts at most this often
const ONGOING_RAIN_COMMENT_CHANCE = 0.15; // per eligible citizen per tick while raining
const ONGOING_RAIN_COOLDOWN_MS = 90 * 60 * 1000; // ...but not more often than this

// === Sky access (lazy, null-safe) ===
// Cross-plugin require, same precedent as Weather.Woodcutting requiring
// Conditions.Fishing. Safe in plain node: getWeather defaults to CLEAR,
// getTimeOfDay computes from the server clock.
let Sky = null;
function getSky() {
  if (!Sky) {
    try {
      Sky = require("../../skills/fishing/Conditions.Fishing");
    } catch {
      Sky = null;
    }
  }
  return Sky;
}
/** Test seam: inject a fake sky. */
function _setSky(fake) {
  Sky = fake;
}

// === Transition state (one sky for the whole world) ===
let lastWeather = null;
let lastTimeOfDay = null;
/** Test seam: reset transition state. */
function _resetState() {
  lastWeather = null;
  lastTimeOfDay = null;
  lastReactionByCitizen.clear();
  lastOngoingByCitizen.clear();
}

// === Cooldown state ===
const lastReactionByCitizen = new Map(); // username -> timestamp (transition reactions)
const lastOngoingByCitizen = new Map(); // username -> timestamp (ongoing rain comments)

// Memory-leak plug: prune entries older than a day, at most hourly.
let lastPruneAt = 0;
function pruneCooldowns(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, at] of lastReactionByCitizen) {
    if (at < cutoff) lastReactionByCitizen.delete(k);
  }
  for (const [k, at] of lastOngoingByCitizen) {
    if (at < cutoff) lastOngoingByCitizen.delete(k);
  }
}

// ============================================================================
// Pure helpers — testable with plain node, no engine.
// ============================================================================

/** Deterministic pick from an array using an injected rng. */
function pickOne(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

/** True only for real human players (not bots, not logged-out). */
function isRealPlayer(player) {
  if (!player) return false;
  try {
    if (player.isPlayerBot?.() === true) return false;
    if (player.getHostAddress?.() === "bot") return false;
    return typeof player.getUsername === "function";
  } catch {
    return false;
  }
}

/** Cheap Chebyshev distance check (same plane). */
function withinTiles(a, b, radius) {
  try {
    const la = a.getLocation?.();
    const lb = b.getLocation?.();
    if (!la || !lb || la.getZ() !== lb.getZ()) return false;
    return Math.max(Math.abs(la.getX() - lb.getX()), Math.abs(la.getY() - lb.getY())) <= radius;
  } catch {
    return false;
  }
}

/** True if any real (non-bot) player is within radius tiles of the citizen. */
function anyRealPlayerNear(director, citizen, radius) {
  try {
    const players = director.onlinePlayers?.() ?? [];
    for (const p of players) {
      if (!isRealPlayer(p)) continue;
      if (withinTiles(citizen, p, radius)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

function traitsOf(record) {
  return new Set(record?.personality?.traits ?? []);
}

/**
 * How does this citizen feel about rain? Pure.
 * @returns {"love"|"hate"|"neutral"}
 */
function rainAttitude(record) {
  const traits = traitsOf(record);
  if (traits.has("cheerful") || traits.has("daydreamer") || traits.has("easygoing")) {
    return "love";
  }
  if (traits.has("gruff") || traits.has("fidgety") || traits.has("proud")) {
    return "hate";
  }
  return "neutral";
}

/**
 * What does this citizen do when night falls? Pure.
 * @returns {"flee"|"pray"|"home"|"stay"}
 *   flee = afraid of the dark, runs home at dusk
 *   pray = devout, evening prayers
 *   home = everyone else drifts homeward
 *   stay = guards on watch stay at their post
 */
function nightBehavior(record) {
  const traits = traitsOf(record);
  const quirk = record?.personality?.quirk ?? "";
  if (quirk.includes("afraid of the dark")) return "flee";
  if (traits.has("devout")) return "pray";
  if (record?.role === "guard") return "stay";
  return "home";
}

/**
 * Is this citizen an early riser who greets the dawn? Pure.
 */
function isEarlyRiser(record) {
  const traits = traitsOf(record);
  return traits.has("dutiful") || traits.has("methodical");
}

// === Scripted line pools (zero LLM) ===
const LINES = {
  rainHate: [
    "Not the rain again. My boots are still wet from last time.",
    "I'm getting under cover. This is miserable.",
    "Rain, rain, go away...",
    "Every time. Every single time it rains when I'm out.",
  ],
  rainLove: [
    "Oh, I love the rain. Smells like the earth waking up.",
    "Rain's good for the crops. Good for the soul, too.",
    "Let it rain. We needed this.",
  ],
  rainNeutral: ["Looks like rain. Better finish up out here.", "Hm. Rain coming in."],
  storm: [
    "Storm coming! Get inside!",
    "Sweet gods, that's a nasty one. Take cover!",
    "Everyone inside! Now!",
  ],
  nightFlee: ["Getting dark. I'm heading home.", "Dark already? I'm not staying out in this."],
  nightPray: ["Evening prayers. The gods watch over us tonight.", "Time for evening prayers."],
  nightHome: ["Long day. Heading home.", "Tavern's calling my name... actually, home's calling louder."],
  dawn: [
    "Up with the dawn. Another day, another coin.",
    "Morning! Fine sunrise today.",
    "Early start. The early bird gets the worm, as they say.",
  ],
  ongoingRain: [
    "Still raining, eh?",
    "This rain just won't quit.",
    "*wring out a soaked sleeve*",
  ],
};

/**
 * Detect what (if anything) just changed in the sky. Pure.
 * @returns {{rainStarted:boolean, stormStarted:boolean, duskFell:boolean, nightFell:boolean, dawnBroke:boolean, raining:boolean}}
 */
function detectTransitions(sky) {
  const weather = sky.getWeather();
  const timeOfDay = sky.getTimeOfDay();
  const W = sky.WEATHER;
  const T = sky.TIME;

  // First observation: just record state, never burst-react on boot.
  if (lastWeather === null || lastTimeOfDay === null) {
    return {
      rainStarted: false,
      stormStarted: false,
      duskFell: false,
      nightFell: false,
      dawnBroke: false,
      raining: weather === W.RAIN || weather === W.STORM,
      weather,
      timeOfDay,
    };
  }

  const wasWet = lastWeather === W.RAIN || lastWeather === W.STORM;
  const isWet = weather === W.RAIN || weather === W.STORM;
  return {
    rainStarted: !wasWet && isWet,
    stormStarted: lastWeather !== W.STORM && weather === W.STORM,
    duskFell: lastTimeOfDay !== T.DUSK && timeOfDay === T.DUSK,
    nightFell: lastTimeOfDay !== T.NIGHT && timeOfDay === T.NIGHT,
    dawnBroke: lastTimeOfDay !== T.DAWN && timeOfDay === T.DAWN,
    raining: isWet,
    weather,
    timeOfDay,
  };
}

/** Commit the observed sky state. Called after detectTransitions. */
function commitSkyState(weather, timeOfDay) {
  lastWeather = weather;
  lastTimeOfDay = timeOfDay;
}

// ============================================================================
// Engine-touching helpers (guarded, never throw).
// ============================================================================

function makeLocation(director, x, y, z) {
  try {
    const Loc = director?.api?.core?.Location;
    if (Loc) return new Loc(x, y, z ?? 0);
  } catch {
    // Non-fatal.
  }
  return null;
}

/** Walk the citizen's bot toward their home tile. Returns true if attempted. */
function walkHome(director, bot, record) {
  try {
    const home = record?.home;
    if (!home || typeof home.x !== "number") return false;
    const loc = makeLocation(director, home.x, home.y, home.z);
    if (!loc) return false;
    bot.moveTo?.(loc);
    return true;
  } catch {
    return false;
  }
}

function say(bot, line) {
  try {
    bot.forceChat?.(String(line).slice(0, 120));
  } catch {
    // Non-fatal.
  }
}

function journal(director, record, text, data) {
  try {
    const { getJournal } = require("./CitizenJournal");
    getJournal().log(record.username, "social", text, { data });
  } catch {
    // The journal must never break the weather.
  }
}

// ============================================================================
// The tick function — called from the slow director tick.
// Gate order: sky transition (cheapest, global) → cooldown → citizen exists
// → real player near → personality-gated reaction.
// ============================================================================

/**
 * @param {object} director - the CitizenDirector instance
 * @param {number} nowMs - Date.now()
 * @param {function} rng - random source (default Math.random; inject for tests)
 */
function tickWeatherReactions(director, nowMs, rng = Math.random) {
  pruneCooldowns(nowMs);
  const sky = getSky();
  if (!sky) return;
  let t;
  try {
    t = detectTransitions(sky);
    commitSkyState(t.weather, t.timeOfDay);
  } catch {
    return;
  }

  // Nothing to react to: no transition and not currently raining.
  if (!t.rainStarted && !t.stormStarted && !t.duskFell && !t.nightFell && !t.dawnBroke && !t.raining) {
    return;
  }

  try {
    for (const record of director.roster?.values?.() ?? []) {
      try {
        reactForCitizen(director, record, t, nowMs, rng);
      } catch {
        // Per-citizen try/catch: one bad citizen never breaks the tick.
      }
    }
  } catch (e) {
    console.warn("[citizen-weather] tick failed:", e?.message ?? e);
  }
}

function reactForCitizen(director, record, t, nowMs, rng) {
  const username = record?.username;
  if (!username) return;

  // 1. Cooldown gate — O(1), skips almost everyone.
  const last = lastReactionByCitizen.get(username) || 0;
  const isTransition = t.rainStarted || t.stormStarted || t.duskFell || t.nightFell || t.dawnBroke;
  if (isTransition && nowMs - last < REACTION_CITIZEN_COOLDOWN_MS) return;

  // Ongoing rain comments have their own longer cooldown and chance gate.
  const isOngoingOnly = !isTransition && t.raining;
  if (isOngoingOnly) {
    const lastOngoing = lastOngoingByCitizen.get(username) || 0;
    if (nowMs - lastOngoing < ONGOING_RAIN_COOLDOWN_MS) return;
    if (rng() >= ONGOING_RAIN_COMMENT_CHANCE) return;
  } else if (!isTransition) {
    return;
  }

  // 2. Citizen must be materialized (near a player already).
  const bot = director.playerFor?.(record);
  if (!bot) return;

  // 3. A real player must be within earshot/eyeshot.
  if (!anyRealPlayerNear(director, bot, REACTION_RADIUS)) return;

  // 4. Personality-gated reaction (scripted, zero LLM).
  if (t.stormStarted) {
    const line = pickOne(rng, LINES.storm);
    say(bot, line);
    walkHome(director, bot, record);
    journal(director, record, "Ran for shelter when the storm hit.", {
      weather: "storm",
    });
    lastReactionByCitizen.set(username, nowMs);
    return;
  }

  if (t.rainStarted) {
    const attitude = rainAttitude(record);
    if (attitude === "hate") {
      say(bot, pickOne(rng, LINES.rainHate));
      walkHome(director, bot, record);
      journal(director, record, "Got caught in the rain and hurried home.", {
        weather: "rain",
        attitude: "hate",
      });
    } else if (attitude === "love") {
      say(bot, pickOne(rng, LINES.rainLove));
      journal(director, record, "Enjoyed the rain starting.", {
        weather: "rain",
        attitude: "love",
      });
    } else {
      say(bot, pickOne(rng, LINES.rainNeutral));
      journal(director, record, "Noticed the rain starting.", {
        weather: "rain",
        attitude: "neutral",
      });
    }
    lastReactionByCitizen.set(username, nowMs);
    return;
  }

  if (t.duskFell || t.nightFell) {
    const behavior = nightBehavior(record);
    const when = t.duskFell ? "dusk" : "night";
    if (behavior === "stay") return; // guards hold their post, no reaction
    if (behavior === "flee") {
      say(bot, pickOne(rng, LINES.nightFlee));
      walkHome(director, bot, record);
      journal(director, record, `Hurried home as ${when} fell (afraid of the dark).`, {
        timeOfDay: when,
      });
    } else if (behavior === "pray") {
      say(bot, pickOne(rng, LINES.nightPray));
      walkHome(director, bot, record);
      journal(director, record, `Went home for evening prayers at ${when}.`, {
        timeOfDay: when,
      });
    } else {
      say(bot, pickOne(rng, LINES.nightHome));
      walkHome(director, bot, record);
      journal(director, record, `Headed home as ${when} fell.`, { timeOfDay: when });
    }
    lastReactionByCitizen.set(username, nowMs);
    return;
  }

  if (t.dawnBroke) {
    if (!isEarlyRiser(record)) return;
    say(bot, pickOne(rng, LINES.dawn));
    journal(director, record, "Started the day at dawn.", { timeOfDay: "dawn" });
    lastReactionByCitizen.set(username, nowMs);
    return;
  }

  // Ongoing rain: occasional ambient comment, no movement, no journal spam.
  if (isOngoingOnly) {
    say(bot, pickOne(rng, LINES.ongoingRain));
    lastOngoingByCitizen.set(username, nowMs);
  }
}

module.exports = {
  tickWeatherReactions,
  // Pure helpers for tests:
  rainAttitude,
  nightBehavior,
  isEarlyRiser,
  detectTransitions,
  commitSkyState,
  pickOne,
  isRealPlayer,
  withinTiles,
  // Test seams:
  _setSky,
  _resetState,
};
