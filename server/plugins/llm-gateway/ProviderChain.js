// ProviderChain -- quota-aware multi-model routing with automatic fallback.
//
// SAFETY MODEL (Jon's rule: never exceed free tier, never spend money):
// Free tiers are PER MODEL, not per provider. Groq gives ~1,000 req/day +
// 200K tokens/day EACH for gpt-oss-120b, gpt-oss-20b and qwen3.8-27b; Gemini
// gives ~1,500 req/day each for its flash models. Using every free model
// multiplies our headroom ~3-5x -- but only if each model is capped on its own.
//
// Model inventory — GROUND TRUTH from Jon's Groq org limits screenshot (2026-10-06).
// Groq (console.groq.com, his actual quotas):
//   Model                          RPM  Req/day  Tok/min  Tok/day
//   allam-2-7b                      30    7,000      6K     500K   <- dark horse
//   openai/gpt-oss-120b             30    1,000      8K     200K
//   openai/gpt-oss-20b              30    1,000      8K     200K
//   openai/gpt-oss-safeguard-20b     3    1,000      2K     200K   <- trickle only
//   qwen/qwen3.8-27b                30    1,000      8K     200K
//   (llama-prompt-guard rows are safety models, not chat -- ignored)
//   CONFIRMED: llama-3.3-70b-versatile is GONE from the free tier.
//   Total Groq free headroom: ~11K req/day, ~1.3M tokens/day across chat models.
// Gemini (AI Studio; Google publishes no fixed table, limits are per-project;
// widely reported ~1,500 RPD for flash models; the 429 circuit breaker is the
// backstop if a project turns out tighter):
//   gemini-2.5-flash / gemini-2.5-flash-lite / gemini-2.0-flash
//
// Slot caps below are exactly 80% of the free tier per model.
//
// Every slot carries BOTH a daily call cap AND a daily token cap at 80% of its
// free tier (env-overridable, see below). Token counting is conservative:
// input ~= prompt chars/4, output ~= maxTokens (the full allowance, though real
// replies are far shorter). When EITHER cap is hit the slot is skipped for the
// rest of the UTC day; if every slot is capped the gateway stays silent.
// Caps reset on UTC day rollover.
//
// ROUTING (intelligent, quota-aware):
//   score(slot) = remainingQuotaFraction(slot) * tierWeight(slot.tier, request.tier)
//   - remainingQuotaFraction = min(1 - calls/callCap, 1 - tokens/tokenCap)
//   - request.tier "flagship" (first contact, complex chats): flagship 1.0,
//     standard 0.55, lite 0.3
//   - request.tier "lite" or unset (routine chatter): flagship 0.75/0.3,
//     standard 0.9/0.6, lite 1.0 -- spend cheap quota first, save flagship headroom
// Slots are tried in score order. Per-slot RPM buckets and per-slot circuit
// breakers: a 429 on gpt-oss-20b does NOT take down gpt-oss-120b.
//
// Env overrides (slot-specific, then provider-level legacy, then the default):
//   <PROVIDER>_<SANITIZED_MODEL>_DAILY_CALL_CAP / _DAILY_TOKEN_CAP / _RPM
//   e.g. GROQ_OPENAI_GPT_OSS_20B_DAILY_TOKEN_CAP=50000
//   Legacy: GEMINI_DAILY_CALL_CAP, GROQ_DAILY_TOKEN_CAP, ... (applies to every
//   slot of that provider)
//
// NOTE: Cerebras was evaluated and dropped (2026-10-06) -- it requires a payment
// method on file. providers/CerebrasProvider.js is kept implemented but OUT of
// the chain; re-add it as slots if that changes.

const { GeminiProvider } = require("./providers/GeminiProvider");
const { GroqProvider } = require("./providers/GroqProvider");
const { UsageTracker } = require("./UsageTracker");

const MAX_QUEUE_WAIT_MS = 30_000;
const CIRCUIT_COOLDOWN_MS = 60_000;
const CIRCUIT_FAILURE_THRESHOLD = 3;

