"use strict";

/**
 * CitizenSurplusSales — banked gathered goods find buyers (peacetime flow).
 *
 * Phases 1-3 put real fish, logs, ore, herbs and produce into citizen
 * banks. The bank hinge banks whatever the pack can't sell; this tick
 * moves the SURPLUS (banked above the personal reserve — SurplusManifest)
 * back into the world:
 *
 *   seller withdraws surplus from their bank -> a nearby citizen with
 *   coins buys at the Prices.Economy reference price -> verified
 *   coin-for-goods transfer (the sellItems vanishing-coins contract).
 *
 * Buyers are needs-shaped: anyone buys food (everyone eats); timber, ore
 * and herbs go to merchant citizens who work the materials. No buyer with
 * coins, no sale — coins are never minted, goods never vanish.
 *
 * Wartime war-supply goods skip this flow (CitizenWarContributions routes
 * them to the quartermaster); everything else trades as usual.
 *
 * Wiring: CitizenDirector.tick() calls tickSurplusSales(this, hour) after
 * the shoppers block. Data tier, zero LLM, zero hash-fiction.
 */

const Manifest = require("./SurplusManifest");
const { localCitizens } = require("../brain/findCitizen");
const { kingdomIdOf } = require("../brain/CitizenSites");
const { isKingdomAtWar } = require("../CitizenEvents");
const {
  ATTR_CITIZEN_ROLE,
  ATTR_SUPPLIER_MERCHANT,
  ROLE_MERCHANT,
} = require("../constants");
const { humanizerProfile, agentRng } = require("../lib/humanizer");

// One citizen sells at most this many units per tick (a market trip, not a
// bank liquidation); the tick stops after this many sellers so a big
// roster can't stampede the local economy in one pass.
const MAX_UNITS_PER_SALE = 24;
const MAX_SELLERS_PER_TICK = 8;
const SALE_CHANCE = 0.06;

function citizenNameOf(bot, record) {
  try {
    return bot?.getUsername?.() ?? record?.username ?? "a citizen";
  } catch {
    return record?.username ?? "a citizen";
  }
}

function roleOf(bot, record) {
  try {
    return bot?.getAttribute?.(ATTR_CITIZEN_ROLE) ?? record?.role ?? null;
  } catch {
    return record?.role ?? null;
  }
}

/** Timber/ore/herbs need a working buyer; food sells to anyone with coins. */
function buyerWants(local, cat) {
  if (cat === "food") return true;
  try {
    if (local?.getAttribute?.(ATTR_SUPPLIER_MERCHANT)) return true;
    return local?.getAttribute?.(ATTR_CITIZEN_ROLE) === ROLE_MERCHANT;
  } catch {
    return false;
  }
}

function sellerIsFree(bot) {
  try {
    if (bot?.getCombat?.()?.isInCombat?.()) return false;
  } catch {
    // Combat state unreadable — assume free.
  }
  return true;
}

function sameKingdom(local, kingdomId) {
  try {
    return kingdomIdOf(local) === kingdomId;
  } catch {
    return false;
  }
}

