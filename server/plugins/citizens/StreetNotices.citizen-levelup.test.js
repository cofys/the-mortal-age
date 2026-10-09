"use strict";

/**
 * StreetNotices.citizen-levelup.test.js — citizen level-up celebration.
 *
 * A citizen (citizens:role set, not a real player) leveling a skill announces
 * it via sayPublic and up to two nearby citizens answer with gz through the
 * same scripted reflex real chat uses. Real players leveling never enter
 * this path (onPlayerLevelUpNotice owns them).
 *
 * Run: node StreetNotices.citizen-levelup.test.js  (from server/plugins/citizens)
 */

const assert = require("assert");
const path = require("path");

// --- Fake director (nearbyCitizens is roster-backed) -------------------------
const directorPath = require.resolve("./director/CitizenDirector");
const fakeRoster = new Map();
const fakeDirector = {
  roster: fakeRoster,
  isOnline: () => true,
};
require.cache[directorPath] = {
  id: directorPath,
  filename: directorPath,
  loaded: true,
  exports: { getDirector: () => fakeDirector },
};

const {
  onCitizenLevelUpNotice,
  isLevelingCitizen,
  isMilestone,
  fillLine,
  CITIZEN_ANNOUNCE_LINES,
  CITIZEN_MILESTONE_LINES,
  resetForTests: resetNotices,
} = require("./StreetNotices");
const { matchPattern, resetForTests: resetReactions } = require("./chat/CitizenHeardReactions");
const { resetForTests: resetSayPublic } = require("./chat/CitizenSayPublic");

// --- Mocks ------------------------------------------------------------------
function mockBot({
  username,
  role = "commoner",
  personality = {},
  host = "bot",
  botFlag = true,
  x = 3000,
  y = 3000,
  locals = [],
}) {
  const forced = [];
  return {
    forcedChat: forced,
    getUsername: () => username,
    getAttribute: (k) => {
      if (k === "citizens:role") return role;
      if (k === "citizens:personality") return personality;
      return undefined;
    },
    getHostAddress: () => host,
    isPlayerBot: () => botFlag,
    getIndex: () => 7,
    forceChat: (t) => {
      forced.push(t);
    },
    getLocalPlayers: () => locals,
    getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => z }),
    getPacketSender: () => ({ sendPublicChat: () => {} }),
    getRelations: () => ({ canReceivePublicChatFrom: () => true }),
  };
}

const z = 0;
const fishing = { getName: () => "Fishing" };

// Deterministic randomness: every chance gate passes, pool picks take index 0.
const realRandom = Math.random;
function stubRandom() {
  Math.random = () => 0;
}
function unstubRandom() {
  Math.random = realRandom;
}

function resetAll() {
  resetNotices();
  resetReactions();
  resetSayPublic();
  fakeRoster.clear();
  unstubRandom();
}

let passed = 0;
function check(name, fn) {
  resetAll();
  stubRandom();
  try {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`FAIL - ${name}: ${error.message}`);
    process.exitCode = 1;
  } finally {
    unstubRandom();
  }
}

// --- Gate --------------------------------------------------------------------
check("real players never enter the citizen celebration path", () => {
  const player = mockBot({ username: "Jon", role: undefined, host: "127.0.0.1", botFlag: false });
  assert.strictEqual(isLevelingCitizen(player), false);
  onCitizenLevelUpNotice({ player, skill: fishing, oldLevel: 69, newLevel: 70 });
  assert.strictEqual(player.forcedChat.length, 0, "a real player must stay silent here");
});

check("bots without a citizen role stay silent", () => {
  const bot = mockBot({ username: "SomeBot", role: null });
  assert.strictEqual(isLevelingCitizen(bot), false);
  onCitizenLevelUpNotice({ player: bot, skill: fishing, oldLevel: 69, newLevel: 70 });
  assert.strictEqual(bot.forcedChat.length, 0);
});

check("a citizen with a role is recognized", () => {
  const bot = mockBot({ username: "Tessa", role: "commoner" });
  assert.strictEqual(isLevelingCitizen(bot), true);
});

check("non-increases and non-integers stay silent", () => {
  const bot = mockBot({ username: "Tessa", role: "commoner" });
  onCitizenLevelUpNotice({ player: bot, skill: fishing, oldLevel: 70, newLevel: 70 });
  onCitizenLevelUpNotice({ player: bot, skill: fishing, oldLevel: 69, newLevel: 70.5 });
  onCitizenLevelUpNotice({ player: bot, skill: fishing, oldLevel: 70, newLevel: 69 });
  assert.strictEqual(bot.forcedChat.length, 0);
});

// --- Announcement --------------------------------------------------------------
check("the leveling citizen announces their level out loud", () => {
  const bot = mockBot({ username: "Tessa Fisher", role: "commoner" });
  onCitizenLevelUpNotice({ player: bot, skill: fishing, oldLevel: 69, newLevel: 70 });
  assert.strictEqual(bot.forcedChat.length, 1);
  const line = bot.forcedChat[0];
  assert.ok(/70/.test(line), `level in line: ${line}`);
  assert.ok(/fishing/i.test(line), `skill in line: ${line}`);
});