// Flat list of (provider, model) slots. Order is the tiebreak priority.
// Caps are exactly 80% of each model's free tier (see inventory above).
const SLOT_DEFS = [
  { provider: "gemini", model: "gemini-2.5-flash",          tier: "flagship", rpm: 15, calls: 1200, tokens: 800_000 },
  { provider: "groq",   model: "openai/gpt-oss-120b",       tier: "flagship", rpm: 24, calls: 800,  tokens: 160_000 },
  { provider: "groq",   model: "qwen/qwen3.8-27b",          tier: "flagship", rpm: 24, calls: 800,  tokens: 160_000 },
  { provider: "gemini", model: "gemini-2.0-flash",          tier: "standard", rpm: 15, calls: 1200, tokens: 800_000 },
  { provider: "groq",   model: "openai/gpt-oss-20b",        tier: "standard", rpm: 24, calls: 800,  tokens: 160_000 },
  { provider: "gemini", model: "gemini-2.5-flash-lite",     tier: "lite",     rpm: 30, calls: 1200, tokens: 800_000 },
  { provider: "groq",   model: "allam-2-7b",                tier: "lite",     rpm: 24, calls: 5600, tokens: 400_000 },
  { provider: "groq",   model: "openai/gpt-oss-safeguard-20b", tier: "drip", rpm: 2,  calls: 800,  tokens: 160_000 },
];

const PROVIDER_CLASSES = { gemini: GeminiProvider, groq: GroqProvider };

// Quality-tier weights: [request tier][slot tier]. "drip" is the safeguard
// model -- only ever used when everything else is exhausted or capped.
const TIER_WEIGHTS = {
  flagship: { flagship: 1.0, standard: 0.55, lite: 0.3,  drip: 0.1 },
  standard: { flagship: 0.75, standard: 0.9,  lite: 1.0,  drip: 0.1 },
  lite:     { flagship: 0.3,  standard: 0.6,  lite: 1.0,  drip: 0.1 },
};

function dailyKey() {
  return new Date().toISOString().slice(0, 10);
}

