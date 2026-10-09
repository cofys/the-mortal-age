"use strict";

/**
 * CitizenStageGuilds.test.js — guild data-tier contracts without a running server.
 * The theater, sites, careers, and reputation modules are stubbed in the
 * require cache so plain-node tests stay engine-free.
 *
 * Run: node server/plugins/citizens/lib/CitizenStageGuilds.test.js
 */

const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");

// --- stubs (must be installed before requiring the guild module) ---

const sitesPath = path.resolve(__dirname, "../brain/CitizenSites.js");
require.cache[sitesPath] = {
  id: sitesPath, filename: sitesPath, loaded: true,
  exports: { KINGDOM_IDS: ["varrock", "falador"], kingdomIdOf: () => "varrock" },
};

// Controllable fake of the real CitizenTheater data tier.
const fakeTheater = {
  playwrights: new Set(), // lower usernames
  plays: Object.create(null), // id -> play
  troupes: Object.create(null), // lower name -> troupe
};
const theaterPath = path.resolve(__dirname, "./CitizenTheater.js");
require.cache[theaterPath] = {
  id: theaterPath, filename: theaterPath, loaded: true,
  exports: {
    isPlaywright: (u) => fakeTheater.playwrights.has(String(u || "").toLowerCase()),
    playFor: (id) => fakeTheater.plays[String(id)] || null,
    playsBy: (u) => Object.values(fakeTheater.plays).filter((p) => p.playwrightLower === String(u || "").toLowerCase()),
    playsIn: (kid) => Object.values(fakeTheater.plays).filter((p) => !kid || String(p.kingdomId).toLowerCase() === String(kid).toLowerCase()),
    troupeFor: (name) => fakeTheater.troupes[String(name || "").toLowerCase()] || null,
    troupesIn: (kid) => Object.values(fakeTheater.troupes).filter((t) => !kid || String(t.homeKingdom).toLowerCase() === String(kid).toLowerCase()),
    troupeLocation: (t) => t ? { kingdomId: t._loc || t.homeKingdom, traveling: false } : null,
    recentReviews: (kid, limit) => fakeTheater.reviews.filter((r) => !kid || String(r.kingdomId).toLowerCase() === String(kid).toLowerCase()).slice(-(limit || 5)),
    theaterTileFor: (kid) => ({ x: 3200, y: 3200, z: 0 }),
    reviews: [],
  },
};

const careersPath = path.resolve(__dirname, "./CitizenCareers.js");
require.cache[careersPath] = {
  id: careersPath, filename: careersPath, loaded: true,
  exports: { careerOf: () => null },
};

const awardedDeeds = [];
const repPath = path.resolve(__dirname, "./CitizenReputation.js");
require.cache[repPath] = {
  id: repPath, filename: repPath, loaded: true,
  exports: { awardDeed: (u, d) => { awardedDeeds.push({ u, d }); } },
};

// --- real module under test ---

const Guilds = require("./CitizenStageGuilds");

// redirect saves to a temp file
const tmpSave = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "stageguild-")), "save.json");
Guilds._setSavePathForTests(tmpSave);

let passed = 0;
function test(name, fn) {
  Guilds.resetForTests();
  fakeTheater.playwrights = new Set();
  fakeTheater.plays = Object.create(null);
  fakeTheater.troupes = Object.create(null);
  fakeTheater.reviews = [];
  awardedDeeds.length = 0;
  try { fs.unlinkSync(tmpSave); } catch { /* ignore */ }
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

function addPlaywright(name) {
  fakeTheater.playwrights.add(name.toLowerCase());
}

function addPlay(id, playwright, opts = {}) {
  fakeTheater.plays[id] = Object.assign({
    id, title: `The Tale of ${playwright}`,
    genre: "tragedy", playwright, playwrightLower: playwright.toLowerCase(),
    kingdomId: "varrock", quality: 7, writtenAt: Date.now(),
  }, opts);
}

function addTroupe(name, members, homeKingdom = "varrock") {
  fakeTheater.troupes[name.toLowerCase()] = {
    name, members: members.slice(), homeKingdom, treasury: 0, _loc: homeKingdom,
  };
}

// --- guilds ---

test("ensureGuild creates a hall near the theater", () => {
  const g = Guilds.ensureGuild("varrock");
  assert.ok(g.hallTile);
  assert.strictEqual(g.hallTile.x, 3208); // 3200 + HALL_TILE_DX
  assert.strictEqual(g.kingdomId, "varrock");
});

test("join requires being a real theater professional", () => {
  const res = Guilds.joinGuild("Nobody", "varrock");
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, "not a theater professional");
});

