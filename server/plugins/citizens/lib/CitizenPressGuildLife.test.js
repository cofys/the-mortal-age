"use strict";

/**
 * CitizenPressGuildLife.test.js — guild life-tick contracts without a running
 * server. The guild data tier is real; CitizenPress, CitizenSites,
 * CitizenSayPublic, CitizenReputation and CitizenJournal are stubbed.
 *
 * Run: node server/plugins/citizens/lib/CitizenPressGuildLife.test.js
 */

const assert = require("assert");
const path = require("path");

// --- stubs ---

const sitesPath = path.resolve(__dirname, "../brain/CitizenSites.js");
require.cache[sitesPath] = {
  id: sitesPath, filename: sitesPath, loaded: true,
  exports: {
    KINGDOM_IDS: ["varrock", "falador"],
    // Real kingdomIdOf shape: reads the "kingdom:id" attribute off a LIVE
    // player entity and silently falls back to KINGDOM_IDS[0] for anything
    // else (plain roster records included). The stub replicates that so the
    // tests catch code that passes records where an entity is required.
    kingdomIdOf: (p) => {
      const id = p?.getAttribute?.("kingdom:id");
      return typeof id === "string" && id ? id : "varrock";
    },
    siteTile: () => ({ x: 3200, y: 3200, z: 0 }),
  },
};

const fakeJournalists = new Set();
const fakeStories = [];
const fakeEvents = {};
const pressPath = path.resolve(__dirname, "./CitizenPress.js");
require.cache[pressPath] = {
  id: pressPath, filename: pressPath, loaded: true,
  exports: {
    BEATS: ["crime", "politics", "war", "discovery", "culture"],
    isJournalist: (u) => fakeJournalists.has(String(u || "").toLowerCase()),
    storyCountFor: (u) => fakeStories.filter((s) => String(s.author).toLowerCase() === String(u || "").toLowerCase()).length,
    storiesFor: (kid, beat, windowMs) => {
      const now = Date.now();
      return fakeStories.filter((s) => s.kingdomId === kid && s.beat === beat && now - s.publishedAt < windowMs);
    },
    eventFor: (id) => fakeEvents[String(id)] || null,
    pressTileFor: () => ({ x: 3200, y: 3200, z: 0 }),
  },
};

const saidPublic = [];
const sayPath = path.resolve(__dirname, "../chat/CitizenSayPublic.js");
require.cache[sayPath] = {
  id: sayPath, filename: sayPath, loaded: true,
  exports: { sayPublic: (bot, msg) => { saidPublic.push({ bot: bot?.username, msg }); } },
};

const deedsAwarded = [];
const repPath = path.resolve(__dirname, "./CitizenReputation.js");
require.cache[repPath] = {
  id: repPath, filename: repPath, loaded: true,
  exports: { awardDeed: (u, d) => { deedsAwarded.push({ username: u, deed: d }); } },
};

const journaled = [];
const journalPath = path.resolve(__dirname, "./CitizenJournal.js");
require.cache[journalPath] = {
  id: journalPath, filename: journalPath, loaded: true,
  // Real journal shape: log(citizenName, kind, text, opts). Entries without a
  // text arg are silently dropped by the journal, so the mock records every
  // arg and the assertions check the text is a real string.
  exports: { getJournal: () => ({ log: (citizenName, kind, text, opts) => { journaled.push({ citizenName, kind, text, opts }); } }) },
};

// --- real modules under test ---

const Guilds = require("./CitizenPressGuilds");
const Life = require("./CitizenPressGuildLife");

function makeInv(coins) {
  let c = coins;
  return {
    // Real ItemContainer shape: getAmount(id), deleteNumber(id, n), adds(id, n).
    getAmount: (id) => (id === 995 ? c : 0),
    deleteNumber: (id, n) => { if (id === 995 && c >= n) { c -= n; return true; } return false; },
    delete: (id, n) => { if (id === 995 && c >= n) { c -= n; return true; } return false; },
    adds: (id, n) => { if (id === 995) c += n; },
    __coins: () => c,
  };
}

function makeBot(username, coins) {
  const inv = makeInv(coins);
  return { username, getInventory: () => inv, __inv: inv };
}

function makeDirector(records) {
  return {
    roster: records,
    isOnline: () => true,
    getBot: (r) => r.__bot || null,
    log: () => {},
  };
}

function makeRecord(username, coins, kingdomId = "varrock") {
  const bot = makeBot(username, coins);
  return { username, name: username, kingdomId, __bot: bot, __inv: bot.__inv };
}

