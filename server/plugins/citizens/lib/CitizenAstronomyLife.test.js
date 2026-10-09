"use strict";

/**
 * CitizenAstronomyLife.test.js — plain-node tests for the astronomy
 * slow-tick module with a stub director.
 *
 * Run: node server/plugins/citizens/lib/CitizenAstronomyLife.test.js
 */

const assert = require("assert");

const Astro = require("./CitizenAstronomy");
const { tickAstronomy, isNightTime, resetForTests } = require("./CitizenAstronomyLife");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    Astro.resetForTests();
    resetForTests();
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL - ${name}: ${err.message}`);
  }
}

/** Minimal stub director: empty roster, no bots. Uses the REAL director API
 *  shape (isOnline(record), getBot(record), onlineBotsForKingdom(kingdomId)).
 *  The dead shims playerFor/getBotsForKingdom/getJournal/sayAs do NOT exist
 *  on the real CitizenDirector, so they are not stubbed here. */
function stubDirector(overrides) {
  return Object.assign({
    roster: new Map(),
    isOnline: () => false,
    getBot: () => null,
    onlineBotsForKingdom: () => [],
    log: () => {},
  }, overrides || {});
}

console.log("CitizenAstronomyLife tests:");

test("tick never throws on empty director", () => {
  tickAstronomy(stubDirector(), Date.now());
  tickAstronomy(null, Date.now());
  tickAstronomy(undefined, undefined);
});

test("isNightTime matches hour math", () => {
  const night = new Date(2026, 5, 1, 23, 0).getTime();
  const day = new Date(2026, 5, 1, 12, 0).getTime();
  assert.strictEqual(isNightTime(night), true);
  assert.strictEqual(isNightTime(day), false);
});

test("curious online citizens get registered", () => {
  const record = {
    username: "Curious Cat",
    role: "commoner",
    personality: { curious: 0.9 },
  };
  const bot = {
    getPersonality: () => ({ curious: 0.9 }),
    getUsername: () => "Curious Cat",
  };
  const director = stubDirector({
    roster: new Map([["curious cat", record]]),
    isOnline: () => true,
    getBot: () => bot,
  });
  tickAstronomy(director, Date.now());
  // kingdomIdOf resolves in the real tree → honest registration.
  const rec = Astro.astronomerFor("Curious Cat");
  assert.ok(rec, "expected Curious Cat to be registered");
  assert.strictEqual(rec.username, "Curious Cat");
});

test("night observations create charts for online astronomers", () => {
  Astro.registerAstronomer("Night Owl", "varrock");
  const bot = {
    getUsername: () => "Night Owl",
    getLocalPlayers: () => [],
  };
  const night = new Date(2026, 5, 1, 23, 0).getTime();
  const record = { username: "Night Owl", role: "commoner" };
  const director = stubDirector({
    roster: new Map([["night owl", record]]),
    isOnline: () => true,
    getBot: () => bot,
  });
  tickAstronomy(director, night);
  const charts = Astro.chartsFor("varrock");
  assert.ok(charts.length >= 1, "expected at least one chart");
  assert.strictEqual(charts[0].astronomer, "Night Owl");
});

test("daytime observations do not create charts", () => {
  Astro.registerAstronomer("Day Dreamer", "varrock");
  const bot = { getUsername: () => "Day Dreamer" };
  const day = new Date(2026, 5, 1, 12, 0).getTime();
  const record = { username: "Day Dreamer", role: "commoner" };
  const director = stubDirector({
    roster: new Map([["day dreamer", record]]),
    isOnline: () => true,
    getBot: () => bot,
  });
  tickAstronomy(director, day);
  assert.strictEqual(Astro.chartsFor("varrock").length, 0);
});

test("celestial events get announced once per cooldown", () => {
  Astro.registerAstronomer("Event Watcher", "varrock");
  const said = [];
  // Fake real player near the speaker: canonical isRealPlayer() treats a
  // player with getUsername (not a bot) as real; the line reaches their
  // packet sender via the real sayPublic() path.
  const fakeReal = {
    getUsername: () => "Jon",
    getIndex: () => 7,
    getPacketSender: () => ({ sendPublicChat: (text) => said.push(text) }),
    getRelations: () => ({ canReceivePublicChatFrom: () => true }),
  };
  const bot = {
    getUsername: () => "Event Watcher",
    getLocalPlayers: () => [fakeReal],
  };
  const jan2026 = new Date(2026, 0, 15, 23, 0).getTime(); // meteor shower month
  const record = { username: "Event Watcher", role: "commoner" };
  const director = stubDirector({
    roster: new Map([["event watcher", record]]),
    isOnline: () => true,
    getBot: () => bot,
    onlineBotsForKingdom: () => [bot],
  });
  tickAstronomy(director, jan2026);
  assert.ok(said.length >= 1, "expected an announcement");
  const firstCount = said.length;
  // Second tick immediately after → throttled, no new announcement.
  tickAstronomy(director, jan2026 + 1000);
  assert.strictEqual(said.length, firstCount);
});

test("events stay silent when no real player is near", () => {
  Astro.registerAstronomer("Lonely Watcher", "varrock");
  const said = [];
  const bot = {
    getUsername: () => "Lonely Watcher",
    getLocalPlayers: () => [], // nobody around
  };
  const jan2026 = new Date(2026, 0, 15, 23, 0).getTime();
  const record = { username: "Lonely Watcher", role: "commoner" };
  const director = stubDirector({
    roster: new Map([["lonely watcher", record]]),
    isOnline: () => true,
    getBot: () => bot,
    onlineBotsForKingdom: () => [bot],
  });
  tickAstronomy(director, jan2026);
  assert.strictEqual(said.length, 0, "expected silence with no real player near");
  // The event was still announced (throttle marked), just not spoken.
  assert.strictEqual(Astro.announceEvent("varrock", "meteor_shower", jan2026 + 2000), false);
});

test("offline astronomers do not observe", () => {
  Astro.registerAstronomer("Sleeper", "varrock");
  const night = new Date(2026, 5, 1, 23, 0).getTime();
  const record = { username: "Sleeper", role: "commoner" };
  const director = stubDirector({
    roster: new Map([["sleeper", record]]),
    isOnline: () => false, // citizen exists but is offline
    getBot: () => null,
  });
  tickAstronomy(director, night);
  assert.strictEqual(Astro.chartsFor("varrock").length, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
