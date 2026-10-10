"use strict";

const { PrayerHandler } = require("../../../../src/main/typescript/elvarg/game/content/PrayerHandler");
const { randomInRange } = require("../navigation/BotNavigation");

/**
 * PvP trash talk (issue #441). Lines fire on a per-bot cooldown while the bot is
 * fighting; nothing here changes combat state, it is pure flavour.
 */
const CHATTER_LINES = Object.freeze([
  "gf",
  "sit",
  "ez",
  "nice",
  "lag?",
  "1v1 me",
  "smite me",
  "free loot",
  "you're barred",
  "r u gonna eat that?",
  "thanks for the key",
  "nice spec",
  "did you just splash?",
  "coward",
  "tele noob",
  "my nan hits harder",
  "buying gf 10k",
  "bank loot?",
  "get rekt",
  "you call that a ko?",
  "cash me outside",
]);
const CHAT_COOLDOWN_MIN_MS = 9000;
const CHAT_COOLDOWN_MAX_MS = 24000;

/**
 * Lines that only make sense while the opponent is actually doing that thing. A bot
 * telling a prayerless opponent to "stop praying" was the first of these.
 */
const CONTEXT_CHATTER = Object.freeze([
  { text: "stop praying", when: hasOverheadPrayer },
]);

function hasOverheadPrayer(target) {
  const active = target?.getPrayerActive?.();
  if (!active) return false;
  return PrayerHandler.OVERHEAD_PRAYERS.some((prayerId) => active[prayerId] === true);
}

function selectChatterLine(target) {
  const lines = [...CHATTER_LINES];
  for (const entry of CONTEXT_CHATTER) {
    if (entry.when?.(target) === true) {
      lines.push(entry.text);
    }
  }
  return lines[Math.floor(Math.random() * lines.length)];
}

function maybeChat(player, state, nowMs) {
  const pvp = state?.pvp;
  if (!player || !pvp || player.isPlayerBot?.() !== true) {
    return false;
  }
  if (nowMs < Number(pvp.nextChatAt ?? 0)) {
    return false;
  }
  pvp.nextChatAt = nowMs + randomInRange(CHAT_COOLDOWN_MIN_MS, CHAT_COOLDOWN_MAX_MS);
  if (player.isDyingReturn?.() === true || player.isTeleportingReturn?.() === true) {
    return false;
  }
  const target = player.getCombat?.()?.getTarget?.() ?? null;
  player.forceChat?.(selectChatterLine(target));
  return true;
}

module.exports = {
  CHATTER_LINES,
  CONTEXT_CHATTER,
  maybeChat,
  selectChatterLine,
};
