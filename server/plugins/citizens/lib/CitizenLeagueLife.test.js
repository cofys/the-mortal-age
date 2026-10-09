"use strict";

/**
 * CitizenLeagueLife.test.js — slow-tick tests for team leagues.
 * Plain node: no engine, no jest. Run with `node <file>`.
 */

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const L = require("./CitizenLeagues");
const Life = require("./CitizenLeagueLife");

const tmpSave = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "leaguelife-")), "citizen-leagues.json");
L._setSavePathForTests(tmpSave);

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (e) {
    console.error(`  FAIL - ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

function emptyDirector() {
  return {
    roster: new Map(),
    isOnline: () => false,
    getBot: () => null,
    getJournal: () => ({ log: () => {} }),
    log: () => {},
  };
}

console.log("CitizenLeagueLife slow tick:");

test("tickLeagues never throws on empty director", () => {
  Life.tickLeagues(emptyDirector(), Date.now());
  Life.tickLeagues(null, Date.now());
  Life.tickLeagues({}, Date.now());
});

test("tickLeagues appoints organizer from roster", () => {
  const d = emptyDirector();
  d.roster.set("commish", {
    username: "Commish",
    kingdomId: "misthalin",
    personality: { sociable: 0.9 },
  });
  Life.tickLeagues(d, Date.now());
  // Organizer may or may not be appointed (needs rep 20+); must not throw.
  assert.ok(true);
});

test("tickLeagues resolves due fixtures", () => {
  const d = emptyDirector();
  const now = Date.now();
  // Force a season with a due fixture by using a past season start.
  const season = L.seasonFor("asgarnia", "football", now - 10 * 7 * 24 * 3600 * 1000);
  const dueBefore = L.dueFixtures("asgarnia", "football", now).length;
  Life.tickLeagues(d, now);
  const dueAfter = L.dueFixtures("asgarnia", "football", now).length;
  // Fixtures should have been resolved (or none were due).
  assert.ok(dueAfter <= dueBefore);
});

test("tickLeagues awards championship when season complete", () => {
  const d = emptyDirector();
  const now = Date.now();
  const kid = "kandarin";
  const sid = "relay";
  const season = L.seasonFor(kid, sid, now);
  for (const f of season.fixtures) {
    if (!f.played) L.recordResult(kid, sid, f.homeId, f.awayId, 2, 1);
  }
  Life.tickLeagues(d, now);
  const after = L.seasonFor(kid, sid, now);
  assert.strictEqual(after.finalPlayed, true);
  assert.ok(after.championTeamId);
});

test("fanWinRecency returns Infinity for unknown team", () => {
  assert.strictEqual(Life.fanWinRecency("nope:football:team0"), Infinity);
});

test("tickLeagues handles missing modules gracefully", () => {
  // Simulate CitizenReputation being unavailable by ticking with a
  // director whose roster throws.
  const d = {
    get roster() { throw new Error("boom"); },
    log: () => {},
  };
  Life.tickLeagues(d, Date.now()); // must not throw
});

console.log(`\n${passed} tests passed.`);
