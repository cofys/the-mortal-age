// Unit tests for the slot-based free-tier spend ceilings + intelligent routing.
// Isolated: fake slots, no network, no server.
// Run: node server/plugins/llm-gateway/ProviderChain.test.js   (from repo root)
const assert = require("node:assert/strict");
const {
  ProviderChain,
  RateLimiter,
  CircuitBreaker,
  estimateCallTokens,
  SLOT_DEFS,
} = require("./ProviderChain");
const { GroqProvider } = require("./providers/GroqProvider");

// Fake slot: { key, def, provider }. def carries quota defaults like SLOT_DEFS.
function fakeSlot(provider, model, tier, rpm = 10000) {
  const fake = {
    name: provider,
    rpm,
    configured: true,
    hits: 0,
    async complete() {
      this.hits += 1;
      return { ok: true, text: "hi" };
    },
  };
  return {
    key: `${provider}/${model}`,
    def: { provider, model, tier, rpm, calls: 100000, tokens: 100000 },
    provider: fake,
  };
}

function testChain(slots) {
  const chain = new ProviderChain();
  chain.slots = slots;
  chain.limiters = new Map(slots.map((s) => [s.key, new RateLimiter(s.def.rpm)]));
  chain.circuits = new Map(slots.map((s) => [s.key, new CircuitBreaker(s.key)]));
  chain.dailyCaps = new (require("./ProviderChain").DailyCaps)();
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

  // 2. Slot inventory: 8 slots, exact confirmed-free model IDs, dead default gone.
  assert.equal(SLOT_DEFS.length, 8, "eight model slots");
  const models = SLOT_DEFS.map((s) => s.model);
  for (const m of [
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.0-flash",
    "openai/gpt-oss-120b",
    "openai/gpt-oss-20b",
    "qwen/qwen3.8-27b",
    "allam-2-7b",
    "openai/gpt-oss-safeguard-20b",
  ]) {
    assert.ok(models.includes(m), `slot inventory includes ${m}`);
  }
  assert.ok(!models.some((m) => m.includes("llama")), "llama-3.3-70b is gone from free tier");
  assert.equal(
    new GroqProvider().model,
    "openai/gpt-oss-120b",
    "Groq default is a confirmed-free model"
  );
  const allam = SLOT_DEFS.find((s) => s.model === "allam-2-7b");
  assert.deepEqual(
    { calls: allam.calls, tokens: allam.tokens, rpm: allam.rpm },
    { calls: 5600, tokens: 400_000, rpm: 24 },
    "allam-2-7b caps are exactly 80% of 7000/500K/30"
  );

  // 3. Per-slot token cap: blocked BEFORE blowing it.
  await withEnv({ GROQ_TESTMX_DAILY_TOKEN_CAP: String(ESTIMATE * 2 - 1) }, async () => {
    const slot = fakeSlot("groq", "testmx", "standard");
    const chain = testChain([slot]);
    const r1 = await chain.complete(REQUEST);
    assert.ok(r1.ok, "first call fits under the cap");
    assert.equal(slot.provider.hits, 1);
    const r2 = await chain.complete(REQUEST);
    assert.equal(r2.ok, false, "second call blocked by token cap");
    assert.equal(slot.provider.hits, 1, "blocked call never reached the slot");
  });

  // 4. Per-slot circuit isolation: 429 on one model doesn't kill its siblings.
  await withEnv({}, async () => {
    const bad = fakeSlot("groq", "model-a", "flagship");
    bad.provider.complete = async () => {
      bad.provider.hits += 1;
      return { ok: false, reason: "RATE_LIMITED" };
    };
    const good = fakeSlot("groq", "model-b", "flagship");
    const chain = testChain([bad, good]);
    const r = await chain.complete(REQUEST);
    assert.equal(r.model, "model-b", "sibling slot serves after 429");
    assert.equal(good.provider.hits, 1);
    assert.ok(chain.circuits.get(bad.key).isOpen, "429 opened the bad slot's circuit");
    assert.ok(!chain.circuits.get(good.key).isOpen, "sibling circuit stays closed");
  });

  // 5. Routing: flagship requests prefer flagship slots; routine prefers lite.
  await withEnv({}, async () => {
    const flagship = fakeSlot("groq", "big", "flagship");
    const lite = fakeSlot("groq", "small", "lite");
    const drip = fakeSlot("groq", "guard", "drip");
    const chain = testChain([drip, lite, flagship]); // worst order on purpose
    const r1 = await chain.complete({ ...REQUEST, tier: "flagship" });
    assert.equal(r1.model, "big", "flagship request routes to flagship slot");
    const r2 = await chain.complete({ ...REQUEST });
    assert.equal(r2.model, "small", "routine request prefers lite slot");
  });

  // 6. Quota-aware: a nearly-drained slot is deprioritized.
  await withEnv({}, async () => {
    const a = fakeSlot("groq", "a", "flagship");
    const b = fakeSlot("groq", "b", "flagship");
    const chain = testChain([a, b]);
    chain.dailyCaps.entry(a.key, a.def).calls = 99999; // 1 call of quota left
    const r = await chain.complete({ ...REQUEST, tier: "flagship" });
    assert.equal(r.model, "b", "depleted slot loses the ranking");
  });

  // 7. Every slot capped -> silence with the right reason.
  await withEnv({ GROQ_CAPD_DAILY_CALL_CAP: "0", GEMINI_CAPD_DAILY_CALL_CAP: "0" }, async () => {
    const chain = testChain([fakeSlot("groq", "capd", "lite"), fakeSlot("gemini", "capd", "lite")]);
    const r = await chain.complete(REQUEST);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "ALL_SLOTS_UNAVAILABLE");
  });

  // 8. Env overrides: slot-level wins, then provider-level, then default; garbage -> default.
  await withEnv(
    {
      GROQ_OPENAI_GPT_OSS_20B_DAILY_CALL_CAP: "42",
      GROQ_DAILY_TOKEN_CAP: "777",
      GEMINI_DAILY_CALL_CAP: "not-a-number",
    },
    async () => {
      const chain = new ProviderChain();
      const slot20b = SLOT_DEFS.find((s) => s.model === "openai/gpt-oss-20b");
      const slot120b = SLOT_DEFS.find((s) => s.model === "openai/gpt-oss-120b");
      assert.equal(
        chain.dailyCaps.entry("groq/openai/gpt-oss-20b", slot20b).callCap,
        42,
        "slot-level env wins"
      );
      assert.equal(
        chain.dailyCaps.entry("groq/openai/gpt-oss-120b", slot120b).tokenCap,
        777,
        "provider-level env is the fallback"
      );
      const gemSlot = SLOT_DEFS.find((s) => s.model === "gemini-2.5-flash");
      assert.equal(
        chain.dailyCaps.entry("gemini/gemini-2.5-flash", gemSlot).callCap,
        1200,
        "garbage env falls back to safe default"
      );
    }
  );

  // 9. UTC day rollover resets per-slot counters.
  await withEnv({}, async () => {
    const slot = fakeSlot("groq", "roll", "lite");
    const chain = testChain([slot]);
    await chain.complete(REQUEST);
    assert.equal(chain.dailyCaps.entry(slot.key, slot.def).calls, 1);
    chain.dailyCaps.day = "2000-01-01"; // force a stale day
    await chain.complete(REQUEST);
    assert.equal(chain.dailyCaps.entry(slot.key, slot.def).calls, 1, "counters reset on new day");
    assert.equal(slot.provider.hits, 2);
  });

  // 10. Chain-wide budget still guards on top of slot caps.
  await withEnv({ LLM_GATEWAY_DAILY_BUDGET: "1" }, async () => {
    const chain = testChain([fakeSlot("gemini", "one", "flagship")]);
    assert.ok((await chain.complete(REQUEST)).ok);
    const r = await chain.complete(REQUEST);
    assert.equal(r.reason, "DAILY_BUDGET_EXHAUSTED");
  });

  console.log("ProviderChain slot tests: all 10 groups passed");
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
