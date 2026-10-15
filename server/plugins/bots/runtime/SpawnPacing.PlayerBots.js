"use strict";

// Bots spawn a few per game tick so a large crowd fills in gradually instead of
// spiking CPU and memory: 8 per 600 ms is ~13 bots/s (1000 site bots in ~75 s).
const SPAWNS_PER_BATCH = 8;
const SPAWN_BATCH_DELAY_MS = 600;

/** Runs `jobs` (functions) SPAWNS_PER_BATCH at a time, then calls `onDone`. */
function runPaced(jobs, onDone = null) {
  let cursor = 0;
  const flush = () => {
    const end = Math.min(cursor + SPAWNS_PER_BATCH, jobs.length);
    while (cursor < end) jobs[cursor++]();
    if (cursor < jobs.length) {
      setTimeout(flush, SPAWN_BATCH_DELAY_MS);
    } else {
      onDone?.();
    }
  };
  flush();
}

module.exports = {
  SPAWNS_PER_BATCH,
  SPAWN_BATCH_DELAY_MS,
  runPaced,
};
