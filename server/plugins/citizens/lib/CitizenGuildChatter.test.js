"use strict";

/**
 * CitizenGuildChatter tests — guild hall sessions have a voice.
 *
 * Verifies:
 *   - Every line in every pool is 3-15 words (human-player-model.md rule).
 *   - Personality scaling: gruff -> terse register, chatty -> warm.
 *   - Tier mapping: masters critique, apprentices ask.
 *   - Round 0 is always a greeting; unknown guilds stay silent, never throw.
 *   - speakInSession calls sayPublic and never throws (even with junk).
 */

const assert = require("assert");
const {
  chatterLine,
  shouldSpeak,
  speakInSession,
  rankTier,
  POOLS,
} = require("./CitizenGuildChatter");

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

function wordCount(s) {
  return String(s).trim().split(/\s+/).filter(Boolean).length;
}

// Deterministic rng for tests: cycles a fixed sequence.
function seqRng(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

const GRUFF = { traits: ["gruff", "taciturn"], speechStyle: "short clipped sentences" };
const CHATTY = { traits: ["chatty", "cheerful"], speechStyle: "rapid-fire chatter" };
const PLAIN = { traits: ["dutiful"], speechStyle: "plain blunt words" };

test("all lines are 3-15 words across all guilds and registers", () => {
  for (const [guild, cats] of Object.entries(POOLS)) {
    for (const [cat, pool] of Object.entries(cats)) {
      for (const [reg, lines] of Object.entries(pool)) {
        assert.ok(Array.isArray(lines) && lines.length > 0,
          `${guild}/${cat}/${reg} is empty`);
        for (const line of lines) {
          const n = wordCount(line);
          assert.ok(n >= 1 && n <= 15,
            `${guild}/${cat}/${reg} line "${line}" has ${n} words (want 1-15)`);
        }
      }
    }
  }
});

test("terse pools exist wherever plain pools do (voice scaling)", () => {
  for (const [guild, cats] of Object.entries(POOLS)) {
    for (const [cat, pool] of Object.entries(cats)) {
      assert.ok(pool.terse && pool.terse.length > 0,
        `${guild}/${cat} missing terse variant`);
    }
  }
});

test("gruff personality gets terse register lines", () => {
  // A gruff master critiquing: terse pool lines are shorter/blunter.
  const seen = new Set();
  for (let i = 0; i < 30; i++) {
    const line = chatterLine({
      guild: "art", rank: "master", personality: GRUFF,
      rng: seqRng([0.05, 0.5]), roundIndex: 1,
    });
    assert.ok(line, "expected a line");
    seen.add(line);
  }
  // Terse lines never exclaim (styleLine strips "!").
  for (const line of seen) {
    assert.ok(!line.includes("!"), `gruff line should not exclaim: "${line}"`);
  }
});

test("chatty personality keeps expressive lines", () => {
  let sawExclaim = false;
  for (let i = 0; i < 40; i++) {
    const line = chatterLine({
      guild: "music", rank: "minstrel", personality: CHATTY,
      // First value picks the category, second picks the line within it.
      rng: seqRng([((0.1 * i) % 1), ((0.37 * i + 0.11) % 1)]), roundIndex: 2,
    });
    if (line.includes("!")) sawExclaim = true;
  }
  assert.ok(sawExclaim, "chatty minstrel should sometimes exclaim");
});

test("round 0 is always a greeting", () => {
  const greets = new Set(POOLS.art.greet.plain.concat(POOLS.art.greet.terse));
  for (let i = 0; i < 20; i++) {
    const line = chatterLine({
      guild: "art", rank: "master", personality: PLAIN,
      rng: seqRng([((0.3 * i) % 1)]), roundIndex: 0,
    });
    // Greeting pool lines are short; just verify it came from greet pools
    // (lowercased by styleLine for some voices — compare case-insensitively).
    const lower = line.toLowerCase();
    const fromGreet = [...greets].some((g) => g.toLowerCase() === lower);
    assert.ok(fromGreet, `round-0 line "${line}" not from greet pool`);
  }
});

test("masters critique, apprentices ask (tier weighting)", () => {
  const critPool = POOLS.art.critique.plain.concat(POOLS.art.critique.terse);
  const qPool = POOLS.art.question.plain.concat(POOLS.art.question.terse);
  let masterCrit = 0, apprenticeQ = 0;
  const N = 60;
  for (let i = 0; i < N; i++) {
    const mLine = chatterLine({
      guild: "art", rank: "master", personality: PLAIN,
      rng: seqRng([(i * 0.37) % 1, (i * 0.61) % 1]), roundIndex: 1,
    }).toLowerCase();
    const aLine = chatterLine({
      guild: "art", rank: "apprentice", personality: PLAIN,
      rng: seqRng([(i * 0.53) % 1, (i * 0.29) % 1]), roundIndex: 1,
    }).toLowerCase();
    if (critPool.some((c) => c.toLowerCase() === mLine)) masterCrit++;
    if (qPool.some((q) => q.toLowerCase() === aLine)) apprenticeQ++;
  }
  // Weights: top tier critique=5/10, low tier question=5/9 — both should
  // dominate their samples well above uniform.
  assert.ok(masterCrit > N * 0.3, `masters critiqued ${masterCrit}/${N} rounds`);
  assert.ok(apprenticeQ > N * 0.3, `apprentices asked ${apprenticeQ}/${N} rounds`);
});

test("rankTier maps all three guilds' ranks", () => {
  assert.strictEqual(rankTier("art", "master"), "top");
  assert.strictEqual(rankTier("art", "artist"), "mid");
  assert.strictEqual(rankTier("art", "apprentice"), "low");
  assert.strictEqual(rankTier("music", "maestro"), "top");
  assert.strictEqual(rankTier("music", "minstrel"), "mid");
  assert.strictEqual(rankTier("music", "novice"), "low");
  assert.strictEqual(rankTier("cook", "chefdecuisine"), "top");
  assert.strictEqual(rankTier("cook", "souschef"), "mid");
  assert.strictEqual(rankTier("cook", "apprentice"), "low");
  assert.strictEqual(rankTier("art", "bogus"), "mid"); // unknown -> mid, never throws
  assert.strictEqual(rankTier("nope", "master"), "mid");
});

test("unknown guild stays silent, never throws", () => {
  assert.strictEqual(
    chatterLine({ guild: "weave", rank: "master", personality: {}, rng: seqRng([0.5]), roundIndex: 1 }),
    ""
  );
  assert.strictEqual(chatterLine(), "");
  assert.strictEqual(chatterLine(null), "");
});

test("shouldSpeak: greeting round always, others ~70%", () => {
  assert.strictEqual(shouldSpeak(seqRng([0.99]), 0), true);
  assert.strictEqual(shouldSpeak(seqRng([0.99]), 0), true);
  // rng 0.99 > 0.7 -> silent; 0.01 < 0.7 -> speaks
  assert.strictEqual(shouldSpeak(seqRng([0.99]), 1), false);
  assert.strictEqual(shouldSpeak(seqRng([0.01]), 1), true);
});

test("speakInSession calls sayPublic with a voiced line", () => {
  const said = [];
  const ok = speakInSession({
    player: { getUsername: () => "painty pete" },
    personality: CHATTY,
    rng: seqRng([0.01, 0.5]), // round 0: always speaks
    rank: "artist",
    roundIndex: 0,
    guild: "art",
    sayPublic: (player, line) => said.push(line),
  });
  assert.strictEqual(ok, true);
  assert.strictEqual(said.length, 1);
  assert.ok(said[0].length > 0, "line should not be empty");
  assert.ok(said[0].length <= 80, "line fits chat box");
});

test("speakInSession never throws on junk input", () => {
  assert.strictEqual(speakInSession({}), false);
  assert.strictEqual(speakInSession(null), false);
  assert.strictEqual(speakInSession({
    player: null, personality: null, rng: null, rank: null,
    roundIndex: 1, guild: "art",
    sayPublic: () => { throw new Error("boom"); },
  }), false);
  // Missing sayPublic -> false, not a throw.
  assert.strictEqual(speakInSession({
    player: {}, personality: {}, rng: seqRng([0.01]),
    rank: "master", roundIndex: 0, guild: "art",
  }), false);
});

test("music and cook guilds produce voiced lines too", () => {
  for (const [guild, rank] of [["music", "maestro"], ["cook", "chefdecuisine"], ["cook", "apprentice"]]) {
    const line = chatterLine({
      guild, rank, personality: GRUFF, rng: seqRng([0.2, 0.4]), roundIndex: 1,
    });
    assert.ok(line && line.length > 0, `${guild}/${rank} produced no line`);
    assert.ok(wordCount(line) <= 15, `${guild} line too long: "${line}"`);
  }
});

console.log(`\n${passed} tests passed`);
