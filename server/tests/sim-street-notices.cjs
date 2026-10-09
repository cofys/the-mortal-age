"use strict";
/**
 * Simulation: StreetNotices level-up and death notices.
 * Verifies: player level-up congrats, citizen level-up announce + gz chain,
 * death sympathy, cooldowns, milestone lines.
 */
const h = require("./sim-chatter-harness.cjs");

// Stub the director module in require cache (real one needs the TS engine).
const directorPath = require.resolve("../plugins/citizens/director/CitizenDirector.js");
let mockDirectorInstance = null;
require.cache[directorPath] = {
  id: directorPath,
  filename: directorPath,
  loaded: true,
  exports: { getDirector: () => mockDirectorInstance },
};

// Mock CitizenSocialBonds for tryScriptedReaction (used by citizen gz chain).
const bondsPath = require.resolve("../plugins/citizens/lib/CitizenSocialBonds.js");
require(bondsPath);
const mockBonds = require.cache[bondsPath].exports;
if (mockBonds.standingFor) {
  const orig = mockBonds.standingFor;
  mockBonds._mockStanding = null;
  mockBonds.standingFor = (a, b) => mockBonds._mockStanding ?? orig(a, b);
}

const notices = require("../plugins/citizens/StreetNotices.js");

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
  notices.resetForTests();
  require("../plugins/citizens/chat/CitizenSayPublic.js").resetForTests();
  require("../plugins/citizens/chat/CitizenHeardReactions.js").resetForTests();
  mockBonds._mockStanding = null;
}

// A citizen bot with a roster record (needs getLocation for withinTiles).
function streetBot(username, personality, x = 0, y = 0) {
  const bot = h.mockBot(username, personality);
  bot.getLocation = () => ({
    getX: () => x,
    getY: () => y,
    getZ: () => 0,
  });
  // Citizens plugin marks citizens via citizens:role attribute.
  const origGetAttr = bot.getAttribute.bind(bot);
  bot.getAttribute = (key) => {
    if (key === "citizens:role") return "fisher";
    return origGetAttr(key);
  };
  return bot;
}

function realPlayerAt(username, x = 0, y = 0, locals = []) {
  const p = h.mockRealPlayer(username);
  p.getLocation = () => ({
    getX: () => x,
    getY: () => y,
    getZ: () => 0,
  });
  p.getLocalPlayers = () => locals;
  return p;
}

function setupDirector(bots) {
  const roster = new Map();
  for (const bot of bots) {
    roster.set(String(bot.getUsername()).trim().toLowerCase(), {
      username: bot.getUsername(),
      personality: bot._personality,
    });
  }
  mockDirectorInstance = {
    roster,
    isOnline: () => true,
  };
}

console.log("== Test 1: player level-up gets congratulated ==");
{
  resetAll();
  const citizen = streetBot("Cheerful Charlie", { traits: ["cheerful"] }, 5, 5);
  setupDirector([citizen]);
  const player = realPlayerAt("Jon", 0, 0, [citizen]);
  const origRandom = Math.random;
  Math.random = () => 0.01; // pass chance gates
  notices.onPlayerLevelUpNotice(
    { player, skill: { getName: () => "Fishing" }, oldLevel: 49, newLevel: 50 },
    1791577403000
  );
  Math.random = origRandom;
  check("congrats fired", h.spoken.length === 1, `spoken=${JSON.stringify(h.spoken)}`);
  check("mentions level 50", h.spoken[0]?.text.includes("50"), `got "${h.spoken[0]?.text}"`);
}

