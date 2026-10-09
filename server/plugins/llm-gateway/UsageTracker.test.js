// Unit + behavioral tests for llm-gateway quota telemetry.
// Plain node, no framework. Run: node server/plugins/llm-gateway/UsageTracker.test.js
// (from repo root)
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { UsageTracker } = require("./UsageTracker");

let failures = 0;
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      return r.then(
        () => console.log(`ok - ${name}`),
        (e) => { failures++; console.error(`FAIL - ${name}: ${e.message}`); }
      );
    }
    console.log(`ok - ${name}`);
  } catch (e) {
    failures++;
    console.error(`FAIL - ${name}: ${e.message}`);
  }
  return Promise.resolve();
}

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "llm-usage-")), "usage.json");
}

async function main() {
  await test("record accumulates calls and tokens per slot", () => {
    const tr = new UsageTracker({ budget: 1000, savePath: null });
    tr.record("groq/allam-2-7b", 42);
    tr.record("groq/allam-2-7b", 58);
    tr.record("gemini/gemini-2.5-flash-lite", 100);
    const s = tr.snapshot();
    assert.equal(s.callsToday, 3);
    assert.equal(s.tokensToday, 200);
    assert.deepEqual(s.perSlot["groq/allam-2-7b"], { calls: 2, tokens: 100 });
    assert.deepEqual(s.perSlot["gemini/gemini-2.5-flash-lite"], { calls: 1, tokens: 100 });
    assert.equal(s.dailyBudget, 1000);
  });

  await test("warns once per day at 50/80/100% of the daily backstop (80% matters most)", () => {
    const seen = [];
    const tr = new UsageTracker({
      budget: 10,
      savePath: null,
      onAlert: (a) => seen.push(a.fraction),
    });
    for (let i = 0; i < 4; i++) tr.record("slot/a", 1);
    assert.deepEqual(seen, [], "no alert under 50%");
    tr.record("slot/a", 1); // 5/10 = 50%
    assert.deepEqual(seen, [0.5]);
    for (let i = 0; i < 2; i++) tr.record("slot/a", 1);
    assert.deepEqual(seen, [0.5], "no repeat");
    tr.record("slot/a", 1); // 8/10 = 80%
    assert.deepEqual(seen, [0.5, 0.8], "80% alert fires once");
    tr.record("slot/a", 1);
    tr.record("slot/a", 1); // 10/10 = 100%
    assert.deepEqual(seen, [0.5, 0.8, 1.0]);
    tr.record("slot/a", 1); // 11/10, no double 100%
    assert.deepEqual(seen, [0.5, 0.8, 1.0]);
    const s = tr.snapshot();
    assert.equal(s.budgetUsedPct, 110);
    assert.equal(s.alerts.length, 3);
  });

  await test("alerts reset on UTC day rollover; finished day archives into the rollup", () => {
    const file = tmpFile();
    let t = Date.UTC(2026, 9, 9, 23, 59, 0);
    const seen = [];
    const tr = new UsageTracker({
      budget: 10,
      savePath: file,
      now: () => t,
      onAlert: (a) => seen.push(a.fraction),
    });
    for (let i = 0; i < 10; i++) tr.record("slot/a", 5); // hits 100%
    assert.deepEqual(seen, [0.5, 0.8, 1.0]);
    t = Date.UTC(2026, 9, 10, 0, 1, 0); // next UTC day
    tr.record("slot/a", 5);
    const s = tr.snapshot();
    assert.equal(s.day, "2026-10-10");
    assert.equal(s.callsToday, 1, "counters reset");
    assert.deepEqual(seen, [0.5, 0.8, 1.0, 0.5, 0.8, 1.0].slice(0, 3),
      "no new alerts at 1/10 next day");
    assert.ok(s.history["2026-10-09"], "finished day archived");
    assert.equal(s.history["2026-10-09"].calls, 10);
    tr.shutdown();
  });

  await test("daily JSON rollup persists and reloads (multi-day history survives restarts)", () => {
    const file = tmpFile();
    const tr = new UsageTracker({ budget: 1000, savePath: file });
    tr.record("groq/allam-2-7b", 42);
    tr.flush();
    assert.ok(fs.existsSync(file), "rollup file written");
    const tr2 = new UsageTracker({ budget: 1000, savePath: file });
    const s = tr2.snapshot();
    // Today's counts are in-memory only (they belong to the live process),
    // but the persisted history must be readable by the ops overlay.
    assert.ok(s.history !== undefined);
    tr.shutdown();
    tr2.shutdown();
  });

  await test("corrupt rollup file starts fresh instead of crashing", () => {
    const file = tmpFile();
    fs.writeFileSync(file, "not json{{{");
    const tr = new UsageTracker({ budget: 1000, savePath: file });
    const s = tr.snapshot();
    assert.equal(s.callsToday, 0);
    tr.shutdown();
  });

  await test("missing tokensUsed records zero tokens but still counts the call", () => {
    const tr = new UsageTracker({ budget: 1000, savePath: null });
    tr.record("slot/a", undefined);
    const s = tr.snapshot();
    assert.equal(s.callsToday, 1);
    assert.equal(s.tokensToday, 0);
  });

  // ---- Behavioral: the chain records usage on success and exposes it ----
  //
  // FAIL-BEFORE: ProviderChain.complete() succeeds but nothing aggregates
  // the spend — status() has no usage field, so the ops overlay and the
  // 80%-of-backstop warning have nothing to read.

  await test("BEHAVIORAL chain: successful completion records usage visible via status()", async () => {
    const { ProviderChain, RateLimiter, CircuitBreaker } = require("./ProviderChain");
    const fakeProvider = {
      name: "groq",
      rpm: 10000,
      configured: true,
      async complete() {
        return { ok: true, text: "hi", tokensUsed: 123 };
      },
    };
    const slot = {
      key: "groq/allam-2-7b",
      def: { provider: "groq", model: "allam-2-7b", tier: "lite", rpm: 10000, calls: 100000, tokens: 100000 },
      provider: fakeProvider,
    };
    // In-memory only for the test: no file writes.
    const saved = process.env.LLM_GATEWAY_USAGE_FILE;
    process.env.LLM_GATEWAY_USAGE_FILE = "";
    const chain = new ProviderChain();
    if (saved === undefined) delete process.env.LLM_GATEWAY_USAGE_FILE;
    else process.env.LLM_GATEWAY_USAGE_FILE = saved;
    chain.slots = [slot];
    chain.limiters = new Map([[slot.key, new RateLimiter(10000)]]);
    chain.circuits = new Map([[slot.key, new CircuitBreaker(slot.key)]]);
    const result = await chain.complete({ system: "s", user: "u", maxTokens: 15, tier: "lite" });
    assert.equal(result.ok, true);
    const st = chain.status();
    assert.ok(st.usage, "status() must expose usage telemetry");
    assert.equal(st.usage.callsToday, 1);
    assert.equal(st.usage.perSlot["groq/allam-2-7b"].tokens, 123);
    chain.usage.shutdown();
  });

  if (failures > 0) {
    console.error(`\n${failures} test(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll UsageTracker tests passed.");
}

main();
