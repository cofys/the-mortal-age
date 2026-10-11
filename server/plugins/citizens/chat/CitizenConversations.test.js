"use strict";

/**
 * CitizenConversations.test.js — the conversation engine that replaced
 * the fixed greeting+one-reply script ("always exactly 2 messages").
 *
 * Proves with numbers, not vibes:
 *   - exchange lengths are variable (distribution over many sims)
 *   - friends talk longer than strangers on average
 *   - no-reply (ignored) exchanges occur
 *   - walk-away endings occur
 *   - one topic per conversation, no topic bleed between lines
 *   - third citizens join in occasionally
 *   - global volume cap + per-citizen cooldowns hold
 *   - turn pacing is human (seconds, jittered)
 *
 * Run: node --test server/plugins/citizens/chat/CitizenConversations.test.js
 */

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const Engine = require("./CitizenConversations");

// --- deterministic rng -------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- fake world ---------------------------------------------------------------

function makePersonality(name, extra = {}) {
  return {
    name,
    traits: [],
    demeanor: "calm",
    speechStyle: "",
    vocabulary: "",
    profession: "",
    ...extra,
  };
}

function makeBot(world, username, x, y) {
  const bot = {
    username,
    x,
    y,
    moving: false,
    online: true,
    getUsername: () => username,
    isPlayerBot: () => true,
    getLocation: () => ({
      getX: () => bot.x,
      getY: () => bot.y,
      x: bot.x,
      y: bot.y,
    }),
    getLocalPlayers: () => world.bots.filter((b) => b.online),
    getMovementQueue: () => ({ size: () => (bot.moving ? 2 : 0) }),
    getForceMovement: () => null,
    face: () => {},
    getAttribute: () => null,
  };
  return bot;
}

function makeWorld() {
  const world = {
    bots: [],
    records: new Map(),
    roster: new Map(),
    add(username, x = 100, y = 100, personalityExtra = {}) {
      const record = {
        username,
        displayName: username,
        personality: makePersonality(username, personalityExtra),
        kingdomId: "asgarnia",
        currentActivityId: null,
      };
      const bot = makeBot(world, username, x, y);
      world.bots.push(bot);
      world.records.set(username, record);
      world.roster.set(username.toLowerCase(), record);
      return { record, bot };
    },
    director: null,
  };
  world.director = {
    roster: world.roster,
    getBot: (record) =>
      world.bots.find((b) => b.username === record.username && b.online) ?? null,
    isOnline: (record) =>
      world.bots.some((b) => b.username === record.username && b.online),
  };
  return world;
}

// Fake scheduler + clock: timers fire in time order when pumped.
function makeHarness() {
  const timers = [];
  const delays = [];
  let now = 1_000_000;
  return {
    delays,
    get now() {
      return now;
    },
    schedule(fn, delay) {
      delays.push(delay);
      timers.push({ at: now + delay, fn });
      timers.sort((a, b) => a.at - b.at);
      return timers.length;
    },
    nowFn: () => now,
    pump(maxSteps = 500) {
      let steps = 0;
      while (timers.length && steps < maxSteps) {
        const t = timers.shift();
        now = Math.max(now, t.at);
        t.fn();
        steps++;
      }
    },
  };
}

function neutralDeps(overrides = {}) {
  return {
    bondScore: () => 0,
    isFriend: () => false,
    isEnemy: () => false,
    memoryEntry: () => null,
    workContext: () => null,
    warContext: () => null,
    priceContext: () => null,
    newsContext: () => null,
    goalContext: () => null,
    ...overrides,
  };
}

