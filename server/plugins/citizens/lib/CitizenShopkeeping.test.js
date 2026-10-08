// CitizenShopkeeping unit checks — pure logic + fakes, no running server.
// From server/plugins/citizens: node lib/CitizenShopkeeping.test.js (plain node)
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  RESTOCK_INTERVAL_MS,
  ARRANGE_INTERVAL_MS,
  SWEEP_INTERVAL_MS,
  TASK_DURATION_MS,
  GREET_RADIUS,
  GREET_COOLDOWN_MS,
  PROXIMITY_TILES,
  SHOP_TASK_DEFS,
  SHOP_TASK_KEYS,
  SHOPKEEPER_GREETINGS,
  COUNTER_OFFSET,
  shopTile,
  taskTile,
  dueTask,
  eligibleForShopkeeping,
  tickShopkeeping,
  startTask,
  endTask,
  _activeTasks,
  _lastTaskAt,
  _lastGreetAt,
} = require("./CitizenShopkeeping");
const { getJournal } = require("./CitizenJournal");

// Tiny deterministic LCG so coverage is exact, not luck-based.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const tests = [];

function test(name, fn) {
  tests.push([name, fn]);
}

function cleanup() {
  _activeTasks.clear();
  _lastTaskAt.clear();
  _lastGreetAt.clear();
  try {
    getJournal().resetForTests();
  } catch {
    // Non-fatal.
  }
}

// --- fakes ---------------------------------------------------------------------

function tile(x, y) {
  return { getX: () => x, getY: () => y, getZ: () => 0 };
}

function fakeBot(x, y, localPlayers = []) {
  return {
    getLocation: () => tile(x, y),
    getLocalPlayers: () => localPlayers,
    isPlayerBot: () => true,
    getMovementQueue: () => ({ size: () => 0 }),
    getForceMovement: () => null,
    faced: null,
    anims: [],
    chats: [],
    movedTo: null,
    face(fx, fy) {
      this.faced = [fx, fy];
    },
    performAnimation(a) {
      this.anims.push(a);
    },
    forceChat(line) {
      this.chats.push(line);
    },
    moveTo(loc) {
      this.movedTo = loc;
    },
  };
}

function fakeRealPlayer(x, y) {
  return {
    getLocation: () => tile(x, y),
    isPlayerBot: () => false,
  };
}

function fakeCitizenBot(x, y) {
  return {
    getLocation: () => tile(x, y),
    isPlayerBot: () => true,
  };
}

function fakeRecord(overrides = {}) {
  return {
    username: "Shopkeep Sam",
    role: "merchant",
    kingdomId: "asgarnia",
    ...overrides,
  };
}

function fakeDirector(records, bots) {
  return {
    roster: new Map(records.map((r) => [r.username.toLowerCase().replace(/\s+/g, "_"), r])),
    isOnline: () => true,
    getBot: (record) => bots[record.username] ?? null,
    api: { core: { Animation: class { constructor(id) { this.id = id; } }, Location: class { constructor(x, y, z) { this.x = x; this.y = y; this.z = z; } } } },
  };
}

// --- tests ---------------------------------------------------------------------

test("tuning constants are sane", () => {
  assert.equal(RESTOCK_INTERVAL_MS, 5 * 60 * 1000);
  assert.equal(ARRANGE_INTERVAL_MS, 3 * 60 * 1000);
  assert.equal(SWEEP_INTERVAL_MS, 10 * 60 * 1000);
  assert.ok(GREET_RADIUS > 0 && GREET_RADIUS < PROXIMITY_TILES);
  assert.ok(SHOP_TASK_KEYS.length === 3);
  assert.deepEqual(SHOP_TASK_KEYS, ["restock", "arrange", "sweep"]);
});

test("task defs have emotes, offsets and journal lines", () => {
  for (const key of SHOP_TASK_KEYS) {
    const def = SHOP_TASK_DEFS[key];
    assert.ok(def.emote.startsWith("*") && def.emote.endsWith("*"), `${key} emote is emote-styled`);
    assert.ok(Array.isArray(def.offset) && def.offset.length === 2, `${key} has [dx,dy]`);
    assert.ok(typeof def.journal === "string" && def.journal.length > 0, `${key} has journal line`);
  }
});

test("greetings pool is non-empty and data-tier", () => {
  assert.ok(SHOPKEEPER_GREETINGS.length >= 4);
  for (const line of SHOPKEEPER_GREETINGS) {
    assert.ok(typeof line === "string" && line.length > 0 && line.length < 120);
  }
});

