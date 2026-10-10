"use strict";

/**
 * TickTiming — per-cycle tick wall-time instrumentation for the citizen
 * director. Measurement only, zero behavior change.
 *
 * Wraps the slow director.tick() (~60s) and the fast tickProximity() (~10s)
 * at the call sites in CitizenDirector.startTask(): each cycle records its
 * wall time plus how many citizens were processed.
 *
 * Every 5 minutes (MemoryDiag-style cadence) one INFO line is logged per
 * label: sample count, mean, p95, max cycle time (ms), and mean/max
 * citizens processed per cycle.
 *
 * Gated by CITIZEN_TICK_TIMING: default ON, set to "0" to disable. The
 * whole module is a no-op when disabled. Keeps per-label sample arrays
 * bounded to the current 5-minute window; the periodic flush sorts them
 * (a few dozen samples at most), so per-cycle overhead is one Date.now()
 * pair plus an array push.
 */

const LOG_PREFIX = "[tick-timing]";
const FLUSH_MS = 5 * 60 * 1000;
const ENABLED = (process.env.CITIZEN_TICK_TIMING ?? "1") !== "0";

// label -> { samples: number[], processed: number[], count, startedMs }
const buckets = new Map();
let flushTimer = null;
let logFn = console.log;

function ensureFlusher() {
  if (flushTimer || !ENABLED) return;
  flushTimer = setInterval(flush, FLUSH_MS);
  if (flushTimer.unref) flushTimer.unref();
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function meanOf(arr) {
  if (arr.length === 0) return 0;
  let sum = 0;
  for (const v of arr) sum += v;
  return sum / arr.length;
}

/**
 * Record one completed tick cycle. Cheap; call from the task wrappers.
 * @param {string} label - e.g. "director.tick" / "director.tickProximity"
 * @param {number} durationMs - wall time of the cycle
 * @param {number} citizensProcessed - roster citizens touched this cycle
 */
function record(label, durationMs, citizensProcessed = 0) {
  if (!ENABLED) return;
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) return;
  ensureFlusher();
  let bucket = buckets.get(label);
  if (!bucket) {
    bucket = { samples: [], processed: [], count: 0 };
    buckets.set(label, bucket);
  }
  bucket.samples.push(durationMs);
  bucket.processed.push(Number.isFinite(citizensProcessed) ? citizensProcessed : 0);
  bucket.count += 1;
}

/**
 * Emit the 5-minute summary lines and reset the window.
 * Returns the per-label summaries (useful for tests).
 */
function flush() {
  const summaries = [];
  for (const [label, bucket] of buckets) {
    // Skip labels with no samples this window: no noise lines.
    if (bucket.count === 0) {
      buckets.delete(label);
      continue;
    }
    const sorted = bucket.samples.slice().sort((a, b) => a - b);
    const summary = {
      label,
      cycles: bucket.count,
      meanMs: Math.round(meanOf(sorted) * 100) / 100,
      p95Ms: Math.round(percentile(sorted, 95) * 100) / 100,
      maxMs: sorted.length ? Math.round(sorted[sorted.length - 1] * 100) / 100 : 0,
      citizensMean: Math.round(meanOf(bucket.processed) * 100) / 100,
      citizensMax: bucket.processed.length ? Math.max(...bucket.processed) : 0,
    };
    summaries.push(summary);
    try {
      logFn(LOG_PREFIX + " " + JSON.stringify(summary));
    } catch {
      // Logging must never break the tick path.
    }
    // Reset the window.
    bucket.samples = [];
    bucket.processed = [];
    bucket.count = 0;
  }
  return summaries;
}

function stopForTests() {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  buckets.clear();
}

function setLogFnForTests(fn) {
  logFn = fn;
}

module.exports = {
  record,
  flush,
  setLogFnForTests,
  stopForTests,
  FLUSH_MS,
};
