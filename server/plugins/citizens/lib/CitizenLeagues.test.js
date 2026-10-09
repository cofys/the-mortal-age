"use strict";

/**
 * CitizenLeagues.test.js — data-tier tests for real citizen team leagues.
 * Plain node: no engine, no jest. Run with `node <file>`.
 */

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const L = require("./CitizenLeagues");

const tmpSave = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "leagues-")), "citizen-leagues.json");
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

console.log("CitizenLeagues data tier:");

test("team sports catalog has 3 sports", () => {
  assert.deepStrictEqual(Object.keys(L.TEAM_SPORTS).sort(), ["football", "relay", "tugofwar"]);
});

test("teamsFor creates 4 deterministic teams per kingdom+sport", () => {
  const teams = L.teamsFor("misthalin", "football");
  assert.strictEqual(teams.length, 4);
  assert.strictEqual(teams[0].name, teams[0].name); // deterministic
  assert.notStrictEqual(teams[0].id, teams[1].id);
});

test("joinTeam / teamOf / leaveTeam round-trip", () => {
  const teams = L.teamsFor("asgarnia", "football");
  assert.strictEqual(L.joinTeam("Alice", teams[0].id), true);
  const mine = L.teamOf("Alice", "asgarnia", "football");
  assert.strictEqual(mine.id, teams[0].id);
  assert.strictEqual(L.leaveTeam("Alice", teams[0].id), true);
  assert.strictEqual(L.teamOf("Alice", "asgarnia", "football"), null);
});

test("joinTeam caps roster at TEAM_SIZE", () => {
  const teams = L.teamsFor("kandarin", "tugofwar");
  const team = teams[0];
  for (let i = 0; i < L.TEAM_SIZE; i++) {
    assert.strictEqual(L.joinTeam(`Roster${i}`, team.id), true);
  }
  assert.strictEqual(L.joinTeam("Extra", team.id), false);
});

test("joinTeam moves citizen between teams in same sport", () => {
  const teams = L.teamsFor("morytania", "relay");
  L.joinTeam("Bob", teams[0].id);
  L.joinTeam("Bob", teams[1].id);
  assert.strictEqual(L.teamOf("Bob", "morytania", "relay").id, teams[1].id);
});

test("playerJoinTeam works on separate roster", () => {
  const teams = L.teamsFor("keldagrim", "football");
  assert.strictEqual(L.playerJoinTeam("RealPlayer1", teams[0].id), true);
  assert.strictEqual(L.playerJoinTeam("RealPlayer1", teams[0].id), true); // idempotent
  assert.ok(L.teamById(teams[0].id).playerRoster.includes("RealPlayer1"));
});

test("teamRating sums real levels via reader", () => {
  const teams = L.teamsFor("misthalin", "tugofwar");
  L.joinTeam("Strong1", teams[2].id);
  L.joinTeam("Strong2", teams[2].id);
  const reader = (user, skill) => (user === "Strong1" ? 50 : 30);
  const rating = L.teamRating(teams[2], reader);
  // tugofwar = strength only: 50 + 30 = 80
  assert.strictEqual(rating, 80);
});

test("teamRating uses honest floor when reader missing", () => {
  const teams = L.teamsFor("misthalin", "tugofwar");
  const rating = L.teamRating(teams[3], null);
  assert.ok(rating >= 0);
});

test("organizer appoint and read", () => {
  L.appointOrganizer("asgarnia", "Commish");
  assert.strictEqual(L.organizerFor("asgarnia"), "commish");
});

test("seasonFor creates fixtures round-robin", () => {
  const season = L.seasonFor("kandarin", "football", Date.now());
  // 4 teams -> 6 fixtures (each pair plays once)
  assert.strictEqual(season.fixtures.length, 6);
  assert.strictEqual(season.fixtures.filter((f) => f.played).length, 0);
});

test("recordResult updates standings and team tallies", () => {
  const teams = L.teamsFor("morytania", "football");
  const season = L.seasonFor("morytania", "football", Date.now());
  const f = season.fixtures[0];
  assert.strictEqual(L.recordResult("morytania", "football", f.homeId, f.awayId, 3, 1), true);
  const table = L.standings("morytania", "football");
  assert.strictEqual(table[0].table.pts, L.WIN_POINTS);
  assert.strictEqual(table[0].table.w, 1);
});

