// PlayerThrottles -- per-PLAYER rate limits on citizen LLM replies.
//
// The research (hidden_files/llm-cost-research.md) found the one unbounded
// cost vector: a single player can farm calls. Per-citizen cooldowns (8s PM,
// 30s public) rotate across the citizen pool, so one spammer near 100
// citizens sustains ~24 calls/min and burns the 1,000-call daily backstop in
// ~40 minutes. These throttles bound the INPUT side: one player can never
// sustain more than ~50 LLM replies/hour on public chat, and gets a daily
// PM budget on top of the per-citizen 8s cooldown.
//
// Human-plausibility note: this is what a real player would do — ignore the
// spammer. The zero-LLM scripted reactions (CitizenHeardReactions) still fire
// for matchable lines, and the moment the window passes, citizens talk to
// them again. Nothing here is permanent: the public window slides, the PM
// budget rolls over at UTC midnight. Silence is free, and so is forgiveness.
//
// Env:
//   LLM_GATEWAY_PUBLIC_PER_PLAYER_MAX (default 4) -- max LLM-triggered public
//       replies per requesting player per window (4/5min ~= 48/hr)
//   LLM_GATEWAY_PUBLIC_PER_PLAYER_WINDOW_MS (default 300000)
//   LLM_GATEWAY_PM_PER_PLAYER_DAILY_MAX (default 200) -- max LLM-triggered
//       PM replies per requesting player per UTC day

const DEFAULT_PUBLIC_MAX = 4;
const DEFAULT_PUBLIC_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_PM_DAILY_MAX = 200;

// Cap on tracked players: pruning pass drops entries whose activity is
// entirely outside the relevant window, so this only bounds pathological
// growth (e.g. a bot cycling thousands of names).
const MAX_TRACKED_PLAYERS = 5000;

const normalize = (name) => String(name ?? "").toLowerCase().trim();

function envInt(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? Math.max(0, Math.floor(v)) : fallback;
}

class PlayerThrottles {
  constructor({ publicMax, publicWindowMs, pmDailyMax, now } = {}) {
    this.publicMax = publicMax ?? envInt("LLM_GATEWAY_PUBLIC_PER_PLAYER_MAX", DEFAULT_PUBLIC_MAX);
    this.publicWindowMs = publicWindowMs ?? envInt("LLM_GATEWAY_PUBLIC_PER_PLAYER_WINDOW_MS", DEFAULT_PUBLIC_WINDOW_MS);
    this.pmDailyMax = pmDailyMax ?? envInt("LLM_GATEWAY_PM_PER_PLAYER_DAILY_MAX", DEFAULT_PM_DAILY_MAX);
    this.now = typeof now === "function" ? now : () => Date.now();
    this.publicHits = new Map(); // playerKey -> [timestamp, ...] of GRANTED public replies
    this.pmCounts = new Map(); // playerKey -> { day, count }
  }

  dayKey() {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  prunePublic() {
    if (this.publicHits.size < MAX_TRACKED_PLAYERS) return;
    const cutoff = this.now() - this.publicWindowMs;
    for (const [key, hits] of this.publicHits) {
      const fresh = hits.filter((t) => t > cutoff);
      if (fresh.length === 0) this.publicHits.delete(key);
      else this.publicHits.set(key, fresh);
    }
  }

  /**
   * Public-chat path: may this player's line trigger one more LLM reply?
   * Sliding window — only GRANTED replies consume budget, so a denied
   * citizen-cooldown doesn't punish the player. The window decays on its
   * own: five quiet minutes restore the full allowance.
   */
  checkPublicReply(playerName) {
    const key = normalize(playerName);
    if (!key) return false;
    if (this.publicMax === 0) return false;
    const now = this.now();
    const cutoff = now - this.publicWindowMs;
    const hits = (this.publicHits.get(key) ?? []).filter((t) => t > cutoff);
    if (hits.length >= this.publicMax) {
      this.publicHits.set(key, hits); // keep the pruned list
      return false;
    }
    hits.push(now);
    this.publicHits.set(key, hits);
    this.prunePublic();
    return true;
  }

  /**
   * PM path: per-player daily budget on top of the per-citizen cooldown.
   * Rolls over at UTC midnight — a heavy chatter is never silenced forever.
   */
  checkPmReply(playerName) {
    const key = normalize(playerName);
    if (!key) return false;
    if (this.pmDailyMax === 0) return false;
    const day = this.dayKey();
    const entry = this.pmCounts.get(key);
    const count = entry && entry.day === day ? entry.count : 0;
    if (count >= this.pmDailyMax) return false;
    this.pmCounts.set(key, { day, count: count + 1 });
    if (this.pmCounts.size >= MAX_TRACKED_PLAYERS) {
      // Stale-day entries are dead weight; drop anything not from today.
      for (const [k, e] of this.pmCounts) {
        if (e.day !== day) this.pmCounts.delete(k);
      }
    }
    return true;
  }

  /** Read-only view for ops/status: where does this player stand? */
  stats(playerName) {
    const key = normalize(playerName);
    const now = this.now();
    const cutoff = now - this.publicWindowMs;
    const publicUsed = (this.publicHits.get(key) ?? []).filter((t) => t > cutoff).length;
    const day = this.dayKey();
    const pmEntry = this.pmCounts.get(key);
    const pmUsed = pmEntry && pmEntry.day === day ? pmEntry.count : 0;
    return {
      player: key,
      public: { used: publicUsed, max: this.publicMax, windowMs: this.publicWindowMs },
      pm: { used: pmUsed, max: this.pmDailyMax, day },
    };
  }
}

module.exports = {
  PlayerThrottles,
  DEFAULT_PUBLIC_MAX,
  DEFAULT_PUBLIC_WINDOW_MS,
  DEFAULT_PM_DAILY_MAX,
};
