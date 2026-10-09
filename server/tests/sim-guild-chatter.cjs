"use strict";
/**
 * Simulation: CitizenGuildChatter session speech.
 * Verifies: all 3 guilds produce lines, rank tiering, round-0 greeting,
 * shouldSpeak gating, personality scaling, never throws on bad input.
 */
const h = require("./sim-chatter-harness.cjs");
const guild = require("../plugins/citizens/lib/CitizenGuildChatter.js");

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

function seqRng(values) {
  let i = 0;
  return () => values[i++ % values.length];
}

console.log("== Test 1: all three guilds produce lines for all rounds ==");
for (const g of ["art", "music", "cook"]) {
  for (let round = 0; round < 3; round++) {
    const line = guild.chatterLine({
      guild: g,
      rank: g === "art" ? "master" : g === "music" ? "maestro" : "chefdecuisine",
      personality: { traits: ["chatty"] },
      rng: seqRng([0.1, 0.3, 0.5, 0.7, 0.9]),
      roundIndex: round,
    });
    check(`${g} round ${round} produces line`, typeof line === "string" && line.length >= 3, `got "${line}"`);
  }
}

console.log("== Test 2: round 0 is always a greeting ==");
{
  const line = guild.chatterLine({
    guild: "art",
    rank: "apprentice",
    personality: { traits: ["chatty"] },
    rng: seqRng([0.99]), // even with high roll, round 0 = greet
    roundIndex: 0,
  });
  const greets = ["evening all", "hey everyone", "made it", "whos showing", "good session", "hey", "evening", "here"];
  check("round 0 is greeting", greets.some((g) => line.toLowerCase().includes(g)), `got "${line}"`);
}

console.log("== Test 3: rank tiering (top critiques, low asks) ==");
{
  // Run many samples with fixed rng to check category distribution.
  let topCritique = 0, lowQuestion = 0;
  for (let i = 0; i < 50; i++) {
    const line = guild.chatterLine({
      guild: "art", rank: "master",
      personality: { traits: ["chatty"] },
      rng: seqRng([(i % 10) / 10]),
      roundIndex: 1,
    });
    // Critique lines contain teaching language.
    if (/shading|composition|contrast|lines|edges|background/i.test(line)) topCritique++;
  }
  for (let i = 0; i < 50; i++) {
    const line = guild.chatterLine({
      guild: "art", rank: "apprentice",
      personality: { traits: ["chatty"] },
      rng: seqRng([(i % 10) / 10]),
      roundIndex: 1,
    });
    if (/\?/.test(line)) lowQuestion++;
  }
  check("masters critique often", topCritique >= 15, `${topCritique}/50`);
  check("apprentices ask questions often", lowQuestion >= 15, `${lowQuestion}/50`);
}

console.log("== Test 4: shouldSpeak gating ==");
{
  check("round 0 always speaks", guild.shouldSpeak(seqRng([0.99]), 0) === true);
  // With rng < 0.7, later rounds speak; with rng >= 0.7 they don't.
  check("round 1 speaks at rng 0.5", guild.shouldSpeak(seqRng([0.5]), 1) === true);
  check("round 1 silent at rng 0.9", guild.shouldSpeak(seqRng([0.9]), 1) === false);
}

console.log("== Test 5: personality scaling in guild lines ==");
{
  const gruffLine = guild.chatterLine({
    guild: "cook", rank: "chefdecuisine",
    personality: { traits: ["gruff"] },
    rng: seqRng([0.05]), // critique category, first line
    roundIndex: 1,
  });
  check("gruff chef is terse", gruffLine.length <= 15 && !gruffLine.includes("!"), `got "${gruffLine}"`);
}

console.log("== Test 6: speakInSession integration ==");
{
  h.clearSpoken();
  const bot = h.mockBot("Artist Amy", { traits: ["chatty"] });
  const result = guild.speakInSession({
    player: bot,
    personality: { traits: ["chatty"] },
    rng: seqRng([0.1]),
    rank: "artist",
    roundIndex: 0, // greeting round: always speaks
    guild: "art",
    sayPublic: h.mockSayPublic,
  });
  check("speakInSession returns true", result === true);
  check("speech captured", h.spoken.length === 1, `spoken=${JSON.stringify(h.spoken)}`);

  // Missing sayPublic: returns false, never throws.
  const noSay = guild.speakInSession({ player: bot, guild: "art", roundIndex: 0 });
  check("missing sayPublic returns false safely", noSay === false);
}

console.log("== Test 7: unknown guild never throws ==");
{
  const line = guild.chatterLine({ guild: "fishing", rank: "master", roundIndex: 1 });
  check("unknown guild returns empty string", line === "", `got "${line}"`);
  const bad = guild.chatterLine(null);
  check("null opts returns empty string", bad === "", `got "${bad}"`);
}

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
