"use strict";

/**
 * CitizenShoppers — citizens buy from PLAYER-owned market stalls.
 *
 * Player stalls exist (PlayerShops.js / PlayerShopStore.js): players lease
 * a pitch, stock it, set prices. This module closes the economic loop —
 * citizens browse those stalls and buy, driven by needs, role, personality,
 * and the stall's price against the economy reference feed.
 *
 * The dynamics Jon asked for:
 *   - Undercut the market → citizens flock (deal-seeking, loyalty, journaled)
 *   - Overprice → citizens walk past (skipped above the walk-past ratio)
 *   - Good deals are remembered: CitizenMemory warms toward the owner and
 *     the journal records it, so the foreground LLM speaks truthfully
 *     ("I always buy my bread from Jon's stall — fair prices").
 *
 * Data tier, zero LLM. Sales are real inventory ops: coins leave the
 * citizen's purse, the stall till grows minus the 5% crown market tax
 * (kingdom:tax-collected, same as player-to-player sales), stock
 * decrements, the store persists. Hungry citizens who buy bread eat it,
 * via the existing CitizenNeeds.eat().
 *
 * Wiring: CitizenDirector.tick() calls tickShoppers(this, hour) after the
 * daily-routines block, wrapped in try/catch with error logging.
 */

const Store = require("./PlayerShopStore");
const KingdomStore = require("../../kingdoms/KingdomStore");
const { getJournal } = require("../lib/CitizenJournal");
const { getMemory } = require("../lib/CitizenMemory");
const { humanizerProfile, agentRng } = require("../lib/humanizer");
const {
  ensureNeeds,
  needsFor,
  eat,
  HUNGRY_AT,
  BREAD_ID,
  BRONZE_SWORD_ID,
  COINS_ID,
} = require("../brain/CitizenNeeds");
const {
  ATTR_CITIZEN_ROLE,
  ATTR_CITIZEN_PERSONALITY,
  ROLE_GUARD,
  ROLE_COMMONER,
  ROLE_MERCHANT,
  ROLE_COURTIER,
  ROLE_REFUGEE,
} = require("../constants");

// Verified in CitizenActivityParties.js (fishing-trip loot): raw shrimps.
const RAW_SHRIMPS_ID = 317;

// Fallback reference prices when the economy feed has no answer.
// Bread 12 matches CitizenNeeds.BREAD_PRICE; the rest are sane defaults.
const FALLBACK_REF = Object.freeze({
  [BREAD_ID]: 12,
  [BRONZE_SWORD_ID]: 120,
  [RAW_SHRIMPS_ID]: 3,
});

// What each role will consider buying from a player stall.
const ROLE_WANTS = Object.freeze({
  [ROLE_GUARD]: [BREAD_ID, BRONZE_SWORD_ID],
  [ROLE_COMMONER]: [BREAD_ID, RAW_SHRIMPS_ID],
  [ROLE_MERCHANT]: [BREAD_ID],
  [ROLE_COURTIER]: [BREAD_ID],
  [ROLE_REFUGEE]: [BREAD_ID],
  // Unknown roles fall back to bread.
});

// Base per-tick shop chance per eligible citizen (~60s director tick).
const BASE_SHOP_CHANCE = 0.02;
// A stall undercutting the market multiplies the chance to shop there.
const BARGAIN_FLOCK_MULT = 3;
// Price ratio at/above which citizens walk past without a second glance.
const WALK_PAST_RATIO = 1.5;
// Ratio at/below which a price reads as "a deal" — flock, remember, journal.
const DEAL_RATIO = 0.9;
// Citizens keep a coin reserve; the hungry spend deeper.
const RESERVE_FRACTION = 0.5;
const HUNGRY_RESERVE_FRACTION = 0.1;
// Max units per purchase — stalls are for daily needs, not bulk trade.
const MAX_QTY = 3;

function journalEvent(citizenName, text, kind) {
  try {
    getJournal().log(citizenName, kind ?? "trade", text);
  } catch {
    // Non-fatal.
  }
}

function normalizeName(name) {
  return String(name ?? "").toLowerCase();
}

function citizenNameOf(record, bot) {
  try {
    return bot?.getUsername?.() ?? record?.username ?? null;
  } catch {
    return record?.username ?? null;
  }
}

function personalityOf(bot) {
  try {
    return bot?.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
  } catch {
    return {};
  }
}