function reset() {
  Guilds.resetForTests();
  Life.resetForTests();
  fakeJournalists.clear();
  fakeStories.length = 0;
  for (const k of Object.keys(fakeEvents)) delete fakeEvents[k];
  saidPublic.length = 0;
  deedsAwarded.length = 0;
  journaled.length = 0;
  try { require("fs").unlinkSync(path.resolve(__dirname, "../data/saves/citizen-pressguilds.json")); } catch {}
}

function joinAs(name, coins = 1000) {
  fakeJournalists.add(name.toLowerCase());
  const r = Guilds.joinGuild(name, "varrock");
  assert.ok(r.ok, `join failed for ${name}: ${r.reason}`);
  return r;
}

function fileStory(author, opts = {}) {
  const id = `story${fakeStories.length + 1}`;
  const s = {
    id,
    eventId: opts.eventId ?? `evt${fakeStories.length + 1}`,
    beat: opts.beat || "crime",
    author,
    authorIsPlayer: false,
    kingdomId: "varrock",
    headline: opts.headline || `Headline ${id}`,
    quality: opts.quality ?? 5,
    publishedAt: opts.publishedAt ?? Date.now(),
  };
  fakeStories.push(s);
  if (s.eventId) fakeEvents[s.eventId] = { id: s.eventId };
  return s;
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

test("tick never throws with an empty world", () => {
  Life.tickPressGuildLife(makeDirector([]), Date.now());
  Life.tickPressGuildLife(null, Date.now());
});

test("dues collected from real online inventories; broke members miss", () => {
  joinAs("Nell", 1000);
  joinAs("Broke", 0);
  Guilds.memberOf("Nell").duesPaidUntil = Date.now() - 1; // dues due now
  Guilds.memberOf("Broke").duesPaidUntil = Date.now() - 1;
  const recNell = makeRecord("Nell", 1000);
  const recBroke = makeRecord("Broke", 0);
  Life.tickPressGuildLife(makeDirector([recNell, recBroke]), Date.now());
  // Dues were collected through the REAL inventory API (getAmount/deleteNumber):
  // 25 coins left the bot's inventory and landed in the guild treasury.
  assert.strictEqual(recNell.__inv.__coins(), 1000 - Guilds.DUES_WEEKLY);
  assert.strictEqual(Guilds.guildTreasuryFor("varrock"), Guilds.DUES_WEEKLY);
  assert.strictEqual(Guilds.memberOf("Broke").missedDues, 1);
});

test("two missed dues suspend the member", () => {
  joinAs("Broke", 0);
  Guilds.memberOf("Broke").duesPaidUntil = Date.now() - 1; // dues due now
  const rec = makeRecord("Broke", 0);
  const d = makeDirector([rec]);
  const t0 = Date.now();
  Life.tickPressGuildLife(d, t0);
  assert.strictEqual(Guilds.memberOf("Broke").missedDues, 1);
  Life.resetForTests(); // clear the 30-min throttle so the second pass runs
  Life.tickPressGuildLife(d, t0 + 8 * 24 * 3600 * 1000); // past the dues period
  assert.strictEqual(Guilds.memberOf("Broke").missedDues, 2);
  assert.strictEqual(Guilds.memberOf("Broke").suspended, true);
  assert.ok(journaled.some((j) => j.kind === "pressguild-suspended" && typeof j.text === "string" && j.text.length > 0 && typeof j.citizenName === "string" && j.citizenName.length > 0), "canonical journal shape (name, kind, text) for pressguild-suspended");
});

test("plagiarism scan auto-opens an ethics case", () => {
  joinAs("Nell");
  joinAs("Zed");
  fileStory("Nell", { headline: "Court Report: the stolen pie", publishedAt: Date.now() - 10000 });
  fileStory("Zed", { headline: "Court Report: the stolen pie", publishedAt: Date.now() });
  Life.tickPressGuildLife(makeDirector([]), Date.now());
  const open = Guilds.openCases("varrock");
  assert.strictEqual(open.length, 1);
  assert.strictEqual(open[0].accused, "Zed");
  assert.ok(journaled.some((j) => j.kind === "pressguild-case-opened" && typeof j.text === "string" && j.text.length > 0 && typeof j.citizenName === "string" && j.citizenName.length > 0), "canonical journal shape (name, kind, text) for pressguild-case-opened");
});

test("tribunal settles old cases; fabrication expels and awards the deed", () => {
  joinAs("Zed");
  joinAs("Ed");
  Guilds.memberOf("Ed").rank = "editor";
  const bad = fileStory("Zed", { eventId: "evt-gone" });
  delete fakeEvents["evt-gone"];
  const r = Guilds.reportViolation("guild", "Zed", "fabrication", bad.id);
  assert.ok(r.ok);
  Guilds.voteOnCase(r.id, "Ed", true);
  // Fast-forward past the 24h settle window.
  Life.tickPressGuildLife(makeDirector([]), Date.now() + 25 * 60 * 60 * 1000);
  const c = Guilds.caseFor(r.id);
  assert.strictEqual(c.status, "decided");
  assert.strictEqual(c.verdict, "guilty");
  assert.ok(!Guilds.isGuildMember("Zed"));
  assert.ok(deedsAwarded.some((d) => d.username === "Zed" && d.deed === "fabricator"));
});

test("Inkwell awarded to the best member story with a real prize and deed", () => {
  joinAs("Nell");
  joinAs("Zed");
  Guilds.creditTreasury("varrock", 1000);
  fileStory("Nell", { beat: "war", quality: 6, publishedAt: Date.now() - 2000 });
  fileStory("Zed", { beat: "war", quality: 9, publishedAt: Date.now() - 1000 });
  const rec = makeRecord("Zed", 0);
  Life.tickPressGuildLife(makeDirector([rec]), Date.now());
  const awards = Guilds.awardsFor("varrock");
  assert.strictEqual(awards.length, 1);
  assert.strictEqual(awards[0].winner, "Zed");
  assert.ok(deedsAwarded.some((d) => d.username === "Zed" && d.deed === "presslaureate"));
  assert.ok(journaled.some((j) => j.kind === "pressguild-award" && typeof j.text === "string" && j.text.length > 0 && typeof j.citizenName === "string" && j.citizenName.length > 0), "canonical journal shape (name, kind, text) for pressguild-award");
  assert.ok(saidPublic.some((s) => /Inkwell/.test(s.msg)), "award announced");
});

test("school: editor teaches stringers; promotions journaled", () => {
  joinAs("Ed");
  joinAs("Nell");
  Guilds.memberOf("Ed").rank = "editor";
  for (let i = 0; i < 5; i++) fileStory("Nell", { beat: "crime" });
  const recEd = makeRecord("Ed", 500);
  const recNell = makeRecord("Nell", 500);
  Life.tickPressGuildLife(makeDirector([recEd, recNell]), Date.now());
  assert.ok(Guilds.memberOf("Nell").trainingCredits >= 1);
  assert.strictEqual(Guilds.guildRankOf("Nell"), "reporter"); // 5 stories -> promoted
  assert.ok(journaled.some((j) => j.kind === "pressguild-class" && typeof j.text === "string" && j.text.length > 0 && typeof j.citizenName === "string" && j.citizenName.length > 0), "canonical journal shape (name, kind, text) for pressguild-class");
  assert.ok(journaled.some((j) => j.kind === "pressguild-promotion" && typeof j.text === "string" && j.text.length > 0 && typeof j.citizenName === "string" && j.citizenName.length > 0), "canonical journal shape (name, kind, text) for pressguild-promotion");
});

test("passes pruned on the tick", () => {
  joinAs("Nell");
  Guilds.issueMemberPass("Nell");
  assert.ok(Guilds.hasPressPass("Nell"));
  Life.tickPressGuildLife(makeDirector([]), Date.now() + 31 * 24 * 3600 * 1000);
  assert.ok(!Guilds.hasPressPass("Nell"));
});

test("kingdom attribution uses the roster record's kingdomId, not the entity-only API", () => {
  // REGRESSION: CitizenSites.kingdomIdOf needs a live player entity and
  // silently returns KINGDOM_IDS[0] for plain roster records. The life tick
  // must read record.kingdomId directly or non-first-kingdom citizens are
  // attributed to varrock (school never matches them, announcements go to
  // the wrong kingdom's bots).
  fakeJournalists.add("fed");
  fakeJournalists.add("fnell");
  Guilds.joinGuild("Fed", "falador");
  Guilds.joinGuild("FNell", "falador");
  Guilds.memberOf("Fed").rank = "editor";
  const recEd = makeRecord("Fed", 500, "falador");
  const recNell = makeRecord("FNell", 500, "falador");
  Life.tickPressGuildLife(makeDirector([recEd, recNell]), Date.now());
  assert.ok(Guilds.memberOf("FNell").trainingCredits >= 1, "falador stringer attended the falador class");
  assert.ok(
    journaled.some((j) => j.kind === "pressguild-class" && j.opts && j.opts.kingdomId === "falador"),
    "class journaled for falador"
  );
});

console.log(`\n${passed} tests passed`);