check("every announce line trips the gz reflex pattern", () => {
  for (const pool of [CITIZEN_ANNOUNCE_LINES, CITIZEN_MILESTONE_LINES]) {
    for (const register of ["plain", "terse"]) {
      const lines = pool[register];
      assert.ok(Array.isArray(lines) && lines.length >= 2, `${register} pool too small`);
      for (const raw of lines) {
        assert.ok(/\{level\}/.test(raw) && /\{skill\}/.test(raw), `missing slots: ${raw}`);
        const filled = fillLine(raw, { name: "", skill: "fishing", level: 70 });
        assert.strictEqual(
          matchPattern(filled),
          "levelup",
          `announce line must read as a level-up to hearers: ${filled}`
        );
      }
    }
  }
});

check("terse citizens announce without exclaiming", () => {
  const bot = mockBot({
    username: "Gruff Guard",
    role: "guard",
    personality: { traits: ["gruff"], speechStyle: "short clipped sentences" },
  });
  onCitizenLevelUpNotice({ player: bot, skill: fishing, oldLevel: 69, newLevel: 70 });
  assert.strictEqual(bot.forcedChat.length, 1);
  assert.ok(!bot.forcedChat[0].includes("!"), `terse line must not exclaim: ${bot.forcedChat[0]}`);
});

// --- gz reactions -----------------------------------------------------------------
check("nearby citizens answer with gz (and the leveler doesn't gz itself)", () => {
  const hearer = mockBot({
    username: "Bram",
    role: "commoner",
    personality: { traits: ["chatty"] },
    x: 3005,
    y: 3005,
  });
  fakeRoster.set("bram", { username: "Bram", personality: { traits: ["chatty"] } });
  const leveler = mockBot({
    username: "Tessa Fisher",
    role: "commoner",
    locals: [hearer],
  });
  hearer.getLocalPlayers = () => [leveler];

  onCitizenLevelUpNotice({ player: leveler, skill: fishing, oldLevel: 69, newLevel: 70 });

  assert.strictEqual(leveler.forcedChat.length, 1, "leveler says exactly one line (the announce)");
  assert.strictEqual(hearer.forcedChat.length, 1, "one nearby citizen answers");
  assert.ok(
    /^(gz|grats|nice)/i.test(hearer.forcedChat[0]),
    `hearer says gz, got: ${hearer.forcedChat[0]}`
  );
});

check("at most two nearby citizens answer", () => {
  const hearers = [];
  for (let i = 0; i < 5; i += 1) {
    const h = mockBot({
      username: `Hearer${i}`,
      role: "commoner",
      personality: { traits: ["chatty"] },
      x: 3001 + i,
      y: 3001,
    });
    fakeRoster.set(`hearer${i}`, { username: `Hearer${i}`, personality: { traits: ["chatty"] } });
    hearers.push(h);
  }
  const leveler = mockBot({ username: "Tessa Fisher", role: "commoner", locals: hearers });
  onCitizenLevelUpNotice({ player: leveler, skill: fishing, oldLevel: 69, newLevel: 70 });
  const answered = hearers.filter((h) => h.forcedChat.length > 0).length;
  assert.ok(answered <= 2, `at most 2 gz answers, got ${answered}`);
  assert.ok(answered >= 1, "at least one citizen answers");
});

check("citizens too far away don't hear it", () => {
  const far = mockBot({
    username: "Far Bram",
    role: "commoner",
    personality: { traits: ["chatty"] },
    x: 3100,
    y: 3100,
  });
  fakeRoster.set("far bram", { username: "Far Bram", personality: { traits: ["chatty"] } });
  const leveler = mockBot({ username: "Tessa Fisher", role: "commoner", locals: [far] });
  onCitizenLevelUpNotice({ player: leveler, skill: fishing, oldLevel: 69, newLevel: 70 });
  assert.strictEqual(leveler.forcedChat.length, 1, "leveler still announces");
  assert.strictEqual(far.forcedChat.length, 0, "far citizen hears nothing");
});

// --- Cooldowns ----------------------------------------------------------------------
check("announce cooldown: a second quick level stays quiet, milestones always land", () => {
  const bot = mockBot({ username: "Tessa Fisher", role: "commoner" });
  const t0 = Date.now();
  onCitizenLevelUpNotice({ player: bot, skill: fishing, oldLevel: 69, newLevel: 70 }, t0);
  assert.strictEqual(bot.forcedChat.length, 1);
  onCitizenLevelUpNotice({ player: bot, skill: fishing, oldLevel: 70, newLevel: 71 }, t0 + 1000);
  assert.strictEqual(bot.forcedChat.length, 1, "cooldown suppresses the second announce");
  onCitizenLevelUpNotice({ player: bot, skill: fishing, oldLevel: 71, newLevel: 72 }, t0 + 16 * 60 * 1000);
  assert.strictEqual(bot.forcedChat.length, 2, "announce fires again after cooldown");
});

check("milestones bypass the announce cooldown", () => {
  assert.ok(isMilestone(50) && isMilestone(99) && !isMilestone(71));
  const bot = mockBot({ username: "Tessa Fisher", role: "commoner" });
  const t0 = Date.now();
  onCitizenLevelUpNotice({ player: bot, skill: fishing, oldLevel: 48, newLevel: 49 }, t0);
  assert.strictEqual(bot.forcedChat.length, 1);
  onCitizenLevelUpNotice({ player: bot, skill: fishing, oldLevel: 49, newLevel: 50 }, t0 + 1000);
  assert.strictEqual(bot.forcedChat.length, 2, "milestone 50 announces despite cooldown");
});

console.log(`\n${passed} checks passed`);
