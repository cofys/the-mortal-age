"use strict";

/**
 * CitizenPressGuildEvents.test.js — ::pressguild command contracts without a
 * server. CitizenPress and CitizenSites are stubbed in the require cache.
 *
 * Run: node server/plugins/citizens/CitizenPressGuildEvents.test.js
 */

const assert = require("assert");
const path = require("path");

// --- stubs ---

const sitesPath = path.resolve(__dirname, "./lib/../brain/CitizenSites.js");
require.cache[sitesPath] = {
  id: sitesPath, filename: sitesPath, loaded: true,
  exports: { KINGDOM_IDS: ["varrock"], kingdomIdOf: () => "varrock" },
};

const fakeJournalists = new Set();
const fakeStories = [];
const fakeEvents = {};
const pressPath = path.resolve(__dirname, "./lib/CitizenPress.js");
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

// --- real modules under test ---

const Guilds = require("./lib/CitizenPressGuilds");
const { onPressGuildCommand, PRESSGUILD_USAGE } = require("./CitizenPressGuildEvents");

function makePlayer(username, coins, isBot) {
  let c = coins;
  const messages = [];
  return {
    messages,
    getUsername: () => username,
    username,
    isBot: !!isBot,
    isRealPlayer: () => !isBot,
    getInventory: () => ({
      // Real ItemContainer API: getAmount(id), deleteNumber(id, amount).
      getAmount: (id) => (id === 995 ? c : 0),
      deleteNumber: (id, n) => { if (id === 995 && c >= n) c -= n; },
    }),
    sendMessage: (t) => messages.push(t),
    __coins: () => c,
  };
}

function reset() {
  Guilds.resetForTests();
  fakeJournalists.clear();
  fakeStories.length = 0;
  for (const k of Object.keys(fakeEvents)) delete fakeEvents[k];
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
    quality: 5,
    publishedAt: Date.now(),
  };
  fakeStories.push(s);
  if (s.eventId) fakeEvents[s.eventId] = { id: s.eventId };
  return s;
}

function run(player, args) {
  onPressGuildCommand(player, args);
  return player.messages;
}

