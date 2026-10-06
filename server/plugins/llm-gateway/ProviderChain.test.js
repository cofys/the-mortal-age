// Unit tests for the free-tier spend ceilings in ProviderChain.
// Isolated: fake providers, no network, no server.
// Run: node server/plugins/llm-gateway/ProviderChain.test.js   (from repo root)
const assert = require("node:assert/strict");
const { ProviderChain, RateLimiter, CircuitBreaker, estimateCallTokens } = require("./ProviderChain");

// A fake provider that always succeeds; records how many times it was hit.
function fakeProvider(name, rpm = 10000) {
  return {
    name,
    rpm,
    configured: true,
    hits: 0,
    async complete() {
      this.hits += 1;
      return { ok: true, text: "hello" };
    },
  };
}

function chainWith(...providers) {
  const chain = new ProviderChain();
  chain.providers = providers;
  chain.limiters = new Map(providers.map((p) => [p.name, new RateLimiter(p.rpm)]));
  chain.circuits = new Map(providers.map((p) => [p.name, new CircuitBreaker(p.name)]));
  return chain;
}

const REQUEST = { system: "s".repeat(400), user: "u".repeat(400), maxTokens: 60 };
const ESTIMATE = 200 + 60; // 800 prompt chars / 4 + 60 output

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
}

async function main() {
  // 1. Token estimate math: conservative, exact.
  assert.equal(estimateCallTokens(REQUEST), ESTIMATE, "estimate = prompt/4 + maxTokens");
  assert.equal(estimateCallTokens({}), 60, "empty request defaults to 60 output tokens");
  assert.equal(estimateCallTokens({ system: "ab" }), 61, "ceil(2/4)=1 + 60");

  // 2. Token cap: blocked BEFORE blowing it, not after.
  await withEnv({ GROQ_DAILY_TOKEN_CAP: String(ESTIMATE * 2 - 1) }, async () => {
    const groq = fakeProvider("groq");
    const chain = chainWith(groq);
    const r1 = await chain.complete(REQUEST);
    assert.equal(r1.provider, "groq", "first call fits under the cap");
    assert.equal(groq.hits, 1);
    // Second call would take us to 2*ESTIMATE > cap -> skipped -> no providers left.
    const r2 = await chain.complete(REQUEST);
    assert.equal(r2.ok, false, "second call blocked by token cap");
    assert.equal(groq.hits, 1, "blocked call never reached the provider");
    assert.equal(chain.dailyCaps.entry("groq").tokens, ESTIMATE, "only spent tokens counted");
  });

  // 3. Call cap: N calls allowed, N+1 blocked.
  await withEnv({ GROQ_DAILY_CALL_CAP: "2" }, async () => {
    const groq = fakeProvider("groq");
    const chain = chainWith(groq);
    assert.ok((await chain.complete(REQUEST)).ok);
    assert.ok((await chain.complete(REQUEST)).ok);
    const r3 = await chain.complete(REQUEST);
    assert.equal(r3.ok, false, "third call blocked by call cap");
    assert.equal(groq.hits, 2);
  });

  // 4. Fallthrough: capped provider skipped, next provider serves.
  await withEnv({ GROQ_DAILY_CALL_CAP: "0" }, async () => {
    const groq = fakeProvider("groq");
    const gemini = fakeProvider("gemini");
    const chain = chainWith(groq, gemini);
    const r = await chain.complete(REQUEST);
    assert.equal(r.provider, "gemini", "falls through past capped groq");
    assert.equal(groq.hits, 0);
    assert.equal(gemini.hits, 1);
  });

  // 5. All capped -> silent, correct reason.
  await withEnv({ GROQ_DAILY_CALL_CAP: "0", GEMINI_DAILY_CALL_CAP: "0" }, async () => {
    const chain = chainWith(fakeProvider("groq"), fakeProvider("gemini"));
    const r = await chain.complete(REQUEST);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "ALL_PROVIDERS_UNAVAILABLE");
  });

  // 6. UTC day rollover resets caps.
  await withEnv({}, async () => {
    const groq = fakeProvider("groq");
    const chain = chainWith(groq);
    await chain.complete(REQUEST);
    assert.equal(chain.dailyCaps.entry("groq").calls, 1);
    chain.dailyCaps.day = "2000-01-01"; // force a stale day
    await chain.complete(REQUEST);
    assert.equal(chain.dailyCaps.entry("groq").calls, 1, "counters reset on new day");
    assert.equal(groq.hits, 2);
  });

  // 7. Env overrides: valid values win, garbage falls back to safe defaults.
  await withEnv(
    {
      GEMINI_DAILY_TOKEN_CAP: "12345",
      GEMINI_DAILY_CALL_CAP: "42",
      GROQ_DAILY_TOKEN_CAP: "not-a-number",
    },
    async () => {
      const chain = new ProviderChain();
      assert.equal(chain.dailyCaps.entry("gemini").tokenCap, 12345);
      assert.equal(chain.dailyCaps.entry("gemini").callCap, 42);
      assert.equal(chain.dailyCaps.entry("groq").tokenCap, 150_000, "garbage env -> safe default");
    }
  );

  // 8. Defaults are the documented 80%-of-free-tier numbers.
  await withEnv(
    {
      GEMINI_DAILY_TOKEN_CAP: undefined,
      GEMINI_DAILY_CALL_CAP: undefined,
      GROQ_DAILY_TOKEN_CAP: undefined,
      GROQ_DAILY_CALL_CAP: undefined,
    },
    async () => {
      const chain = new ProviderChain();
      assert.deepEqual(
        {
          gCalls: chain.dailyCaps.entry("gemini").callCap,
          gTokens: chain.dailyCaps.entry("gemini").tokenCap,
          qCalls: chain.dailyCaps.entry("groq").callCap,
          qTokens: chain.dailyCaps.entry("groq").tokenCap,
        },
        { gCalls: 1200, gTokens: 800_000, qCalls: 800, qTokens: 150_000 }
      );
    }
  );

  // 9. Chain-wide budget still guards on top.
  await withEnv({ LLM_GATEWAY_DAILY_BUDGET: "1" }, async () => {
    const chain = chainWith(fakeProvider("gemini"));
    assert.ok((await chain.complete(REQUEST)).ok);
    const r = await chain.complete(REQUEST);
    assert.equal(r.reason, "DAILY_BUDGET_EXHAUSTED");
  });

  console.log("ProviderChain cap tests: all 9 groups passed");
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