test("playwright can join", () => {
  addPlaywright("Will");
  const res = Guilds.joinGuild("Will", "varrock");
  assert.strictEqual(res.ok, true);
  assert.strictEqual(Guilds.guildRankOf("Will"), Guilds.RANK_PLAYER);
});

test("troupe member can join", () => {
  addTroupe("The Players", ["Alice", "Bob"]);
  const res = Guilds.joinGuild("Alice", "varrock");
  assert.strictEqual(res.ok, true);
});

test("dues payment credits treasury and relief fund", () => {
  addPlaywright("Will");
  Guilds.joinGuild("Will", "varrock");
  Guilds.recordDuesPayment("Will");
  const t = Guilds.guildTreasuryFor("varrock");
  assert.strictEqual(t.treasury, Guilds.DUES_WEEKLY - 5);
  assert.strictEqual(t.reliefFund, 5);
});

test("two missed dues suspend", () => {
  addPlaywright("Will");
  Guilds.joinGuild("Will", "varrock");
  Guilds.recordMissedDues("Will");
  assert.strictEqual(Guilds.memberOf("Will").suspended, false);
  Guilds.recordMissedDues("Will");
  assert.strictEqual(Guilds.memberOf("Will").suspended, true);
  assert.strictEqual(Guilds.isGuildMember("Will"), false);
});

// --- certification ---

test("certify rejects plays the submitter did not write", () => {
  addPlaywright("Will");
  addPlay("play-1", "Will");
  Guilds.joinGuild("Will", "varrock");
  const res = Guilds.submitForCertification("play-1", "Marlowe", "varrock");
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, "not your play");
});

test("certify rejects unknown plays", () => {
  addPlaywright("Will");
  Guilds.joinGuild("Will", "varrock");
  const res = Guilds.submitForCertification("play-999", "Will", "varrock");
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, "no such play");
});

test("certification grades from real quality and pays bounty", () => {
  addPlaywright("Will");
  addPlay("play-1", "Will", { quality: 9, genre: "comedy" });
  Guilds.joinGuild("Will", "varrock");
  const g = Guilds.ensureGuild("varrock");
  g.treasury = 1000;
  const sub = Guilds.submitForCertification("play-1", "Will", "varrock");
  assert.strictEqual(sub.ok, true);
  const settled = Guilds.settleCertification("play-1");
  assert.strictEqual(settled.ok, true);
  assert.strictEqual(settled.grade, "A");
  assert.strictEqual(settled.paid, 120); // A bounty, no doubling (comedy)
  assert.strictEqual(Guilds.sealFor("play-1").grade, "A");
});

test("home history/epic doubles the bounty (culture seam)", () => {
  addPlaywright("Will");
  addPlay("play-1", "Will", { quality: 8, genre: "history", kingdomId: "varrock" });
  Guilds.joinGuild("Will", "varrock");
  const g = Guilds.ensureGuild("varrock");
  g.treasury = 1000;
  Guilds.submitForCertification("play-1", "Will", "varrock");
  const settled = Guilds.settleCertification("play-1");
  assert.strictEqual(settled.doubled, true);
  assert.strictEqual(settled.paid, 240); // A bounty x2
});

test("broke treasury owes the bounty honestly", () => {
  addPlaywright("Will");
  addPlay("play-1", "Will", { quality: 3 });
  Guilds.joinGuild("Will", "varrock");
  Guilds.ensureGuild("varrock"); // treasury 0, relief 0
  Guilds.submitForCertification("play-1", "Will", "varrock");
  const settled = Guilds.settleCertification("play-1");
  assert.strictEqual(settled.grade, "C");
  assert.strictEqual(settled.paid, 0);
  assert.strictEqual(settled.owed, 30);
});

