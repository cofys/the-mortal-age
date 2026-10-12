"use strict";

/**
 * CitizenSocial.test.js — unit checks for the social-reactivity pass:
 * greeting tuning pins + the cheap "notice" (turn to face newcomers).
 *
 * Run: node CitizenSocial.test.js  (from server/plugins/citizens/chat)
 */

const assert = require("assert");
const {
  initCitizenSocial,
  maybeNoticePlayer,
  resetForTests,
  _GREET_TICK_CHANCE,
  _GREET_PLAYER_COOLDOWN_MS,
  _GREET_CITIZEN_COOLDOWN_MS,
  _NOTICE_RADIUS,
  _NOTICE_COOLDOWN_MS,
  _lastNoticedAt,
} = require("./CitizenSocial");

initCitizenSocial({ emitCustomEvent: () => {}, log: () => {} });

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

function makePlayer(name, { x = 0, y = 0, botHost = false } = {}) {
  return {
    getUsername: () => name,
    getHostAddress: () => (botHost ? "bot" : "somehost"),
    isPlayerBot: () => botHost,
    inCombat: () => false,
    busy: () => false,
    getLocation: () => makeTile(x, y),
  };
}

function makeCitizenBot(name, { x = 0, y = 0, inCombat = false, locals = [] } = {}) {
  const faced = [];
  const bot = {
    faced,
    _locals: locals,
    getUsername: () => name,
    inCombat: () => inCombat,
    busy: () => false,
    getLocalPlayers: () => [bot, ...bot._locals],
    getLocation: () => makeTile(x, y),
    face: (fx, fy) => faced.push([fx, fy]),
    getAttribute: () => ({}),
  };
  return bot;
}

