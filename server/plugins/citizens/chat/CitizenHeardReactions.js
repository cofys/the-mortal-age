"use strict";

/**
 * CitizenHeardReactions — zero-LLM scripted reactions to public chat.
 *
 * When a citizen hears public chat (via citizens:chat-heard), common patterns
 * get instant scripted reactions instead of waiting for the LLM mouth:
 *   - "gz!" on level-up announcements (the "gz" culture)
 *   - greeting back when greeted
 *   - "thanks!" when someone says "gz" to them
 *   - farewells, laughter, "gl!" — the fast social glue
 *
 * Why scripted, not LLM:
 *   - Zero token cost (the free-tier ceiling is hard)
 *   - Instant (no LLM latency — "gz!" 30s late is worse than silence)
 *   - These are reflexes, not conversation — real players don't compose
 *     thoughtful prose for "gz"
 *
 * Personality-gated (chatty citizens react more, taciturn less) and throttled
 * (per-citizen cooldown) so crowds don't become echo chambers. If no pattern
 * matches, the caller falls through to the LLM path.
 *
 * Two-tier by construction: all matching is string/regex (free); the visible
 * forceChat only fires for citizens already selected as repliers.
 */

const { ATTR_CITIZEN_PERSONALITY } = require("../constants");
const { humanizerProfile } = require("../lib/humanizer");

// Per-citizen throttle: username -> timestamp of last scripted reaction.
const lastReactionAt = new Map();
const REACTION_COOLDOWN_MS = 60 * 1000; // 60s between scripted reactions

// Memory-leak plug: prune hourly.
let lastPruneAt = 0;
function pruneCooldowns(nowMs) {
  if (nowMs - lastPruneAt < 3600 * 1000) return;
  lastPruneAt = nowMs;
  const cutoff = nowMs - 24 * 3600 * 1000;
  for (const [k, at] of lastReactionAt) {
    if (at < cutoff) lastReactionAt.delete(k);
  }
}

// --- Reaction pools -------------------------------------------------------
// Short, informal, RuneScape-native. 3-15 words max per the player model.

const POOLS = Object.freeze({
  greeting: Object.freeze(["hey!", "hi!", "hello!", "yo!", "howdy!", "hey there!"]),
  farewell: Object.freeze(["cya!", "later!", "bye!", "see ya!", "take care!"]),
  thanks: Object.freeze(["np!", "anytime!", "no worries!", "you're welcome!"]),
  laughter: Object.freeze(["lol", "haha", "hehe", "lmao"]),
  levelup: Object.freeze(["gz!", "grats!", "nice!", "gz gz!", "huge gz!"]),
  gzReceived: Object.freeze(["thanks!", "ty!", "tyty!", "appreciated!"]),
  gl: Object.freeze(["gl!", "good luck!", "you got this!"]),
  agree: Object.freeze(["yeah", "exactly", "true", "ikr", "facts"]),
});

// Terse variants for gruff/taciturn citizens (they don't exclaim).
const TERSE = Object.freeze({
  greeting: Object.freeze(["hey.", "hi.", "yo."]),
  farewell: Object.freeze(["cya.", "later.", "bye."]),
  thanks: Object.freeze(["np.", "sure."]),
  laughter: Object.freeze(["heh.", "lol."]),
  levelup: Object.freeze(["gz.", "grats.", "nice."]),
  gzReceived: Object.freeze(["ty.", "thanks."]),
  gl: Object.freeze(["gl."]),
  agree: Object.freeze(["yeah.", "true."]),
});

// --- Pattern matchers -----------------------------------------------------
// Each returns the pool key or null. Ordered by specificity.