test("relief fund backs bounties before owing", () => {
  addPlaywright("Will");
  addPlay("play-1", "Will", { quality: 6 }); // B = 60
  Guilds.joinGuild("Will", "varrock");
  const g = Guilds.ensureGuild("varrock");
  g.treasury = 10;
  g.reliefFund = 100;
  Guilds.submitForCertification("play-1", "Will", "varrock");
  const settled = Guilds.settleCertification("play-1");
  assert.strictEqual(settled.paid, 60);
  assert.strictEqual(settled.owed, 0);
  assert.strictEqual(g.treasury, 0);
  assert.strictEqual(g.reliefFund, 50);
});

test("cannot certify the same play twice", () => {
  addPlaywright("Will");
  addPlay("play-1", "Will", { quality: 7 });
  Guilds.joinGuild("Will", "varrock");
  const g = Guilds.ensureGuild("varrock");
  g.treasury = 1000;
  Guilds.submitForCertification("play-1", "Will", "varrock");
  Guilds.settleCertification("play-1");
  const again = Guilds.submitForCertification("play-1", "Will", "varrock");
  assert.strictEqual(again.ok, false);
  assert.strictEqual(again.reason, "already certified");
});

// --- plagiarism tribunal ---

test("plagiarism scan finds duplicate titles by different playwrights", () => {
  addPlaywright("Will");
  addPlaywright("Marlowe");
  addPlay("play-1", "Will", { title: "The King's Folly", writtenAt: 1000 });
  addPlay("play-2", "Marlowe", { title: "the king's folly!!", writtenAt: 2000 });
  const cands = Guilds.plagiarismScan();
  assert.strictEqual(cands.length, 1);
  assert.strictEqual(cands[0].playId, "play-2");
  assert.strictEqual(cands[0].accused, "Marlowe");
});

test("report + vote + settle convicts a plagiarist", () => {
  addPlaywright("Will");
  addPlaywright("Marlowe");
  addPlay("play-1", "Will", { title: "The King's Folly", writtenAt: 1000 });
  addPlay("play-2", "Marlowe", { title: "The King's Folly", writtenAt: 2000 });
  // two stagemasters to vote
  addTroupe("The Old Vic", ["Master1"]);
  addTroupe("The Globe", ["Master2"]);
  Guilds.joinGuild("Master1", "varrock");
  Guilds.joinGuild("Master2", "varrock");
  Guilds.memberOf("Master1").rank = Guilds.RANK_STAGEMASTER;
  Guilds.memberOf("Master2").rank = Guilds.RANK_STAGEMASTER;
  const rep = Guilds.reportPlagiarism("varrock", "play-2", "Will");
  assert.strictEqual(rep.ok, true);
  assert.strictEqual(Guilds.voteOnCase(rep.case.id, "Master1", "guilty").ok, true);
  assert.strictEqual(Guilds.voteOnCase(rep.case.id, "Master2", "guilty").ok, true);
  const settled = Guilds.settleRipeCases("varrock", Date.now() + 25 * 3600 * 1000);
  assert.strictEqual(settled.length, 1);
  assert.strictEqual(settled[0].status, "guilty");
  assert.ok(awardedDeeds.some((d) => d.d === "plagiarist" && d.u === "Marlowe"));
});

test("no double jeopardy on the same play", () => {
  addPlaywright("Will");
  addPlaywright("Marlowe");
  addPlay("play-1", "Will", { title: "Stolen Words", writtenAt: 1000 });
  addPlay("play-2", "Marlowe", { title: "Stolen Words", writtenAt: 2000 });
  assert.strictEqual(Guilds.reportPlagiarism("varrock", "play-2", "Will").ok, true);
  assert.strictEqual(Guilds.reportPlagiarism("varrock", "play-2", "Will").ok, false);
});

// --- touring circuits ---

