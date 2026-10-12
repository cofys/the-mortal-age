"use strict";

/**
 * CitizenWarContributions — wartime surplus flows to the war machine.
 *
 * Jon's directive: citizens should end up with more war supplies — what
 * they gather must GO somewhere real. While their kingdom is at war,
 * citizens' banked surplus of quartermaster-eligible goods (provisions,
 * timber for arrows/engines) is delivered through the SAME real path a
 * player uses:
 *
 *   withdraw surplus from the bank -> OfficeTools.deliverSupplies ->
 *   war demand takes it first (WarSupply.addStock, capped at quota) ->
 *   the kingdom treasury pays the posted price per unit, real coins.
 *
 * No minting (the treasury pays only what it holds — deliverSupplies
 * refuses when the coffers are empty), no vanishing (verified bank
 * withdrawal; a refused delivery stays in the pack and the next bank
 * hinge re-banks it). Each credited stock unit is origin-tagged with the
 * contributing kingdom, so an inter-kingdom export flow can later read
 * exactly who supplied what.
 *
 * Wiring: CitizenDirector.tick() calls tickWarContributions(this, hour)
 * before the surplus-sales block (wartime priority). Data tier, zero LLM,
 * zero hash-fiction.
 */

const Manifest = require("./SurplusManifest");
const { kingdomIdOf } = require("../brain/CitizenSites");
const { isKingdomAtWar } = require("../CitizenEvents");
const { agentRng } = require("../lib/humanizer");

// A war delivery is a supply run, not a liquidation; the tick stops after
// this many contributors so wartime doesn't drain every bank at once.
const MAX_UNITS_PER_DELIVERY = 24;
const MAX_DELIVERIES_PER_TICK = 6;
const CONTRIBUTE_CHANCE = 0.1;

function citizenNameOf(bot, record) {
  try {
    return bot?.getUsername?.() ?? record?.username ?? "a citizen";
  } catch {
    return record?.username ?? "a citizen";
  }
}

function contributorIsFree(bot) {
  try {
    if (bot?.getCombat?.()?.isInCombat?.()) return false;
  } catch {
    // Combat state unreadable — assume free.
  }
  return true;
}

function officeTools() {
  try {
    return require("../../kingdoms/OfficeTools.Kingdoms");
  } catch {
    return null;
  }
}

function warSupply() {
  try {
    return require("../../kingdoms/WarSupply.Kingdoms");
  } catch {
    return null;
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
 * One citizen's war delivery: withdraw banked surplus of one war-supply
 * good and run it through the quartermaster. Returns the coins paid (0
 * when nothing moved).
 */
function attemptContribution(bot, record, kingdomId, rng) {
  const tools = officeTools();
  const supply = warSupply();
  if (!tools?.deliverSupplies) return 0;
  const itemIds = Object.keys(Manifest.GATHERED_GOODS)
    .map(Number)
    .sort(() => rng() - 0.5);
  for (const itemId of itemIds) {
    const info = Manifest.gatheredInfo(itemId);
    const spec = Manifest.warSupplySpec(itemId);
    if (!spec) continue; // the quartermaster doesn't buy this
    const banked = Manifest.bankTotal(bot, itemId);
    const surplus = Manifest.surplusOf(banked, itemId);
    if (surplus <= 0) continue;
    // Only haul what the war effort still wants — routeDelivery names the
    // neediest war and its remaining quota, so a full stockpile never
    // triggers a pointless bank run.
    let qty = Math.min(surplus, MAX_UNITS_PER_DELIVERY);
    try {
      const route = supply?.routeDelivery?.(kingdomId, spec.cat);
      if (!route || !(route.remaining > 0)) continue;
      qty = Math.min(qty, Math.floor(route.remaining / spec.units));
    } catch {
      // Demand state unreadable — deliverSupplies still caps safely.
    }
    if (qty <= 0) continue;
    const withdrawn = Manifest.withdrawFromBank(bot, itemId, qty);
    if (withdrawn <= 0) continue;
    const coinsBefore = coinsOf(bot);
    let result = null;
    try {
      // Origin-tagged for the future export design; intra-kingdom today.
      result = tools.deliverSupplies(bot, kingdomId, itemId, withdrawn, kingdomId);
    } catch {
      result = null;
    }
    if (result?.ok) {
      const paid = Math.max(0, coinsOf(bot) - coinsBefore);
      const sellerName = citizenNameOf(bot, record);
      Manifest.recordMovement({
        kind: "war-delivery",
        itemId,
        qty: withdrawn,
        originKingdom: kingdomId,
        seller: sellerName,
        buyer: `quartermaster:${kingdomId}`,
        coins: paid,
        units: withdrawn * spec.units,
      });
      Manifest.journalTrade(
        bot,
        `Hauled ${withdrawn} ${info.name.toLowerCase()} to the quartermaster for the war effort (+${paid}c).`
      );
      return paid;
    }
    // Refused (coffers empty, demand filled between check and delivery):
    // goods sit in the pack; the next bank hinge re-banks them. Real
    // items, no loss.
    return 0;
  }
  return 0;
}

/**
 * Director tick entry. Only runs for citizens whose kingdom is at war;
 * each eligible contributor gets a small chance to make one delivery.
 */
function tickWarContributions(director, hour) {
  if (!director?.roster) return 0;
  if (!officeTools()?.deliverSupplies) return 0;
  let delivered = 0;
  for (const record of director.roster.values()) {
    if (delivered >= MAX_DELIVERIES_PER_TICK) break;
    let bot = null;
    try {
      if (!director.isOnline(record)) continue;
      bot = director.getBot(record);
      if (!bot) continue;
    } catch {
      continue;
    }
    if (!contributorIsFree(bot)) continue;
    let kingdomId = null;
    try {
      kingdomId = kingdomIdOf(bot);
    } catch {
      continue;
    }
    let atWar = false;
    try {
      atWar = isKingdomAtWar(kingdomId);
    } catch {
      atWar = false;
    }
    if (!atWar) continue;
    const rng = agentRng(`warcontrib:${record.username}:${Date.now() >> 18}`);
    if (rng() >= CONTRIBUTE_CHANCE) continue;
    try {
      const paid = attemptContribution(bot, record, kingdomId, rng);
      if (paid > 0) delivered++;
    } catch {
      // One bad delivery never blocks the rest.
    }
  }
  return delivered;
}

module.exports = {
  tickWarContributions,
  // Exported for tests / review.
  attemptContribution,
  MAX_UNITS_PER_DELIVERY,
  MAX_DELIVERIES_PER_TICK,
};
