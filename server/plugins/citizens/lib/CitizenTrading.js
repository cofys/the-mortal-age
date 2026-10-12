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
 *   - OFFERS its own goods when it has something to sell (v2): merchants
 *     offer their ware at the listed ware price; gatherers / broke citizens /
 *     citizens holding product batches offer surplus from their real
 *     inventory at the living-economy reference price with a
 *     personality-driven markup — and say the asking price out loud,
 *   - haggles: on accept-back it values what Jon offered (coins at face,
 *     items at reference price) and refuses to accept back below 80% of
 *     the ask, saying so instead of silently giving goods away,
 *   - accepts back on the second screen so fair trades complete,
 *   - journals sales and gifts, and thanks the trading partner.
 *
 * Utility-driven, never scripted: every decision reads real state —
 * inventory contents, coin wealth, the ware attributes, work-kind,
 * personality traits, friendship bonds, and live reference prices.
 * Zero LLM. Pure engine calls + citizen speech. Bot-safe throughout.
 */

const { isEnemy, isFriend } = require("./CitizenBonds");
const { getJournal } = require("./CitizenJournal");
const { recordInteraction } = require("./CitizenSocialBonds");
const { sayPublic } = require("../chat/CitizenSayPublic");
const { voiceFor, voiceLine } = require("./citizenVoice");
const { getReferencePrice } = require("../../economy/Prices.Economy");
const {
  ATTR_CITIZEN_PERSONALITY,
  ATTR_CITIZEN_WORK_KIND,
  ATTR_WARE_ITEM,
  ATTR_WARE_PRICE,
} = require("../constants");

const COINS_ID = 995; // ItemIds.COINS, verified in ItemIdentifiers.ts
const BREAD_ID = 2309; // the HP staple — never sold from a personal stash
const NEVER_SELL_IDS = new Set([COINS_ID, BREAD_ID]);

// --- offer sizing ---------------------------------------------------------
const MERCHANT_RESERVE = 4; // merchants keep a small stall reserve
const SURPLUS_KEEP = 10; // everyone else keeps this much of a stackable
const SURPLUS_MIN_STACK = 20; // stackables only sell above this held amount
const BATCH_MIN_UNSTACKABLE = 4; // 4+ identical unstackables = product batch
const MAX_OFFER_STACK = 100; // per-trade sanity caps
const MAX_OFFER_UNSTACKABLE = 10;
const MAX_OFFER_LINES = 2; // at most two wares per trade, like a real player

// --- pricing ----------------------------------------------------------------
const BROKE_COINS = 500; // below this a citizen feels money pressure
const MARKUP_DEFAULT = 1.2; // everyone marks up over reference a little
const MARKUP_GREEDY = 1.5;
const MARKUP_SUSPICIOUS = 1.4;
const BROKE_DISCOUNT = 0.85; // broke sellers undercut to move stock
const FRIEND_DISCOUNT = 0.9; // friends get a better price, like real players
const HAGGLE_TOLERANCE = 0.8; // accept-back at 80%+ of the ask
const HAGGLE_SPEECH_COOLDOWN_MS = 10000;

const GATHER_WORK_KINDS = new Set(["rock", "tree", "fishing"]);

// --- speech -----------------------------------------------------------------
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
const TRADE_OFFER_LINES = {
  plain: ["Selling {desc} — {price} coins for the lot."],
  warm: ["Selling {desc} — just {price} coins for the lot!"],
  terse: ["{desc} — {price}."],
  colorful: ["Fine {desc}, yours for {price} coins!"],
};
const TRADE_OFFER_FRIEND_LINES = {
  plain: ["For you: {desc} — {price} coins."],
  warm: ["For you, friend: {desc} — just {price} coins!"],
  terse: ["{desc} — {price}, for you."],
  colorful: ["For you: fine {desc}, {price} coins!"],
};
const TRADE_HAGGLE_LINES = {
  plain: ["Bit light — {price} for the lot.", "Throw in {short} more and it's yours."],
  warm: ["Almost! {price} for the lot, yeah?", "A touch more — {price} does it."],
  terse: ["Not enough. {price}.", "{price}."],
  colorful: ["Ye're short, friend — {price} for the lot!"],
};
const TRADE_HAGGLE_EMPTY_LINES = {
  plain: ["You'll need to offer something for these.", "These aren't free, you know."],
  warm: ["Happy to sell, but I do need something for them!"],
  terse: ["Offer something.", "Not free."],
  colorful: ["Nothin' for nothin', friend!"],
};
const TRADE_SOLD_LINES = {
  plain: ["Pleasure doing business.", "Thanks for the trade."],
  warm: ["Lovely doing business with you!", "Thanks a bunch!"],
  terse: ["Done.", "Sold."],
  colorful: ["A fine deal!", "Pleasure!"],
};