test("circuit claim requires a verified tour", () => {
  addTroupe("Wandering Players", ["Will"], "varrock");
  addPlaywright("Will");
  Guilds.joinGuild("Will", "varrock");
  const post = Guilds.postCircuit("varrock", "falador", "Sponsor", 500);
  assert.strictEqual(post.ok, true);
  // troupe still home — claim fails
  const fail = Guilds.claimCircuit(post.circuit.id, "Wandering Players", "Will");
  assert.strictEqual(fail.ok, false);
  assert.strictEqual(fail.reason, "troupe is not there");
});

test("circuit claim succeeds after a verified tour", () => {
  addTroupe("Wandering Players", ["Will"], "varrock");
  addPlaywright("Will");
  Guilds.joinGuild("Will", "varrock");
  const post = Guilds.postCircuit("varrock", "falador", "Sponsor", 500);
  // troupe tours to falador AFTER the bounty posted
  const troupe = fakeTheater.troupes["wandering players"];
  troupe._loc = "falador";
  Guilds.noteTroupeLocations(Date.now() + 1000);
  const claim = Guilds.claimCircuit(post.circuit.id, "Wandering Players", "Will");
  assert.strictEqual(claim.ok, true);
  assert.strictEqual(claim.bounty, 500);
  assert.strictEqual(troupe.treasury, 500);
});

// --- laurel ---

test("critics' choice laurel picks the most acclaimed troupe", () => {
  const g = Guilds.ensureGuild("varrock");
  g.treasury = 1000;
  fakeTheater.reviews = [
    { troupe: "The Players", kingdomId: "varrock", stars: 5 },
    { troupe: "The Players", kingdomId: "varrock", stars: 5 },
    { troupe: "Rivals", kingdomId: "varrock", stars: 5 },
  ];
  addTroupe("The Players", ["Will"]);
  const res = Guilds.grantLaurel("varrock");
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.laurel.troupe, "The Players");
  assert.strictEqual(res.laurel.fiveStarCount, 2);
  assert.strictEqual(res.laurel.paid, 200);
});

// --- school & promotion ---

test("promotion requires tenure, credits, and stage proof", () => {
  addPlaywright("Will");
  Guilds.joinGuild("Will", "varrock");
  const m = Guilds.memberOf("Will");
  m.joinedAt = Date.now() - 31 * 24 * 3600 * 1000;
  m.trainingCredits = 2;
  addPlay("play-1", "Will");
  addPlay("play-2", "Will");
  addPlay("play-3", "Will");
  const res = Guilds.tryPromote("Will");
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.rank, Guilds.RANK_PERFORMER);
});

test("promotion fails without stage proof", () => {
  addPlaywright("Will");
  Guilds.joinGuild("Will", "varrock");
  const m = Guilds.memberOf("Will");
  m.joinedAt = Date.now() - 31 * 24 * 3600 * 1000;
  m.trainingCredits = 2;
  // Will is a playwright but wrote no plays and is in no troupe
  fakeTheater.playwrights.delete("will");
  const res = Guilds.tryPromote("Will");
  assert.strictEqual(res.ok, false);
});

test("stagemaster promotion awards the deed", () => {
  addPlaywright("Will");
  addTroupe("The Players", ["Will"]);
  Guilds.joinGuild("Will", "varrock");
  const m = Guilds.memberOf("Will");
  m.rank = Guilds.RANK_PERFORMER;
  m.joinedAt = Date.now() - 61 * 24 * 3600 * 1000;
  m.trainingCredits = 4;
  m.certCount = 2;
  const res = Guilds.tryPromote("Will");
  assert.strictEqual(res.ok, true);
  assert.ok(awardedDeeds.some((d) => d.d === "stagemaster"));
});

// --- persistence ---

test("save round-trip preserves state", () => {
  addPlaywright("Will");
  Guilds.joinGuild("Will", "varrock");
  assert.strictEqual(Guilds.save(), true);
  Guilds.resetForTests();
  Guilds._setSavePathForTests(tmpSave);
  assert.strictEqual(Guilds.isGuildMember("Will"), true);
});

test("describe returns guild summary", () => {
  addPlaywright("Will");
  Guilds.joinGuild("Will", "varrock");
  const d = Guilds.describe("varrock");
  assert.strictEqual(d.exists, true);
  assert.strictEqual(d.memberCount, 1);
});

console.log(`\n${passed} tests passed`);
