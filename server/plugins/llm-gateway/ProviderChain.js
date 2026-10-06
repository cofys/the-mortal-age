// ProviderChain -- Gemini -> Groq with automatic fallback.
//
// SAFETY MODEL (Jon's rule: never exceed free tier, never spend money):
// Free-tier math per provider (2026-10-06 research):
//   Gemini (AI Studio free): ~1,500 req/day, 1M tokens/day  -> call-bound at ~920 tok/call
//   Groq   (free):           ~1,000 req/day, 200K tokens/day -> TOKEN-bound at ~200 tok/call
// A chat call costs ~920 tokens (see DESIGN.md "Token budget math"), so the
// chain-wide call budget alone is NOT enough: 1000 calls x 920 tokens = 920K
// tokens, 4.6x over Groq's 200K/day token quota. We would hit Groq's 429 wall
// instead of staying comfortably inside.
// Therefore every provider carries BOTH a daily call cap AND a daily token cap,
// each set at 80% of the free tier (env-overridable):
//   Gemini: GEMINI_DAILY_CALL_CAP=1200  (free 1500), GEMINI_DAILY_TOKEN_CAP=800000  (free 1M)
//   Groq:   GROQ_DAILY_CALL_CAP=800     (free 1000), GROQ_DAILY_TOKEN_CAP=150000    (free 200K)
// Token counting is conservative: input ~= prompt chars/4, output ~= maxTokens
// (the full allowance, though real replies are far shorter). When EITHER cap is
// hit the provider is skipped for the rest of the UTC day and the chain falls
// through; if every provider is capped the gateway stays silent. Caps reset on
// UTC day rollover.
//
// - Per-provider RPM token bucket: we QUEUE and wait rather than bursting past
//   the free-tier rate limits.
// - Circuit breaker: a 429 opens the circuit immediately (explicit backpressure);
//   other errors open it after 3 consecutive failures. Cooldown default 60s.
// - Chain-wide daily call budget (default 1000 calls/day, env LLM_GATEWAY_DAILY_BUDGET)
//   is an additional coarse guard on top of the per-provider caps.
//
// NOTE: Cerebras was evaluated and dropped (2026-10-06) — it requires a payment
// method on file. providers/CerebrasProvider.js is kept implemented but OUT of
// the chain; re-add it to the providers array if that changes.

const { GeminiProvider } = require("./providers/GeminiProvider");
const { GroqProvider } = require("./providers/GroqProvider");

const MAX_QUEUE_WAIT_MS = 30_000;
const CIRCUIT_COOLDOWN_MS = 60_000;
const CIRCUIT_FAILURE_THRESHOLD = 3;

// 80% of each free tier -- the most we will ever spend in a UTC day.
const DEFAULT_CAPS = {
  gemini: { calls: 1200, tokens: 800_000 },
  groq: { calls: 800, tokens: 150_000 },
};

