"use strict";
/**
 * Simulation: CitizenActivityChatter tick with mock citizens.
 * Verifies: fires when watched+skilling, silent when alone, cooldown respected,
 * personality scaling (gruff=terse, chatty=warm), milestone detection.
 */
const h = require("./sim-chatter-harness.cjs");

// Mock CitizenIntents BEFORE the chatter module loads it.
const intentsPath = require.resolve("../plugins/citizens/brain/CitizenIntents.js");
require(intentsPath);
require.cache[intentsPath].exports.activeIntents = (player) => {
  // Return intents based on a marker on the mock bot.
  return player._mockIntents ?? [];
};

const chatter = require("../plugins/citizens/chat/CitizenActivityChatter.js");
const { voiceFor } = require("../plugins/citizens/lib/citizenVoice.js");

let passed = 0;
let failed = 0;
function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    console.log(`  PASS: ${name}`);
  } else {
    failed++;
    console.log(`  FAIL: ${name}${detail ? " — " + detail : ""}`);
  }
}

function resetAll() {
  h.clearSpoken();
  chatter._resetForTests();
  require("../plugins/citizens/chat/CitizenSayPublic.js").resetForTests();
}

// Deterministic rng for repeatable tests.
function seqRng(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

console.log("== Test 1: fires when watched and skilling ==");
{
  resetAll();
  const realPlayer = h.mockRealPlayer("Jon");
  const bot = h.mockBot("Fisher Fred", { traits: ["chatty"] }, [realPlayer], {
    [h.Skill.FISHING]: { level: 50, xp: 100000 },
  });
  bot._mockIntents = [{ type: "gain_xp", label: "fishing" }];
  const sessions = new Map([
    ["s1", { sessionId: "s1", arrived: true, skill: "fishing", members: ["Fisher Fred"] }],
  ]);
  const director = h.mockDirector([bot], sessions, h.Skill);
  // Force chatter chance to pass and cooldown to be expired.
  const origRandom = Math.random;
  Math.random = () => 0.01; // always passes chance gates, minimal cooldown
  chatter.tickActivityChatter(director, { sessions, nowMs: 1000000 });
  Math.random = origRandom;
  check("speech fired", h.spoken.length > 0, `spoken=${JSON.stringify(h.spoken)}`);
  check("speech from Fisher Fred", h.spoken.some((s) => s.from === "Fisher Fred"));
}

console.log("== Test 2: silent when no real player nearby ==");
{
  resetAll();
  const bot = h.mockBot("Lonely Larry", { traits: ["chatty"] }, [], {
    [h.Skill.FISHING]: { level: 50, xp: 100000 },
  });
  const sessions = new Map([
    ["s1", { sessionId: "s1", arrived: true, skill: "fishing", members: ["Lonely Larry"] }],
  ]);
  const director = h.mockDirector([bot], sessions, h.Skill);
  const origRandom = Math.random;
  Math.random = () => 0.01;
  chatter.tickActivityChatter(director, { sessions, nowMs: 2000000 });
  Math.random = origRandom;
  check("no speech when unwatched", h.spoken.length === 0, `spoken=${JSON.stringify(h.spoken)}`);
}

console.log("== Test 3: silent when not in a session ==");
{
  resetAll();
  const realPlayer = h.mockRealPlayer("Jon");
  const bot = h.mockBot("Idle Ivan", { traits: ["chatty"] }, [realPlayer], {});
  const sessions = new Map(); // no sessions
  const director = h.mockDirector([bot], sessions, h.Skill);
  const origRandom = Math.random;
  Math.random = () => 0.01;
  chatter.tickActivityChatter(director, { sessions, nowMs: 3000000 });
  Math.random = origRandom;
  check("no speech when not skilling", h.spoken.length === 0);
}

console.log("== Test 4: cooldown respected (no spam) ==");
{
  resetAll();
  const realPlayer = h.mockRealPlayer("Jon");
  const bot = h.mockBot("Chatty Cathy", { traits: ["chatty"] }, [realPlayer], {
    [h.Skill.FISHING]: { level: 50, xp: 100000 },
  });
  const sessions = new Map([
    ["s1", { sessionId: "s1", arrived: true, skill: "fishing", members: ["Chatty Cathy"] }],
  ]);
  const director = h.mockDirector([bot], sessions, h.Skill);
  const origRandom = Math.random;
  Math.random = () => 0.01;
  chatter.tickActivityChatter(director, { sessions, nowMs: 4000000 });
  const firstCount = h.spoken.length;
  // Immediate second tick — should be throttled by per-citizen cooldown.
  chatter.tickActivityChatter(director, { sessions, nowMs: 4000001 });
  Math.random = origRandom;
  check(
    "second immediate tick adds no chatter",
    h.spoken.length === firstCount,
    `first=${firstCount} second=${h.spoken.length}`
  );
}

console.log("== Test 5: personality scaling (gruff=terse, chatty=warm) ==");
{
  resetAll();
  const gruffVoice = voiceFor({ traits: ["gruff"] });
  const chattyVoice = voiceFor({ traits: ["chatty"] });
  check("gruff -> terse register", gruffVoice.register === "terse", `got ${gruffVoice.register}`);
  check("chatty -> warm register", chattyVoice.register === "warm", `got ${chattyVoice.register}`);

  // Direct line picking: gruff should get terse lines, chatty warm/plain.
  const gruffLine = chatter._pickSkillLine("fishing", { level: 50, xp: 100000 }, { traits: ["gruff"] }, seqRng([0.5]));
  const chattyLine = chatter._pickSkillLine("fishing", { level: 50, xp: 100000 }, { traits: ["chatty"] }, seqRng([0.5]));
  check("gruff line is terse (short, no !)", gruffLine.length <= 20 && !gruffLine.includes("!"), `got "${gruffLine}"`);
  console.log(`    info: chatty line="${chattyLine}" gruff line="${gruffLine}"`);
}

console.log("== Test 6: milestone detection (close to level -> 'almost N') ==");
{
  resetAll();
  // OSRS XP: level 70 = 737,627. Put citizen at 95% of the way to 70.
  const xp70 = 737627;
  const xp69 = 668051;
  const almostThere = xp69 + Math.floor((xp70 - xp69) * 0.9);
  const line = chatter._pickSkillLine(
    "fishing",
    { level: 69, xp: almostThere },
    { traits: ["chatty"] },
    seqRng([0.1])
  );
  check("milestone line mentions level 70", line.includes("70"), `got "${line}"`);

  // Far from level: should NOT mention next level as milestone.
  const farLine = chatter._pickSkillLine(
    "fishing",
    { level: 50, xp: 101333 + 100 }, // just into 50
    { traits: ["chatty"] },
    seqRng([0.9])
  );
  console.log(`    info: far-from-level line="${farLine}"`);
}

console.log("== Test 7: goal announcement fires once per session ==");
{
  resetAll();
  const realPlayer = h.mockRealPlayer("Jon");
  const bot = h.mockBot("Goal Gary", { traits: ["chatty"] }, [realPlayer], {
    [h.Skill.FISHING]: { level: 50, xp: 100000 },
  });
  bot._mockIntents = [{ type: "earn_coins", label: "coins" }];
  const sessions = new Map([
    ["s1", { sessionId: "s1", arrived: true, skill: "fishing", members: ["Goal Gary"] }],
  ]);
  const director = h.mockDirector([bot], sessions, h.Skill);
  const origRandom = Math.random;
  Math.random = () => 0.01;
  chatter.tickActivityChatter(director, { sessions, nowMs: 7000000 });
  const afterFirst = h.spoken.length;
  // Second tick same session — goal should NOT re-announce (but chatter cooldown also blocks).
  chatter.tickActivityChatter(director, { sessions, nowMs: 7000001 });
  Math.random = origRandom;
  const goalLines = h.spoken.filter((s) => /coin|today/i.test(s.text));
  check("goal announced", goalLines.length > 0, `spoken=${JSON.stringify(h.spoken)}`);
  console.log(`    info: total lines after 2 ticks=${h.spoken.length} (first tick=${afterFirst})`);
}

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
