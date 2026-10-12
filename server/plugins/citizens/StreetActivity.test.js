"use strict";

/**
 * StreetActivity.test.js — unit checks for the street-activity rung.
 *
 * Run: node StreetActivity.test.js  (from server/plugins/citizens)
 */

const assert = require("assert");
const {
  tickActivityReactions,
  skillOfAnim,
  classifyPlayerActivity,
  activityLabel,
  ACTIVITY_LINES,
  ACT_WOODCUTTING,
  ACT_FISHING,
  ACT_MINING,
  ACT_FIGHTING,
  resetForTests,
} = require("./StreetActivity");
const { setChunkScheduler, resetForTests: resetSayPublic } = require("./chat/CitizenSayPublic");

// Run chunk continuations immediately so no timers keep the process alive.
setChunkScheduler((fn) => {
  try {
    fn();
  } catch {
    // ignore
  }
});

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`FAIL - ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}

// --- mocks ---------------------------------------------------------------

function makeTile(x, y, z = 0) {
  return { getX: () => x, getY: () => y, getZ: () => z };
}

function makePlayer(name, { x = 0, y = 0, animId = null, inCombat = false } = {}) {
  return {
    getUsername: () => name,
    getHostAddress: () => "somehost",
    isPlayerBot: () => false,
    inCombat: () => inCombat,
    getAnimation: () => (animId == null ? null : { getId: () => animId }),
    getLocation: () => makeTile(x, y),
  };
}

function makeCitizenBot(name, { x = 0, y = 0, inCombat = false, locals = [] } = {}) {
  const faced = [];
  const said = [];
  const bot = {
    faced,
    said,
    _locals: locals,
    getUsername: () => name,
    inCombat: () => inCombat,
    // The engine always includes the bot itself in its local list.
    getLocalPlayers: () => [bot, ...bot._locals],
    getLocation: () => makeTile(x, y),
    face: (fx, fy) => faced.push([fx, fy]),
    getAttribute: () => ({}),
    forceChat: (text) => said.push(text),
    getIndex: () => 1,
    getPacketSender: () => ({ sendPublicChat: () => {} }),
  };
  return bot;
}

function buildBot(name, opts = {}) {
  return makeCitizenBot(name, opts);
}

function makeDirector(entries) {
  // entries: [{ username, personality, bot }]
  const roster = new Map();
  const bots = new Map();
  for (const e of entries) {
    roster.set(e.username, { username: e.username, personality: e.personality ?? {} });
    bots.set(e.username, e.bot);
  }
  return {
    roster,
    isOnline: () => true,
    getBot: (record) => bots.get(record.username) ?? null,
  };
}

function chattyPersonality() {
  return { traits: ["chatty"], demeanor: "warm and friendly" };
}

// --- pure helpers ---------------------------------------------------------

check("skillOfAnim maps the verified skilling animations", () => {
  for (const id of [618, 619, 620, 621, 622]) assert.strictEqual(skillOfAnim(id), ACT_FISHING, String(id));
  for (const id of [624, 625, 626, 627, 628, 629]) assert.strictEqual(skillOfAnim(id), ACT_MINING, String(id));
  for (const id of [879, 877, 875, 867, 2846, 10064, 10074, 2117]) {
    assert.strictEqual(skillOfAnim(id), ACT_WOODCUTTING, String(id));
  }
  assert.strictEqual(skillOfAnim(862), null); // cheer emote is not skilling
  assert.strictEqual(skillOfAnim(0), null);
  assert.strictEqual(skillOfAnim(null), null);
  assert.strictEqual(skillOfAnim(undefined), null);
  assert.strictEqual(skillOfAnim("879"), null);
});

check("classifyPlayerActivity: fighting wins, then animation, then null", () => {
  const fighter = makePlayer("Jon", { animId: 879, inCombat: true });
  assert.strictEqual(classifyPlayerActivity(fighter), ACT_FIGHTING);
  const chopper = makePlayer("Jon", { animId: 879 });
  assert.strictEqual(classifyPlayerActivity(chopper), ACT_WOODCUTTING);
  const fisher = makePlayer("Jon", { animId: 622 });
  assert.strictEqual(classifyPlayerActivity(fisher), ACT_FISHING);
  const miner = makePlayer("Jon", { animId: 625 });
  assert.strictEqual(classifyPlayerActivity(miner), ACT_MINING);
  const idler = makePlayer("Jon", {});
  assert.strictEqual(classifyPlayerActivity(idler), null);
  const emote = makePlayer("Jon", { animId: 862 });
  assert.strictEqual(classifyPlayerActivity(emote), null);
  assert.strictEqual(classifyPlayerActivity(null), null);
});

check("activityLabel names every activity", () => {
  assert.strictEqual(activityLabel(ACT_WOODCUTTING), "chopping wood");
  assert.strictEqual(activityLabel(ACT_FISHING), "fishing");
  assert.strictEqual(activityLabel(ACT_MINING), "mining");
  assert.strictEqual(activityLabel(ACT_FIGHTING), "fighting");
  assert.strictEqual(activityLabel("weird"), "busy");
});

check("every activity has warm/neutral/wry pools with filled slots", () => {
  for (const activity of [ACT_WOODCUTTING, ACT_FISHING, ACT_MINING, ACT_FIGHTING]) {
    for (const warmth of ["warm", "neutral", "wry"]) {
      const pool = ACTIVITY_LINES[activity]?.[warmth];
      assert.ok(Array.isArray(pool) && pool.length >= 2, `${activity}/${warmth} too small`);
      for (const line of pool) {
        assert.ok(line.length <= 120, `${activity}/${warmth} line too long: ${line}`);
        assert.ok(!/\{(skill|level|foe)\}/.test(line), `${activity}/${warmth} unfilled slot: ${line}`);
      }
    }
  }
});

// --- tick behavior (mocked director) --------------------------------------

check("a citizen reacts to a nearby skilling player: faces them and speaks", () => {
  resetForTests();
  resetSayPublic();
  const player = makePlayer("Jon", { x: 3, y: 0, animId: 879 });
  const bot = buildBot("bob", { x: 0, y: 0, locals: [player], personality: chattyPersonality() });
  const director = makeDirector([{ username: "bob", personality: chattyPersonality(), bot }]);
  const nowMs = Date.now();

  // Roll the tick until the personality-scaled chance fires (bounded).
  let fired = false;
  for (let i = 0; i < 50 && !fired; i += 1) {
    tickActivityReactions(director, nowMs + i * 61000);
    fired = bot.faced.length > 0;
    if (!fired) resetForTests(); // fresh cooldowns so the roll is the only gate
  }
  assert.ok(fired, "no reaction after 50 eligible ticks");
  assert.deepStrictEqual(bot.faced[0], [3, 0]);
  assert.ok(bot.said.length > 0, "citizen said nothing overhead");
  resetSayPublic();
});

check("cooldowns: one reaction per player per 10 min, per citizen per 15 min", () => {
  resetForTests();
  resetSayPublic();
  const player = makePlayer("Jon", { x: 3, y: 0, animId: 879 });
  const bot = buildBot("bob", { x: 0, y: 0, locals: [player] });
  const director = makeDirector([{ username: "bob", personality: chattyPersonality(), bot }]);
  const nowMs = Date.now();

  // Force the chance gate open by repeating ticks with fresh citizen
  // cooldowns would be wrong — instead run once per minute-step and count.
  let reactions = 0;
  for (let i = 0; i < 30; i += 1) {
    const before = bot.faced.length;
    tickActivityReactions(director, nowMs + i * 61000);
    if (bot.faced.length > before) reactions += 1;
  }
  // Player cooldown (10 min) is the binding constraint: at most ~3 in 30 min.
  assert.ok(reactions <= 4, `too many reactions in 30 min: ${reactions}`);
  resetSayPublic();
});

check("a citizen in combat does not react", () => {
  resetForTests();
  resetSayPublic();
  const player = makePlayer("Jon", { x: 3, y: 0, animId: 879 });
  const bot = buildBot("bob", { x: 0, y: 0, inCombat: true, locals: [player] });
  const director = makeDirector([{ username: "bob", personality: chattyPersonality(), bot }]);
  for (let i = 0; i < 20; i += 1) {
    tickActivityReactions(director, Date.now() + i * 61000);
  }
  assert.strictEqual(bot.faced.length, 0, "citizen in combat reacted");
  resetSayPublic();
});

check("excluded citizens (just greeted) do not double-react", () => {
  resetForTests();
  resetSayPublic();
  const player = makePlayer("Jon", { x: 3, y: 0, animId: 879 });
  const bot = buildBot("bob", { x: 0, y: 0, locals: [player] });
  const director = makeDirector([{ username: "bob", personality: chattyPersonality(), bot }]);
  for (let i = 0; i < 20; i += 1) {
    tickActivityReactions(director, Date.now() + i * 61000, new Set(["bob"]));
  }
  assert.strictEqual(bot.faced.length, 0, "excluded citizen reacted");
  resetSayPublic();
});

check("idle players and distant players get no reaction", () => {
  resetForTests();
  resetSayPublic();
  const idler = makePlayer("Jon", { x: 3, y: 0 });
  const farSkiller = makePlayer("Zed", { x: 30, y: 0, animId: 879 });
  const bot = buildBot("bob", { x: 0, y: 0, locals: [idler, farSkiller] });
  const director = makeDirector([{ username: "bob", personality: chattyPersonality(), bot }]);
  for (let i = 0; i < 20; i += 1) {
    tickActivityReactions(director, Date.now() + i * 61000);
  }
  assert.strictEqual(bot.faced.length, 0, "reacted to idle/distant player");
  resetSayPublic();
});

check("fighting players get a reaction too", () => {
  resetForTests();
  resetSayPublic();
  const player = makePlayer("Jon", { x: 3, y: 0, inCombat: true });
  const bot = buildBot("bob", { x: 0, y: 0, locals: [player] });
  const director = makeDirector([{ username: "bob", personality: chattyPersonality(), bot }]);
  let fired = false;
  for (let i = 0; i < 50 && !fired; i += 1) {
    tickActivityReactions(director, Date.now() + i * 61000);
    fired = bot.faced.length > 0;
    if (!fired) resetForTests();
  }
  assert.ok(fired, "no reaction to a fighting player after 50 eligible ticks");
  resetSayPublic();
});

console.log(`\n${passed} checks passed.`);