function roleOf(record, bot) {
  try {
    return (
      bot?.getAttribute?.(ATTR_CITIZEN_ROLE) ?? record?.role ?? ROLE_COMMONER
    );
  } catch {
    return ROLE_COMMONER;
  }
}

function coinCountOf(bot) {
  try {
    return bot?.getInventory?.()?.getAmount?.(COINS_ID) ?? 0;
  } catch {
    return 0;
  }
}

/** Economy reference price, with the fallback table when the feed is silent. */
function referencePrice(itemId) {
  try {
    const Prices = require("../../economy/Prices.Economy");
    const ref = Prices.getReferencePrice?.(Number(itemId));
    if (Number.isFinite(ref) && ref > 0) return ref;
  } catch {
    // Fall through to the fallback table.
  }
  return FALLBACK_REF[Number(itemId)] ?? null;
}

/**
 * Max price ratio this citizen will pay, from personality + circumstance.
 * Greedy citizens won't pay over reference; easygoing ones don't fuss;
 * hunger and loyalty stretch the purse.
 */
function maxPayRatio(bot, record, ownerName, needy) {
  const traits = new Set(personalityOf(bot)?.traits ?? []);
  let ratio = 1.15;
  if (traits.has("greedy")) ratio = 1.0;
  else if (traits.has("easygoing") || traits.has("cheerful")) ratio = 1.3;
  if (needy) ratio += 0.25; // hunger is a powerful negotiator
  const role = roleOf(record, bot);
  if (role === ROLE_COURTIER) ratio += 0.2; // the rich don't haggle over bread
  if (role === ROLE_REFUGEE) ratio -= 0.2; // the poor count every coin
  // Loyalty: citizens who got good deals here before pay a little more.
  try {
    const memory = getMemory();
    const me = citizenNameOf(record, bot);
    const entry = memory.getEntry?.(me, ownerName);
    const warmth = entry?.tone ?? 0;
    if (warmth > 3) ratio += 0.15;
  } catch {
    // No loyalty adjustment.
  }
  return Math.max(0.5, ratio);
}

/** Stalls in this citizen's kingdom with at least one priced ware in stock. */
function stallsForKingdom(kingdomId) {
  let stalls = [];
  try {
    stalls = Store.getAllStalls();
  } catch {
    return [];
  }
  return stalls.filter((stall) => {
    if (!stall || stall.kingdomId !== kingdomId) return false;
    const stock = stall.stock ?? {};
    const prices = stall.prices ?? {};
    return Object.keys(stock).some(
      (id) => (stock[id] ?? 0) > 0 && (prices[id] ?? 0) > 0
    );
  });
}

/** Is this citizen free to browse? Not in a party, not minding a stall. */
function isFreeToShop(director, record) {
  try {
    const { getParty } = require("../lib/CitizenBonds");
    if (getParty(record.username)) return false;
  } catch {
    // No party info — assume free.
  }
  try {
    if (Store.isEmployed(record.username)) return false;
  } catch {
    // Store unavailable — assume free.
  }
  return true;
}

/** The online player entity for a name, or null. */
function onlinePlayer(director, name) {
  try {
    return director?.api?.core?.World?.getPlayerByName?.(name) ?? null;
  } catch {
    return null;
  }
}

/**
 * Execute the sale. Mirrors PlayerShops' buyWare math: stock down, till up
 * minus the 5% crown market tax (granted before the notification event),
 * real coin/item transfer on the citizen's inventory.
 */
function executeSale(director, bot, record, stall, itemId, qty, price) {
  const cost = qty * price;
  if (!(cost > 0) || !(qty > 0)) return false;
  const buyerInv = bot?.getInventory?.();
  if (!buyerInv) return false;
  const coins = coinCountOf(bot);
  if (coins < cost) return false;
  const stock = stall.stock?.[itemId] ?? 0;
  if (stock < qty) return false;

  const tax = Math.floor(cost * Store.MARKET_TAX_RATE);
  stall.stock[itemId] = stock - qty;
  stall.till = (stall.till ?? 0) + (cost - tax);
  try {
    Store.save();
  } catch {
    // The trade stands; persistence retries next mutation.
  }
  try {
    buyerInv.deleteNumber(COINS_ID, cost);
    buyerInv.adds(itemId, qty);
  } catch {
    return false;
  }
  if (tax > 0) {
    try {
      KingdomStore.grantTax(stall.kingdomId, tax);
      director.api?.emitCustomEvent?.("kingdom:tax-collected", {
        kingdomId: stall.kingdomId,
        amount: tax,
        source: "player-stall",
      });
    } catch {
      // The treasury misses a coin; the sale stands.
    }
  }
  return { cost, tax };
}