function startSim(world, harness, aName, bName, opts = {}) {
  const lines = [];
  const conv = Engine.maybeStart(
    world.director,
    world.records.get(aName),
    world.bots.find((b) => b.username === aName),
    world.records.get(bName),
    world.bots.find((b) => b.username === bName),
    harness.now,
    {
      rng: opts.rng ?? mulberry32(opts.seed ?? 1),
      say: (bot, text) => lines.push({ speaker: bot.username, text }),
      schedule: harness.schedule,
      now: harness.nowFn,
      deps: opts.deps ?? neutralDeps(),
      context: opts.context,
      forceTopic: opts.forceTopic,
      topicVars: opts.topicVars,
      onLine: opts.onLine,
    }
  );
  return { conv, lines };
}

// --- distribution: the shape itself ------------------------------------------

describe("planLength distribution", () => {
  it("strangers passing: variable lengths, not pinned at 2", () => {
    const rng = mulberry32(42);
    const counts = new Map();
    const N = 4000;
    for (let i = 0; i < N; i++) {
      const len = Engine._planLength(rng, {
        context: "passing",
        tier: "neutral",
        responderSociability: 1.0,
      });
      counts.set(len, (counts.get(len) ?? 0) + 1);
    }
    const share = (len) => (counts.get(len) ?? 0) / N;
    assert.ok(share(1) > 0.1, `lone comments should be common: ${share(1)}`);
    assert.ok(share(2) < 0.6, `exactly-2 must not dominate: ${share(2)}`);
    assert.ok(share(3) > 0.05, `3-turn exchanges should occur: ${share(3)}`);
    assert.ok(share(4) > 0.02, `4-turn exchanges should occur: ${share(4)}`);
  });

  it("friends lingering talk longer than strangers passing (means)", () => {
    const mean = (opts, seed) => {
      const rng = mulberry32(seed);
      let sum = 0;
      const N = 4000;
      for (let i = 0; i < N; i++) sum += Engine._planLength(rng, opts);
      return sum / N;
    };
    const strangers = mean(
      { context: "passing", tier: "neutral", responderSociability: 1.0 },
      7
    );
    const friends = mean(
      { context: "lingering", tier: "friend", responderSociability: 1.0 },
      7
    );
    assert.ok(
      friends > strangers + 1.0,
      `friends (${friends.toFixed(2)}) should clearly out-talk strangers (${strangers.toFixed(2)})`
    );
    // And the friend distribution must reach real conversation lengths.
    const rng = mulberry32(9);
    let sawLong = false;
    for (let i = 0; i < 2000; i++) {
      if (
        Engine._planLength(rng, {
          context: "lingering",
          tier: "close",
          responderSociability: 1.5,
        }) >= 6
      ) {
        sawLong = true;
        break;
      }
    }
    assert.ok(sawLong, "close friends should sometimes reach 6+ turns");
  });

  it("taciturn responders collapse exchanges to a lone comment more often", () => {
    const ones = (sociability, seed) => {
      const rng = mulberry32(seed);
      let n = 0;
      const N = 2000;
      for (let i = 0; i < N; i++) {
        if (
          Engine._planLength(rng, {
            context: "passing",
            tier: "neutral",
            responderSociability: sociability,
          }) === 1
        ) {
          n++;
        }
      }
      return n / N;
    };
    assert.ok(ones(0.4, 3) > ones(1.0, 3) + 0.08);
  });
});

// --- full simulated conversations ---------------------------------------------

