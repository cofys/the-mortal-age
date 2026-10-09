"use strict";

/**
 * citizenVoice — how a citizen SOUNDS in scripted (zero-LLM) chat.
 *
 * The problem: every forceChat pool reads in the same voice. A gruff guard
 * and a chatty merchant are indistinguishable in text. This module maps the
 * seeded personality (traits + speechStyle from personalities.js) to a voice
 * profile, then picks/styles lines to match.
 *
 * Design:
 *   voiceFor(personality) -> { register, lowercase, exclaim }
 *     Pure and deterministic — same personality always yields the same
 *     voice. Zero per-tick cost (compute once, or inline in the pick).
 *   voiceLine(voice, pool, rng) -> string
 *     pool = { plain: [...], terse: [...] } — picks the register's variant,
 *     falling back to plain. Keeps existing pools working unchanged.
 *   styleLine(voice, line) -> string
 *     Applies case/punctuation transforms (lowercase, ! -> .).
 *
 * Registers:
 *   terse    — gruff, taciturn, suspicious. Short. Periods, never "!".
 *   warm     — chatty, cheerful, easygoing. Exclamations, greetings.
 *   colorful — flowery/long-winded speech. (Falls back to plain pools for
 *              now; the LLM card carries the full colorful voice.)
 *   plain    — everyone else. The existing pool content, unmodified.
 */

const REGISTERS = Object.freeze(["terse", "plain", "warm", "colorful"]);

/**
 * Map a personality to its voice profile. Deterministic: same input personality
 * object always yields the same profile (no RNG here — personalities.js already
 * seeded everything).
 */
function voiceFor(personality) {
  const traits = new Set(
    Array.isArray(personality?.traits) ? personality.traits : []
  );
  const speech = personality?.speechStyle ?? "";
  const vocab = personality?.vocabulary ?? "";

  let register = "plain";
  if (
    traits.has("gruff") ||
    traits.has("taciturn") ||
    traits.has("suspicious") ||
    speech === "short clipped sentences" ||
    speech === "plain blunt words"
  ) {
    register = "terse";
  } else if (
    traits.has("chatty") ||
    traits.has("cheerful") ||
    traits.has("easygoing") ||
    speech === "rapid-fire chatter"
  ) {
    register = "warm";
  } else if (
    speech === "colorful flowery words" ||
    speech === "long winding sentences" ||
    vocab === "colorful vivid words"
  ) {
    register = "colorful";
  }

  // Lowercase typists: street slang + clipped speakers type like real
  // RuneScape players (mostly lowercase, minimal punctuation).
  const lowercase =
    speech === "rough street slang" ||
    speech === "short clipped sentences" ||
    (register === "terse" && traits.has("gruff"));

  // Warm citizens exclaim; terse citizens never do.
  const exclaim = register === "warm";

  return { register, lowercase, exclaim };
}

/**
 * Pick a line from a voice-aware pool.
 * pool = { plain: [...], terse: [...] } — terse is optional; colorful and
 * warm fall back to plain (with styleLine applying their flavor).
 */
function voiceLine(voice, pool, rng = Math.random) {
  const register = voice?.register ?? "plain";
  const lines =
    (register !== "plain" && pool?.[register]?.length > 0
      ? pool[register]
      : pool?.plain) ?? [];
  if (lines.length === 0) {
    // Fallback: first non-empty variant, so a malformed pool never silences.
    for (const key of REGISTERS) {
      if (pool?.[key]?.length > 0) return styleLine(voice, pool[key][0]);
    }
    return "";
  }
  return styleLine(voice, lines[Math.floor(rng() * lines.length)]);
}

/**
 * Apply case/punctuation transforms for the voice.
 * - terse: "!" -> "." (they don't exclaim)
 * - lowercase: whole line lowercased (street typists)
 * - warm without exclaim flag: leave as-is (pool already has "!")
 */
function styleLine(voice, line) {
  let out = String(line ?? "");
  if (voice?.register === "terse") {
    out = out.replace(/!+/g, ".");
  }
  if (voice?.lowercase) {
    out = out.toLowerCase();
  }
  return out;
}

/**
 * Compact voice directive for the LLM personality card. Keeps the scripted
 * voice and the LLM mouth consistent: the LLM should sound like the same
 * person, not like a chatbot.
 */
function voiceDirective(personality) {
  const voice = voiceFor(personality);
  const parts = [];
  // Real RuneScape chat: lowercase, terse, minimal punctuation.
  parts.push("type in lowercase like a real player, not formal sentences");
  if (voice.register === "terse") {
    parts.push("keep replies to 1-6 words, blunt, no exclamation marks");
  } else if (voice.register === "warm") {
    parts.push("you may use exclamation marks, you are expressive");
  } else {
    parts.push("keep replies under 15 words");
  }
  if (voice.lowercase) {
    parts.push("never use capital letters");
  }
  return parts.join(". ") + ".";
}

module.exports = {
  REGISTERS,
  voiceFor,
  voiceLine,
  styleLine,
  voiceDirective,
};
