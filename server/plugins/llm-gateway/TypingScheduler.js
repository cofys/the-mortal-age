// TypingScheduler -- citizen bots never reply instantly.
//
// Delay = simulated typing at 40-60 words/minute over the reply length, plus a
// small human jitter. Latest message wins per (citizen, requester): if a player
// sends a second line while a reply is queued, the queued one is replaced.

const MIN_DELAY_MS = 900;
const MAX_DELAY_MS = 10_000; // cap: a paragraph shouldn't take half a minute
const JITTER_MIN_MS = 400;
const JITTER_MAX_MS = 1600;

function typingDelayMs(reply) {
  const words = String(reply ?? "").trim().split(/\s+/).filter(Boolean).length || 1;
  const wpm = 40 + Math.random() * 20; // 40-60 wpm
  const typing = (words / wpm) * 60_000;
  const jitter = JITTER_MIN_MS + Math.random() * (JITTER_MAX_MS - JITTER_MIN_MS);
  return Math.round(Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, typing + jitter)));
}

class TypingScheduler {
  constructor() {
    this.pending = new Map(); // `${citizen}|${requester}` -> timeout id
  }

  key(citizenUsername, requesterUsername) {
    return `${String(citizenUsername).toLowerCase()}|${String(requesterUsername).toLowerCase()}`;
  }

  // Queue fn to run after the typing delay; replaces any pending reply for the
  // same (citizen, requester) pair. Returns { cancel }.
  schedule(citizenUsername, requesterUsername, reply, fn) {
    const key = this.key(citizenUsername, requesterUsername);
    this.cancel(key);
    const delayMs = typingDelayMs(reply);
    const timeout = setTimeout(() => {
      this.pending.delete(key);
      Promise.resolve().then(fn).catch((error) =>
        console.warn(`[llm-gateway] scheduled reply failed for ${citizenUsername}`, error?.message ?? error)
      );
    }, delayMs);
    // Don't keep the process alive for a pending reply on shutdown.
    timeout.unref?.();
    this.pending.set(key, timeout);
    return { cancel: () => this.cancel(key), delayMs };
  }

  cancel(key) {
    const existing = this.pending.get(key);
    if (existing) {
      clearTimeout(existing);
      this.pending.delete(key);
    }
  }

  cancelAll() {
    for (const timeout of this.pending.values()) clearTimeout(timeout);
    this.pending.clear();
  }

  pendingCount() {
    return this.pending.size;
  }
}

module.exports = { TypingScheduler, typingDelayMs };
