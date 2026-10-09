"use strict";

/**
 * CitizenPressGuilds.test.js — press association data-tier contracts without
 * a running server. CitizenPress and CitizenSites are stubbed in the require
 * cache so plain-node tests stay engine-free.
 *
 * Run: node server/plugins/citizens/lib/CitizenPressGuilds.test.js
 */

const assert = require("assert");
const path = require("path");

// --- stubs (must be installed before requiring the guild module) ---

const sitesPath = path.resolve(__dirname, "../brain/CitizenSites.js");
require.cache[sitesPath] = {
  id: sitesPath, filename: sitesPath, loaded: true,
  exports: {
    KINGDOM_IDS: ["varrock", "falador"],
    kingdomIdOf: (r) => r?.kingdomId || "varrock",
    siteTile: () => ({ x: 3200, y: 3200, z: 0 }),
  },
};

// Controllable fake of the real CitizenPress data tier.
const fakeJournalists = new Set();
const fakeStories = []; // { id, eventId, beat, author, authorIsPlayer, kingdomId, headline, quality, publishedAt }
const fakeEvents = {}; // id -> { id }
const pressPath = path.resolve(__dirname, "./CitizenPress.js");
require.cache[pressPath] = {
  id: pressPath, filename: pressPath, loaded: true,
  exports: {
    BEATS: ["crime", "politics", "war", "discovery", "culture"],
    isJournalist: (u) => fakeJournalists.has(String(u || "").toLowerCase()),
    registerJournalist: (u) => { fakeJournalists.add(String(u || "").toLowerCase()); return { ok: true }; },
    storyCountFor: (u) => fakeStories.filter((s) => String(s.author).toLowerCase() === String(u || "").toLowerCase()).length,
    storiesFor: (kid, beat, windowMs) => {
      const now = Date.now();
      return fakeStories.filter((s) => s.kingdomId === kid && s.beat === beat && now - s.publishedAt < windowMs);
    },
    eventFor: (id) => fakeEvents[String(id)] || null,
    pressTileFor: () => ({ x: 3200, y: 3200, z: 0 }),
    SUBSCRIPTION_PRICE: 5,
  },
};

// --- real module under test ---

const Guilds = require("./CitizenPressGuilds");

function reset() {
  Guilds.resetForTests();
  fakeJournalists.clear();
  fakeStories.length = 0;
  for (const k of Object.keys(fakeEvents)) delete fakeEvents[k];
}