describe("simulated conversations", () => {
  beforeEach(() => Engine._resetForTests());

  it("runs a multi-turn conversation on ONE topic with human pacing", () => {
    const world = makeWorld();
    world.add("Alice", 100, 100);
    world.add("Bob", 101, 100);
    const harness = makeHarness();
    const { conv, lines } = startSim(world, harness, "Alice", "Bob", {
      seed: 5,
      context: "lingering",
      forceTopic: "work",
      topicVars: { skill: "fishing" },
      deps: neutralDeps({
        isFriend: () => true,
        bondScore: () => 50,
        memoryEntry: () => ({ met: 6 }),
      }),
    });
    assert.ok(conv, "conversation should start");
    harness.pump();
    assert.equal(conv.state, "done");
    assert.ok(
      lines.length >= 2 && lines.length <= Engine.MAX_TURNS,
      `expected 2..${Engine.MAX_TURNS} lines, got ${lines.length}`
    );
    // Topic continuity: every recorded turn belongs to the work topic,
    // and the skill named never changes mid-conversation.
    assert.ok(conv.history.every((h) => h.topicId === "work"));
    for (const line of lines) {
      assert.ok(
        !/bread|paper|war/i.test(line.text) || /fishing/.test(line.text),
        `topic bleed in line: ${line.text}`
      );
    }
    // Pacing: every scheduled gap is seconds-scale and jittered.
    assert.ok(harness.delays.length >= 1);
    for (const d of harness.delays) {
      assert.ok(d >= 3000 && d <= 11000, `delay out of human range: ${d}`);
    }
    assert.ok(
      new Set(harness.delays).size > 1,
      "delays should jitter, not be a fixed metronome"
    );
  });

  it("no-reply exchanges happen: a lone comment nobody answers", () => {
    let lone = 0;
    const RUNS = 300;
    for (let seed = 0; seed < RUNS; seed++) {
      Engine._resetForTests();
      const world = makeWorld();
      world.add("Alice", 100, 100);
      world.add("Bob", 101, 100, { demeanor: "guarded", traits: ["taciturn"] });
      const harness = makeHarness();
      const { conv, lines } = startSim(world, harness, "Alice", "Bob", {
        seed: 1000 + seed,
        context: "passing",
      });
      harness.pump();
      if (conv && lines.length === 1) {
        lone++;
        assert.equal(conv.endReason, "no-reply");
      }
    }
    assert.ok(
      lone >= 15,
      `expected a solid share of ignored openers, got ${lone}/${RUNS}`
    );
    assert.ok(lone < RUNS * 0.9, "but most openers should still get answers");
  });

  it("walk-away: a participant who leaves ends the chat early", () => {
    let found = null;
    for (let seed = 0; seed < 200 && !found; seed++) {
      Engine._resetForTests();
      const world = makeWorld();
      const a = world.add("Alice", 100, 100);
      const b = world.add("Bob", 101, 100);
      const harness = makeHarness();
      const { conv, lines } = startSim(world, harness, a.record.username, b.record.username, {
        seed,
        context: "lingering",
        forceTopic: "greeting",
        deps: neutralDeps({
          isFriend: () => true,
          bondScore: () => 60,
          memoryEntry: () => ({ met: 9 }),
        }),
      });
      if (conv && conv.plannedTurns >= 4) {
        // Bob wanders off before his next turn.
        b.bot.x = 160;
        b.bot.y = 160;
        harness.pump();
        if (conv.endReason === "walkaway") found = { conv, lines };
      }
    }
    assert.ok(found, "expected at least one walk-away ending across seeds");
    assert.ok(
      found.lines.length <= found.conv.plannedTurns,
      "walk-away must cut the exchange short"
    );
  });

  it("a third citizen joins an ongoing chat occasionally", () => {
    let joined = null;
    for (let seed = 0; seed < 300 && !joined; seed++) {
      Engine._resetForTests();
      const world = makeWorld();
      world.add("Alice", 100, 100);
      world.add("Bob", 101, 100);
      world.add("Carol", 102, 100);
      const harness = makeHarness();
      const { conv, lines } = startSim(world, harness, "Alice", "Bob", {
        seed,
        context: "lingering",
        forceTopic: "greeting",
        deps: neutralDeps({
          isFriend: () => true,
          bondScore: () => 45,
          memoryEntry: () => ({ met: 4 }),
        }),
      });
      harness.pump();
      if (conv && conv.participants.length === 3) {
        joined = { conv, lines };
      }
    }
    assert.ok(joined, "expected a join-in across 300 seeded runs");
    assert.ok(
      joined.lines.some((l) => l.speaker === "Carol"),
      "the joiner should actually speak"
    );
  });

  it("friends' realized exchanges average longer than strangers'", () => {
    const realizedMean = (deps, seedBase) => {
      let total = 0;
      let n = 0;
      for (let seed = 0; seed < 150; seed++) {
        Engine._resetForTests();
        const world = makeWorld();
        world.add("Alice", 100, 100);
        world.add("Bob", 101, 100);
        const harness = makeHarness();
        const { conv, lines } = startSim(world, harness, "Alice", "Bob", {
          seed: seedBase + seed,
          context: "lingering",
          deps,
        });
        harness.pump();
        if (conv) {
          total += lines.length;
          n++;
        }
      }
      return total / Math.max(1, n);
    };
    const strangers = realizedMean(neutralDeps(), 5000);
    const friends = realizedMean(
      neutralDeps({
        isFriend: () => true,
        bondScore: () => 55,
        memoryEntry: () => ({ met: 8 }),
      }),
      5000
    );
    assert.ok(
      friends > strangers + 0.4,
      `friends realized ${friends.toFixed(2)} vs strangers ${strangers.toFixed(2)}`
    );
  });

  it("topics never bleed: war talk and work talk stay separate", () => {
    const deps = neutralDeps({
      warContext: () => ({ enemy: "Misthalin", goal: "plunder" }),
      workContext: () => ({ skill: "mining" }),
      priceContext: () => ({ item: "bread", dir: "up" }),
      newsContext: () => ({ headline: "A dragon was spotted near the border." }),
    });
    const seenTopics = new Set();
    for (let seed = 0; seed < 120; seed++) {
      Engine._resetForTests();
      const world = makeWorld();
      world.add("Alice", 100, 100);
      world.add("Bob", 101, 100);
      const harness = makeHarness();
      const { conv, lines } = startSim(world, harness, "Alice", "Bob", {
        seed: 9000 + seed,
        context: "lingering",
        deps,
      });
      harness.pump();
      if (!conv) continue;
      seenTopics.add(conv.topic.id);
      const all = lines.map((l) => l.text).join(" | ");
      const mentions = [
        /Misthalin/.test(all),
        /mining/.test(all),
        /bread/.test(all),
        /dragon/.test(all),
      ].filter(Boolean).length;
      assert.ok(
        mentions <= 1,
        `topic bleed in ${conv.topic.id}: ${all}`
      );
      assert.ok(conv.history.every((h) => h.topicId === conv.topic.id));
    }
    assert.ok(seenTopics.size >= 3, `expected topic variety, saw ${[...seenTopics]}`);
  });

  it("enemies never start conversations", () => {
    const world = makeWorld();
    world.add("Alice", 100, 100);
    world.add("Bob", 101, 100);
    const harness = makeHarness();
    const { conv } = startSim(world, harness, "Alice", "Bob", {
      deps: neutralDeps({ isEnemy: () => true }),
    });
    assert.equal(conv, null);
  });
});

