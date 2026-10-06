// ProviderChain -- Cerebras -> Gemini -> Groq with automatic fallback.
//
// - Per-provider RPM token bucket: we QUEUE and wait rather than bursting past
//   the free-tier rate limits (Cerebras/Groq both enforce RPM).
// - Circuit breaker: a 429 opens the circuit immediately (explicit backpressure);
//   other errors open it after 3 consecutive failures. Cooldown default 60s.
// - Daily call budget guard (default 1000 calls/day, env LLM_GATEWAY_DAILY_BUDGET)
//   keeps us well under Cerebras's 1M free tokens/day.

const { CerebrasProvider } = require("./providers/CerebrasProvider");
const { GeminiProvider } = require("./providers/GeminiProvider");
const { GroqProvider } = require("./providers/GroqProvider");

const MAX_QUEUE_WAIT_MS = 30_000;
const CIRCUIT_COOLDOWN_MS = 60_000;
const CIRCUIT_FAILURE_THRESHOLD = 3;

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

class ProviderChain {
  constructor() {
    this.providers = [new CerebrasProvider(), new GeminiProvider(), new GroqProvider()];
    this.limiters = new Map(this.providers.map((p) => [p.name, new RateLimiter(p.rpm)]));
    this.circuits = new Map(this.providers.map((p) => [p.name, new CircuitBreaker(p.name)]));
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
      providers: this.providers.map((p) => ({
        name: p.name,
        configured: p.configured,
        rpm: p.rpm,
        circuitOpen: this.circuits.get(p.name).isOpen,
      })),
      dailyBudget: this.dailyBudget,
      callsToday: this.callsToday,
    };
  }
}

module.exports = { ProviderChain, RateLimiter, CircuitBreaker };