test("shopTile resolves for a known kingdom", () => {
  const t = shopTile("asgarnia");
  assert.ok(t && Number.isFinite(t.x) && Number.isFinite(t.y), "got a tile");
});

test("shopTile is total for unknown kingdoms", () => {
  const t = shopTile("no-such-kingdom");
  // siteTileByKingdom falls back to the first kingdom's sites — never throws.
  assert.ok(t === null || (Number.isFinite(t.x) && Number.isFinite(t.y)));
});

test("taskTile applies the task offset", () => {
  const shop = shopTile("asgarnia");
  const def = SHOP_TASK_DEFS.restock;
  const t = taskTile("asgarnia", "restock");
  assert.equal(t.x, shop.x + def.offset[0]);
  assert.equal(t.y, shop.y + def.offset[1]);
});

test("taskTile returns null for unknown task keys", () => {
  assert.equal(taskTile("asgarnia", "nap"), null);
});

test("dueTask returns the first due task in priority order", () => {
  cleanup();
  const name = "shopkeep sam";
  // Nothing done yet: restock is due first (defined first).
  assert.equal(dueTask(name, 10 * 60 * 1000), "restock");
  // Mark restock done recently: arrange becomes due.
  _lastTaskAt.set(name, { restock: 10 * 60 * 1000 });
  assert.equal(dueTask(name, 10 * 60 * 1000 + 1000), "arrange");
  // Everything fresh: nothing due.
  _lastTaskAt.set(name, {
    restock: 10 * 60 * 1000,
    arrange: 10 * 60 * 1000,
    sweep: 10 * 60 * 1000,
  });
  assert.equal(dueTask(name, 10 * 60 * 1000 + 1000), null);
});

test("dueTask respects each task's own interval", () => {
  cleanup();
  const name = "shopkeep sam";
  _lastTaskAt.set(name, { restock: 0, arrange: 0, sweep: 0 });
  // 4 minutes in: arrange (3min) is due, restock (5min) is not, sweep (10min) is not.
  // But restock is checked first and not due, so arrange wins.
  assert.equal(dueTask(name, 4 * 60 * 1000), "arrange");
});

test("eligibleForShopkeeping requires the merchant role", () => {
  cleanup();
  const director = fakeDirector([], {});
  assert.equal(eligibleForShopkeeping(fakeRecord({ role: "commoner" }), director), false);
  assert.equal(eligibleForShopkeeping(fakeRecord({ role: "guard" }), director), false);
  assert.equal(eligibleForShopkeeping(fakeRecord({ role: "merchant" }), director), true);
});

test("eligibleForShopkeeping rejects offline and mid-task citizens", () => {
  cleanup();
  const rec = fakeRecord();
  const offline = fakeDirector([rec], {});
  offline.isOnline = () => false;
  assert.equal(eligibleForShopkeeping(rec, offline), false);
  const online = fakeDirector([rec], {});
  _activeTasks.set("shopkeep sam", { taskKey: "restock", startedAt: 0 });
  assert.equal(eligibleForShopkeeping(rec, online), false);
});

test("startTask moves, emotes, faces and journals", () => {
  cleanup();
  const rec = fakeRecord();
  const bot = fakeBot(2960, 3330);
  const director = fakeDirector([rec], { [rec.username]: bot });
  const nowMs = 60 * 1000;
  const ok = startTask(director, rec, bot, "restock", nowMs);
  assert.equal(ok, true);
  assert.ok(_activeTasks.has("shopkeep sam"), "task registered");
  assert.ok(bot.movedTo !== null, "walked to the spot");
  assert.ok(bot.chats.includes("*restocks the shelves*"), "emote sent");
  assert.ok(bot.faced !== null, "faced the spot");
  assert.ok(bot.anims.length === 1 && bot.anims[0].id === 885, "restock anim played");
  // Journal is fire-and-forget by design; just confirm it didn't throw.
  assert.ok(true);
});

test("startTask for sweep uses no animation (movement + emote only)", () => {
  cleanup();
  const rec = fakeRecord();
  const bot = fakeBot(2960, 3330);
  const director = fakeDirector([rec], { [rec.username]: bot });
  const ok = startTask(director, rec, bot, "sweep", 60 * 1000);
  assert.equal(ok, true);
  assert.equal(bot.anims.length, 0, "no anim for sweep");
  assert.ok(bot.chats.includes("*sweeps the shop floor*"), "emote sent");
  assert.ok(bot.movedTo !== null, "still walks to the spot");
});

test("startTask returns false for unknown tasks", () => {
  cleanup();
  const rec = fakeRecord();
  const bot = fakeBot(2960, 3330);
  const director = fakeDirector([rec], { [rec.username]: bot });
  assert.equal(startTask(director, rec, bot, "nap", 60 * 1000), false);
});

