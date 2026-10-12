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
    bossContext: () => null,
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

// --- boss topic: real boss-run state only ---------------------------------------

describe("boss topic", () => {
  beforeEach(() => Engine._resetForTests());

  function assertCleanLines(lines) {
    for (const l of lines) {
      assert.ok(!/\{/.test(l.text), `unrendered token: ${l.text}`);
    }
  }

  it("never selected without real boss state", () => {
    const seen = new Set();
    for (let seed = 0; seed < 200; seed++) {
      Engine._resetForTests();
      const world = makeWorld();
      world.add("Alice", 100, 100);
      world.add("Bob", 101, 100);
      const harness = makeHarness();
      const { conv } = startSim(world, harness, "Alice", "Bob", {
        seed: 30000 + seed,
        context: "lingering",
        deps: neutralDeps(),
      });
      harness.pump();
      if (conv) seen.add(conv.topic.id);
    }
    assert.ok(!seen.has("boss"), "boss topic must never be picked with no state");
    assert.ok(seen.size >= 1, "conversations should still happen on other topics");
  });

  it("selected for a live party: own perspective, real member count", () => {
    let picked = 0;
    let total = 0;
    for (let seed = 0; seed < 120; seed++) {
      Engine._resetForTests();
      const world = makeWorld();
      world.add("Alice", 100, 100);
      world.add("Bob", 101, 100);
      const harness = makeHarness();
      const { conv, lines } = startSim(world, harness, "Alice", "Bob", {
        seed: 31000 + seed,
        context: "lingering",
        deps: neutralDeps({
          bossContext: () => ({ boss: "the Giant Mole", n: 4 }),
        }),
      });
      harness.pump();
      if (!conv) continue;
      total++;
      if (conv.topic.id === "boss") {
        picked++;
        assert.equal(conv.topic.vars.boss, "the Giant Mole");
        assert.equal(conv.topic.vars.n, 4);
        assert.equal(conv.topic.vars.own, "");
        assert.ok(!("theirs" in conv.topic.vars));
        assert.ok(!("past" in conv.topic.vars));
        assertCleanLines(lines);
      }
    }
    assert.ok(total > 0);
    assert.ok(picked > 0, "boss topic should be picked sometimes with live party state");
  });

  it("prefers the speaker's own run over gossip about the other", () => {
    const deps = neutralDeps({
      bossContext: (record) =>
        record.username === "Alice"
          ? { boss: "the Giant Mole", n: 4 }
          : { boss: "Scurrius", n: 3 },
    });
    let bossPicks = 0;
    for (let seed = 0; seed < 150; seed++) {
      Engine._resetForTests();
      const world = makeWorld();
      world.add("Alice", 100, 100);
      world.add("Bob", 101, 100);
      const harness = makeHarness();
      const { conv, lines } = startSim(world, harness, "Alice", "Bob", {
        seed: 32000 + seed,
        context: "lingering",
        deps,
      });
      harness.pump();
      if (conv?.topic.id === "boss") {
        bossPicks++;
        assert.equal(conv.topic.vars.boss, "the Giant Mole");
        assert.equal(conv.topic.vars.own, "");
        assert.ok(!("theirs" in conv.topic.vars));
        assertCleanLines(lines);
      }
    }
    assert.ok(bossPicks > 0);
  });

  it("gossip perspective when only the other citizen has boss state", () => {
    let bossPicks = 0;
    for (let seed = 0; seed < 150; seed++) {
      Engine._resetForTests();
      const world = makeWorld();
      world.add("Alice", 100, 100);
      world.add("Bob", 101, 100);
      const harness = makeHarness();
      const { conv, lines } = startSim(world, harness, "Alice", "Bob", {
        seed: 33000 + seed,
        context: "lingering",
        deps: neutralDeps({
          bossContext: (record) =>
            record.username === "Bob" ? { boss: "Scurrius", n: 3 } : null,
        }),
      });
      harness.pump();
      if (conv?.topic.id === "boss") {
        bossPicks++;
        assert.equal(conv.topic.vars.boss, "Scurrius");
        assert.equal(conv.topic.vars.theirs, "");
        assert.ok(!("own" in conv.topic.vars));
        const opener = lines[0]?.text ?? "";
        assert.ok(
          /You lot|Heard/.test(opener),
          `gossip opener expected, got: ${opener}`
        );
        assertCleanLines(lines);
      }
    }
    assert.ok(bossPicks > 0);
  });

  it("past tense for a journaled run with no live party", () => {
    let bossPicks = 0;
    for (let seed = 0; seed < 150; seed++) {
      Engine._resetForTests();
      const world = makeWorld();
      world.add("Alice", 100, 100);
      world.add("Bob", 101, 100);
      const harness = makeHarness();
      const { conv, lines } = startSim(world, harness, "Alice", "Bob", {
        seed: 34000 + seed,
        context: "lingering",
        deps: neutralDeps({
          bossContext: () => ({ boss: "Obor", n: null }),
        }),
      });
      harness.pump();
      if (conv?.topic.id === "boss") {
        bossPicks++;
        assert.equal(conv.topic.vars.past, "");
        assert.ok(!("n" in conv.topic.vars));
        const opener = lines[0]?.text ?? "";
        assert.ok(
          /took down|went down/i.test(opener),
          `past-tense opener expected, got: ${opener}`
        );
        assertCleanLines(lines);
      }
    }
    assert.ok(bossPicks > 0);
  });

  it("terse voices render boss lines cleanly (no tag leakage)", () => {
    let bossPicks = 0;
    for (let seed = 0; seed < 120; seed++) {
      Engine._resetForTests();
      const world = makeWorld();
      world.add("Alice", 100, 100, { traits: ["gruff"] });
      world.add("Bob", 101, 100, { traits: ["taciturn"] });
      const harness = makeHarness();
      const { conv, lines } = startSim(world, harness, "Alice", "Bob", {
        seed: 35000 + seed,
        context: "lingering",
        deps: neutralDeps({
          bossContext: () => ({ boss: "the Giant Mole", n: 4 }),
        }),
      });
      harness.pump();
      if (conv?.topic.id === "boss") {
        bossPicks++;
        for (const l of lines) {
          assert.ok(!/\{/.test(l.text), `unrendered token: ${l.text}`);
          assert.ok(
            !/\bown\b|\btheirs\b|\bpast\b/.test(l.text),
            `perspective tag leaked: ${l.text}`
          );
        }
      }
    }
    assert.ok(bossPicks > 0);
  });

  it("_pickTopic perspective tags follow the state owner", () => {
    const ctxFor = (bossFn, seed) => ({
      sources: neutralDeps({ bossContext: bossFn }),
      aRecord: { username: "Alice" },
      aBot: null,
      bRecord: { username: "Bob" },
      tier: "neutral",
      context: "lingering",
      rng: mulberry32(seed),
    });
    const picks = [];
    for (let seed = 0; seed < 60; seed++) {
      const t = Engine._pickTopic(
        ctxFor(
          (r) => (r.username === "Bob" ? { boss: "Scurrius", n: 2 } : null),
          seed
        )
      );
      if (t.id === "boss") picks.push(t);
    }
    assert.ok(picks.length > 0, "boss should be picked across seeds");
    for (const t of picks) {
      assert.equal(t.vars.boss, "Scurrius");
      assert.equal(t.vars.theirs, "");
      assert.equal(t.vars.n, 2);
      assert.ok(!("own" in t.vars));
    }
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

  it("shifts the follow-up after the typing-delayed reply (initialDelayMs)", () => {
    const world = makeWorld();
    const { record, bot } = world.add("Alice", 100, 100);
    const baseHarness = makeHarness();
    const offsetHarness = makeHarness();
    const mkOpts = (harness, extra = {}) => ({
      rng: mulberry32(79),
      say: () => {},
      schedule: harness.schedule,
      now: harness.nowFn,
      force: true,
      deps: neutralDeps(),
      forceTopic: "greeting",
      ...extra,
    });
    const base = Engine.maybePlayerFollowUp(
      world.director,
      record,
      bot,
      "Jon",
      mkOpts(baseHarness)
    );
    assert.ok(base);
    const offset = Engine.maybePlayerFollowUp(
      world.director,
      record,
      bot,
      "Jon",
      mkOpts(offsetHarness, { initialDelayMs: 2500 })
    );
    assert.ok(offset);
    const baseDelay = baseHarness.delays[0];
    const offsetDelay = offsetHarness.delays[0];
    assert.ok(
      Math.abs(offsetDelay - (baseDelay + 2500)) < 1e-9,
      `offset delay ${offsetDelay} should be base ${baseDelay} + 2500`
    );
    assert.ok(offsetDelay >= 3000, "follow-up still human-paced");
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

// --- continuations ---------------------------------------------------------------

describe("player continuations", () => {
  beforeEach(() => Engine._resetForTests());

  function startPlayerThread(seed = 81) {
    const world = makeWorld();
    const { record, bot } = world.add("Alice", 100, 100);
    const harness = makeHarness();
    const lines = [];
    const conv = Engine.maybePlayerFollowUp(world.director, record, bot, "Jon", {
      rng: mulberry32(seed),
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
    assert.ok(conv, "thread should be created");
    return { world, record, bot, harness, lines, conv };
  }

  it("continues the active thread on the same topic instead of a fresh one-shot", () => {
    const { conv, harness, lines } = startPlayerThread();
    const plannedBefore = conv.plannedTurns;
    const topicBefore = conv.topic.id;
    const ok = Engine.continuePlayerConversation(
      "Alice",
      "Jon",
      "oh nice, tell me more",
      null
    );
    assert.equal(ok, true, "active thread should continue");
    assert.equal(conv.topic.id, topicBefore, "topic must not change");
    assert.equal(
      conv.plannedTurns,
      Math.min(Engine.MAX_TURNS, plannedBefore + 1),
      "thread extends by one citizen answer"
    );
    const playerLine = conv.history.find((h) => h.stage === "player-line");
    assert.ok(playerLine, "player line recorded in thread history");
    assert.equal(playerLine.topicId, topicBefore);
    harness.pump();
    assert.ok(
      lines.length >= 2,
      `expected continued thread lines, got ${lines.length}`
    );
    for (const h of conv.history) {
      assert.equal(h.topicId, topicBefore, "no topic bleed between lines");
    }
    const stages = conv.history.map((h) => h.stage);
    assert.ok(
      stages.includes("reply"),
      `continuation answer should use the reply stage, got ${stages}`
    );
    assert.equal(conv.state, "done");
  });

  it("answers with human typing pacing through a continuation", () => {
    const { conv, harness, lines } = startPlayerThread();
    Engine.continuePlayerConversation("Alice", "Jon", "tell me more", null);
    assert.ok(harness.delays.length > 0, "reply should be scheduled");
    const firstDelay = harness.delays[0];
    // Turn pacing floor (3800ms) + typing-delay floor (1200ms clamp).
    assert.ok(
      firstDelay >= 5000,
      `continuation reply too fast to be human: ${firstDelay}ms`
    );
    assert.ok(
      firstDelay <= 17500,
      `continuation reply unreasonably slow: ${firstDelay}ms`
    );
    harness.pump();
    assert.ok(lines.length >= 1, "reply should land after its delay");
    // Follow-up turns still land after the reply (offset behavior).
    assert.ok(
      harness.delays.every((d) => d >= 3000),
      "every thread turn stays human-paced"
    );
  });

  it("cancels a stale pending turn so the new reply answers the new line", () => {
    const { conv, harness, lines } = startPlayerThread();
    // The initial follow-up is still pending (not pumped).
    const ok = Engine.continuePlayerConversation("Alice", "Jon", "and then?", null);
    assert.equal(ok, true);
    harness.pump();
    // The stale pre-continuation turn must not have double-spoken:
    // exactly the planned citizen lines speak, then the thread ends.
    assert.equal(
      lines.length,
      conv.plannedTurns,
      `stale turn leaked extra lines: ${lines.length} vs ${conv.plannedTurns}`
    );
    assert.equal(conv.state, "done");
  });

  it("returns false when there is no active player thread to continue", () => {
    // Nothing started.
    assert.equal(
      Engine.continuePlayerConversation("Alice", "Jon", "hi", null),
      false
    );
    // Thread finished already.
    const { conv, harness } = startPlayerThread();
    harness.pump();
    assert.equal(conv.state, "done");
    assert.equal(
      Engine.continuePlayerConversation("Alice", "Jon", "hi again", null),
      false
    );
    // A different speaker is not this thread's player.
    const t2 = startPlayerThread(82);
    assert.equal(
      Engine.continuePlayerConversation("Alice", "NotJon", "hi", null),
      false
    );
    assert.equal(t2.conv.state, "active", "thread untouched by a stranger");
  });

  it("returns false and goes stale when the citizen is offline", () => {
    const { world, bot, conv } = startPlayerThread();
    bot.online = false;
    assert.equal(
      Engine.continuePlayerConversation("Alice", "Jon", "you there?", null),
      false
    );
    assert.equal(conv.state, "done");
    void world;
  });

  it("bounds extended threads at MAX_TURNS", () => {
    const { conv, harness } = startPlayerThread();
    for (let i = 0; i < 20; i++) {
      Engine.continuePlayerConversation("Alice", "Jon", `line ${i}`, null);
      if (conv.state !== "active") break;
    }
    assert.ok(
      conv.plannedTurns <= Engine.MAX_TURNS,
      `planned turns escaped the bound: ${conv.plannedTurns}`
    );
    harness.pump(2000);
  });
});

// --- player initiation ---------------------------------------------------------

describe("player initiation", () => {
  beforeEach(() => Engine._resetForTests());

  const fakePlayerBot = {
    getLocation: () => ({ getX: () => 102, getY: () => 100 }),
  };

  // Cooldown math is (now - lastAt < cooldown) with "never" stored as 0,
  // so the clock must start at a realistic wall-clock time — the shared
  // makeHarness() starts at 1e6 ms (16.7 min), inside the 20-min player
  // cooldown, which would decline every first hail. Same shape as
  // makeHarness, realistic start.
  function freshHarness(startAt = Date.now()) {
    const timers = [];
    const delays = [];
    let now = startAt;
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

  function initiateOpts(harness, extra = {}) {
    return {
      rng: mulberry32(91),
      say: extra.say ?? (() => {}),
      schedule: harness.schedule,
      now: harness.nowFn,
      deps: neutralDeps(),
      forceTopic: "greeting",
      ...extra,
    };
  }

  it("a citizen can open a player-directed conversation", () => {
    const world = makeWorld();
    const { record, bot } = world.add("Alice", 100, 100);
    const harness = freshHarness();
    const lines = [];
    const conv = Engine.maybePlayerInitiate(
      world.director,
      record,
      bot,
      "Jon",
      fakePlayerBot,
      harness.now,
      initiateOpts(harness, { say: (b, text) => lines.push({ speaker: b.username, text }) })
    );
    assert.ok(conv, "initiation should be created");
    assert.equal(conv.kind, "player");
    assert.equal(conv.participants.length, 2);
    assert.ok(conv.participants[1].isPlayer, "second participant is the player");
    assert.equal(lines.length, 1, "the opener is spoken once");
    assert.equal(lines[0].speaker, "Alice");
    assert.ok(!/\{\w+\}/.test(lines[0].text), `unrendered token in opener: ${lines[0].text}`);
  });

  it("the opener is just one line; a silent player closes the thread quietly", () => {
    const world = makeWorld();
    const { record, bot } = world.add("Alice", 100, 100);
    const harness = freshHarness();
    const conv = Engine.maybePlayerInitiate(
      world.director,
      record,
      bot,
      "Jon",
      fakePlayerBot,
      harness.now,
      initiateOpts(harness)
    );
    assert.ok(conv);
    assert.equal(conv.plannedTurns, 1, "opener only — no unprompted follow-ups");
    // The no-reply timer fires at ~90s; pump past it.
    harness.pump(500);
    assert.equal(conv.state, "done");
    assert.equal(conv.endReason, "no-reply");
  });

  it("a replying player continues the thread on the same topic", () => {
    const world = makeWorld();
    const { record, bot } = world.add("Alice", 100, 100);
    const harness = freshHarness();
    const lines = [];
    const conv = Engine.maybePlayerInitiate(
      world.director,
      record,
      bot,
      "Jon",
      fakePlayerBot,
      harness.now,
      initiateOpts(harness, { say: (b, text) => lines.push(text) })
    );
    assert.ok(conv);
    const continued = Engine.continuePlayerConversation("Alice", "Jon", "hey!", bot);
    assert.equal(continued, true, "the player's answer should continue the thread");
    harness.pump(500);
    assert.ok(
      lines.length >= 2,
      `expected opener + reply, got ${lines.length}`
    );
  });

  it("cooldowns: one player isn't hailed twice in a row; a second player is", () => {
    const world = makeWorld();
    const { record, bot } = world.add("Alice", 100, 100);
    const harness = freshHarness();
    const first = Engine.maybePlayerInitiate(
      world.director,
      record,
      bot,
      "Jon",
      fakePlayerBot,
      harness.now,
      initiateOpts(harness)
    );
    assert.ok(first);
    // The same citizen can't immediately hail another player either.
    const second = Engine.maybePlayerInitiate(
      world.director,
      record,
      bot,
      "NotJon",
      fakePlayerBot,
      harness.now,
      initiateOpts(harness)
    );
    assert.equal(second, null, "citizen cooldown should block a second hail");
    harness.pump(500);
    // Even a DIFFERENT citizen can't re-hail Jon within the player cooldown.
    const { record: bobRecord, bot: bobBot } = world.add("Bob", 105, 100);
    const third = Engine.maybePlayerInitiate(
      world.director,
      bobRecord,
      bobBot,
      "Jon",
      fakePlayerBot,
      harness.now,
      initiateOpts(harness)
    );
    assert.equal(third, null, "player cooldown should block re-hailing Jon");
  });

  it("refuses hostile pairs", () => {
    const world = makeWorld();
    const { record, bot } = world.add("Alice", 100, 100);
    const harness = freshHarness();
    const conv = Engine.maybePlayerInitiate(
      world.director,
      record,
      bot,
      "Jon",
      fakePlayerBot,
      harness.now,
      initiateOpts(harness, { deps: neutralDeps({ isEnemy: () => true }) })
    );
    assert.equal(conv, null, "hostile initiation should be refused");
  });

  it("respects the global conversation cap", () => {
    const world = makeWorld();
    const harness = freshHarness();
    // MAX_ACTIVE is 20; fill it with forced follow-ups.
    const worlds = [];
    for (let i = 0; i < Engine.MAX_ACTIVE; i++) {
      const w = makeWorld();
      const { record, bot } = w.add(`Cit${i}`, 100 + i, 100);
      const c = Engine.maybePlayerFollowUp(w.director, record, bot, `Player${i}`, {
        ...initiateOpts(harness),
        force: true,
      });
      assert.ok(c);
      worlds.push(w);
    }
    void worlds;
    void world;
    const w2 = makeWorld();
    const { record, bot } = w2.add("Alice", 100, 100);
    const conv = Engine.maybePlayerInitiate(
      w2.director,
      record,
      bot,
      "Jon",
      fakePlayerBot,
      harness.now,
      initiateOpts(harness)
    );
    assert.equal(conv, null, "initiation should be refused at the global cap");
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

// --- tier flavor: what the relationship sounds like ---------------------------

describe("flavorBucket", () => {
  const convFor = (tier, sources) => ({ tier, sources });

  it("warm for close friends with a warm directed score", () => {
    const sources = neutralDeps({
      bondScore: () => 55,
      isFriend: () => true,
    });
    assert.equal(Engine._flavorBucket(convFor("close", sources), "Alice", "Bob"), "warm");
    assert.equal(Engine._flavorBucket(convFor("friend", sources), "Alice", "Bob"), "warm");
  });

  it("warm via the friend flag even with a modest score", () => {
    const sources = neutralDeps({ bondScore: () => 0, isFriend: () => true });
    assert.equal(Engine._flavorBucket(convFor("friend", sources), "Alice", "Bob"), "warm");
  });

  it("cold for cold-tier pairs when the speaker feels it too", () => {
    const sources = neutralDeps({ bondScore: () => -40 });
    assert.equal(Engine._flavorBucket(convFor("cold", sources), "Alice", "Bob"), "cold");
  });

  it("no snap when the speaker is warm toward a cold-feeling addressee", () => {
    const sources = neutralDeps({
      bondScore: (a) => (a === "Alice" ? 20 : -40),
    });
    assert.equal(Engine._flavorBucket(convFor("cold", sources), "Alice", "Bob"), null);
    assert.equal(Engine._flavorBucket(convFor("cold", sources), "Bob", "Alice"), "cold");
  });

  it("null for strangers and acquaintances", () => {
    assert.equal(Engine._flavorBucket(convFor("neutral", neutralDeps()), "Alice", "Bob"), null);
    assert.equal(
      Engine._flavorBucket(convFor("familiar", neutralDeps({ bondScore: () => 12 })), "Alice", "Bob"),
      null
    );
  });

  it("family for spouses/partners unless feuding", () => {
    const loving = neutralDeps({ bondScore: () => 30, isFamily: () => true });
    assert.equal(Engine._flavorBucket(convFor("familiar", loving), "Alice", "Bob"), "family");
    const feuding = neutralDeps({ bondScore: () => -30, isFamily: () => true });
    assert.equal(Engine._flavorBucket(convFor("cold", feuding), "Alice", "Bob"), "cold");
  });
});

describe("tier flavor in conversations", () => {
  function simPair(tierDeps, seeds = 40) {
    const seen = [];
    for (let seed = 0; seed < seeds; seed++) {
      Engine._resetForTests();
      const world = makeWorld();
      world.add("Alice", 100, 100);
      world.add("Bob", 101, 100);
      const harness = makeHarness();
      const { lines } = startSim(world, harness, "Alice", "Bob", {
        seed: 50000 + seed,
        context: "lingering",
        forceTopic: "greeting",
        deps: tierDeps,
      });
      harness.pump();
      for (const l of lines) seen.push(l.text);
    }
    return seen;
  }

  it("friends tease and use first names", () => {
    const lines = simPair(
      neutralDeps({
        bondScore: () => 60,
        isFriend: () => true,
        memoryEntry: () => ({ met: 12 }),
      })
    );
    assert.ok(lines.length > 0);
    const flavored = lines.filter((t) =>
      /troublemaker|legend|menace|cat dragged in|Well, well/.test(t)
    );
    assert.ok(
      flavored.length > 0,
      `expected warm flavor across sims, saw: ${lines.slice(0, 6).join(" | ")}`
    );
    assert.ok(
      !lines.some((t) => /It's you|We're done here|Watch yourself/.test(t)),
      "friends must never snap cold barbs"
    );
  });

  it("rivals trade barbs", () => {
    const lines = simPair(neutralDeps({ bondScore: () => -40 }));
    assert.ok(lines.length > 0);
    const barbs = lines.filter((t) =>
      /It's you|We're done here|Watch yourself|Make it quick|Hmph|blocking the road/.test(t)
    );
    assert.ok(
      barbs.length > 0,
      `expected cold barbs across sims, saw: ${lines.slice(0, 6).join(" | ")}`
    );
    assert.ok(
      !lines.some((t) => /troublemaker|legend|Good to see you/.test(t)),
      "rivals must never gush warm lines"
    );
  });

  it("strangers keep the shallow base pools", () => {
    const lines = simPair(neutralDeps());
    assert.ok(lines.length > 0);
    assert.ok(
      !lines.some((t) =>
        /troublemaker|legend|menace|It's you|We're done here|Hey love|dear/.test(t)
      ),
      `strangers must stay shallow, saw: ${lines.filter((t) => /troublemaker|legend|It's you/.test(t)).join(" | ")}`
    );
  });

  it("friends reminisce about real favors; rivals nurse real grudges", () => {
    const warmLines = simPair(
      neutralDeps({
        bondScore: () => 60,
        isFriend: () => true,
        favorStory: () => "lent you 5k for the rune scim",
      })
    );
    assert.ok(
      warmLines.some((t) => t.includes("lent you 5k for the rune scim")),
      `expected a real favor reference, saw: ${warmLines.slice(0, 8).join(" | ")}`
    );
    const coldLines = simPair(
      neutralDeps({
        bondScore: () => -40,
        grudgeStory: () => "stole my rune scim",
      })
    );
    assert.ok(
      coldLines.some((t) => t.includes("stole my rune scim")),
      `expected a real grudge reference, saw: ${coldLines.slice(0, 8).join(" | ")}`
    );
  });

  it("family uses familiar terms", () => {
    const lines = simPair(
      neutralDeps({ bondScore: () => 30, isFamily: () => true })
    );
    assert.ok(lines.length > 0);
    assert.ok(
      lines.some((t) => /Hey love|dear|See you at home/.test(t)),
      `expected familiar terms, saw: ${lines.slice(0, 6).join(" | ")}`
    );
  });

  it("flavor lines never leak unrendered tokens", () => {
    const lines = simPair(
      neutralDeps({
        bondScore: () => 60,
        isFriend: () => true,
        favorStory: () => "covered your shift at the mill",
      })
    );
    for (const t of lines) {
      assert.ok(!/\{/.test(t), `unrendered token: ${t}`);
    }
  });
});