let passed = 0;
function test(name, fn) {
  reset();
  try {
    fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (e) {
    console.error(`FAIL: ${name}\n  ${e.message}`);
    process.exitCode = 1;
  }
}

test("usage string is exported", () => {
  assert.ok(PRESSGUILD_USAGE.includes("::pressguild"));
});

test("bots are rejected", () => {
  const p = makePlayer("Bot1", 100, true);
  const msgs = run(p, ["status"]);
  assert.ok(msgs.some((m) => /own sessions/i.test(m)));
});

test("status shows association info and membership", () => {
  const p = makePlayer("Player1", 100, false);
  let msgs = run(p, ["status"]);
  assert.ok(msgs.some((m) => /Press association of varrock/i.test(m)));
  fakeJournalists.add("player1");
  run(p, ["join"]);
  msgs = run(p, ["status"]);
  assert.ok(msgs.some((m) => /stringer/i.test(m)));
});

test("join requires journalist registration", () => {
  const p = makePlayer("Nobody", 100, false);
  const msgs = run(p, ["join"]);
  assert.ok(msgs.some((m) => /journalist/i.test(m)));
  assert.ok(!Guilds.isGuildMember("Nobody"));
});

test("join succeeds for journalists and issues a pass", () => {
  fakeJournalists.add("player1");
  const p = makePlayer("Player1", 100, false);
  const msgs = run(p, ["join"]);
  assert.ok(msgs.some((m) => /Welcome to the press association/i.test(m)));
  assert.ok(Guilds.isGuildMember("Player1"));
  assert.ok(Guilds.hasPressPass("Player1"));
});

test("dues: broke player cannot pay; rich player can", () => {
  fakeJournalists.add("player1");
  const broke = makePlayer("Player1", 0, false);
  run(broke, ["join"]);
  let msgs = run(broke, ["dues"]);
  assert.ok(msgs.some((m) => /need 25 coins/i.test(m)));
  const rich = makePlayer("Player1", 100, false);
  msgs = run(rich, ["dues"]);
  assert.ok(msgs.some((m) => /Dues paid/i.test(m)));
  assert.strictEqual(rich.__coins(), 100 - Guilds.DUES_WEEKLY);
});

test("code prints the ethics articles", () => {
  const p = makePlayer("Player1", 100, false);
  const msgs = run(p, ["code"]);
  assert.ok(msgs.some((m) => /Truth/i.test(m)));
  assert.strictEqual(msgs.length, 6); // header + 5 articles
});

test("report validates input and files a case", () => {
  fakeJournalists.add("player1");
  fakeJournalists.add("zed");
  const p = makePlayer("Player1", 100, false);
  run(p, ["join"]);
  Guilds.joinGuild("Zed", "varrock");
  const s = fileStory("Zed");
  let msgs = run(p, ["report"]);
  assert.ok(msgs.some((m) => /Usage/i.test(m)));
  msgs = run(p, ["report", "Zed", "plagiarism", s.id]);
  assert.ok(msgs.some((m) => /Ethics case .* opened/i.test(m)));
  msgs = run(p, ["cases"]);
  assert.ok(msgs.some((m) => new RegExp(s.id).test(m)));
});

test("vote: only editors in good standing can vote", () => {
  fakeJournalists.add("player1");
  fakeJournalists.add("zed");
  const p = makePlayer("Player1", 100, false);
  run(p, ["join"]);
  Guilds.joinGuild("Zed", "varrock");
  const s = fileStory("Zed");
  Guilds.reportViolation("Player1", "Zed", "plagiarism", s.id);
  const caseId = Guilds.openCases("varrock")[0].id;
  let msgs = run(p, ["vote", caseId, "guilty"]);
  assert.ok(msgs.some((m) => /editors/i.test(m))); // stringer cannot vote
  Guilds.memberOf("Player1").rank = "editor";
  msgs = run(p, ["vote", caseId, "guilty"]);
  assert.ok(msgs.some((m) => /Vote recorded/i.test(m)));
});

test("awards lists Inkwells", () => {
  const p = makePlayer("Player1", 100, false);
  let msgs = run(p, ["awards"]);
  assert.ok(msgs.some((m) => /No Inkwell awards yet/i.test(m)));
});

test("school shows rank progress", () => {
  fakeJournalists.add("player1");
  const p = makePlayer("Player1", 100, false);
  let msgs = run(p, ["school"]);
  assert.ok(msgs.some((m) => /not a member/i.test(m)));
  run(p, ["join"]);
  msgs = run(p, ["school"]);
  assert.ok(msgs.some((m) => /Rank: stringer/i.test(m)));
});

test("pass and daypass issue credentials", () => {
  fakeJournalists.add("player1");
  const p = makePlayer("Player1", 100, false);
  run(p, ["join"]);
  let msgs = run(p, ["pass"]);
  assert.ok(msgs.some((m) => /Press pass renewed/i.test(m)));
  const visitor = makePlayer("Visitor", 5, false);
  msgs = run(visitor, ["daypass"]);
  assert.ok(msgs.some((m) => /costs 10 coins/i.test(m)));
  const rich = makePlayer("Visitor", 50, false);
  msgs = run(rich, ["daypass"]);
  assert.ok(msgs.some((m) => /Day press pass issued/i.test(m)));
  assert.ok(Guilds.hasPressPass("Visitor"));
});

test("leave ends membership", () => {
  fakeJournalists.add("player1");
  const p = makePlayer("Player1", 100, false);
  run(p, ["join"]);
  const msgs = run(p, ["leave"]);
  assert.ok(msgs.some((m) => /left the press association/i.test(m)));
  assert.ok(!Guilds.isGuildMember("Player1"));
});

test("unknown subcommand prints usage", () => {
  const p = makePlayer("Player1", 100, false);
  const msgs = run(p, ["frobnicate"]);
  assert.ok(msgs.some((m) => /::pressguild/.test(m)));
});

console.log(`\n${passed} tests passed`);
