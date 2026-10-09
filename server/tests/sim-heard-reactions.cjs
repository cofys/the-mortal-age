"use strict";
/**
 * Simulation: CitizenHeardReactions scripted reflexes.
 * Verifies: pattern matching (greetings, gz, farewells, thanks, laughter),
 * personality gating, 60s throttle, hostile shun, warm friend greeting.
 */
const h = require("./sim-chatter-harness.cjs");

// Mock CitizenSocialBonds BEFORE the reactions module loads it.
const bondsPath = require.resolve("../plugins/citizens/lib/CitizenSocialBonds.js");
require(bondsPath);
const mockBonds = require.cache[bondsPath].exports;
// Default: strangers (no special standing).
if (mockBonds.standingFor) {
  const orig = mockBonds.standingFor;
  mockBonds._mockStanding = null;
  mockBonds.standingFor = (a, b) => mockBonds._mockStanding ?? orig(a, b);
}

const reactions = require("../plugins/citizens/chat/CitizenHeardReactions.js");

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
  reactions.resetForTests();
  require("../plugins/citizens/chat/CitizenSayPublic.js").resetForTests();
  mockBonds._mockStanding = null;
}

function chattyBot(name) {
  const bot = h.mockBot(name, { traits: ["chatty"] });
  return bot;
}

console.log("== Test 1: pattern matching ==");
{
  check("'hi' -> greeting", reactions.matchPattern("hi") === "greeting");
  check("'hey everyone' -> greeting", reactions.matchPattern("hey everyone") === "greeting");
  check("'gz!' -> levelup", reactions.matchPattern("gz!") === "levelup");
  check("'just hit 70 fishing!' -> levelup", reactions.matchPattern("just hit 70 fishing!") === "levelup");
  check("'cya!' -> farewell", reactions.matchPattern("cya!") === "farewell");
  check("'thanks!' -> thanks", reactions.matchPattern("thanks!") === "thanks");
  check("'lol' -> laughter", reactions.matchPattern("lol") === "laughter");
  check("'gl!' -> gl", reactions.matchPattern("gl!") === "gl");
  check("'yeah' -> agree", reactions.matchPattern("yeah") === "agree");
  check("long sentence -> null", reactions.matchPattern("this is a long thoughtful sentence about the economy") === null);
  check("empty -> null", reactions.matchPattern("") === null);
}

console.log("== Test 2: greeting reaction fires ==");
{
  resetAll();
  const bot = chattyBot("Greeter Gus");
  const origRandom = Math.random;
  Math.random = () => 0.01; // always pass personality gate
  const line = reactions.tryScriptedReaction("Greeter Gus", "Jon", "hey!", bot, 1000000);
  Math.random = origRandom;
  check("reaction returned a line", typeof line === "string" && line.length > 0, `got "${line}"`);
  check("speech captured via sayPublic", h.spoken.length === 1, `spoken=${JSON.stringify(h.spoken)}`);
}

console.log("== Test 3: 60s throttle prevents spam ==");
{
  resetAll();
  const bot = chattyBot("Throttled Tim");
  const origRandom = Math.random;
  Math.random = () => 0.01;
  reactions.tryScriptedReaction("Throttled Tim", "Jon", "hey!", bot, 3000000);
  const first = h.spoken.length;
  // 10 seconds later: should be throttled.
  const second = reactions.tryScriptedReaction("Throttled Tim", "Jon", "hello!", bot, 3010000);
  Math.random = origRandom;
  check("second reaction within 60s returns null", second === null);
  check("no additional speech", h.spoken.length === first);
  // After 61s: fires again.
  Math.random = () => 0.01;
  const third = reactions.tryScriptedReaction("Throttled Tim", "Jon", "hello!", bot, 3062000);
  Math.random = origRandom;
  check("reaction fires after cooldown", typeof third === "string");
}

console.log("== Test 4: personality gating (taciturn reacts less) ==");
{
  resetAll();
  // Taciturn has 0.25 chance. With rng=0.5, should NOT react.
  const bot = h.mockBot("Quiet Quinn", { traits: ["taciturn"] });
  const origRandom = Math.random;
  Math.random = () => 0.5;
  const line = reactions.tryScriptedReaction("Quiet Quinn", "Jon", "hey!", bot, 4000000);
  Math.random = origRandom;
  check("taciturn stays silent at rng 0.5", line === null);

  // Chatty has 0.85 chance. With rng=0.5, SHOULD react.
  resetAll();
  const chatty = chattyBot("Chatty Cathy");
  Math.random = () => 0.5;
  const line2 = reactions.tryScriptedReaction("Chatty Cathy", "Jon", "hey!", bot, 4000000);
  // Note: wrong bot passed intentionally? No — fix: use chatty bot.
  Math.random = origRandom;
  // Re-run correctly:
  resetAll();
  Math.random = () => 0.5;
  const line3 = reactions.tryScriptedReaction("Chatty Cathy", "Jon", "hey!", chatty, 4000000);
  Math.random = origRandom;
  check("chatty reacts at rng 0.5", typeof line3 === "string", `got "${line3}"`);
}

console.log("== Test 5: gruff voice is terse ==");
{
  resetAll();
  const bot = h.mockBot("Gruff Gary", { traits: ["gruff"] });
  const origRandom = Math.random;
  Math.random = () => 0.01;
  const line = reactions.tryScriptedReaction("Gruff Gary", "Jon", "hey!", bot, 5000000);
  Math.random = origRandom;
  check("gruff greeting is terse", line && line.length <= 10 && !line.includes("!"), `got "${line}"`);
}

console.log("== Test 6: hostile standing -> shun ==");
{
  resetAll();
  mockBonds._mockStanding = "rival";
  const bot = chattyBot("Rival Ron");
  const origRandom = Math.random;
  Math.random = () => 0.01;
  const line = reactions.tryScriptedReaction("Rival Ron", "Jon", "hey!", bot, 6000000);
  Math.random = origRandom;
  const shuns = ["...", "what.", "not now.", "whatever.", "hm."];
  check("rival gets shunned", shuns.includes(line), `got "${line}"`);
}

console.log("== Test 7: warm friend greeting uses name ==");
{
  resetAll();
  mockBonds._mockStanding = "friend";
  const bot = chattyBot("Friend Fiona");
  const origRandom = Math.random;
  Math.random = () => 0.01;
  const line = reactions.tryScriptedReaction("Friend Fiona", "Jon", "hey!", bot, 7000000);
  Math.random = origRandom;
  check("friend greeted by name", line && line.toLowerCase().includes("jon"), `got "${line}"`);
}

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
