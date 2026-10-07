"use strict";

/**
 * emotions — the feeling tier of the two-tier simulation.
 *
 * Personalities are who a citizen IS; emotions are how they FEEL right now.
 * Events in the background tier shift emotions (war news scares, insults
 * anger, festivals excite, a good sale makes a merchant proud). Emotions
 * decay toward calm each tick, so a citizen rattled at noon is steady by
 * evening — unless something else happens.
 *
 * All data, zero LLM. The foreground LLM reads the emotion line in the
 * context section and speaks from inside it. Stored on the director record
 * (boot lifetime); notable shifts are also journaled so "lately" stays true.
 *
 * Shape: record.emotion = { state, intensity (0-100), cause, updatedAt }
 * States: calm (baseline, no line), scared, angry, excited, sad, proud.
 */

const { getJournal } = require("./CitizenJournal");

const CALM = "calm";
const STATES = Object.freeze(["scared", "angry", "excited", "sad", "proud"]);

// Per-tick decay: strong feelings fade, they don't snap off.
const DECAY_PER_TICK = 18;
// Below this, the citizen is effectively calm — no prompt line.
const NOTICEABLE_AT = 40;
// A fresh shock replaces a weaker old feeling; a weaker shock just nudges.
const REPLACE_MARGIN = 15;

function current(record) {
  const emotion = record?.emotion;
  if (!emotion || typeof emotion.intensity !== "number") {
    return { state: CALM, intensity: 0, cause: null, updatedAt: 0 };
  }
  return emotion;
}

/**
 * Push an emotion onto a citizen. Stronger feelings replace weaker ones;
 * weaker ones add a little to what's already there (feelings compound).
 */
function shiftEmotion(record, state, intensity, cause) {
  if (!record || !STATES.includes(state)) return;
  const amount = Math.max(0, Math.min(100, Number(intensity) || 0));
  if (amount <= 0) return;
  const prev = current(record);
  let next;
  if (prev.state === CALM || amount >= prev.intensity + REPLACE_MARGIN) {
    next = { state, intensity: amount, cause: cause ?? null, updatedAt: Date.now() };
  } else {
    // Same feeling deepens; a different one just colors the edges.
    next = {
      state: prev.state,
      intensity: Math.min(100, prev.intensity + Math.round(amount * 0.25)),
      cause: prev.cause,
      updatedAt: prev.updatedAt,
    };
  }
  record.emotion = next;
  // Notable shifts land in the journal — "lately" stays truthful.
  if (next.intensity >= NOTICEABLE_AT && next.state !== prev.state) {
    try {
      getJournal().log(
        record.username,
        "felt",
        emotionJournalLine(next),
        {}
      );
    } catch {
      // Journal must never break the background tick.
    }
  }
}

/** One tick of emotional gravity: everything drifts back toward calm. */
function decayEmotion(record) {
  if (!record) return;
  const prev = current(record);
  if (prev.state === CALM || prev.intensity <= 0) {
    record.emotion = { state: CALM, intensity: 0, cause: null, updatedAt: 0 };
    return;
  }
  const intensity = prev.intensity - DECAY_PER_TICK;
  record.emotion =
    intensity < NOTICEABLE_AT * 0.5
      ? { state: CALM, intensity: 0, cause: null, updatedAt: 0 }
      : { ...prev, intensity };
}

function emotionJournalLine(emotion) {
  const cause = emotion.cause ? ` — ${emotion.cause}` : "";
  switch (emotion.state) {
    case "scared":
      return `Left shaken${cause}.`;
    case "angry":
      return `Seething${cause}.`;
    case "excited":
      return `Buzzing with excitement${cause}.`;
    case "sad":
      return `Heavy-hearted${cause}.`;
    case "proud":
      return `Walking tall${cause}.`;
    default:
      return `Felt something${cause}.`;
  }
}

/**
 * One short line for the LLM context section. Returns "" when the citizen
 * is calm — the prompt stays lean when there's nothing to say.
 */
function emotionLine(record) {
  const emotion = current(record);
  if (emotion.state === CALM || emotion.intensity < NOTICEABLE_AT) return "";
  const cause = emotion.cause ? ` ${emotion.cause}` : "";
  switch (emotion.state) {
    case "scared":
      return `You are on edge and frightened.${cause} It shows in how you talk.`;
    case "angry":
      return `You are angry.${cause} You are short with people.`;
    case "excited":
      return `You are excited and full of energy.${cause} It bubbles out when you talk.`;
    case "sad":
      return `You are sad and heavy-hearted.${cause} You don't hide it well.`;
    case "proud":
      return `You are proud and walking tall.${cause} You might boast a little.`;
    default:
      return "";
  }
}

module.exports = {
  CALM,
  STATES,
  NOTICEABLE_AT,
  current,
  shiftEmotion,
  decayEmotion,
  emotionLine,
};
