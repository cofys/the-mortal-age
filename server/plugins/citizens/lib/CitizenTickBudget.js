"use strict";

/**
 * CitizenTickBudget — a hard per-cycle execution budget for the citizen layer.
 *
 * The director's proximity tick runs dozens of citizen feature ticks in one
 * synchronous burst. Even with per-citizen cooldown gates, that burst can
 * exceed what the main loop should spend on citizens in a single cycle
 * (the 8GB-PC ceiling makes this a stability issue, not just a nicety).
 *
 * This module enforces a simple rule: the citizen layer gets TICK_BUDGET_MS
 * (default 30ms) per tick cycle. Feature ticks run in order; when the budget
 * is exhausted the rest are deferred to the next cycle, which resumes where
 * this one stopped (round-robin), so no feature starves.
 *
 * Notes:
 * - The budget is checked *between* items, never preempted mid-item: a
 *   single slow feature still runs to completion (synchronous JS can't be
 *   interrupted), but everything after it defers.
 * - The clock is injectable (nowFn) so tests are fully deterministic.
 * - Zero LLM, no I/O, no stored state — the director owns the cursor.
 */

const TICK_BUDGET_MS = 30;

/**
 * Start a budget. nowFn must return milliseconds (defaults to Date.now).
 */
function createBudget(budgetMs = TICK_BUDGET_MS, nowFn = Date.now) {
  const startMs = nowFn();
  const raw = Number(budgetMs);
  const budget = Number.isFinite(raw) ? Math.max(0, raw) : TICK_BUDGET_MS;
  const elapsed = () => Math.max(0, nowFn() - startMs);
  return {
    startMs,
    budgetMs: budget,
    elapsedMs: () => elapsed(),
    remainingMs: () => budget - elapsed(),
    /** True while there is budget left to start another item. */
    hasTime: () => elapsed() < budget,
  };
}

/**
 * Run items in order until the budget is exhausted.
 *
 * @param {Array} items - the work items (feature tick functions, citizens...)
 * @param {(item, index) => void} runOne - runs a single item; may throw
 *   (throwing aborts the run — callers that want per-item isolation should
 *   try/catch inside runOne, as the director already does per feature).
 * @param {object} budget - from createBudget().
 * @returns {{ ran, deferred, stoppedAt, exhausted, elapsedMs }}
 */
function runWithinBudget(items, runOne, budget) {
  const list = Array.isArray(items) ? items : [];
  const ran = [];
  let stoppedAt = list.length;
  for (let i = 0; i < list.length; i++) {
    if (!budget.hasTime()) {
      stoppedAt = i;
      break;
    }
    runOne(list[i], i);
    ran.push(list[i]);
  }
  return {
    ran,
    deferred: list.slice(stoppedAt),
    stoppedAt,
    exhausted: stoppedAt < list.length,
    elapsedMs: budget.elapsedMs(),
  };
}

/**
 * Rotate a feature list so the next cycle starts at startIndex (round-robin).
 * Pure: does not mutate the input array.
 */
function rotateStart(items, startIndex) {
  const list = Array.isArray(items) ? items.slice() : [];
  const n = list.length;
  if (n <= 1) return list;
  const k = ((Math.floor(Number(startIndex)) % n) + n) % n;
  if (k === 0 || !Number.isFinite(k)) return list;
  return list.slice(k).concat(list.slice(0, k));
}

/**
 * Advance a persistent round-robin cursor by the number of items that ran.
 * The director stores the cursor and passes it to rotateStart() next cycle.
 */
function advanceCursor(cursor, ranCount, totalCount) {
  const total = Math.floor(Number(totalCount));
  if (!Number.isFinite(total) || total <= 0) return 0;
  const c = Number.isFinite(Number(cursor)) ? Math.floor(Number(cursor)) : 0;
  const ran = Number.isFinite(Number(ranCount)) ? Math.max(0, Math.floor(Number(ranCount))) : 0;
  return (((c + ran) % total) + total) % total;
}

module.exports = {
  TICK_BUDGET_MS,
  createBudget,
  runWithinBudget,
  rotateStart,
  advanceCursor,
};