function coinsOf(bot) {
  try {
    return bot?.getInventory?.()?.getAmount?.(Manifest.COINS_ID) ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Find the best local buyer: same kingdom, wants this category, has coins.
 * Supplier merchants first (they wholesale materials), then anyone.
 */
function findBuyer(seller, cat, kingdomId, unitPrice) {
  const locals = [];
  try {
    for (const local of localCitizens(seller)) {
      if (!sameKingdom(local, kingdomId)) continue;
      if (!buyerWants(local, cat)) continue;
      if (coinsOf(local) < unitPrice) continue;
      locals.push(local);
    }
  } catch {
    return null;
  }
  if (!locals.length) return null;
  let supplier = null;
  for (const local of locals) {
    try {
      if (local?.getAttribute?.(ATTR_SUPPLIER_MERCHANT)) {
        supplier = local;
        break;
      }
    } catch {
      // Keep scanning.
    }
  }
  return supplier ?? locals[0];
}

function sellItemsFn() {
  try {
    return require("../brain/actions/CitizenRoutine")._sellItems;
  } catch {
    return null;
  }
}

/**
 * Attempt one peer sale for this citizen: withdraw banked surplus of one
 * gathered good, sell what a local buyer can cover. Returns the coins
 * earned (0 when nothing moved).
 */
function attemptSale(bot, record, kingdomId, rng) {
  const atWar = (() => {
    try {
      return isKingdomAtWar(kingdomId);
    } catch {
      return false;
    }
  })();
  const itemIds = Object.keys(Manifest.GATHERED_GOODS)
    .map(Number)
    .sort(() => rng() - 0.5);
  for (const itemId of itemIds) {
    const info = Manifest.gatheredInfo(itemId);
    // Wartime war-supply goods belong to the quartermaster flow.
    if (atWar && Manifest.isWarSupplyItem(itemId)) continue;
    const banked = Manifest.bankTotal(bot, itemId);
    const surplus = Manifest.surplusOf(banked, itemId);
    if (surplus <= 0) continue;
    const unitPrice = Manifest.referencePrice(itemId);
    const buyer = findBuyer(bot, info.cat, kingdomId, unitPrice);
    if (!buyer) continue;
    const afford = Math.floor(coinsOf(buyer) / unitPrice);
    const qty = Math.min(surplus, MAX_UNITS_PER_SALE, afford);
    if (qty <= 0) continue;
    const withdrawn = Manifest.withdrawFromBank(bot, itemId, qty);
    if (withdrawn <= 0) continue;
    const sellerInv = bot.getInventory?.();
    const buyerInv = buyer.getInventory?.();
    const trade = sellItemsFn();
    if (!sellerInv || !buyerInv || !trade) continue;
    const paid = trade(sellerInv, buyerInv, itemId, withdrawn, unitPrice);
    if (paid > 0) {
      const sellerName = citizenNameOf(bot, record);
      const buyerName = citizenNameOf(buyer, null);
      Manifest.recordMovement({
        kind: "peer-sale",
        itemId,
        qty: withdrawn,
        originKingdom: kingdomId,
        seller: sellerName,
        buyer: buyerName,
        coins: paid,
      });
      Manifest.journalTrade(
        bot,
        `Sold ${withdrawn} ${info.name.toLowerCase()} to ${buyerName} for ${paid} coins (${unitPrice} each).`
      );
      return paid;
    }
    // The trade failed — goods sit in the pack; the next bank hinge
    // re-banks them. Nothing lost, nothing fabricated.
    return 0;
  }
  return 0;
}

/**
 * Director tick entry. Each eligible citizen gets a small chance to move
 * one banked surplus good to a local buyer; the tick caps total sellers.
 */
function tickSurplusSales(director, hour) {
  if (!director?.roster) return 0;
  const trade = sellItemsFn();
  if (!trade) return 0; // brain not loaded — the flow stays parked
  let sellers = 0;
  for (const record of director.roster.values()) {
    if (sellers >= MAX_SELLERS_PER_TICK) break;
    let bot = null;
    try {
      if (!director.isOnline(record)) continue;
      bot = director.getBot(record);
      if (!bot) continue;
    } catch {
      continue;
    }
    if (!sellerIsFree(bot)) continue;
    let kingdomId = null;
    try {
      kingdomId = kingdomIdOf(bot);
    } catch {
      continue;
    }
    const rng = agentRng(`surplus:${record.username}:${Date.now() >> 18}`);
    if (rng() >= SALE_CHANCE) continue;
    try {
      const earned = attemptSale(bot, record, kingdomId, rng);
      if (earned > 0) sellers++;
    } catch {
      // One bad sale never blocks the rest.
    }
  }
  return sellers;
}

module.exports = {
  tickSurplusSales,
  // Exported for tests / review.
  attemptSale,
  findBuyer,
  MAX_UNITS_PER_SALE,
  MAX_SELLERS_PER_TICK,
};