// --- volume discipline ---------------------------------------------------------

describe("volume discipline", () => {
  beforeEach(() => Engine._resetForTests());

  it("global cap: concurrent conversations never exceed MAX_ACTIVE", () => {
    const world = makeWorld();
    const harness = makeHarness();
    let started = 0;
    for (let i = 0; i < Engine.MAX_ACTIVE + 6; i++) {
      world.add(`Cit${i}a`, 100 + i * 30, 100);
      world.add(`Cit${i}b`, 101 + i * 30, 100);
      const { conv } = startSim(
        world,
        harness,
        `Cit${i}a`,
        `Cit${i}b`,
        { seed: i + 1, context: "lingering" }
      );
      if (conv) started++;
    }
    assert.equal(started, Engine.MAX_ACTIVE);
    assert.ok(Engine._conversations.size <= Engine.MAX_ACTIVE);
  });

  it("per-citizen cooldown: no instant re-chat after a conversation ends", () => {
    const world = makeWorld();
    world.add("Alice", 100, 100);
    world.add("Bob", 101, 100);
    world.add("Carol", 102, 100);
    const harness = makeHarness();
    const first = startSim(world, harness, "Alice", "Bob", { seed: 11 });
    harness.pump();
    assert.equal(first.conv.state, "done");
    const second = startSim(world, harness, "Alice", "Carol", { seed: 12 });
    assert.equal(second.conv, null, "Alice should be on post-chat cooldown");
  });

  it("nobody holds two conversations at once", () => {
    const world = makeWorld();
    world.add("Alice", 100, 100);
    world.add("Bob", 101, 100);
    world.add("Carol", 102, 100);
    const harness = makeHarness();
    const first = startSim(world, harness, "Alice", "Bob", { seed: 21 });
    assert.ok(first.conv);
    const second = startSim(world, harness, "Alice", "Carol", { seed: 22 });
    assert.equal(second.conv, null);
  });
});

