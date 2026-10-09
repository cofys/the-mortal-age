// Tests for lite-tier routing of public chat replies + JSON memory persistence.
// Plain node, no framework. Run: node server/plugins/llm-gateway/GatewayGuardrails.test.js
// (from repo root)
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { resolveReplyTier } = require("./Gateway");
const { JsonMemoryStore } = require("./JsonMemoryStore");

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

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

async function main() {
  // ---- lite routing ----
  await test("public replies route lite even on first contact", () => {
    assert.equal(resolveReplyTier({ channel: "public", historyLength: 0 }), "lite");
    assert.equal(resolveReplyTier({ channel: "public", historyLength: 5 }), "lite");
  });

  await test("PM first contact keeps flagship; PM follow-ups go lite", () => {
    assert.equal(resolveReplyTier({ channel: "private", historyLength: 0 }), "flagship");
    assert.equal(resolveReplyTier({ channel: "private", historyLength: 3 }), "lite");
  });

  await test("caller-specified tier always wins (c2c threads stay lite, etc.)", () => {
    assert.equal(resolveReplyTier({ channel: "public", tier: "lite", historyLength: 0 }), "lite");
    assert.equal(resolveReplyTier({ channel: "private", tier: "standard", historyLength: 0 }), "standard");
  });

  await test("LLM_GATEWAY_PUBLIC_FLAGSHIP_FIRST_CONTACT=1 restores flagship for public first impressions", () => {
    withEnv({ LLM_GATEWAY_PUBLIC_FLAGSHIP_FIRST_CONTACT: "1" }, () => {
      assert.equal(resolveReplyTier({ channel: "public", historyLength: 0 }), "flagship");
      assert.equal(resolveReplyTier({ channel: "public", historyLength: 2 }), "lite");
    });
    assert.equal(resolveReplyTier({ channel: "public", historyLength: 0 }), "lite", "env restored");
  });

  // ---- memory persistence ----
  await test("history survives a store restart (no flagship re-burn after deploys)", async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "llm-mem-")), "memory.json");
    const a = new JsonMemoryStore(file);
    await a.pushExchange("Zara Khan", "Jon", "hello", "well met, traveller");
    await a.addNote("Zara Khan", "Jon", "friendly chatter");
    await a.setCard("Zara Khan", "test card");
    a.flush();
    assert.ok(fs.existsSync(file), "memory file written");
    const b = new JsonMemoryStore(file); // "restart"
    const history = await b.getHistory("Zara Khan", "Jon");
    assert.equal(history.length, 1);
    assert.equal(history[0].playerText, "hello");
    assert.equal(history[0].replyText, "well met, traveller");
    assert.deepEqual(await b.getNotes("Zara Khan", "Jon"), ["friendly chatter"]);
    assert.equal(await b.getCard("Zara Khan"), "test card");
  });

  await test("missing file starts empty; corrupt file starts fresh", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-mem-"));
    const a = new JsonMemoryStore(path.join(dir, "nope.json"));
    assert.deepEqual(await a.getHistory("X", "Y"), []);
    const bad = path.join(dir, "bad.json");
    fs.writeFileSync(bad, "{{{nope");
    const b = new JsonMemoryStore(bad);
    assert.deepEqual(await b.getHistory("X", "Y"), []);
  });

  await test("pair cap evicts the stalest pairs (bounded disk growth)", async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "llm-mem-")), "memory.json");
    const store = new JsonMemoryStore(file, { maxPairs: 5 });
    for (let i = 0; i < 12; i++) {
      await store.pushExchange("C", `Player${i}`, "hi", "yo");
    }
    // 12 pairs attempted, cap 5 per map -> eviction kept the newest.
    const latest = await store.getHistory("C", "Player11");
    assert.equal(latest.length, 1, "newest pair kept");
    const oldest = await store.getHistory("C", "Player0");
    assert.equal(oldest.length, 0, "stalest pair evicted");
  });

  await test("debounced writes coalesce: rapid mutations produce one file write", async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "llm-mem-")), "memory.json");
    const store = new JsonMemoryStore(file, { flushMs: 60_000 }); // long debounce
    await store.pushExchange("C", "P", "a", "b");
    await store.pushExchange("C", "P", "c", "d");
    assert.equal(fs.existsSync(file), false, "no write on the hot path");
    store.flush();
    assert.equal(fs.existsSync(file), true, "explicit flush writes");
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(parsed.history["c|p"].length, 2);
  });

  if (failures > 0) {
    console.error(`\n${failures} test(s) FAILED`);
    process.exit(1);
  }
  console.log("\nAll GatewayGuardrails tests passed.");
}

main();