// --- lazy engine requires (TS modules resolve under ts-node at runtime) ------
let ItemIdsCache = null;
function itemIds() {
  if (!ItemIdsCache) {
    try {
      ItemIdsCache =
        require("../../../src/main/typescript/elvarg/util/IdEnums").ItemIds ?? {};
    } catch {
      ItemIdsCache = {};
    }
  }
  return ItemIdsCache;
}

let ItemDefinitionCache = null;
function itemNameFor(id) {
  try {
    if (!ItemDefinitionCache) {
      ItemDefinitionCache =
        require("../../../src/main/typescript/elvarg/game/definition/ItemDefinition")
          .ItemDefinition;
    }
    const name = ItemDefinitionCache.forId(id)?.getName?.();
    if (typeof name === "string" && name.length > 0) {
      return name.charAt(0).toLowerCase() + name.slice(1);
    }
  } catch {
    // Cache unavailable (unit tests) — fall back to the id.
  }
  return `item ${id}`;
}

/** Reference price with a floor — the living-economy price, never invented. */
function refPrice(id) {
  try {
    const p = getReferencePrice(id, Date.now());
    if (Number.isFinite(p) && p >= 1) return Math.floor(p);
  } catch {
    // Economy unavailable.
  }
  return 1;
}

/** "BREAD" -> 2309 via the engine's id enum; numeric ids pass through. */
function resolveWareId(raw) {
  if (Number.isInteger(raw)) return raw;
  const key = String(raw ?? "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
  if (!key) return null;
  const id = itemIds()[key];
  return Number.isInteger(id) ? id : null;
}

function voiceOf(bot) {
  try {
    return voiceFor(bot?.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {});
  } catch {
    return voiceFor({});
  }
}

function traitsOf(bot) {
  try {
    return new Set(bot?.getAttribute?.(ATTR_CITIZEN_PERSONALITY)?.traits ?? []);
  } catch {
    return new Set();
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

function isFriendSafe(citizenName, otherName) {
  try {
    return isFriend(citizenName, otherName);
  } catch {
    return false;
  }
}

function fill(template, vars) {
  let out = String(template);
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{${k}}`).join(String(v));
  }
  return out;
}

/** Personality + money pressure -> price markup over the reference price. */
function priceMarkup(traits, broke) {
  let markup = MARKUP_DEFAULT;
  if (traits.has("greedy")) markup = MARKUP_GREEDY;
  else if (traits.has("suspicious")) markup = MARKUP_SUSPICIOUS;
  if (broke) markup *= BROKE_DISCOUNT;
  return markup;
}

/**
 * Decide what (if anything) the citizen offers in this trade.
 * Returns { lines: [{id, amount, unitPrice, name}], askingPrice, friend }
 * or null when the citizen has nothing to sell / no reason to sell.
 *
 * Merchants sell their ware at the listed ware price. Everyone else needs
 * a reason a real player would have: money pressure, a gatherer's shift
 * output, or a crafter's product batch — priced at the living-economy
 * reference price with a personality markup.
 */
function decideOffer(bot, partnerName) {
  try {
    const inventory = bot.getInventory?.();
    if (!inventory) return null;
    const citizenName = displayNameOf(bot, "citizen");
    const traits = traitsOf(bot);
    const coins = inventory.getAmount?.(COINS_ID) ?? 0;
    const broke = coins < BROKE_COINS;
    const friend = isFriendSafe(citizenName, partnerName);

    // --- merchant path: the ware attribute is the source of truth ------------
    const wareId = resolveWareId(bot.getAttribute?.(ATTR_WARE_ITEM));
    if (Number.isInteger(wareId) && wareId > 0) {
      const held = inventory.getAmount?.(wareId) ?? 0;
      const amount = Math.min(held - MERCHANT_RESERVE, MAX_OFFER_STACK);
      if (amount > 0 && sampleTradeable(inventory, wareId)) {
        const attrPrice = Math.floor(Number(bot.getAttribute?.(ATTR_WARE_PRICE)));
        const unitPrice = attrPrice > 0 ? attrPrice : refPrice(wareId);
        const asking = Math.max(
          1,
          Math.floor(amount * unitPrice * (friend ? FRIEND_DISCOUNT : 1))
        );
        return {
          lines: [{ id: wareId, amount, unitPrice, name: itemNameFor(wareId) }],
          askingPrice: asking,
          friend,
        };
      }
      return null; // stall's empty — a merchant offers nothing else
    }

    // --- everyone else: needs a reason to sell -------------------------------
    const workKind = bot.getAttribute?.(ATTR_CITIZEN_WORK_KIND);
    const items = inventory.getItems?.() ?? [];
    let hasProductBatch = false;
    const byId = new Map();
    for (const item of items) {
      if (!item || item.getId() <= 0 || item.getAmount() <= 0) continue;
      const id = item.getId();
      if (NEVER_SELL_IDS.has(id)) continue;
      if (typeof item.isTradeable === "function" && !item.isTradeable()) continue;
      let stackable = false;
      try {
        stackable = !!item.getDefinition?.()?.isStackable?.();
      } catch { /* treat as unstackable */ }
      const entry = byId.get(id) ?? { id, amount: 0, stackable };
      entry.amount += item.getAmount();
      entry.stackable = entry.stackable || stackable;
      byId.set(id, entry);
      if (!stackable && entry.amount >= BATCH_MIN_UNSTACKABLE) hasProductBatch = true;
    }
    const willing = broke || GATHER_WORK_KINDS.has(workKind) || hasProductBatch;
    if (!willing) return null;

    const markup = priceMarkup(traits, broke);
    const lines = [];
    for (const entry of byId.values()) {
      let amount = 0;
      if (entry.stackable) {
        if (entry.amount <= SURPLUS_MIN_STACK) continue;
        amount = Math.min(entry.amount - SURPLUS_KEEP, MAX_OFFER_STACK);
      } else {
        if (entry.amount < BATCH_MIN_UNSTACKABLE) continue;
        amount = Math.min(entry.amount - 1, MAX_OFFER_UNSTACKABLE);
      }
      if (amount <= 0) continue;
      const unitPrice = Math.max(1, Math.round(refPrice(entry.id) * markup));
      lines.push({
        id: entry.id,
        amount,
        unitPrice,
        name: itemNameFor(entry.id),
      });
    }
    if (lines.length === 0) return null;
    lines.sort((a, b) => b.amount * b.unitPrice - a.amount * a.unitPrice);
    const picked = lines.slice(0, MAX_OFFER_LINES);
    const asking = Math.max(
      1,
      Math.floor(
        picked.reduce((sum, l) => sum + l.amount * l.unitPrice, 0) *
          (friend ? FRIEND_DISCOUNT : 1)
      )
    );
    return { lines: picked, askingPrice: asking, friend };
  } catch {
    return null; // offering is best-effort; the trade still works
  }
}

/** First tradeable sample of an item id in the inventory, or null. */
function sampleTradeable(inventory, id) {
  try {
    for (const item of inventory.getItems?.() ?? []) {
      if (item && item.getId() === id && item.getAmount() > 0) {
        if (typeof item.isTradeable === "function" && !item.isTradeable()) return null;
        return item;
      }
    }
  } catch { /* fall through */ }
  return null;
}

/**
 * Move up to `amount` of an item id from the bot's inventory into the trade
 * offer container. Mirrors the engine's Trading.moveItems (slot-verified,
 * tradeable-checked, stack-aware). Returns the verified moved amount.
 */
function moveToOffer(inventory, container, id, amount) {
  try {
    const before = container.getAmount?.(id) ?? 0;
    const liveItems = () => inventory.getItems?.() ?? [];
    const first = liveItems().findIndex(
      (it) => it && it.getId() === id && it.getAmount() > 0
    );
    if (first < 0) return 0;
    const sample = liveItems()[first];
    if (typeof sample.isTradeable === "function" && !sample.isTradeable()) return 0;
    let stackable = false;
    try {
      stackable = !!sample.getDefinition?.()?.isStackable?.();
    } catch { /* treat as unstackable */ }

    if (stackable) {
      if (container.getFreeSlots() <= 0 && !container.containsNumber?.(id)) return 0;
      const qty = Math.min(amount, sample.getAmount());
      if (qty <= 0) return 0;
      inventory.switchItem(container, sample.clone().setAmount(qty), false, first, false);
    } else {
      let moved = 0;
      const order = [
        first,
        ...liveItems().map((_, i) => i).filter((i) => i !== first),
      ];
      for (const index of order) {
        if (moved >= amount || container.getFreeSlots() <= 0) break;
        const it = liveItems()[index];
        if (!it || it.getId() !== id) continue;
        if (typeof it.isTradeable === "function" && !it.isTradeable()) continue;
        inventory.switchItem(container, it.clone(), false, index, false);
        moved++;
      }
    }
    try {
      inventory.refreshItems?.();
    } catch { /* cosmetic */ }
    try {
      container.refreshItems?.();
    } catch { /* cosmetic */ }
    const after = container.getAmount?.(id) ?? 0;
    return Math.max(0, after - before);
  } catch {
    return 0;
  }
}

/** Execute an offer plan: move the goods, return what actually landed. */
function executeOffer(bot, container, offer) {
  const moved = [];
  try {
    const inventory = bot.getInventory?.();
    if (!inventory || !container) return moved;
    if ((container.getValidItems?.() ?? []).length > 0) return moved; // no double-offer
    for (const line of offer.lines) {
      const qty = moveToOffer(inventory, container, line.id, line.amount);
      if (qty > 0) moved.push({ ...line, amount: qty });
    }
  } catch { /* best-effort */ }
  return moved;
}

/** Value a trade container's contents: coins at face, items at reference. */
function containerValue(container) {
  let total = 0;
  try {
    for (const item of container?.getValidItems?.() ?? []) {
      const id = item?.getId?.() ?? 0;
      const amt = item?.getAmount?.() ?? 0;
      if (id <= 0 || amt <= 0) continue;
      total += id === COINS_ID ? amt : refPrice(id) * amt;
    }
  } catch { /* best-effort */ }
  return total;
}

/**
 * Builds the TradingInteraction for one citizen bot.
 * Matches the shape TradeRequestPacketListener.sendRequest expects:
 *   { acceptTradeRequest, addItemsToTrade, acceptTrade, receivedItems }
 */
function createTradingInteraction(bot) {
  const citizenName = displayNameOf(bot, "citizen");
  // Per-trade state: what this citizen offered and for how much. Reset on
  // every new trade request so a declined trade can't leak into the next.
  const trade = { offer: null, haggleSaidAt: 0 };

  return {
    /**
     * The engine calls this when someone requests a trade with the citizen.
     * We complete the handshake by requesting back — requestTrade detects the
     * mutual REQUESTED_TRADE pair and opens both trade screens.
     */
    acceptTradeRequest(requester) {
      trade.offer = null;
      trade.haggleSaidAt = 0;
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
     * The engine calls this once when the trade screen opens. The citizen
     * offers its own goods here — decided from real state, priced from the
     * living economy, announced out loud like a real player would.
     */
    addItemsToTrade(container, interact) {
      try {
        const partnerName = displayNameOf(interact, "someone");
        const offer = decideOffer(bot, partnerName);
        if (!offer) return;
        const moved = executeOffer(bot, container, offer);
        if (moved.length === 0) return;
        // Re-price on what actually moved (a short move = a smaller ask).
        const asking = Math.max(
          1,
          Math.floor(
            moved.reduce((sum, l) => sum + l.amount * l.unitPrice, 0) *
              (offer.friend ? FRIEND_DISCOUNT : 1)
          )
        );
        trade.offer = { lines: moved, askingPrice: asking, friend: offer.friend };
        const desc = moved.map((l) => `${l.name} ×${l.amount}`).join(", ");
        const lines = offer.friend ? TRADE_OFFER_FRIEND_LINES : TRADE_OFFER_LINES;
        sayPublic(bot, fill(voiceLine(voiceOf(bot), lines), { desc, price: asking }));
        journalEvent(
          citizenName,
          `Offered ${desc} to ${partnerName} for ${asking} coins.`,
          "economy"
        );
        recordInteraction(citizenName, partnerName, "traded");
      } catch { /* offering is best-effort; the trade still works */ }
    },

    /**
     * Accept-back gate. The engine calls this when Jon accepts (screen one
     * and the confirm screen). When the citizen offered goods, Jon's side
     * has to cover the ask: at 80%+ we accept back and the trade completes;
     * below that the citizen says so and does NOT accept — the trade stalls
     * until Jon offers more or declines. Gifts (citizen offered nothing)
     * keep the old accept-back behavior.
     */
    acceptTrade() {
      const acceptBack = () => {
        try {
          bot.getTrading().acceptTrade();
        } catch { /* trade may have closed — safe to ignore */ }
      };
      try {
        const offer = trade.offer;
        if (offer && offer.askingPrice > 0) {
          let paid = 0;
          try {
            const partner = bot.getTrading().getInteract();
            paid = containerValue(partner?.getTrading?.()?.getContainer?.());
          } catch {
            // Couldn't read Jon's offer — fail open to the old behavior.
            acceptBack();
            return;
          }
          if (paid >= offer.askingPrice * HAGGLE_TOLERANCE) {
            acceptBack();
            return;
          }
          // Not enough — haggle instead of giving goods away.
          const now = Date.now();
          if (now - trade.haggleSaidAt > HAGGLE_SPEECH_COOLDOWN_MS) {
            trade.haggleSaidAt = now;
            const voice = voiceOf(bot);
            if (paid <= 0) {
              sayPublic(bot, voiceLine(voice, TRADE_HAGGLE_EMPTY_LINES));
            } else {
              const short = Math.max(
                1,
                Math.ceil(offer.askingPrice * HAGGLE_TOLERANCE - paid)
              );
              sayPublic(
                bot,
                fill(voiceLine(voice, TRADE_HAGGLE_LINES), {
                  price: offer.askingPrice,
                  short,
                })
              );
            }
          }
          journalEvent(
            citizenName,
            `Held out for ${offer.askingPrice} coins (offered ${paid}).`,
            "economy"
          );
          return; // do NOT accept back — Jon can offer more or decline
        }
        acceptBack();
      } catch {
        acceptBack(); // fail open: a broken gate must never wedge trades
      }
    },

    /**
     * Called when the trade completes and the citizen receives items.
     * Distinguishes a sale (citizen offered goods — the received items are
     * payment) from a gift (citizen offered nothing).
     */
    receivedItems(items, from) {
      try {
        const offer = trade.offer;
        trade.offer = null;
        const fromName = displayNameOf(from, "someone");
        if (offer && offer.lines.length > 0) {
          const paid = containerValue({ getValidItems: () => items ?? [] });
          const desc = offer.lines.map((l) => `${l.name} ×${l.amount}`).join(", ");
          journalEvent(
            citizenName,
            `Sold ${desc} to ${fromName} for ~${paid} coins.`,
            "economy"
          );
          recordInteraction(citizenName, fromName, "traded");
          sayPublic(bot, voiceLine(voiceOf(bot), TRADE_SOLD_LINES));
          try {
            require("../brain/CitizenNeeds").addMood(
              bot,
              Math.min(6, 1 + Math.floor(paid / 50))
            );
          } catch { /* mood is cosmetic */ }
          return;
        }
        const count = Array.isArray(items) ? items.length : 0;
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
  // Test seams (pure logic, no running server).
  _decideOffer: decideOffer,
  _containerValue: containerValue,
  _moveToOffer: moveToOffer,
  _constants: {
    COINS_ID,
    BREAD_ID,
    MERCHANT_RESERVE,
    SURPLUS_KEEP,
    SURPLUS_MIN_STACK,
    BATCH_MIN_UNSTACKABLE,
    MAX_OFFER_STACK,
    MAX_OFFER_UNSTACKABLE,
    MAX_OFFER_LINES,
    BROKE_COINS,
    HAGGLE_TOLERANCE,
    FRIEND_DISCOUNT,
  },
  _resetStateForTests() {
    ItemIdsCache = null;
    ItemDefinitionCache = null;
  },
};
