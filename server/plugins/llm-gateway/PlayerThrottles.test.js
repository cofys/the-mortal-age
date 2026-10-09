// Unit + behavioral tests for per-player LLM reply throttles.
// Plain node, no framework. Run: node server/plugins/llm-gateway/PlayerThrottles.test.js
// (from repo root)
const assert = require("node:assert/strict");
const {
  PlayerThrottles,
  DEFAULT_PUBLIC_MAX,
  DEFAULT_PM_DAILY_MAX,
} = require("./PlayerThrottles");
const { ChatInterceptor } = require("./ChatInterceptor");

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

// ---- PlayerThrottles unit behavior ----

async function main() {
  await test("public: allows up to the per-player max, then denies", () => {
    let t = 1_000_000;
    const th = new PlayerThrottles({ publicMax: 4, now: () => t });
    for (let i = 0; i < 4; i++) assert.equal(th.checkPublicReply("Spammer"), true);
    assert.equal(th.checkPublicReply("Spammer"), false);
    assert.equal(th.checkPublicReply("Spammer"), false);
  });

  await test("public: different players have independent budgets", () => {
    let t = 1_000_000;
    const th = new PlayerThrottles({ publicMax: 2, now: () => t });
    assert.equal(th.checkPublicReply("Alice"), true);
    assert.equal(th.checkPublicReply("Alice"), true);
    assert.equal(th.checkPublicReply("Alice"), false);
    assert.equal(th.checkPublicReply("Bob"), true); // unaffected
  });

  await test("public: window slides — quiet time restores the allowance (no permanent silence)", () => {
    let t = 1_000_000;
    const th = new PlayerThrottles({ publicMax: 2, publicWindowMs: 60_000, now: () => t });
    assert.equal(th.checkPublicReply("Spammer"), true);
    assert.equal(th.checkPublicReply("Spammer"), true);
    assert.equal(th.checkPublicReply("Spammer"), false);
    t += 61_000; // window passes
    assert.equal(th.checkPublicReply("Spammer"), true, "decays, never permanent");
    assert.equal(th.checkPublicReply("Spammer"), true);
    assert.equal(th.checkPublicReply("Spammer"), false);
  });

  await test("public: only granted replies consume budget (denied citizen-cooldown doesn't punish)", () => {
    // checkPublicReply is only CALLED for granted replies — a caller-side
    // contract, but the throttle itself must count grants, not attempts.
    let t = 1_000_000;
    const th = new PlayerThrottles({ publicMax: 3, now: () => t });
    th.checkPublicReply("Spammer");
    assert.deepEqual(th.stats("Spammer").public.used, 1);
  });

  await test("public: names normalize (case/whitespace)", () => {
    let t = 1_000_000;
    const th = new PlayerThrottles({ publicMax: 1, now: () => t });
    assert.equal(th.checkPublicReply("Spammer"), true);
    assert.equal(th.checkPublicReply("  SPAMMER "), false, "same player, normalized");
  });

  await test("pm: daily budget caps per player, rolls over at UTC midnight", () => {
    let t = Date.UTC(2026, 9, 9, 12, 0, 0);
    const th = new PlayerThrottles({ pmDailyMax: 3, now: () => t });
    assert.equal(th.checkPmReply("Chatter"), true);
    assert.equal(th.checkPmReply("Chatter"), true);
    assert.equal(th.checkPmReply("Chatter"), true);
    assert.equal(th.checkPmReply("Chatter"), false);
    assert.equal(th.checkPmReply("Other"), true, "independent per player");
    t = Date.UTC(2026, 9, 10, 0, 0, 1); // next UTC day
    assert.equal(th.checkPmReply("Chatter"), true, "rolls over, never permanent");
  });

  await test("defaults match research numbers", () => {
    assert.equal(DEFAULT_PUBLIC_MAX, 4); // ~48/hr, under the ~50/hr bar
    assert.equal(DEFAULT_PM_DAILY_MAX, 200);
  });

  await test("max of 0 denies everything (kill-switch via env)", () => {
    const th = new PlayerThrottles({ publicMax: 0, pmDailyMax: 0 });
    assert.equal(th.checkPublicReply("Anyone"), false);
    assert.equal(th.checkPmReply("Anyone"), false);
  });

  // ---- Behavioral: the PM spam vector, end to end through ChatInterceptor ----
  //
  // The research's abuse vector #2: a player cycling PMs across 50 citizens
  // sustains ~7 calls/min with NO per-player cap — the per-citizen 8s
  // cooldown is the only guard. FAIL-BEFORE: the unthrottled interceptor
  // emits one llm:chat-request per citizen with no bound.

  await test("BEHAVIORAL pm: one player PMing 250 citizens is capped at the daily per-player budget", () => {
    const emitted = [];
    const fakeApi = { emitCustomEvent: (name, payload) => emitted.push({ name, payload }) };
    const ic = new ChatInterceptor(fakeApi);
    for (let i = 0; i < 250; i++) {
      ic.registerCitizen({ username: `Citizen${i}`, personalityCard: "card" });
    }
    for (let i = 0; i < 250; i++) {
      ic.requestChat({
        citizenUsername: `Citizen${i}`,
        requesterUsername: "Spammer",
        text: "hi",
        channel: "private",
      });
    }
    const chatRequests = emitted.filter((e) => e.name === "llm:chat-request");
    assert.ok(
      chatRequests.length <= 200,
      `expected <=200 chat-requests for one player, got ${chatRequests.length} (unbounded!)`
    );
  });

  // ---- Behavioral: the public spam vector through the gateway choke point ----
  //
  // Abuse vector #1: public chat spam in a crowd. The gateway's public path
  // (channel === "public") must ALSO consult the per-player throttle after
  // the per-citizen cooldown passes.

  await test("BEHAVIORAL public: per-player throttle consulted on the public path", () => {
    const fakeApi = { emitCustomEvent: () => {} };
    const ic = new ChatInterceptor(fakeApi);
    for (let i = 0; i < 5; i++) {
      const ok = ic.checkPublicRateLimit("Spammer");
      assert.equal(ok, i < 4, `public grant ${i} should be ${i < 4}`);
    }
  });

  if (failures > 0) {
    console.error(`\n${failures} test(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll PlayerThrottles tests passed.");
}

main();