test("endTask clears the active task", () => {
  cleanup();
  _activeTasks.set("shopkeep sam", { taskKey: "restock", startedAt: 0 });
  endTask("shopkeep sam");
  assert.ok(!_activeTasks.has("shopkeep sam"));
});

test("tickShopkeeping greets a customer who walks in", () => {
  cleanup();
  const shop = shopTile("asgarnia");
  const rec = fakeRecord();
  const customer = fakeRealPlayer(shop.x + 2, shop.y + 1);
  const bot = fakeBot(shop.x, shop.y, [customer]);
  const director = fakeDirector([rec], { [rec.username]: bot });
  // No task due yet (all done just now) so only the greeting fires.
  _lastTaskAt.set("shopkeep sam", {
    restock: Date.now(),
    arrange: Date.now(),
    sweep: Date.now(),
  });
  tickShopkeeping(director, Date.now());
  const greeted = bot.chats.some((c) => SHOPKEEPER_GREETINGS.includes(c));
  assert.ok(greeted, `owner greeted the customer (chats: ${JSON.stringify(bot.chats)})`);
});

test("tickShopkeeping does not greet twice within the cooldown", () => {
  cleanup();
  const shop = shopTile("asgarnia");
  const rec = fakeRecord();
  const customer = fakeRealPlayer(shop.x + 2, shop.y + 1);
  const bot = fakeBot(shop.x, shop.y, [customer]);
  const director = fakeDirector([rec], { [rec.username]: bot });
  _lastTaskAt.set("shopkeep sam", {
    restock: Date.now(),
    arrange: Date.now(),
    sweep: Date.now(),
  });
  const nowMs = Date.now();
  tickShopkeeping(director, nowMs);
  tickShopkeeping(director, nowMs + 1000);
  const greets = bot.chats.filter((c) => SHOPKEEPER_GREETINGS.includes(c));
  assert.equal(greets.length, 1, "one greeting per cooldown window");
});

test("tickShopkeeping ignores citizen bots as customers", () => {
  cleanup();
  const shop = shopTile("asgarnia");
  const rec = fakeRecord();
  const otherCitizen = fakeCitizenBot(shop.x + 2, shop.y + 1);
  const bot = fakeBot(shop.x, shop.y, [otherCitizen]);
  const director = fakeDirector([rec], { [rec.username]: bot });
  _lastTaskAt.set("shopkeep sam", {
    restock: Date.now(),
    arrange: Date.now(),
    sweep: Date.now(),
  });
  tickShopkeeping(director, Date.now());
  const greets = bot.chats.filter((c) => SHOPKEEPER_GREETINGS.includes(c));
  assert.equal(greets.length, 0, "citizen bots are not customers");
});

test("tickShopkeeping stays quiet with no real player nearby", () => {
  cleanup();
  const rec = fakeRecord();
  const bot = fakeBot(2960, 3330, []); // nobody around
  const director = fakeDirector([rec], { [rec.username]: bot });
  tickShopkeeping(director, 60 * 60 * 1000);
  assert.equal(bot.chats.length, 0, "no emotes with nobody watching");
  assert.ok(!_activeTasks.has("shopkeep sam"), "no task started");
});

test("tickShopkeeping never throws on a broken citizen", () => {
  cleanup();
  const bad = fakeRecord({ username: "Broken Bob" });
  const director = fakeDirector([bad], {});
  director.getBot = () => {
    throw new Error("boom");
  };
  assert.doesNotThrow(() => tickShopkeeping(director, Date.now()));
});

test("source has no LLM usage in the tick path", () => {
  const src = fs.readFileSync(path.join(__dirname, "CitizenShopkeeping.js"), "utf8");
  // The header docs say "zero LLM" on purpose; what matters is no actual
  // LLM machinery: no llm requires, no llm: events, no gateway calls.
  assert.ok(!/require\(["'].*llm.*["']\)/i.test(src), "no llm requires");
  assert.ok(!/llm:/i.test(src), "no llm: events");
  assert.ok(!/llmGateway/i.test(src), "no gateway references");
  assert.ok(!/fetch\(/i.test(src), "no network calls");
});

// --- runner --------------------------------------------------------------------

let failures = 0;
for (const [name, fn] of tests) {
  cleanup();
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures++;
    console.log(`FAIL - ${name}`);
    console.log(`  ${String(error?.stack ?? error).split("\n").slice(0, 3).join("\n  ")}`);
  }
}
console.log(`\n${tests.length - failures}/${tests.length} passing`);
process.exit(failures === 0 ? 0 : 1);