console.log("== Test 2: player congratulated at most every 10 min ==");
{
  resetAll();
  const citizen = streetBot("Cheerful Charlie", { traits: ["cheerful"] }, 5, 5);
  setupDirector([citizen]);
  const player = realPlayerAt("Jon", 0, 0, [citizen]);
  const origRandom = Math.random;
  Math.random = () => 0.01;
  notices.onPlayerLevelUpNotice(
    { player, skill: { getName: () => "Fishing" }, oldLevel: 49, newLevel: 50 },
    1791581003000
  );
  const first = h.spoken.length;
  // 5 minutes later: same player levels again — should be suppressed.
  notices.onPlayerLevelUpNotice(
    { player, skill: { getName: () => "Woodcutting" }, oldLevel: 30, newLevel: 31 },
    1791581303000
  );
  Math.random = origRandom;
  check("second level-up suppressed (player cooldown)", h.spoken.length === first);
}

console.log("== Test 3: milestone (99) gets big lines ==");
{
  resetAll();
  const citizen = streetBot("Warm Wendy", { traits: ["cheerful", "friendly"] }, 5, 5);
  setupDirector([citizen]);
  const player = realPlayerAt("Jon", 0, 0, [citizen]);
  const origRandom = Math.random;
  Math.random = () => 0.01;
  notices.onPlayerLevelUpNotice(
    { player, skill: { getName: () => "Fishing" }, oldLevel: 98, newLevel: 99 },
    1791588203000
  );
  Math.random = origRandom;
  check("milestone congrats fired", h.spoken.length === 1, `got "${h.spoken[0]?.text}"`);
}

console.log("== Test 4: citizen level-up announces + nearby citizens gz ==");
{
  resetAll();
  const leveler = streetBot("Fisher Fred", { traits: ["chatty"] }, 0, 0);
  const hearer = streetBot("Hearer Hannah", { traits: ["chatty"] }, 5, 5);
  // The hearer needs the leveler in their local players for tryScriptedReaction... no,
  // actually tryScriptedReaction is called directly with the bot. It needs bot for sayPublic.
  // nearbyCitizens(player, radius) uses player.getLocalPlayers() — the LEVELER's locals.
  leveler.getLocalPlayers = () => [hearer];
  hearer.getLocalPlayers = () => [leveler];
  setupDirector([leveler, hearer]);
  const origRandom = Math.random;
  Math.random = () => 0.01; // pass announce chance + gz personality gate
  notices.onCitizenLevelUpNotice(
    { player: leveler, skill: { getName: () => "Fishing" }, oldLevel: 69, newLevel: 70 },
    1791591803000
  );
  Math.random = origRandom;
  const announce = h.spoken.find((s) => s.from === "Fisher Fred");
  const gz = h.spoken.find((s) => s.from === "Hearer Hannah");
  check("leveler announced", !!announce, `spoken=${JSON.stringify(h.spoken)}`);
  check("announce matches levelup pattern", announce && /just hit|ding/i.test(announce.text), `got "${announce?.text}"`);
  check("hearer gz'd", !!gz, `spoken=${JSON.stringify(h.spoken)}`);
}

console.log("== Test 5: player death gets sympathy ==");
{
  resetAll();
  const citizen = streetBot("Sympathetic Sam", { traits: ["kind"] }, 5, 5);
  setupDirector([citizen]);
  const player = realPlayerAt("Jon", 0, 0, [citizen]);
  const origRandom = Math.random;
  Math.random = () => 0.01;
  notices.onPlayerDeathNotice({ player }, 5000000);
  Math.random = origRandom;
  check("sympathy fired", h.spoken.length === 1, `spoken=${JSON.stringify(h.spoken)}`);
}

console.log("== Test 6: distant citizens don't react ==");
{
  resetAll();
  const farCitizen = streetBot("Far Frank", { traits: ["cheerful"] }, 100, 100);
  setupDirector([farCitizen]);
  const player = realPlayerAt("Jon", 0, 0, [farCitizen]);
  const origRandom = Math.random;
  Math.random = () => 0.01;
  notices.onPlayerLevelUpNotice(
    { player, skill: { getName: () => "Fishing" }, oldLevel: 49, newLevel: 50 },
    1791595403000
  );
  Math.random = origRandom;
  check("no congrats from 100 tiles away", h.spoken.length === 0);
}

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