/** Item display name, best-effort. */
function itemName(director, itemId) {
  try {
    return (
      director?.api?.core?.ItemDefinition?.forId?.(Number(itemId))?.getName?.() ??
      `item ${itemId}`
    );
  } catch {
    return `item ${itemId}`;
  }
}

/**
 * One citizen considers one stall. Returns true when a purchase happened.
 * Decision order: skip absurd prices → need-driven buy → bargain buy.
 */
function considerStall(director, bot, record, stall, rng) {
  const me = citizenNameOf(record, bot);
  if (!me) return false;
  const role = roleOf(record, bot);
  const wants = ROLE_WANTS[role] ?? [BREAD_ID];
  const needs = (() => {
    try {
      ensureNeeds(me);
      return needsFor(me);
    } catch {
      return null;
    }
  })();
  const hungry = (needs?.hunger ?? 100) < HUNGRY_AT;
  const coins = coinCountOf(bot);
  if (coins <= 0) return false;

  const ownerName = stall.owner ?? stall.ownerKey ?? "the stallholder";
  // Find the best acceptable deal among this citizen's wants.
  let best = null;
  for (const itemId of wants) {
    const key = String(itemId);
    const stock = stall.stock?.[key] ?? stall.stock?.[itemId] ?? 0;
    const price = stall.prices?.[key] ?? stall.prices?.[itemId] ?? 0;
    if (!(stock > 0) || !(price > 0)) continue;
    const ref = referencePrice(itemId);
    if (!ref) continue;
    const ratio = price / ref;
    if (ratio >= WALK_PAST_RATIO) continue; // walk past, no second glance
    const needy = hungry && Number(itemId) === BREAD_ID;
    const threshold = maxPayRatio(bot, record, ownerName, needy);
    const isDeal = ratio <= DEAL_RATIO;
    if (ratio <= threshold || isDeal) {
      const score = ratio - (isDeal ? 0.5 : 0) - (needy ? 0.3 : 0);
      if (!best || score < best.score) {
        best = { itemId: Number(itemId), price, ref, ratio, isDeal, needy, score };
      }
    }
  }
  if (!best) return false;

  // Quantity: 1-3, bounded by stock, affordability, and the coin reserve.
  const reserveFrac = best.needy ? HUNGRY_RESERVE_FRACTION : RESERVE_FRACTION;
  const spendable = Math.max(0, coins - Math.floor(coins * reserveFrac));
  const afford = Math.floor(spendable / best.price);
  if (afford <= 0) return false;
  const stockKey =
    stall.stock?.[String(best.itemId)] != null
      ? String(best.itemId)
      : best.itemId;
  const stock = stall.stock?.[stockKey] ?? 0;
  const qty = Math.min(MAX_QTY, stock, afford);
  if (qty <= 0) return false;

  const result = executeSale(director, bot, record, stall, stockKey, qty, best.price);
  if (!result) return false;

  // Remember the deal: meeting + warmth toward the owner, spend recorded.
  // A bargain warms twice as fast — this is the loyalty loop.
  try {
    const memory = getMemory();
    memory.recordMeeting?.(me, ownerName);
    memory.recordTone?.(me, ownerName, best.isDeal ? 2 : 1);
    memory.recordSpend?.(me, ownerName, result.cost);
  } catch {
    // Memory is best-effort.
  }

  const name = itemName(director, best.itemId);
  if (best.isDeal) {
    journalEvent(
      me,
      `Bought ${qty} x ${name} from ${ownerName}'s stall for ${result.cost} coins — a proper bargain.`,
      "trade"
    );
  } else if (best.needy) {
    journalEvent(
      me,
      `Bought ${qty} x ${name} from ${ownerName}'s stall for ${result.cost} coins. Needed it badly.`,
      "trade"
    );
  } else {
    journalEvent(
      me,
      `Bought ${qty} x ${name} from ${ownerName}'s stall for ${result.cost} coins.`,
      "trade"
    );
  }

  // Hungry citizens eat the bread they just bought.
  if (best.needy) {
    try {
      eat(bot);
    } catch {
      // They'll eat it later.
    }
  }

  // Tell the stall owner — a real player gets live feedback on their shop.
  try {
    const owner = onlinePlayer(director, ownerName);
    owner?.sendMessage?.(
      `Your stall sold ${qty} x ${name} for ${result.cost} coins.`
    );
  } catch {
    // Offline owner; the sales feed tells the story later.
  }
  // Record the sale on the stall's feed (visible in the marketplace UI).
  try {
    Store.logSale(stall.ownerKey, {
      id: best.itemId,
      name,
      qty,
      total: result.cost,
      buyer: me,
      at: Date.now(),
    });
  } catch {
    // The sale stands; the feed misses a line.
  }

  // Visible to anyone watching: the citizen reacts, but ONLY when a real
  // player is nearby to hear it (two-tier rule — no unheard LLM).
  try {
    const nearby = bot?.getLocalPlayers?.() ?? [];
    const realNearby = [...nearby].some(
      (p) => p !== bot && p?.isPlayerBot?.() !== true
    );
    if (realNearby && best.isDeal && rng() < 0.5) {
      bot?.forceChat?.("What a bargain!");
    }
  } catch {
    // Cosmetic.
  }

  try {
    console.info("[citizen-shoppers] sale", {
      buyer: me,
      stall: ownerName,
      item: best.itemId,
      qty,
      cost: result.cost,
      tax: result.tax,
      ratio: Number(best.ratio.toFixed(2)),
    });
  } catch {
    // Logging is best-effort.
  }
  return true;
}