let passed = 0;
function test(name, fn) {
  reset();
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL - ${name}: ${e.message}`);
    process.exitCode = 1;
  }
}

function makeJournalist(name) {
  fakeJournalists.add(String(name).toLowerCase());
}

function fileStory(author, opts = {}) {
  const id = `story${fakeStories.length + 1}`;
  const s = {
    id,
    eventId: opts.eventId ?? `evt${fakeStories.length + 1}`,
    beat: opts.beat || "crime",
    author,
    authorIsPlayer: !!opts.player,
    kingdomId: opts.kingdomId || "varrock",
    headline: opts.headline || `Headline ${id}`,
    quality: opts.quality ?? 5,
    publishedAt: opts.publishedAt ?? Date.now(),
  };
  fakeStories.push(s);
  if (s.eventId) fakeEvents[s.eventId] = { id: s.eventId };
  return s;
}

// --- associations ---

test("ensureGuild creates a guild with a hall tile and zero treasury", () => {
  const g = Guilds.ensureGuild("varrock");
  assert.ok(g);
  assert.ok(g.hallTile);
  assert.strictEqual(g.treasury, 0);
  assert.strictEqual(Guilds.guildTreasuryFor("varrock"), 0);
});

test("treasury credit/debit is honest (no invented coins)", () => {
  assert.ok(Guilds.creditTreasury("varrock", 100));
  assert.strictEqual(Guilds.debitTreasury("varrock", 40), true);
  assert.strictEqual(Guilds.guildTreasuryFor("varrock"), 60);
  assert.strictEqual(Guilds.debitTreasury("varrock", 1000), false); // broke — honest failure
  assert.strictEqual(Guilds.guildTreasuryFor("varrock"), 60);
});

// --- membership ---

test("join requires a registered journalist — no minting reporters", () => {
  const r = Guilds.joinGuild("Nobody", "varrock");
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "not-journalist");
});

test("journalist joins as stringer; duplicate join rejected", () => {
  makeJournalist("Nell");
  const r = Guilds.joinGuild("Nell", "varrock");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.rank, "stringer");
  assert.ok(Guilds.isGuildMember("Nell"));
  assert.strictEqual(Guilds.guildRankOf("Nell"), "stringer");
  const dup = Guilds.joinGuild("Nell", "varrock");
  assert.strictEqual(dup.ok, false);
});

test("leave removes membership and pass", () => {
  makeJournalist("Nell");
  Guilds.joinGuild("Nell", "varrock");
  Guilds.issueMemberPass("Nell");
  assert.ok(Guilds.leaveGuild("Nell"));
  assert.ok(!Guilds.isGuildMember("Nell"));
  assert.ok(!Guilds.hasPressPass("Nell"));
});

test("liftSuspension restores a suspended member", () => {
  makeJournalist("Nell");
  Guilds.joinGuild("Nell", "varrock");
  const m = Guilds.memberOf("Nell");
  m.suspended = true;
  assert.ok(Guilds.liftSuspension("Nell"));
  assert.ok(Guilds.isGuildMember("Nell"));
});

// --- ethics ---

test("reportViolation validates: bad type, non-member, no story", () => {
  makeJournalist("Nell");
  Guilds.joinGuild("Nell", "varrock");
  const s = fileStory("Nell");
  assert.strictEqual(Guilds.reportViolation("Bob", "Nell", "gossip", s.id).ok, false);
  assert.strictEqual(Guilds.reportViolation("Bob", "Nobody", "plagiarism", s.id).ok, false);
  assert.strictEqual(Guilds.reportViolation("Bob", "Nell", "plagiarism", "nope").ok, false);
});

test("reportViolation rejects pinning someone else's story on the accused", () => {
  makeJournalist("Nell");
  makeJournalist("Zed");
  Guilds.joinGuild("Nell", "varrock");
  Guilds.joinGuild("Zed", "varrock");
  const s = fileStory("Zed");
  const r = Guilds.reportViolation("Bob", "Nell", "plagiarism", s.id);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, "not-their-story");
});

test("plagiarism verified from duplicate normalized headlines", () => {
  makeJournalist("Nell");
  makeJournalist("Zed");
  Guilds.joinGuild("Nell", "varrock");
  Guilds.joinGuild("Zed", "varrock");
  const orig = fileStory("Nell", { headline: "Justice Served: the miller did it", publishedAt: Date.now() - 100000 });
  const copy = fileStory("Zed", { headline: "justice served: the miller did it!", publishedAt: Date.now() });
  const v = Guilds.verifyPlagiarism(copy.id);
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.plagiarized, true);
  assert.strictEqual(v.originalId, orig.id);
  const clean = Guilds.verifyPlagiarism(orig.id);
  assert.strictEqual(clean.plagiarized, false);
});

test("fabrication verified when the cited event does not exist", () => {
  makeJournalist("Zed");
  Guilds.joinGuild("Zed", "varrock");
  const bad = fileStory("Zed", { eventId: "evt-ghost" });
  delete fakeEvents["evt-ghost"];
  const v = Guilds.verifyFabrication(bad.id);
  assert.strictEqual(v.ok, true);
  assert.strictEqual(v.fabricated, true);
  assert.strictEqual(v.reason, "no-such-event");
  const good = fileStory("Zed", { eventId: "evt-real" });
  const v2 = Guilds.verifyFabrication(good.id);
  assert.strictEqual(v2.fabricated, false);
});

test("tribunal: editor vote + evidence settles; plagiarism sanction is fine + suspension", () => {
  makeJournalist("Nell");
  makeJournalist("Zed");
  makeJournalist("Ed");
  Guilds.joinGuild("Nell", "varrock");
  Guilds.joinGuild("Zed", "varrock");
  Guilds.joinGuild("Ed", "varrock");
  Guilds.memberOf("Ed").rank = "editor";
  fileStory("Nell", { headline: "Court Report: stolen chickens", publishedAt: Date.now() - 50000 });
  const copy = fileStory("Zed", { headline: "Court Report: stolen chickens", publishedAt: Date.now() });
  const r = Guilds.reportViolation("Nell", "Zed", "plagiarism", copy.id);
  assert.ok(r.ok);
  // No quorum yet (under 24h, no votes).
  assert.strictEqual(Guilds.settleCase(r.id).ok, false);
  const vote = Guilds.voteOnCase(r.id, "Ed", true);
  assert.ok(vote.ok);
  const settled = Guilds.settleCase(r.id);
  assert.strictEqual(settled.ok, true);
  assert.strictEqual(settled.verdict, "guilty");
  assert.strictEqual(settled.sanction, "fine-and-suspension");
  const m = Guilds.memberOf("Zed");
  assert.strictEqual(m.fineOwed, Guilds.PLAGIARISM_FINE);
  assert.strictEqual(m.suspended, true);
});

test("tribunal: non-editor cannot vote; accused cannot judge self", () => {
  makeJournalist("Nell");
  makeJournalist("Zed");
  Guilds.joinGuild("Nell", "varrock");
  Guilds.joinGuild("Zed", "varrock");
  const s = fileStory("Zed");
  const r = Guilds.reportViolation("Nell", "Zed", "fabrication", s.id);
  assert.strictEqual(Guilds.voteOnCase(r.id, "Nell", true).ok, false); // stringer
  Guilds.memberOf("Nell").rank = "editor";
  assert.strictEqual(Guilds.voteOnCase(r.id, "Zed", true).ok, false); // self
  assert.ok(Guilds.voteOnCase(r.id, "Nell", false).ok);
});

test("tribunal: guilty fabrication expels and strips the pass", () => {
  makeJournalist("Zed");
  makeJournalist("Ed");
  Guilds.joinGuild("Zed", "varrock");
  Guilds.joinGuild("Ed", "varrock");
  Guilds.memberOf("Ed").rank = "editor";
  const bad = fileStory("Zed", { eventId: "evt-nope" });
  delete fakeEvents["evt-nope"];
  Guilds.issueMemberPass("Zed");
  const r = Guilds.reportViolation("guild", "Zed", "fabrication", bad.id);
  Guilds.voteOnCase(r.id, "Ed", true);
  const settled = Guilds.settleCase(r.id, r.filedAt ? Date.now() : Date.now());
  assert.strictEqual(settled.verdict, "guilty");
  assert.strictEqual(settled.sanction, "expulsion");
  assert.ok(!Guilds.isGuildMember("Zed"));
  assert.ok(!Guilds.hasPressPass("Zed"));
});

test("tribunal: innocent verdict clears the accused", () => {
  makeJournalist("Nell");
  makeJournalist("Ed");
  makeJournalist("Ed2");
  Guilds.joinGuild("Nell", "varrock");
  Guilds.joinGuild("Ed", "varrock");
  Guilds.joinGuild("Ed2", "varrock");
  Guilds.memberOf("Ed").rank = "editor";
  Guilds.memberOf("Ed2").rank = "editor";
  const s = fileStory("Nell", { headline: "A wholly original headline here" });
  const r = Guilds.reportViolation("Bob", "Nell", "plagiarism", s.id);
  Guilds.voteOnCase(r.id, "Ed", false);
  Guilds.voteOnCase(r.id, "Ed2", false);
  const settled = Guilds.settleCase(r.id);
  assert.strictEqual(settled.verdict, "not-guilty");
  assert.ok(Guilds.isGuildMember("Nell"));
});

test("double jeopardy: one open case per story", () => {
  makeJournalist("Nell");
  makeJournalist("Zed");
  Guilds.joinGuild("Nell", "varrock");
  Guilds.joinGuild("Zed", "varrock");
  const s = fileStory("Zed");
  assert.ok(Guilds.reportViolation("Nell", "Zed", "plagiarism", s.id).ok);
  const dup = Guilds.reportViolation("Nell", "Zed", "fabrication", s.id);
  assert.strictEqual(dup.ok, false);
  assert.strictEqual(dup.reason, "already-open");
});

// --- Inkwell awards ---

test("grantAward picks the highest-quality member story; prize owed when broke", () => {
  makeJournalist("Nell");
  makeJournalist("Zed");
  makeJournalist("Outsider");
  Guilds.joinGuild("Nell", "varrock");
  Guilds.joinGuild("Zed", "varrock");
  fileStory("Outsider", { beat: "war", quality: 10, kingdomId: "varrock" }); // not a member
  fileStory("Nell", { beat: "war", quality: 6, kingdomId: "varrock", publishedAt: Date.now() - 2000 });
  fileStory("Zed", { beat: "war", quality: 9, kingdomId: "varrock", publishedAt: Date.now() - 1000 });
  const r = Guilds.grantAward("varrock", "war");
  assert.ok(r.ok);
  assert.strictEqual(r.award.winner, "Zed");
  assert.strictEqual(r.award.quality, 9);
  assert.strictEqual(r.award.prizeOwed, Guilds.AWARD_PRIZE); // treasury empty — honest debt
  assert.strictEqual(Guilds.guildTreasuryFor("varrock"), 0);
});

test("grantAward pays real prize when the treasury can afford it", () => {
  makeJournalist("Nell");
  Guilds.joinGuild("Nell", "varrock");
  Guilds.creditTreasury("varrock", 500);
  fileStory("Nell", { beat: "culture", quality: 7, kingdomId: "varrock" });
  const r = Guilds.grantAward("varrock", "culture");
  assert.ok(r.ok);
  assert.strictEqual(r.award.prizeOwed, 0);
  assert.strictEqual(Guilds.guildTreasuryFor("varrock"), 500 - Guilds.AWARD_PRIZE);
});

test("grantAward refuses twice in one cycle and with no contenders", () => {
  makeJournalist("Nell");
  Guilds.joinGuild("Nell", "varrock");
  Guilds.creditTreasury("varrock", 500);
  fileStory("Nell", { beat: "war", quality: 7, kingdomId: "varrock" });
  assert.ok(Guilds.grantAward("varrock", "war").ok);
  assert.strictEqual(Guilds.grantAward("varrock", "war").ok, false);
  assert.strictEqual(Guilds.grantAward("varrock", "politics").ok, false); // no stories
});

test("award ties break toward the earliest story", () => {
  makeJournalist("Nell");
  makeJournalist("Zed");
  Guilds.joinGuild("Nell", "varrock");
  Guilds.joinGuild("Zed", "varrock");
  Guilds.creditTreasury("varrock", 500);
  fileStory("Zed", { beat: "discovery", quality: 8, kingdomId: "varrock", publishedAt: Date.now() });
  fileStory("Nell", { beat: "discovery", quality: 8, kingdomId: "varrock", publishedAt: Date.now() - 5000 });
  const r = Guilds.grantAward("varrock", "discovery");
  assert.strictEqual(r.award.winner, "Nell");
});

// --- school ---

test("holdClass requires an editor master and stringer pupils", () => {
  makeJournalist("Ed");
  makeJournalist("Nell");
  Guilds.joinGuild("Ed", "varrock");
  Guilds.joinGuild("Nell", "varrock");
  assert.strictEqual(Guilds.holdClass("Nell", ["Ed"], "varrock").ok, false); // Nell is no editor
  Guilds.memberOf("Ed").rank = "editor";
  const r = Guilds.holdClass("Ed", ["Nell"], "varrock");
  assert.ok(r.ok);
  assert.strictEqual(Guilds.memberOf("Nell").trainingCredits, 1);
});

test("promotion: stringer -> reporter at 5 real stories", () => {
  makeJournalist("Nell");
  Guilds.joinGuild("Nell", "varrock");
  for (let i = 0; i < 5; i++) fileStory("Nell", { beat: "crime" });
  const elig = Guilds.promotionEligible("Nell");
  assert.ok(elig.ok);
  assert.strictEqual(elig.to, "reporter");
  const p = Guilds.promote("Nell");
  assert.strictEqual(p.to, "reporter");
  assert.strictEqual(Guilds.guildRankOf("Nell"), "reporter");
});

test("promotion: editor needs 12 stories, 2 training credits, clean record", () => {
  makeJournalist("Nell");
  makeJournalist("Ed");
  Guilds.joinGuild("Nell", "varrock");
  Guilds.joinGuild("Ed", "varrock");
  Guilds.memberOf("Ed").rank = "editor";
  Guilds.memberOf("Nell").rank = "reporter";
  for (let i = 0; i < 12; i++) fileStory("Nell", { beat: "politics" });
  assert.strictEqual(Guilds.promotionEligible("Nell").ok, false); // no training
  Guilds.holdClass("Ed", ["Nell"], "varrock"); // Nell is reporter, not stringer — no credit
  assert.strictEqual(Guilds.memberOf("Nell").trainingCredits, 0);
  Guilds.memberOf("Nell").rank = "stringer";
  Guilds.memberOf("Nell").trainingCredits = 2; // simulated classes
  Guilds.memberOf("Nell").rank = "reporter";
  const elig = Guilds.promotionEligible("Nell");
  assert.ok(elig.ok, JSON.stringify(elig));
  assert.strictEqual(Guilds.promote("Nell").to, "editor");
});

// --- press passes ---

test("members get a 30-day pass; suspended members cannot", () => {
  makeJournalist("Nell");
  Guilds.joinGuild("Nell", "varrock");
  const r = Guilds.issueMemberPass("Nell");
  assert.ok(r.ok);
  assert.ok(Guilds.hasPressPass("Nell"));
  Guilds.memberOf("Nell").suspended = true;
  assert.strictEqual(Guilds.issueMemberPass("Nell").ok, false);
});

test("day passes for players; expired passes pruned", () => {
  const r = Guilds.issueDayPass("SomePlayer", "varrock");
  assert.ok(r.ok);
  assert.ok(Guilds.hasPressPass("SomePlayer"));
  assert.strictEqual(Guilds.prunePasses(Date.now() + 2 * 24 * 3600 * 1000), 1);
  assert.ok(!Guilds.hasPressPass("SomePlayer"));
});

// --- persistence ---

test("save round-trips guilds, members, cases, awards, passes", () => {
  makeJournalist("Nell");
  Guilds.joinGuild("Nell", "varrock");
  Guilds.creditTreasury("varrock", 77);
  Guilds.issueMemberPass("Nell");
  assert.ok(Guilds.save());
  // Force a fresh module instance so load() re-reads the save file from disk.
  const guildPath = path.resolve(__dirname, "./CitizenPressGuilds.js");
  delete require.cache[guildPath];
  const Fresh = require("./CitizenPressGuilds");
  const g = Fresh.guildOf("varrock");
  assert.ok(g);
  assert.strictEqual(g.treasury, 77);
  assert.ok(Fresh.isGuildMember("Nell"));
  assert.ok(Fresh.hasPressPass("Nell"));
  // Clean up: the save file is a runtime artifact, not part of the commit.
  try { require("fs").unlinkSync(path.resolve(__dirname, "../data/saves/citizen-pressguilds.json")); } catch {}
});

test("describe summarizes the association", () => {
  makeJournalist("Nell");
  makeJournalist("Ed");
  Guilds.joinGuild("Nell", "varrock");
  Guilds.joinGuild("Ed", "varrock");
  Guilds.memberOf("Ed").rank = "editor";
  const d = Guilds.describe("varrock");
  assert.strictEqual(d.members, 2);
  assert.strictEqual(d.editors, 1);
  assert.strictEqual(d.openCases, 0);
});

console.log(`\n${passed} tests passed`);