function matchPattern(text) {
  const t = String(text ?? "").trim().toLowerCase();
  if (!t || t.length > 120) return null; // too long for a reflex

  // Level-up announcements: "just hit 70 fishing!", "ding 99!", "level 50!"
  if (/\b(ding|just hit|just got|just reached)\b/i.test(t) && /\d/.test(t)) {
    return "levelup";
  }
  if (/\blevel\s*\d+\s*!+\s*$/i.test(t)) {
    return "levelup";
  }

  // Short messages only for the rest (avoid hijacking real conversation).
  const words = t.split(/\s+/).length;
  const short = words <= 4 && t.length <= 24;

  // "gz" (congratulations) — someone celebrating.
  if (/\bgz\b/i.test(t) && short) {
    return "levelup"; // respond with gz to their gz (shared celebration)
  }

  // Greetings.
  if (short && /^(hi+|hello|hey+|yo|sup|howdy|greetings|good\s?morning|good\s?evening|good\s?day)\b/.test(t)) {
    return "greeting";
  }

  // Farewells.
  if (short && /^(bye+|goodbye|cya|see\s?ya|later|good\s?night|farewell)\b/.test(t)) {
    return "farewell";
  }

  // Thanks.
  if (/\b(thanks|thank\s?you|ty|thx|tyvm)\b/i.test(t) && short) {
    return "thanks";
  }

  // Laughter (join in).
  if (/\b(lol|haha+|hehe|lmao|rofl)\b/i.test(t) && short) {
    return "laughter";
  }

  // Good luck.
  if (/\bgl\b/i.test(t) && short) {
    return "gl";
  }

  // Agreement.
  if (short && /^(yeah|yes|yep|yup|exactly|true|ikr|facts|agreed)\b/.test(t)) {
    return "agree";
  }

  return null;
}

// --- Personality gating ---------------------------------------------------

function reactionChance(personality) {
  try {
    const traits = personality?.traits ?? [];
    const set = new Set(Array.isArray(traits) ? traits : []);
    if (set.has("chatty")) return 0.85;
    if (set.has("cheerful") || set.has("easygoing")) return 0.65;
    if (set.has("taciturn") || set.has("gruff") || set.has("suspicious")) return 0.25;
    if (set.has("proud")) return 0.35;
    // Fall back to humanizer chatRate.
    const profile = humanizerProfile(personality ?? {});
    return Math.max(0.2, Math.min(0.8, (profile.chatRate ?? 1.0) * 0.5));
  } catch {
    return 0.5;
  }
}

function isTerse(personality) {
  try {
    const traits = personality?.traits ?? [];
    const set = new Set(Array.isArray(traits) ? traits : []);
    return set.has("gruff") || set.has("taciturn");
  } catch {
    return false;
  }
}

function pick(pool, rng = Math.random) {
  return pool[Math.floor(rng() * pool.length)];
}

// --- Main entry ------------------------------------------------------------

/**
 * Attempt a scripted reaction. Returns the line spoken, or null if no
 * reaction fired (caller should fall through to the LLM path).
 *
 * @param {string} citizenUsername - the hearing citizen
 * @param {string} speakerUsername - who spoke
 * @param {string} text - what they said
 * @param {object} bot - the citizen's Player object (for forceChat + personality)
 * @param {number} nowMs - Date.now()
 * @returns {string|null} the line spoken, or null
 */
function tryScriptedReaction(citizenUsername, speakerUsername, text, bot, nowMs = Date.now()) {
  pruneCooldowns(nowMs);
  if (!citizenUsername || !bot || !text) return null;

  // Throttle: one scripted reaction per citizen per cooldown.
  const last = lastReactionAt.get(citizenUsername) ?? 0;
  if (nowMs - last < REACTION_COOLDOWN_MS) return null;

  // Pattern match.
  const poolKey = matchPattern(text);
  if (!poolKey) return null;

  // Personality gate.
  let personality = {};
  try {
    personality = bot.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
  } catch {
    personality = {};
  }
  const chance = reactionChance(personality);
  if (Math.random() >= chance) return null;

  // Special case: "gz" directed AT this citizen (their name in the text).
  // They say thanks instead of gz'ing back.
  let key = poolKey;
  if (poolKey === "levelup") {
    try {
      const name = String(citizenUsername).toLowerCase();
      const firstName = name.split(" ")[0];
      const lowered = String(text).toLowerCase();
      if (lowered.includes(firstName) && /\bgz\b/i.test(lowered)) {
        key = "gzReceived";
      }
    } catch {
      // Keep levelup.
    }
  }

  // Pick line (terse variants for gruff/taciturn).
  const pool = isTerse(personality) ? TERSE[key] : POOLS[key];
  const line = pick(pool);

  // Speak.
  try {
    bot.forceChat?.(line);
  } catch {
    return null; // couldn't speak — let LLM try
  }

  lastReactionAt.set(citizenUsername, nowMs);
  return line;
}

/** Clear throttle state (tests). */
function resetForTests() {
  lastReactionAt.clear();
  lastPruneAt = 0;
}

module.exports = {
  tryScriptedReaction,
  matchPattern,
  reactionChance,
  resetForTests,
  POOLS,
  TERSE,
  REACTION_COOLDOWN_MS,
};
