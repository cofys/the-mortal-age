"use strict";

/**
 * humanizer — the anti-bot-tell kit. Perfection is the bot tell: uniform
 * sleeps, exact waypoints, instant reactions. Everything here is seeded per
 * agent (username hash) so behavior is stable per citizen but varied across
 * the population, and timing is log-normal — never uniform-random sleeps.
 */

// Park-Miller-ish; good enough for cosmetic jitter, no crypto needed.
function hashSeed(text) {
  const input = String(text ?? "");
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed) {
  let state = (Number(seed) >>> 0) || 1;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal via Box-Muller. */
function gaussian(rng) {
  const random = typeof rng === "function" ? rng : Math.random;
  let u = 0;
  let v = 0;
  while (u === 0) u = random();
  while (v === 0) v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Log-normal timing jitter: most waits cluster near the median, with a long
 * tail of distracted pauses — the way humans actually behave. sigma ~0.5 is
 * subtle, ~1.0 is visibly human.
 */
function logNormalJitter(rng, medianMs, sigma = 0.7) {
  const safeMedian = Math.max(1, Number(medianMs) || 1);
  const safeSigma = Math.max(0.05, Number(sigma) || 0.7);
  return Math.max(1, Math.round(safeMedian * Math.exp(gaussian(rng) * safeSigma)));
}

/** Uniform disc offset so waypoints are approached, never pixel-stacked. */
function noisyTile(x, y, radius, rng) {
  const random = typeof rng === "function" ? rng : Math.random;
  const safeRadius = Math.max(0, Number(radius) || 0);
  if (safeRadius <= 0) {
    return { x: Math.round(x), y: Math.round(y) };
  }
  const angle = random() * 2 * Math.PI;
  const distance = Math.sqrt(random()) * safeRadius;
  return {
    x: Math.round(x + Math.cos(angle) * distance),
    y: Math.round(y + Math.sin(angle) * distance),
  };
}

/** True with probability p per call. */
function chance(rng, p) {
  const random = typeof rng === "function" ? rng : Math.random;
  return random() < p;
}

/**
 * Per-agent humanizer profile derived from personality traits. Rates are per
 * decision-point, not per tick — call sites decide how often they roll.
 */
function humanizerProfile(personality) {
  const traits = new Set(personality?.traits ?? []);
  return {
    // Log-normal sigma for timing: fidgety citizens vary more.
    tempoSigma: traits.has("fidgety") ? 1.0 : traits.has("methodical") ? 0.45 : 0.7,
    // Chance of an idle pause before starting a new leg / line.
    pauseRate: traits.has("daydreamer") ? 0.25 : traits.has("dutiful") ? 0.04 : 0.1,
    // Chance of a 1-2 tile misclick on a waypoint (corrected next decision).
    misclickRate: traits.has("clumsy") ? 0.08 : 0.02,
    // Chat eagerness multiplier.
    chatRate: traits.has("chatty") ? 1.6 : traits.has("taciturn") ? 0.4 : 1.0,
    // Stranger-challenge eagerness (guards).
    challengeRate: traits.has("suspicious") ? 1.5 : traits.has("easygoing") ? 0.5 : 1.0,
  };
}

/** Build a stable per-agent RNG from any seed string (usually the username). */
function agentRng(seedText) {
  return mulberry32(hashSeed(seedText));
}

module.exports = {
  hashSeed,
  mulberry32,
  agentRng,
  gaussian,
  logNormalJitter,
  noisyTile,
  chance,
  humanizerProfile,
};