function parseCap(envName, fallback) {
  const value = Number(process.env[envName]);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function sanitizeModel(model) {
  return model.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

// Conservative per-call token estimate: input ~= prompt chars/4,
// output ~= the full maxTokens allowance (real replies are far shorter).
function estimateCallTokens(request = {}) {
  const promptChars = String(request.system ?? "").length + String(request.user ?? "").length;
  const maxTokens = Number.isFinite(request.maxTokens) ? Math.max(0, request.maxTokens) : 60;
  return Math.ceil(promptChars / 4) + maxTokens;
}

// Token bucket: capacity = rpm, refills steadily. acquire() waits its turn.
class RateLimiter {
  constructor(rpm) {
    this.capacity = Math.max(1, rpm);
    this.tokens = this.capacity;
    this.lastRefill = Date.now();
    this.queue = [];
  }

  refill() {
    const now = Date.now();
    const elapsedMin = (now - this.lastRefill) / 60000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedMin * this.capacity);
    this.lastRefill = now;
    while (this.tokens >= 1 && this.queue.length > 0) {
      this.tokens -= 1;
      const waiter = this.queue.shift();
      clearTimeout(waiter.timeout);
      waiter.resolve();
    }
  }

  acquire() {
    this.refill();
    return new Promise((resolve, reject) => {
      if (this.tokens >= 1 && this.queue.length === 0) {
        this.tokens -= 1;
        resolve();
        return;
      }
      const waiter = { resolve, reject };
      waiter.timeout = setTimeout(() => {
        const idx = this.queue.indexOf(waiter);
        if (idx >= 0) this.queue.splice(idx, 1);
        reject(new Error("RATE_LIMITED_QUEUE_FULL"));
      }, MAX_QUEUE_WAIT_MS);
      this.queue.push(waiter);
      // In case refill happens only on acquire, nudge a timer.
      setTimeout(() => this.refill(), Math.ceil(60000 / this.capacity) + 5);
    });
  }
}

class CircuitBreaker {
  constructor(name) {
    this.name = name;
    this.failures = 0;
    this.openedAt = 0;
  }

  get isOpen() {
    if (this.openedAt === 0) return false;
    if (Date.now() - this.openedAt > CIRCUIT_COOLDOWN_MS) {
      this.openedAt = 0; // half-open: next call is the probe
      this.failures = 0;
      console.info(`[llm-gateway] circuit half-open for ${this.name}, probing`);
      return false;
    }
    return true;
  }

  recordSuccess() {
    this.failures = 0;
    this.openedAt = 0;
  }

  recordFailure(reason) {
    this.failures += 1;
    if (reason === "RATE_LIMITED" || this.failures >= CIRCUIT_FAILURE_THRESHOLD) {
      if (this.openedAt === 0) {
        this.openedAt = Date.now();
        console.warn(
          `[llm-gateway] circuit OPEN for ${this.name} (${reason}, ${this.failures} failures) -- cooling down ${CIRCUIT_COOLDOWN_MS / 1000}s`
        );
      }
    }
  }
}

// Per-slot daily spend caps. Both a call cap and a token cap; hitting EITHER
// takes the slot out for the rest of the UTC day. Conservative by design: we
// skip a call when it *would* reach the cap, not after it blows it.
class DailyCaps {
  constructor() {
    this.caps = new Map();
    this.day = dailyKey();
  }

  entry(slotKey, def) {
    if (this.day !== dailyKey()) {
      this.day = dailyKey();
      this.caps.clear();
    }
    if (!this.caps.has(slotKey)) {
      this.caps.set(slotKey, {
        calls: 0,
        tokens: 0,
        callCap: resolveSlotNumber(def, "CALL_CAP", def.calls),
        tokenCap: resolveSlotNumber(def, "TOKEN_CAP", def.tokens),
        warned: new Set(),
      });
    }
    return this.caps.get(slotKey);
  }

  // Returns null when the call fits, otherwise which dimension(s) blocked it.
  blockedReason(slotKey, def, estimateTokens) {
    const e = this.entry(slotKey, def);
    const reasons = [];
    if (e.calls + 1 > e.callCap) reasons.push("calls");
    if (e.tokens + estimateTokens > e.tokenCap) reasons.push("tokens");
    return reasons.length > 0 ? reasons.join("+") : null;
  }

  record(slotKey, def, estimateTokens) {
    const e = this.entry(slotKey, def);
    e.calls += 1;
    e.tokens += estimateTokens;
  }

  warnOnce(slotKey, def, reason) {
    const e = this.entry(slotKey, def);
    const key = `${slotKey}:${reason}`;
    if (e.warned.has(key)) return;
    e.warned.add(key);
    console.warn(`[llm-gateway] DAILY CAP reached for ${slotKey} (${reason}) -- silent until reset`);
  }
}

// Slot-specific env var wins, then legacy provider-level, then the slot default.
function resolveSlotNumber(def, kind, fallback) {
  const slotVar = `${def.provider.toUpperCase()}_${sanitizeModel(def.model)}_DAILY_${kind}`;
  const providerVar = `${def.provider.toUpperCase()}_DAILY_${kind}`;
  const fromSlot = Number(process.env[slotVar]);
  if (Number.isFinite(fromSlot)) return Math.max(0, Math.floor(fromSlot));
  const fromProvider = Number(process.env[providerVar]);
  if (Number.isFinite(fromProvider)) return Math.max(0, Math.floor(fromProvider));
  return fallback;
}

function resolveSlotRpm(def, providerRpm) {
  const slotVar = `${def.provider.toUpperCase()}_${sanitizeModel(def.model)}_RPM`;
  const fromSlot = Number(process.env[slotVar]);
  if (Number.isFinite(fromSlot)) return Math.max(1, Math.floor(fromSlot));
  return Math.max(1, providerRpm);
}

class ProviderChain {
  constructor() {
    this.slots = SLOT_DEFS.map((def) => {
      const ProviderClass = PROVIDER_CLASSES[def.provider];
      const provider = new ProviderClass(def.model);
      const rpm = resolveSlotRpm(def, provider.rpm);
      provider.rpm = rpm;
      return { key: `${def.provider}/${def.model}`, def, provider, rpm };
    });
    this.limiters = new Map(this.slots.map((s) => [s.key, new RateLimiter(s.rpm)]));
    this.circuits = new Map(this.slots.map((s) => [s.key, new CircuitBreaker(s.key)]));
    this.dailyCaps = new DailyCaps();
    const envBudget = Number(process.env.LLM_GATEWAY_DAILY_BUDGET);
    this.dailyBudget = Number.isFinite(envBudget) ? Math.max(0, Math.floor(envBudget)) : 1000;
    this.callsToday = 0;
    this.callsDay = dailyKey();
    // Quota telemetry: per-slot daily counters + warn-once alerts at
    // 50/80/100% of the daily backstop + a debounced JSON rollup in
    // data/saves. The ops overlay reads it via status().usage.
    // LLM_GATEWAY_USAGE_FILE="" keeps it in-memory only (tests).
    this.usage = new UsageTracker({ budget: this.dailyBudget });
  }

  budgetExceeded() {
    if (dailyKey() !== this.callsDay) {
      this.callsDay = dailyKey();
      this.callsToday = 0;
    }
    return this.callsToday >= this.dailyBudget;
  }

  // Rank slots by remaining quota x quality-tier weight. Stable: SLOT_DEFS
  // order breaks ties, so provider priority is preserved when all is equal.
  rankSlots(request) {
    const weights = TIER_WEIGHTS[request.tier] || TIER_WEIGHTS.standard;
    return this.slots
      .map((slot, index) => {
        const caps = this.dailyCaps.entry(slot.key, slot.def);
        const remCalls = caps.callCap > 0 ? 1 - caps.calls / caps.callCap : 0;
        const remTokens = caps.tokenCap > 0 ? 1 - caps.tokens / caps.tokenCap : 0;
        const remaining = Math.max(0, Math.min(remCalls, remTokens));
        const weight = weights[slot.def.tier] ?? 0.5;
        return { slot, score: remaining * weight, index };
      })
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map((x) => x.slot);
  }

  async complete(request) {
    if (this.budgetExceeded()) {
      console.warn(`[llm-gateway] daily call budget (${this.dailyBudget}) exhausted -- staying silent`);
      return { ok: false, reason: "DAILY_BUDGET_EXHAUSTED", retryable: false };
    }
    const estimate = estimateCallTokens(request);
    for (const slot of this.rankSlots(request)) {
      const circuit = this.circuits.get(slot.key);
      if (circuit.isOpen) continue;
      if (!slot.provider.configured) {
        slot.provider.needsApiKey(); // logs once
        continue;
      }
      // Free-tier safety: skip slots whose daily call or token cap is hit.
      const blocked = this.dailyCaps.blockedReason(slot.key, slot.def, estimate);
      if (blocked) {
        this.dailyCaps.warnOnce(slot.key, slot.def, blocked);
        continue;
      }
      const limiter = this.limiters.get(slot.key);
      try {
        await limiter.acquire();
      } catch {
        circuit.recordFailure("RATE_LIMITED");
        continue;
      }
      const result = await slot.provider.complete(request);
      if (result.ok && result.text) {
        circuit.recordSuccess();
        this.callsToday += 1;
        this.dailyCaps.record(slot.key, slot.def, estimate);
        // Telemetry: provider-reported tokens where available, else the same
        // conservative estimate the caps use. Never on a failure path.
        this.usage.record(slot.key, result.tokensUsed ?? estimate);
        return { ...result, provider: slot.def.provider, model: slot.def.model };
      }
      circuit.recordFailure(result.reason);
      if (result.reason === "STUBBED") {
        // Key exists but LIVE is off: don't burn the other slots, the whole
        // chain is intentionally inert. The next slot would say the same.
        continue;
      }
    }
    return { ok: false, reason: "ALL_SLOTS_UNAVAILABLE", retryable: false };
  }

  status() {
    return {
      order: this.slots.map((s) => s.key),
      slots: this.slots.map((s) => {
        const caps = this.dailyCaps.entry(s.key, s.def);
        return {
          key: s.key,
          tier: s.def.tier,
          configured: s.provider.configured,
          rpm: s.rpm,
          circuitOpen: this.circuits.get(s.key).isOpen,
          callsToday: caps.calls,
          callCap: caps.callCap,
          tokensToday: caps.tokens,
          tokenCap: caps.tokenCap,
        };
      }),
      dailyBudget: this.dailyBudget,
      callsToday: this.callsToday,
      // Quota telemetry for the ops overlay: per-slot daily counters,
      // 50/80/100% backstop alerts, and the persisted multi-day history.
      usage: this.usage.snapshot(),
    };
  }
}

module.exports = { ProviderChain, RateLimiter, CircuitBreaker, DailyCaps, estimateCallTokens, SLOT_DEFS };