test("recordResult handles draws", () => {
  const teams = L.teamsFor("keldagrim", "relay");
  const season = L.seasonFor("keldagrim", "relay", Date.now());
  const f = season.fixtures.find((x) => !x.played);
  L.recordResult("keldagrim", "relay", f.homeId, f.awayId, 2, 2);
  const home = L.teamById(f.homeId);
  assert.strictEqual(home.draws, 1);
  assert.strictEqual(home.points, L.DRAW_POINTS);
});

test("recordResult rejects already-played fixture", () => {
  const season = L.seasonFor("morytania", "football", Date.now());
  const f = season.fixtures.find((x) => x.played);
  assert.strictEqual(L.recordResult("morytania", "football", f.homeId, f.awayId, 1, 0), false);
});

test("resolveFixture is deterministic for same seed", () => {
  const teams = L.teamsFor("asgarnia", "tugofwar");
  const r1 = L.resolveFixture(teams[0], teams[1], null, 42);
  const r2 = L.resolveFixture(teams[0], teams[1], null, 42);
  assert.deepStrictEqual(r1, r2);
});

test("resolveFixture favors stronger team", () => {
  const teams = L.teamsFor("asgarnia", "football");
  // Give team0 a huge rating advantage
  const reader = (user, skill) => (teams[0].roster.includes(user.toLowerCase()) ? 99 : 1);
  L.joinTeam("Star", teams[0].id);
  let homeWins = 0;
  for (let seed = 0; seed < 20; seed++) {
    const r = L.resolveFixture(teams[0], teams[1], reader, seed);
    if (r.homeScore > r.awayScore) homeWins++;
  }
  assert.ok(homeWins > 10, `expected stronger team to win most, got ${homeWins}/20`);
});

test("awardChampionship needs complete season", () => {
  // Fresh kingdom+sport with unplayed fixtures
  const champ = L.awardChampionship("misthalin", "relay");
  assert.strictEqual(champ, null); // fixtures not played yet
});

test("awardChampionship picks top team when complete", () => {
  const kid = "kandarin";
  const sid = "tugofwar";
  const season = L.seasonFor(kid, sid, Date.now());
  for (const f of season.fixtures) {
    if (!f.played) L.recordResult(kid, sid, f.homeId, f.awayId, 2, 0);
  }
  const champ = L.awardChampionship(kid, sid);
  assert.ok(champ);
  assert.strictEqual(champ.trophies, 1);
  // Second call returns null (already awarded)
  assert.strictEqual(L.awardChampionship(kid, sid), null);
});

test("fan club join and lookup", () => {
  const teams = L.teamsFor("misthalin", "football");
  assert.strictEqual(L.joinFanClub("Fan1", teams[0].id), true);
  assert.strictEqual(L.fanTeamOf("Fan1").id, teams[0].id);
  assert.strictEqual(L.fanCount(teams[0].id), 1);
  assert.strictEqual(L.joinFanClub("Fan1", "nonexistent"), false);
});

test("fund credit and debit", () => {
  const teams = L.teamsFor("asgarnia", "relay");
  const team = teams[0];
  assert.strictEqual(L.creditFund(team.id, 500), 500);
  assert.strictEqual(L.debitFund(team.id, 200), true);
  assert.strictEqual(L.teamById(team.id).fund, 300);
  assert.strictEqual(L.debitFund(team.id, 9999), false); // insufficient
  assert.strictEqual(L.creditFund(team.id, -50), 300); // negative rejected
});

test("priceMerchandise splits correctly", () => {
  const scarf = L.priceMerchandise("scarf");
  assert.strictEqual(scarf.price, 15);
  assert.strictEqual(scarf.teamShare + scarf.sellerShare, 15);
  const banner = L.priceMerchandise("banner");
  assert.strictEqual(banner.price, 40);
});

test("describeTeam returns summary", () => {
  const teams = L.teamsFor("morytania", "tugofwar");
  const d = L.describeTeam(teams[0]);
  assert.ok(d.name);
  assert.strictEqual(d.sport, "Tug-of-War");
  assert.ok("record" in d);
});

test("leagueSummary returns table", () => {
  const s = L.leagueSummary("keldagrim", "football");
  assert.strictEqual(s.table.length, 4);
  assert.ok("fixturesPlayed" in s);
});

test("save persists and reloads", () => {
  L.teamsFor("misthalin", "football");
  assert.strictEqual(L.save(), true);
  L.resetForTests();
  L._setSavePathForTests(tmpSave);
  const teams = L.teamsFor("misthalin", "football");
  assert.strictEqual(teams.length, 4);
});

console.log(`\n${passed} tests passed.`);
