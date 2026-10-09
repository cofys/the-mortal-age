"use strict";

// CitizenActivityChatter unit checks — pure logic, no running server.
const assert = require("node:assert/strict");
const Chatter = require("./CitizenActivityChatter");
const { resetForTests: resetSayPublic } = require("./CitizenSayPublic");

const {
  tickActivityChatter,
  _resetForTests,
  _pickSkillLine,
  _pickGoalLine,
  _xpToNextLevel,
  _levelProgress,
  _chatterChance,
  _nextChatterAt,
  _announcedSessions,
} = Chatter;

// OSRS XP table reference values (verified against the canonical formula).
const XP_69 = 668051;
const XP_70 = 737627;

function makeRealPlayer(username = "Cofy") {
  const sent = [];
  return {
    player: {
      getUsername: () => username,
      getIndex: () => 7,
      getHostAddress: () => "127.0.0.1",
      isPlayerBot: () => false,
      getRelations: () => ({ canReceivePublicChatFrom: () => true }),
      getPacketSender: () => ({
        sendPublicChat: (message, from, playerId) => sent.push({ message, from, playerId }),
      }),
    },
    sent,
  };
}

function makeBot({
  username = "Mira",
  personality = { traits: ["chatty"] },
  locals = [],
  level = 69,
  xp = XP_69 + 1000,
} = {}) {
  const forced = [];
  return {
    bot: {
      getUsername: () => username,
      getAttribute: () => personality,
      getLocalPlayers: () => locals.map((l) => l.player),
      forceChat: (text) => forced.push(text),
      getSkillManager: () => ({
        getCurrentLevel: () => level,
        getExperience: () => xp,
      }),
    },
    forced,
  };
}

function makeDirector(bot, recordUsername = "Mira") {
  return {
    roster: new Map([[recordUsername.toLowerCase(), { username: recordUsername }]]),
    isOnline: () => true,
    getBot: () => bot,
    api: { core: { Skill: { FISHING: 0, WOODCUTTING: 1, MINING: 2 } } },
  };
}

function makeSessions(skill = "fishing", members = ["Mira"], sessionId = "sess-1") {
  return new Map([
    [
      "s1",
      { skill, arrived: true, members, sessionId },
    ],
  ]);
}

let origRandom = null;
function fixRandom(value = 0) {
  origRandom = Math.random;
  Math.random = () => value;
}
function unfixRandom() {
  if (origRandom) Math.random = origRandom;
  origRandom = null;
}

function run(name, fn) {
  _resetForTests();
  resetSayPublic();
  fixRandom(0);
  try {
    fn();
    console.log(`PASS: ${name}`);
  } catch (e) {
    console.error(`FAIL: ${name}: ${e.message}`);
    process.exitCode = 1;
  } finally {
    unfixRandom();
  }
}

// --- XP helpers ---------------------------------------------------------------

run("xpToNextLevel: known values", () => {
  assert.equal(_xpToNextLevel(XP_69, 69), XP_70 - XP_69);
  assert.equal(_xpToNextLevel(XP_70 - 1, 69), 1);
  assert.equal(_xpToNextLevel(0, 99), null); // maxed
  assert.equal(_xpToNextLevel(NaN, 69), null);
});

run("levelProgress: fractions", () => {
  const p = _levelProgress(XP_69 + 1000, 69);
  assert.ok(p > 0 && p < 0.02, `expected tiny progress, got ${p}`);
  const q = _levelProgress(XP_70 - 100, 69);
  assert.ok(q > 0.99, `expected near-1 progress, got ${q}`);
});

// --- line picking ---------------------------------------------------------------

run("pickSkillLine: plain grind line for chatty fisher", () => {
  const line = _pickSkillLine("fishing", { level: 69, xp: XP_69 + 1000 }, { traits: ["chatty"] }, () => 0);
  assert.equal(line, "fish are biting today");
});

run("pickSkillLine: milestone line when close to level", () => {
  const line = _pickSkillLine("fishing", { level: 69, xp: XP_70 - 500 }, { traits: ["chatty"] }, () => 0);
  assert.ok(line.includes("70"), `expected upcoming level 70 in "${line}"`);
  assert.ok(/fish/i.test(line), `expected skill mention in "${line}"`);
});

run("pickSkillLine: terse voice for gruff citizen", () => {
  const line = _pickSkillLine("fishing", { level: 69, xp: XP_69 + 1000 }, { traits: ["gruff"] }, () => 0);
  assert.equal(line, "fishing.");
});

