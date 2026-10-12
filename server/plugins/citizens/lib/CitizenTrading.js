"use strict";

/**
 * CitizenTrading — implements the engine's TradingInteraction contract for
 * citizen bots.
 *
 * The engine's trade flow (Trading.requestTrade / TradeRequestPacketListener)
 * is built for real players AND bots: it calls
 *   player.getTradingInteraction?.().acceptTradeRequest?.(requester)
 * to auto-accept on the receiving side. But getTradingInteraction was NEVER
 * implemented anywhere, so trade requests to citizens fired into the void.
 *
 * This module attaches a real implementation in spawnCitizen. The citizen:
 *   - accepts trade requests from non-enemies (with visible feedback),
 *   - offers nothing of its own in v1 (Jon gives, citizen receives),
 *   - accepts back on the second screen so the trade completes,
 *   - journals received items and thanks the giver.
 *
 * Zero LLM. Pure engine calls + citizen speech. Bot-safe throughout.
 */

const { isEnemy } = require("./CitizenBonds");
const { getJournal } = require("./CitizenJournal");
const { recordInteraction } = require("./CitizenSocialBonds");
const { sayPublic } = require("../chat/CitizenSayPublic");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { ATTR_CITIZEN_PERSONALITY } = require("../constants");

const TRADE_ACCEPT_LINES = {
  plain: ["Sure, let's trade.", "Alright, open trade."],
  warm: ["Happy to trade with you!", "Of course! Let's see what you've got."],
  terse: ["Fine.", "Trade."],
  colorful: ["Aye, let's do business!", "Show me yer wares!"],
};
const TRADE_REFUSE_LINES = {
  plain: ["Sorry, not right now.", "I can't trade at the moment."],
  warm: ["Maybe later, friend!", "Not right now, sorry!"],
  terse: ["No.", "Busy."],
};
const TRADE_ENEMY_LINES = {
  plain: ["I'm not trading with you.", "Trade with you? Never."],
  terse: ["No.", "Piss off."],
};
const TRADE_THANKS_LINES = {
  plain: ["Thanks!", "Appreciate it."],
  warm: ["Thank you so much!", "You're too kind!"],
  terse: ["Thanks.", "Got it."],
  colorful: ["Much obliged!", "A fine gift!"],
};

function voiceOf(bot) {
  try {
    return voiceFor(bot?.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {});
  } catch {
    return voiceFor({});
  }
}

function journalEvent(citizenName, message, category) {
  try {
    getJournal(citizenName)?.addEntry?.({ text: message, category: category ?? "social" });
  } catch { /* journal is best-effort */ }
}

function displayNameOf(bot, fallback) {
  try {
    return bot?.getUsername?.() ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Builds the TradingInteraction for one citizen bot.
 * Matches the shape TradeRequestPacketListener.sendRequest expects:
 *   { acceptTradeRequest, addItemsToTrade, acceptTrade, receivedItems }
 */
function createTradingInteraction(bot) {
  const citizenName = displayNameOf(bot, "citizen");

  return {
    /**
     * The engine calls this when someone requests a trade with the citizen.
     * We complete the handshake by requesting back — requestTrade detects the
     * mutual REQUESTED_TRADE pair and opens both trade screens.
     */
    acceptTradeRequest(requester) {
      try {
        const requesterName = displayNameOf(requester, "someone");
        const voice = voiceOf(bot);

        // Enemies get a hard no with feedback.
        if (isEnemy(citizenName, requesterName)) {
          sayPublic(bot, voiceLine(voice, TRADE_ENEMY_LINES));
          journalEvent(citizenName, `Refused trade with enemy ${requesterName}.`, "social");
          return false;
        }

        // Already in a trade — don't stack.
        try {
          if (bot.getTrading().getState().isTrading?.()) {
            sayPublic(bot, voiceLine(voice, TRADE_REFUSE_LINES));
            return false;
          }
        } catch { /* state read failed — proceed */ }

        sayPublic(bot, voiceLine(voice, TRADE_ACCEPT_LINES));
        journalEvent(citizenName, `Accepted trade with ${requesterName}.`, "social");
        recordInteraction(citizenName, requesterName, "traded");

        // Complete the mutual handshake: Jon requested us, we request back.
        // requestTrade detects both sides REQUESTED_TRADE and opens the screens.
        return bot.getTrading().requestTrade(requester);
      } catch {
        return false;
      }
    },

    /**
     * The engine calls this for the citizen to offer items.
     * v1: citizens offer nothing — Jon gives, the citizen receives.
     * (A future slice can teach citizens to offer goods for sale.)
     */
    addItemsToTrade(/* container, interact */) {
      // Intentionally empty — citizen brings nothing to the table yet.
    },

    /**
     * Second-screen accept. The engine's Trading.acceptTrade checks the
     * OTHER side's state; calling the real method accepts back properly.
     */
    acceptTrade() {
      try {
        bot.getTrading().acceptTrade();
      } catch { /* trade may have closed — safe to ignore */ }
    },

    /**
     * Called when the trade completes and the citizen receives items.
     */
    receivedItems(items, from) {
      try {
        const count = Array.isArray(items) ? items.length : 0;
        const fromName = displayNameOf(from, "someone");
        journalEvent(citizenName, `Received ${count} item stack(s) from ${fromName}.`, "economy");
        recordInteraction(citizenName, fromName, "gifted");
        sayPublic(bot, voiceLine(voiceOf(bot), TRADE_THANKS_LINES));
      } catch { /* feedback is best-effort */ }
    },
  };
}

/**
 * Attaches the trading interaction to a spawned citizen bot.
 * Called from CitizenDirector.spawnCitizen after setPlayerBot(true).
 */
function attachTradingInteraction(bot) {
  try {
    if (!bot || bot.isPlayerBot?.() !== true) return;
    if (typeof bot.getTradingInteraction === "function") return; // already attached
    const interaction = createTradingInteraction(bot);
    bot.getTradingInteraction = () => interaction;
  } catch { /* never break spawning */ }
}

module.exports = {
  attachTradingInteraction,
  createTradingInteraction,
  _resetStateForTests() {},
};
