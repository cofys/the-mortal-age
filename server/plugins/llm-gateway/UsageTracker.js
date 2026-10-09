// UsageTracker -- quota telemetry for the llm-gateway.
//
// The research found Jon's blind spot: tokensUsed flows out of
// llm:chat-response but nothing aggregates it, so the first sign of quota
// trouble is citizens going silent. This tracker fixes that:
//
//   - in-memory per-slot daily counters (calls + tokens), updated on every
//     successful chain completion;
//   - warn-once per UTC day at 50%/80%/100% of the chain-wide daily call
//     backstop (LLM_GATEWAY_DAILY_BUDGET, default 1000). The 80% line is
//     the one that matters: headroom to notice before silence;
//   - a debounced daily JSON rollup at
//     <cwd>/data/saves/llm-gateway-usage.json (env LLM_GATEWAY_USAGE_FILE),
//     keeping the last 30 UTC days. Never written on the hot path: record()
//     only marks dirty and (re)arms a 15s debounce; flush() is also called
//     on gateway shutdown.
//   - snapshot() for the ops overlay via gatewayStatus().usage.
//
// Token numbers here are the providers' reported tokensUsed where present,
// else the chain's conservative estimate — same conservatism as the caps.

const fs = require("fs");
const path = require("path");

const DEFAULT_SAVE_NAME = "llm-gateway-usage.json";
const KEEP_DAYS = 30;
const FLUSH_DEBOUNCE_MS = 15_000;

// Warn-once thresholds, as fractions of the daily backstop.
const ALERT_FRACTIONS = [0.5, 0.8, 1.0];

function defaultSavePath() {
  return path.join(process.cwd(), "data", "saves", DEFAULT_SAVE_NAME);
}

function resolveSavePath() {
  if (process.env.LLM_GATEWAY_USAGE_FILE !== undefined) {
    return process.env.LLM_GATEWAY_USAGE_FILE || null; // empty = in-memory only
  }
  return defaultSavePath();
}

class UsageTracker {
  constructor({ budget, savePath, now, onAlert } = {}) {
    this.budget = Number.isFinite(budget) ? Math.max(0, budget) : 1000;
    this.savePath = savePath === undefined ? resolveSavePath() : savePath;
    this.now = typeof now === "function" ? now : () => Date.now();
    // Allow tests to observe alerts without scraping console.
    this.onAlert = typeof onAlert === "function" ? onAlert : null;
    this.day = this.dayKey();
    this.callsToday = 0;
    this.tokensToday = 0;
    this.perSlot = new Map(); // slotKey -> { calls, tokens }
    this.alerted = new Set(); // "day:fraction"
    this.alerts = []; // today's alert records, newest last
    this.rollup = { version: 1, days: {} }; // persisted multi-day history
    this.dirty = false;
    this.flushTimer = null;
    if (this.savePath) this.load();
  }

  dayKey() {
    return new Date(this.now()).toISOString().slice(0, 10);
  }

  rolloverIfNeeded() {
    const day = this.dayKey();
    if (day === this.day) return;
    // Archive the finished day into the rollup before resetting.
    if (this.callsToday > 0 || this.tokensToday > 0) {
      this.rollup.days[this.day] = {
        calls: this.callsToday,
        tokens: this.tokensToday,
        perSlot: Object.fromEntries(this.perSlot),
      };
      this.trimRollup();
      this.dirty = true;
      this.scheduleFlush();
    }
    this.day = day;
    this.callsToday = 0;
    this.tokensToday = 0;
    this.perSlot = new Map();
    this.alerted = new Set();
    this.alerts = [];
  }

  trimRollup() {
    const days = Object.keys(this.rollup.days).sort();
    while (days.length > KEEP_DAYS) {
      delete this.rollup.days[days.shift()];
    }
  }

  record(slotKey, tokensUsed) {
    this.rolloverIfNeeded();
    const tokens = Number.isFinite(tokensUsed) ? Math.max(0, Math.floor(tokensUsed)) : 0;
    this.callsToday += 1;
    this.tokensToday += tokens;
    const entry = this.perSlot.get(slotKey) ?? { calls: 0, tokens: 0 };
    entry.calls += 1;
    entry.tokens += tokens;
    this.perSlot.set(slotKey, entry);
    this.checkAlerts();
    this.dirty = true;
    this.scheduleFlush();
  }

  checkAlerts() {
    if (this.budget <= 0) return;
    const frac = this.callsToday / this.budget;
    for (const threshold of ALERT_FRACTIONS) {
      if (frac < threshold) continue;
      const key = `${this.day}:${threshold}`;
      if (this.alerted.has(key)) continue;
      this.alerted.add(key);
      const pct = Math.round(threshold * 100);
      const message =
        `[llm-gateway] USAGE ${pct}% of daily call backstop ` +
        `(${this.callsToday}/${this.budget} calls, ~${this.tokensToday} tokens today)`;
      this.alerts.push({ at: this.now(), fraction: threshold, message });
      if (this.onAlert) this.onAlert({ fraction: threshold, message, snapshot: this.snapshot() });
      else console.warn(message);
    }
  }

  snapshot() {
    this.rolloverIfNeeded();
    const frac = this.budget > 0 ? this.callsToday / this.budget : 0;
    return {
      day: this.day,
      dailyBudget: this.budget,
      callsToday: this.callsToday,
      tokensToday: this.tokensToday,
      budgetUsedPct: Math.round(frac * 100),
      perSlot: Object.fromEntries(this.perSlot),
      alerts: this.alerts.map((a) => ({ ...a })),
      history: { ...this.rollup.days }, // last KEEP_DAYS UTC days, persisted
    };
  }

  scheduleFlush() {
    if (!this.savePath || !this.dirty || this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, FLUSH_DEBOUNCE_MS);
    // Don't keep the process alive for telemetry.
    if (typeof this.flushTimer.unref === "function") this.flushTimer.unref();
  }

  flush() {
    if (!this.savePath || !this.dirty) return;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    try {
      const dir = path.dirname(this.savePath);
      fs.mkdirSync(dir, { recursive: true });
      this.rollup.savedAt = this.now();
      const tmp = `${this.savePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.rollup, null, 2));
      fs.renameSync(tmp, this.savePath);
      this.dirty = false;
    } catch (error) {
      console.warn(`[llm-gateway] usage rollup write failed: ${error?.message ?? error}`);
    }
  }

  load() {
    try {
      if (!fs.existsSync(this.savePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.savePath, "utf8"));
      if (parsed && typeof parsed === "object" && parsed.days && typeof parsed.days === "object") {
        this.rollup = { version: 1, days: parsed.days, savedAt: parsed.savedAt };
        this.trimRollup();
      }
    } catch (error) {
      console.warn(`[llm-gateway] usage rollup read failed (starting fresh): ${error?.message ?? error}`);
    }
  }

  /** Flush pending writes; called on gateway shutdown. */
  shutdown() {
    this.flush();
  }
}

module.exports = { UsageTracker, resolveSavePath, ALERT_FRACTIONS, KEEP_DAYS };