function makeDirector(entries) {
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

/** Roll maybeNoticePlayer across minute-steps until the citizen faces; returns the fire time or null. */
function rollUntilNotice(director, bot, excluded, maxTicks = 60) {
  const base = Date.now();
  for (let i = 0; i < maxTicks; i += 1) {
    const t = base + i * 61000;
    maybeNoticePlayer(director, t, excluded);
    if (bot.faced.length > 0) return t;
    resetForTests(); // keep cooldowns out of the chance roll
  }
  return null;
}

// --- greeting tuning pins -------------------------------------------------

check("greeting tuning: faster tick chance, 2-min player cooldown, 20-min citizen cooldown", () => {
  assert.strictEqual(_GREET_TICK_CHANCE, 0.12);
  assert.strictEqual(_GREET_PLAYER_COOLDOWN_MS, 2 * 60 * 1000);
  assert.strictEqual(_GREET_CITIZEN_COOLDOWN_MS, 20 * 60 * 1000);
});

check("notice tuning: 8-tile radius, ~2-min per citizen+player cooldown", () => {
  assert.strictEqual(_NOTICE_RADIUS, 8);
  assert.strictEqual(_NOTICE_COOLDOWN_MS, 2 * 60 * 1000);
});

// --- notice behavior --------------------------------------------------------

check("a citizen turns to face a newcomer within radius", () => {
  resetForTests();
  const player = makePlayer("Jon", { x: 5, y: 0 });
  const bot = makeCitizenBot("bob", { x: 0, y: 0, locals: [player] });
  const director = makeDirector([{ username: "bob", personality: chattyPersonality(), bot }]);
  assert.ok(rollUntilNotice(director, bot), "citizen never noticed the newcomer");
  assert.deepStrictEqual(bot.faced[0], [5, 0]);
});

check("notice cooldown: no second glance within 2 min, glance again after", () => {
  resetForTests();
  const player = makePlayer("Jon", { x: 5, y: 0 });
  const bot = makeCitizenBot("bob", { x: 0, y: 0, locals: [player] });
  const director = makeDirector([{ username: "bob", personality: chattyPersonality(), bot }]);
  const firedAt = rollUntilNotice(director, bot);
  assert.ok(firedAt != null, "first notice never fired");
  assert.strictEqual(_lastNoticedAt.get("bob:Jon") !== undefined, true);
  const firstNotices = bot.faced.length;

  // Ticks inside the cooldown window: no new glances.
  for (const dt of [30000, 61000, 91000, 119000]) {
    maybeNoticePlayer(director, firedAt + dt);
  }
  assert.strictEqual(bot.faced.length, firstNotices, "citizen stared during cooldown");

  // Past the cooldown: the citizen may notice again.
  bot.faced.length = 0;
  let refired = false;
  for (let i = 0; i < 60 && !refired; i += 1) {
    maybeNoticePlayer(director, firedAt + _NOTICE_COOLDOWN_MS + 61000 + i * 61000);
    refired = bot.faced.length > 0;
  }
  assert.ok(refired, "citizen never re-noticed after cooldown");
});

check("the cooldown is per citizen+player: a second citizen still notices", () => {
  resetForTests();
  const player = makePlayer("Jon", { x: 5, y: 0 });
  const botA = makeCitizenBot("ann", { x: 0, y: 0, locals: [player] });
  const botB = makeCitizenBot("zed", { x: 0, y: 1, locals: [player] });
  const director = makeDirector([
    { username: "ann", personality: chattyPersonality(), bot: botA },
    { username: "zed", personality: chattyPersonality(), bot: botB },
  ]);
  const t0 = Date.now();
  for (let i = 0; i < 60 && (botA.faced.length === 0 || botB.faced.length === 0); i += 1) {
    maybeNoticePlayer(director, t0 + i * 61000);
  }
  assert.ok(botA.faced.length > 0, "ann never noticed");
  assert.ok(botB.faced.length > 0, "zed never noticed (cooldown leaked across citizens)");
});

check("a citizen in combat does not glance at passers-by", () => {
  resetForTests();
  const player = makePlayer("Jon", { x: 5, y: 0 });
  const bot = makeCitizenBot("bob", { x: 0, y: 0, inCombat: true, locals: [player] });
  const director = makeDirector([{ username: "bob", personality: chattyPersonality(), bot }]);
  const t0 = Date.now();
  for (let i = 0; i < 60; i += 1) {
    maybeNoticePlayer(director, t0 + i * 61000);
  }
  assert.strictEqual(bot.faced.length, 0, "citizen in combat glanced");
});

check("players beyond the notice radius are ignored", () => {
  resetForTests();
  const player = makePlayer("Jon", { x: 20, y: 0 });
  const bot = makeCitizenBot("bob", { x: 0, y: 0, locals: [player] });
  const director = makeDirector([{ username: "bob", personality: chattyPersonality(), bot }]);
  const t0 = Date.now();
  for (let i = 0; i < 60; i += 1) {
    maybeNoticePlayer(director, t0 + i * 61000);
  }
  assert.strictEqual(bot.faced.length, 0, "citizen noticed a far-away player");
});

check("citizens that greeted this tick are excluded from the glance", () => {
  resetForTests();
  const player = makePlayer("Jon", { x: 5, y: 0 });
  const bot = makeCitizenBot("bob", { x: 0, y: 0, locals: [player] });
  const director = makeDirector([{ username: "bob", personality: chattyPersonality(), bot }]);
  const t0 = Date.now();
  for (let i = 0; i < 60; i += 1) {
    maybeNoticePlayer(director, t0 + i * 61000, new Set(["bob"]));
  }
  assert.strictEqual(bot.faced.length, 0, "excluded citizen glanced");
});

check("other citizen bots are not 'noticed' — only real players", () => {
  resetForTests();
  const fellow = makePlayer("fellow_citizen", { x: 5, y: 0, botHost: true });
  const bot = makeCitizenBot("bob", { x: 0, y: 0, locals: [fellow] });
  const director = makeDirector([{ username: "bob", personality: chattyPersonality(), bot }]);
  const t0 = Date.now();
  for (let i = 0; i < 60; i += 1) {
    maybeNoticePlayer(director, t0 + i * 61000);
  }
  assert.strictEqual(bot.faced.length, 0, "citizen glanced at another bot");
});

console.log(`\n${passed} checks passed.`);
