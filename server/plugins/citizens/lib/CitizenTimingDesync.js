"use strict";

/**
 * CitizenTimingDesync — breaks the synchronized citizen "wave".
 *
 * Without this, every per-tick citizen system loops the whole roster on the
 * same tick: all citizens decide to emote, greet, or start a work loop in
 * the same 10-second window, which reads as robotic. This module staggers
 * those AI updates across the tick cycle instead.
 *
 * How it works:
 *   - Each citizen gets a persistent tick offset: slotFor(username) hashes
 *     the (lowercased) username with FNV-1a and takes it modulo the spread.
 *     The slot is stable across restarts and processes — no stored state.
 *   - The director keeps a monotonically increasing tick counter and passes
 *     { tick, spread } into the per-tick citizen systems it already calls
 *     (CitizenAlive.tickAlive, CitizenWorkLoops.tickWorkLoops). Those keep
 *     their own loops; they just skip citizens whose slot doesn't match the
 *     current phase (tick % spread).
 *   - With the default spread of 10, roughly 1/10th of citizens are "due"
 *     per tick and every citizen gets a turn once per 10 ticks.
 *
 * This is pure timing logic — no LLM, no I/O, no stored state. Hook into
 * the tick, don't replace it: the director's tick structure is untouched.
 *
 * Spread is configurable via CITIZEN_DESYNC_SPREAD (default 10). A spread
 * of 1 (or any invalid value) means "everyone, every tick" — the old
 * behavior, useful for debugging.
 */

// --- tuning ------------------------------------------------------------------

const DEFAULT_SPREAD = 10;

// --- hashing -----------------------------------------------------------------

/**
 * 32-bit FNV-1a. Deterministic across restarts and processes, cheap,
 * and distributes usernames evenly enough across small spreads.
 */
function hashUsername(username) {
  const s = String(username ?? "").toLowerCase();
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function normalizeSpread(spread) {
  const n = Math.floor(Number(spread));
  if (!Number.isFinite(n) || n <= 0) {
    return DEFAULT_SPREAD;
  }
  return n;
}

// --- slots & phases ------------------------------------------------------------

/**
 * The tick offset for a citizen: 0..spread-1. Persistent — derived from the
 * username hash, so the same citizen always lands in the same slot.
 */
function slotFor(username, spread = DEFAULT_SPREAD) {
  return hashUsername(username) % normalizeSpread(spread);
}

/**
 * Which slot is due on a given tick counter: tick % spread.
 */
function phaseFor(tickCount, spread = DEFAULT_SPREAD) {
  const s = normalizeSpread(spread);
  const t = Math.floor(Number(tickCount));
  const tt = Number.isFinite(t) ? t : 0;
  return ((tt % s) + s) % s;
}

function usernameOf(record) {
  return record?.username ?? record?.name ?? "";
}

/**
 * Should this citizen's AI run on this tick? True when its hash slot
 * matches the current phase.
 */
function isCitizenDue(record, tickCount, spread = DEFAULT_SPREAD) {
  const s = normalizeSpread(spread);
  return slotFor(usernameOf(record), s) === phaseFor(tickCount, s);
}

/**
 * The subset of records due on this tick, in iteration order.
 * Convenience for systems that want a pre-filtered list instead of gating.
 */
function dueThisTick(records, tickCount, spread = DEFAULT_SPREAD) {
  const s = normalizeSpread(spread);
  const phase = phaseFor(tickCount, s);
  const out = [];
  for (const record of records ?? []) {
    if (slotFor(usernameOf(record), s) === phase) {
      out.push(record);
    }
  }
  return out;
}

/**
 * Per-slot population counts for a set of records — the desync actually
 * spreads the load (used by tests and diagnostics).
 */
function distribution(records, spread = DEFAULT_SPREAD) {
  const s = normalizeSpread(spread);
  const counts = new Array(s).fill(0);
  for (const record of records ?? []) {
    counts[slotFor(usernameOf(record), s)]++;
  }
  return counts;
}

// --- configuration -----------------------------------------------------------

/**
 * Spread from the environment (CITIZEN_DESYNC_SPREAD), falling back to
 * DEFAULT_SPREAD. Invalid values mean the old behavior is NOT applied —
 * they fall back to the default, so a typo can't silently disable desync.
 */
function configuredSpread(env = process.env) {
  const raw = env?.CITIZEN_DESYNC_SPREAD;
  if (raw == null || String(raw).trim() === "") {
    return DEFAULT_SPREAD;
  }
  const n = Math.floor(Number(String(raw).trim()));
  if (!Number.isFinite(n) || n <= 0) {
    return DEFAULT_SPREAD;
  }
  return n;
}

module.exports = {
  // tuning
  DEFAULT_SPREAD,
  // slots & phases
  slotFor,
  phaseFor,
  isCitizenDue,
  dueThisTick,
  distribution,
  // configuration
  configuredSpread,
  // exposed for tests
  _hashUsername: hashUsername,
};