// --- player follow-ups -----------------------------------------------------------

describe("player follow-ups", () => {
  beforeEach(() => Engine._resetForTests());

  it("extends a scripted reply with 1-2 on-topic lines, human-paced", () => {
    const world = makeWorld();
    const { record, bot } = world.add("Alice", 100, 100);
    const harness = makeHarness();
    const lines = [];
    const conv = Engine.maybePlayerFollowUp(world.director, record, bot, "Jon", {
      rng: mulberry32(77),
      say: (b, text) => lines.push({ speaker: b.username, text }),
      schedule: harness.schedule,
      now: harness.nowFn,
      force: true,
      deps: neutralDeps({
        newsContext: () => ({ headline: "The crier reports a festival soon." }),
      }),
      forceTopic: "news",
      topicVars: { headline: "The crier reports a festival soon." },
    });
    assert.ok(conv, "follow-up conversation should be created");
    harness.pump();
    assert.ok(
      lines.length >= 1 && lines.length <= 2,
      `expected 1-2 follow-up lines, got ${lines.length}`
    );
    assert.ok(lines.every((l) => l.speaker === "Alice"));
    for (const d of harness.delays) {
      assert.ok(d >= 3000, `follow-up pacing too fast: ${d}`);
    }
    assert.equal(conv.state, "done");
  });

  it("respects the per-citizen cooldown without force", () => {
    const world = makeWorld();
    const { record, bot } = world.add("Alice", 100, 100);
    const harness = makeHarness();
    const opts = {
      rng: mulberry32(78),
      say: () => {},
      schedule: harness.schedule,
      now: harness.nowFn,
      deps: neutralDeps(),
    };
    const first = Engine.maybePlayerFollowUp(world.director, record, bot, "Jon", {
      ...opts,
      force: true,
    });
    assert.ok(first);
    harness.pump();
    const second = Engine.maybePlayerFollowUp(
      world.director,
      record,
      bot,
      "Jon",
      opts
    );
    assert.equal(second, null, "cooldown should block an immediate repeat");
  });
});

// --- closeness -------------------------------------------------------------------

describe("closenessTier", () => {
  it("reads real relationship state", () => {
    const sources = neutralDeps({
      bondScore: (a, b) => (a === "Alice" ? 55 : 50),
      isFriend: () => true,
      memoryEntry: () => ({ met: 12 }),
    });
    assert.equal(Engine._closenessTier("Alice", "Bob", sources), "close");
    assert.equal(
      Engine._closenessTier("Alice", "Bob", neutralDeps()),
      "neutral"
    );
    assert.equal(
      Engine._closenessTier(
        "Alice",
        "Bob",
        neutralDeps({ memoryEntry: () => ({ met: 4 }) })
      ),
      "familiar"
    );
    assert.equal(
      Engine._closenessTier("Alice", "Bob", neutralDeps({ isEnemy: () => true })),
      "hostile"
    );
    assert.equal(
      Engine._closenessTier(
        "Alice",
        "Bob",
        neutralDeps({ bondScore: () => -40 })
      ),
      "cold"
    );
  });
});