/**
 * Director tick entry. Each eligible citizen gets a small chance to browse
 * the player stalls of their kingdom; stalls undercutting the market draw
 * a flock (multiplied chance), overpriced stalls are walked past.
 */
function tickShoppers(director, hour) {
  if (!director?.roster) return;
  let stalls = [];
  try {
    stalls = Store.getAllStalls();
  } catch {
    return;
  }
  if (!stalls.length) return;
  // Group stalls by kingdom once per tick.
  const byKingdom = new Map();
  for (const stall of stallsForKingdomAll(stalls)) {
    const list = byKingdom.get(stall.kingdomId) ?? [];
    list.push(stall);
    byKingdom.set(stall.kingdomId, list);
  }
  if (!byKingdom.size) return;

  for (const record of director.roster.values()) {
    let bot = null;
    try {
      if (!director.isOnline(record)) continue;
      bot = director.getBot(record);
      if (!bot) continue;
    } catch {
      continue;
    }
    if (!isFreeToShop(director, record)) continue;
    const kingdomStalls = byKingdom.get(record.kingdomId);
    if (!kingdomStalls?.length) continue;

    const rng = agentRng(`shoppers:${record.username}:${Date.now() >> 16}`);
    // Does this citizen feel like browsing at all?
    // A kingdom with bargain stalls draws more foot traffic.
    let chance = BASE_SHOP_CHANCE;
    try {
      if (kingdomHasBargain(kingdomStalls)) chance *= BARGAIN_FLOCK_MULT;
    } catch {
      // Base chance stands.
    }
    if (rng() >= chance) continue;

    // Browse stalls in random order; stop after the first purchase.
    const order = [...kingdomStalls].sort(() => rng() - 0.5);
    for (const stall of order) {
      try {
        if (considerStall(director, bot, record, stall, rng)) break;
      } catch {
        // One bad stall never blocks the rest.
      }
    }
  }
}

/** All stalls with priced stock, regardless of kingdom (grouped by caller). */
function stallsForKingdomAll(stalls) {
  return stalls.filter((stall) => {
    if (!stall || !stall.kingdomId) return false;
    const stock = stall.stock ?? {};
    const prices = stall.prices ?? {};
    return Object.keys(stock).some(
      (id) => (stock[id] ?? 0) > 0 && (prices[id] ?? 0) > 0
    );
  });
}

/** True when any ware in these stalls undercuts its reference price. */
function kingdomHasBargain(stalls) {
  for (const stall of stalls) {
    const stock = stall.stock ?? {};
    const prices = stall.prices ?? {};
    for (const id of Object.keys(stock)) {
      if (!((stock[id] ?? 0) > 0)) continue;
      const price = prices[id] ?? 0;
      if (!(price > 0)) continue;
      const ref = referencePrice(id);
      if (ref && price / ref < DEAL_RATIO) return true;
    }
  }
  return false;
}

module.exports = {
  tickShoppers,
  // Exported for tests / review.
  referencePrice,
  maxPayRatio,
  considerStall,
  BASE_SHOP_CHANCE,
  BARGAIN_FLOCK_MULT,
  WALK_PAST_RATIO,
  DEAL_RATIO,
};