function parseCap(envName, fallback) {
  const value = Number(process.env[envName]);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

// Conservative per-call token estimate: input ~= prompt chars/4,
// output ~= the full maxTokens allowance (real replies are far shorter).
function estimateCallTokens(request = {}) {
  const promptChars = String(request.system ?? "").length + String(request.user ?? "").length;
  const maxTokens = Number.isFinite(request.maxTokens) ? Math.max(0, request.maxTokens) : 60;
  return Math.ceil(promptChars / 4) + maxTokens;
}

function dailyKey() {
  return new Date().toISOString().slice(0, 10);
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

// Per-provider daily spend caps. Both a call cap and a token cap; hitting
// EITHER takes the provider out for the rest of the UTC day. Conservative by
// design: we skip a call when it *would* reach the cap, not after it blows it.
class DailyCaps {
  constructor() {
    this.caps = new Map();
    this.day = dailyKey();
  }

  entry(name) {
    if (this.day !== dailyKey()) {
      this.day = dailyKey();
      this.caps.clear();
    }
    if (!this.caps.has(name)) {
      const upper = name.toUpperCase();
      const fallback = DEFAULT_CAPS[name] ?? { calls: 1000, tokens: 100_000 };
      this.caps.set(name, {
        calls: 0,
        tokens: 0,
        callCap: parseCap(`${upper}_DAILY_CALL_CAP`, fallback.calls),
        tokenCap: parseCap(`${upper}_DAILY_TOKEN_CAP`, fallback.tokens),
        warned: new Set(),
      });
    }
    return this.caps.get(name);
  }

  // Returns null when the call fits, otherwise which dimension(s) blocked it.
  blockedReason(name, estimateTokens) {
    const e = this.entry(name);
    const reasons = [];
    if (e.calls + 1 > e.callCap) reasons.push("calls");
    if (e.tokens + estimateTokens > e.tokenCap) reasons.push("tokens");
    return reasons.length > 0 ? reasons.join("+") : null;
  }

  record(name, estimateTokens) {
    const e = this.entry(name);
    e.calls += 1;
    e.tokens += estimateTokens;
  }

  warnOnce(name, reason) {
    const e = this.entry(name);
    const key = `${name}:${reason}`;
    if (e.warned.has(key)) return;
    e.warned.add(key);
    console.warn(
      `[llm-gateway] DAILY CAP reached for ${name} (${reason}) -- silent until reset`
    );
  }
}

class ProviderChain {
  constructor() {
    this.providers = [new GeminiProvider(), new GroqProvider()];
    this.limiters = new Map(this.providers.map((p) => [p.name, new RateLimiter(p.rpm)]));
    this.circuits = new Map(this.providers.map((p) => [p.name, new CircuitBreaker(p.name)]));
    this.dailyCaps = new DailyCaps();
    const envBudget = Number(process.env.LLM_GATEWAY_DAILY_BUDGET);
    this.dailyBudget = Number.isFinite(envBudget) ? Math.max(0, Math.floor(envBudget)) : 1000;
    this.callsToday = 0;
    this.callsDay = dailyKey();
  }

  budgetExceeded() {
    if (dailyKey() !== this.callsDay) {
      this.callsDay = dailyKey();
      this.callsToday = 0;
    }
    return this.callsToday >= this.dailyBudget;
  }

  async complete(request) {
    if (this.budgetExceeded()) {
      console.warn(`[llm-gateway] daily call budget (${this.dailyBudget}) exhausted -- staying silent`);
      return { ok: false, reason: "DAILY_BUDGET_EXHAUSTED", retryable: false };
    }
    for (const provider of this.providers) {
      const circuit = this.circuits.get(provider.name);
      if (circuit.isOpen) continue;
      if (!provider.configured) {
        provider.needsApiKey(); // logs once
        continue;
      }
      // Free-tier safety: skip providers whose daily call or token cap is hit.
      const estimate = estimateCallTokens(request);
      const blocked = this.dailyCaps.blockedReason(provider.name, estimate);
      if (blocked) {
        this.dailyCaps.warnOnce(provider.name, blocked);
        continue;
      }
      const limiter = this.limiters.get(provider.name);
      try {
        await limiter.acquire();
      } catch {
        circuit.recordFailure("RATE_LIMITED");
        continue;
      }
      const result = await provider.complete(request);
      if (result.ok && result.text) {
        circuit.recordSuccess();
        this.callsToday += 1;
        this.dailyCaps.record(provider.name, estimate);
        return { ...result, provider: provider.name };
      }
      circuit.recordFailure(result.reason);
      if (result.reason === "STUBBED") {
        // Key exists but LIVE is off: don't burn the other providers, the whole
        // chain is intentionally inert. The next provider would say the same.
        continue;
      }
    }
    return { ok: false, reason: "ALL_PROVIDERS_UNAVAILABLE", retryable: false };
  }

  status() {
    return {
      order: this.providers.map((p) => p.name),
      providers: this.providers.map((p) => {
        const caps = this.dailyCaps.entry(p.name);
        return {
          name: p.name,
          configured: p.configured,
          rpm: p.rpm,
          circuitOpen: this.circuits.get(p.name).isOpen,
          callsToday: caps.calls,
          callCap: caps.callCap,
          tokensToday: caps.tokens,
          tokenCap: caps.tokenCap,
        };
      }),
      dailyBudget: this.dailyBudget,
      callsToday: this.callsToday,
    };
  }
}

module.exports = { ProviderChain, RateLimiter, CircuitBreaker, DailyCaps, estimateCallTokens };