run("pickSkillLine: unknown skill falls back to default pool", () => {
  const line = _pickSkillLine("dungeoneering", { level: 10, xp: 1154 + 10 }, {}, () => 0);
  assert.ok(typeof line === "string" && line.length > 0, "expected a fallback line");
});

run("pickGoalLine: gain_xp intent mentions the label", () => {
  const line = _pickGoalLine(
    [{ type: "gain_xp", label: "70 fishing" }],
    { traits: ["chatty"] },
    () => 0
  );
  assert.ok(line.includes("70 fishing"), `expected label in "${line}"`);
});

run("chatterChance: chatty high, gruff low", () => {
  assert.ok(_chatterChance({ traits: ["chatty"] }) > _chatterChance({ traits: ["gruff"] }));
  assert.ok(_chatterChance({ traits: ["taciturn"] }) < 0.3);
});

// --- tick behavior ---------------------------------------------------------------

run("tick: chatting fisher speaks when watched", () => {
  const rp = makeRealPlayer();
  const { bot, forced } = makeBot({ locals: [rp] });
  // Pre-announce the session so we only test grind chatter.
  _announcedSessions.add("sess-1");
  const director = makeDirector(bot);
  tickActivityChatter(director, { sessions: makeSessions(), nowMs: 1000000 });
  assert.equal(forced.length, 1, `expected one chatter line, got ${forced.length}`);
  assert.equal(forced[0], "fish are biting today");
  assert.equal(rp.sent.length, 1, "expected chat-box delivery to the real player");
});

run("tick: silent when no real player nearby", () => {
  const { bot, forced } = makeBot({ locals: [] }); // nobody watching
  _announcedSessions.add("sess-1");
  const director = makeDirector(bot);
  tickActivityChatter(director, { sessions: makeSessions(), nowMs: 1000000 });
  assert.equal(forced.length, 0, "expected silence when unwatched");
});

run("tick: cooldown respected", () => {
  const rp = makeRealPlayer();
  const { bot, forced } = makeBot({ locals: [rp] });
  _announcedSessions.add("sess-1");
  const director = makeDirector(bot);
  const sessions = makeSessions();
  tickActivityChatter(director, { sessions, nowMs: 1000000 });
  assert.equal(forced.length, 1);
  // Immediate second tick: throttled.
  tickActivityChatter(director, { sessions, nowMs: 1000000 + 1000 });
  assert.equal(forced.length, 1, "expected no second line within cooldown");
});

run("tick: not in a session, no chatter", () => {
  const rp = makeRealPlayer();
  const { bot, forced } = makeBot({ locals: [rp], username: "Bob" });
  _announcedSessions.add("sess-1");
  const director = makeDirector(bot, "Bob");
  // Session members don't include Bob.
  tickActivityChatter(director, { sessions: makeSessions("fishing", ["Mira"]), nowMs: 1000000 });
  assert.equal(forced.length, 0, "expected silence when not skilling");
});

run("tick: milestone line when close to level", () => {
  const rp = makeRealPlayer();
  const { bot, forced } = makeBot({ locals: [rp], xp: XP_70 - 500 });
  _announcedSessions.add("sess-1");
  const director = makeDirector(bot);
  tickActivityChatter(director, { sessions: makeSessions(), nowMs: 1000000 });
  assert.equal(forced.length, 1);
  assert.ok(forced[0].includes("70"), `expected milestone line, got "${forced[0]}"`);
});

run("tick: one bad citizen does not break the tick", () => {
  const rp = makeRealPlayer();
  const { bot, forced } = makeBot({ locals: [rp] });
  _announcedSessions.add("sess-1");
  const badBot = {
    getUsername: () => {
      throw new Error("boom");
    },
  };
  const director = {
    roster: new Map([
      ["mira", { username: "Mira" }],
      ["bad", { username: "Bad" }],
    ]),
    isOnline: () => true,
    getBot: (record) => (record.username === "Mira" ? bot : badBot),
    api: { core: { Skill: { FISHING: 0 } } },
  };
  const sessions = new Map([
    ["s1", { skill: "fishing", arrived: true, members: ["Mira", "Bad"], sessionId: "sess-1" }],
  ]);
  tickActivityChatter(director, { sessions, nowMs: 1000000 });
  assert.equal(forced.length, 1, "good citizen still chattered");
});

console.log("done.");
