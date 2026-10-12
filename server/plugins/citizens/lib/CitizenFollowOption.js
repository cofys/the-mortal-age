"use strict";

/**
 * CitizenFollowOption — "Follow me" right-click option on citizen bots.
 *
 * The engine's slot-3 Follow makes the *player* follow the *target*. When the
 * target is a citizen bot, Jon wants the reverse: the citizen follows him.
 * This module syncs a custom player option on slot 8 and routes clicks to
 * requestFollow, with visible feedback on every outcome — nothing may fail
 * silently.
 */

const FOLLOW_OPTION_SLOT = 8;
const FOLLOW_OPTION_TEXT = "Follow me";

// Citizens keep following for up to 10 minutes without a refresh, then the
// follow lapses (the tick layer already handles expiry).
const sentOptionPlayers = new WeakSet();

const {
  requestFollow,
  requestStopFollow,
} = require("./CitizenSocialMechanics");
const { getFollow } = require("./CitizenBonds");
const { sayPublic } = require("../chat/CitizenSayPublic");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");

/** Voice pools keyed by citizenVoice registers (terse/plain/warm/colorful). */
const ACCEPT_LINES = {
  plain: ["Sure, I'll follow you.", "Alright, I'm with you."],
  warm: ["Happy to! Lead the way!", "Of course, let's go together!"],
  terse: ["Fine.", "Let's go."],
  colorful: ["Aye, I'll walk with ye!", "Lead on, friend!"],
};
const ALREADY_LINES = {
  plain: ["I'm already following you!", "I'm right here!"],
  warm: ["Already on it!", "I'm with you already!"],
  terse: ["Here.", "Already."],
};
const STOP_LINES = {
  plain: ["Alright, I'll stop following you.", "Okay, I'll head off then."],
  warm: ["See you around!", "Alright, take care!"],
  terse: ["Fine.", "Gone."],
  colorful: ["Aye, off I go then!", "Fair winds to ye!"],
};
const ENEMY_LINES = {
  plain: ["Not a chance. Stay away from me.", "I won't follow you. Leave me be."],
  warm: ["I'm sorry, but no.", "I can't do that."],
  terse: ["No.", "Piss off."],
  colorful: ["Not in a hundred years!", "Ye must be joking."],
};
const REFUSED_LINES = {
  plain: ["I don't know you well enough to follow you.", "Sorry, I don't follow strangers."],
  warm: ["I'd love to, but we only just met!", "Maybe once I know you better?"],
  terse: ["Don't know you.", "Strangers, no."],
  colorful: ["Whoa there — I don't even know yer name!", "Slow down, stranger!"],
};

/**
 * Syncs the "Follow me" option once per real player.
 * Follows the MerchantShops/CitizenPartyPlay pattern.
 */
function syncFollowOption(player) {
  try {
    if (!player || player.isPlayerBot?.() || sentOptionPlayers.has(player)) return;
    player.getPacketSender()?.sendPlayerOption?.(FOLLOW_OPTION_SLOT, FOLLOW_OPTION_TEXT, false);
    sentOptionPlayers.add(player);
  } catch {
    // Bot-safe: a broken UI sync must never break the tick.
  }
}

function voiceOf(bot) {
  try {
    return voiceFor(bot?.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {});
  } catch {
    return voiceFor({});
  }
}

/**
 * Handles the slot-8 "Follow me" click. Target must be a citizen bot.
 * Toggles: clicking again while the citizen follows you stops it.
 */
function onFollowPlayerOption(event, ctx = {}) {
  const { player, target } = event;
  try {
    if (!event || event.option !== FOLLOW_OPTION_SLOT) return false;
    if (!target || target.isPlayerBot?.() !== true) return false;
    if (event.handled) return true;
    event.handled = true;

    const bot = ctx.getBot ? ctx.getBot(target) : target;
    const speaker = bot ?? target;
    const citizenName = bot?.getUsername?.() ?? target?.getUsername?.();
    const playerName = player?.getUsername?.();
    if (!citizenName || !playerName) return true;
    const voice = voiceOf(bot);

    // Toggle: already following this player → stop.
    const existing = getFollow(citizenName);
    if (existing && existing.target?.toLowerCase?.() === playerName.toLowerCase()) {
      requestStopFollow(citizenName, playerName);
      sayPublic(speaker, voiceLine(voice, STOP_LINES));
      return true;
    }

    const result = requestFollow(citizenName, playerName);
    if (result.reason === "enemy") {
      sayPublic(speaker, voiceLine(voice, ENEMY_LINES));
    } else if (result.reason === "refused") {
      sayPublic(speaker, voiceLine(voice, REFUSED_LINES));
    } else if (result.reason === "already") {
      sayPublic(speaker, voiceLine(voice, ALREADY_LINES));
    } else {
      // friend | party | willing — all accepted.
      sayPublic(speaker, voiceLine(voice, ACCEPT_LINES));
    }
    return true;
  } catch {
    return true;
  }
}

/**
 * Plugin wiring — called from Citizens.plugin.js register.
 * Mirrors initPartyPlay in CitizenPartyPlay.js.
 */
function initFollowOption(api, ctx = {}) {
  if (!api || typeof api.onPlayerProcess !== "function") return;
  api.onPlayerProcess(({ player }) => syncFollowOption(player));
  if (typeof api.onPlayerOption === "function") {
    api.onPlayerOption((event) => onFollowPlayerOption(event, ctx));
  }
}

module.exports = {
  initFollowOption,
  onFollowPlayerOption,
  syncFollowOption,
  FOLLOW_OPTION_SLOT,
  FOLLOW_OPTION_TEXT,
  _resetStateForTests() {
    // WeakSet cannot be cleared; tests inject fresh mocks instead.
  },
};
