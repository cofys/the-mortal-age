"use strict";
/**
 * Tick simulation for citizen chatter systems.
 * Mocks the director, bots, sessions, and sayPublic capture.
 */
const path = require("path");
const REPO = path.join(__dirname, "..");

// --- capture speech -------------------------------------------------------
const spoken = []; // {from, text, via}
function mockSayPublic(bot, text) {
  spoken.push({ from: bot.getUsername(), text });
  return true;
}

// Inject our mock into the module registry BEFORE requiring the chatter modules.
const sayPublicPath = require.resolve("../plugins/citizens/chat/CitizenSayPublic.js");
require(sayPublicPath); // load real module first
require.cache[sayPublicPath].exports.sayPublic = mockSayPublic;
require.cache[sayPublicPath].exports.resetForTests = () => {};

// --- mock bot -------------------------------------------------------------
function mockBot(username, personality, localPlayers = [], skillLevels = {}) {
  return {
    _username: username,
    _personality: personality,
    _locals: localPlayers,
    _skills: skillLevels,
    getUsername() { return this._username; },
    getAttribute(key) {
      if (key === "citizens:personality") return this._personality;
      return undefined;
    },
    getLocalPlayers() { return this._locals; },
    isPlayerBot() { return true; },
    getHostAddress() { return "bot"; },
    getSkillManager() {
      const skills = this._skills;
      return {
        getCurrentLevel(skillId) { return skills[skillId]?.level ?? 1; },
        getExperience(skillId) { return skills[skillId]?.xp ?? 0; },
      };
    },
    getIndex() { return 1; },
    forceChat() {},
  };
}

function mockRealPlayer(username) {
  return {
    _username: username,
    getUsername() { return this._username; },
    isPlayerBot() { return false; },
    getHostAddress() { return "127.0.0.1"; },
    getIndex() { return 2; },
    getPacketSender() { return { sendPublicChat() {} }; },
    getRelations() { return { canReceivePublicChatFrom() { return true; } }; },
  };
}

// --- mock director ----------------------------------------------------------
function mockDirector(bots, sessions, Skill) {
  const roster = new Map();
  for (const bot of bots) {
    roster.set(String(bot.getUsername()).trim().toLowerCase(), {
      username: bot.getUsername(),
      personality: bot._personality,
    });
  }
  return {
    roster,
    api: { core: { Skill } },
    isOnline() { return true; },
    getBot(record) {
      return bots.find((b) => b.getUsername() === record.username) ?? null;
    },
    _sessions: sessions,
  };
}

const Skill = { FISHING: 0, WOODCUTTING: 1, MINING: 2, COOKING: 3 };

module.exports = {
  REPO,
  spoken,
  mockSayPublic,
  mockBot,
  mockRealPlayer,
  mockDirector,
  Skill,
  clearSpoken() { spoken.length = 0; },
};
