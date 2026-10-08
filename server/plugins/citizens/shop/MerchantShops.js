"use strict";

/**
 * MerchantShops — real shop fronts for citizen merchants.
 *
 * A player right-clicks a merchant citizen, picks Trade, and a stall
 * interface opens showing the merchant's wares at the current price.
 * Buying takes coins from the player and wares from the merchant's own
 * inventory (finite — a sold-out merchant shows empty until they restock);
 * the coins land in the merchant's inventory toward their save_gold goal.
 * Selling works the other way: the merchant only buys back their own
 * wares, paying 85% of the stall price from their own coin pouch.
 *
 * Why a custom interface instead of ShopManager: the engine's shop system
 * is definition-static with a void economy (stock lives in the shop, coins
 * vanish into / are minted from nothing, restock ticks regenerate wares).
 * A citizen merchant's stock IS their live inventory, so the stall is
 * backed directly by it. No core changes, no per-merchant shop
 * registration — sessions resolve the merchant live, so director
 * spawn/despawn just works (a logged-out merchant closes its viewers).
 *
 * Cross-plugin talk: prices come from the economy plugin via the
 * economy:price-query custom event (falls back to the merchant's
 * configured pricePerWare when the economy plugin is absent).
 *
 * Future player-owned shops can reuse this interface pattern; the session
 * shape ({ merchant, wares }) already treats the seller as a Player.
 */

const {
  ATTR_CITIZEN_ROLE,
  ATTR_CITIZEN_PERSONALITY,
  ATTR_WARE_ITEM,
  ATTR_WARE_PRICE,
  ATTR_MARKET_WARES,
  ROLE_MERCHANT,
} = require("../constants");
const { isKingdomAtWar } = require("../CitizenEvents");
const { kingdomIdOf } = require("../brain/CitizenSites");
const {
  FLAG_OP1,
  FLAG_OP2,
  FLAG_OP3,
  TYPE_GRAPHIC,
  TYPE_TEXT,
  createWidgetGroup,
} = require("../../interface/widgetGroup");
const {
  getMemory,
  GOSSIP_GENEROSITY,
} = require("../lib/CitizenMemory");

const GROUP_ID = 30010;
const OVERLAY_HOST_UID = (161 << 16) | 34;
const TRADE_OPTION_SLOT = 7; // 1 attack, 2 trade req, 3 follow, 4 duel, 5 recruit, 6 forfeit
const COINS = 995;
const SELL_TAX = 0.85; // merchants buy back at 85%, mirroring real shops
const MAX_ACTION_AMOUNT = 5000;
const NEARBY_RADIUS = 10;

const COMPONENT = {
  ROOT: 0,
  TITLE: 1,
  SUBTITLE: 2,
  CLOSE: 3,
  HINT: 4,
  ROW_BASE: 10,
  ROW_STRIDE: 8,
  MAX_WARES: 4,
};
// Row parts: 0 icon, 1 name, 2 detail, 3 buy, 4 sell.
const uid = (component) => (GROUP_ID << 16) | component;
const rowUid = (row, part) =>
  uid(COMPONENT.ROW_BASE + row * COMPONENT.ROW_STRIDE + part);

const BUY_OPS = ["Buy 1", "Buy 5", "Buy X"];
const SELL_OPS = ["Sell 1", "Sell 5", "Sell X"];
const OP_FLAGS = FLAG_OP1 | FLAG_OP2 | FLAG_OP3;

let pluginApi = null;
/** viewer player -> { merchant, wares: [{ id, name, price }] } */
const sessions = new Map();
const tradeOptionSent = new WeakSet();

function isMerchantCitizen(player) {
  return (
    !!player &&
    player.isPlayerBot?.() === true &&
    player.getAttribute?.(ATTR_CITIZEN_ROLE) === ROLE_MERCHANT
  );
}

function isMerchantAvailable(merchant) {
  if (!isMerchantCitizen(merchant)) {
    return false;
  }
  try {
    if (merchant.isRegistered?.() === false) {
      return false;
    }
  } catch (error) {
    return false;
  }
  return true;
}

function nearby(player, merchant, radius = NEARBY_RADIUS) {
  try {
    const a = player.getLocation();
    const b = merchant.getLocation();
    return (
      a.getZ() === b.getZ() &&
      Math.max(Math.abs(a.getX() - b.getX()), Math.abs(a.getY() - b.getY())) <=
        radius
    );
  } catch (error) {
    return false;
  }
}

function resolveWareId(ItemIds, name) {
  if (Number.isInteger(name)) {
    return name;
  }
  const key = String(name ?? "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
  return ItemIds[key] ?? null;
}

/** The merchant_tend activity spec — one source of truth with the brain. */
function loadMerchantSpec() {
  const fallback = { wareItem: "BREAD", pricePerWare: 12 };
  try {
    const data = require("../data/citizen-activities.json");
    const tend = (data?.activities ?? []).find((a) => a?.id === "merchant_tend");
    const action = (tend?.actions ?? []).find((a) => a?.type === "merchant") ?? {};
    return {
      wareItem: action.wareItem ?? fallback.wareItem,
      pricePerWare: Number(action.pricePerWare) > 0 ? Number(action.pricePerWare) : fallback.pricePerWare,
    };
  } catch (error) {
    return fallback;
  }
}

/** Economy reference price first, merchant's configured price as the fallback. */
function queryReferencePrice(api, itemId) {
  let price = null;
  try {
    api.emitCustomEvent("economy:price-query", {
      itemId,
      respond: (p) => {
        price = p;
      },
    });
  } catch (error) {
    // Economy plugin absent — fall back below.
  }
  return Number.isFinite(price) && price > 0 ? Math.floor(price) : null;
}

/**
 * The layered market price stack (war / scarcity / demand / season),
 * applied to one ware. Shared by the single-ware and market-stall paths.
 */
function priceWithMarketStack(api, merchant, wareId, base) {
  const name =
    api.core.ItemDefinition.forId(wareId)?.getName?.() ?? `Item ${wareId}`;
  const warMult = isWarGood(name) ? warPriceMultiplier(merchant) : 1;
  const scarce = scarcityPricing(merchant, wareId);
  const demand = demandPricing(wareId);
  const season = seasonalPricing(name);
  const marketMult = warMult * scarce.mult * demand.mult * season.mult;
  const price = Math.max(1, Math.ceil(base * marketMult));
  const marketNote =
    scarce.note ?? demand.note ?? season.note ?? (warMult > 1 ? "war prices" : null);
  return { id: wareId, name, price, marketNote };
}

/**
 * Market-stall wares published by CitizenMarketStalls on the merchant's
 * citizens:market-wares attribute (JSON [{id, price}]). Returns the priced
 * ware list, or null when the merchant has no stall set up (falls back to
 * the single-ware spec path).
 */
function marketStallWares(api, merchant) {
  let raw = null;
  try {
    raw = merchant?.getAttribute?.(ATTR_MARKET_WARES);
  } catch {
    return null;
  }
  if (!raw) return null;
  let list = null;
  try {
    list = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(list) || list.length === 0) return null;
  const out = [];
  for (const entry of list.slice(0, COMPONENT.MAX_WARES)) {
    const id = Math.floor(Number(entry?.id));
    const base = Math.floor(Number(entry?.price));
    if (!(id > 0) || !(base > 0)) continue;
    out.push(priceWithMarketStack(api, merchant, id, base));
  }
  return out.length > 0 ? out : null;
}

function merchantWares(api, merchant) {
  // CitizenMarketStalls publishes the day's 3-5 wares (with
  // personality-driven list prices) while the stall is open. The market
  // stack applies on top, same as the single-ware path.
  const stallWares = marketStallWares(api, merchant);
  if (stallWares) return stallWares;

  const spec = loadMerchantSpec();
  // Per-merchant ware override: specialist merchants (the sword supplier,
  // the prime) carry citizens:ware-item / citizens:ware-price attributes
  // that win over the shared spec, so the stall shows what they sell.
  let wareItem = spec.wareItem;
  let pricePerWare = spec.pricePerWare;
  try {
    const attrItem = merchant?.getAttribute?.(ATTR_WARE_ITEM);
    if (attrItem !== undefined && attrItem !== null && attrItem !== "") {
      wareItem = attrItem;
    }
    const attrPrice = merchant?.getAttribute?.(ATTR_WARE_PRICE);
    if (Number(attrPrice) > 0) {
      pricePerWare = Math.floor(Number(attrPrice));
    }
  } catch (error) {
    // Spec defaults.
  }
  const wareId = resolveWareId(api.core.ItemIds, wareItem);
  if (!Number.isInteger(wareId)) {
    return [];
  }
  const base =
    queryReferencePrice(api, wareId) ?? Math.max(1, Math.floor(pricePerWare));
  const priced = priceWithMarketStack(api, merchant, wareId, base);
  journalPriceMove(merchant, priced.name, priced.price);
  return [priced];
}

// War goods: weapons and food — what an army (or a frightened town) buys.
const WAR_GOOD_KEYWORDS = [
  "SWORD",
  "BOW",
  "ARROW",
  "SHIELD",
  "DAGGER",
  "BATTLEAXE",
  "MACE",
  "BREAD",
  "MEAT",
  "FISH",
  "TUNA",
  "LOBSTER",
  "PIKE",
  "CAKE",
  "POTATO",
  "STEW",
];
// Borders this hot smell of war; merchants price it in.
const WAR_PRICE_TENSION = 60;

/** Ms until the kingdom's latest post-war armistice expires (0 when none). */
function armisticeRemainingMs(kingdomId) {
  try {
    const Store = require("../../kingdoms/KingdomStore");
    const Tension = require("../../kingdoms/Tension.Kingdoms");
    const armisticeMs = Tension.ARMISTICE_MS ?? 0;
    if (!armisticeMs) return 0;
    const now = Date.now();
    let best = 0;
    for (const war of Store.getEndedWars()) {
      if (war?.attackerId !== kingdomId && war?.defenderId !== kingdomId) continue;
      if (!Number.isFinite(war?.endedAt)) continue;
      const remaining = armisticeMs - (now - war.endedAt);
      if (remaining > best) best = remaining;
    }
    return best;
  } catch {
    return 0;
  }
}

/**
 * War-economy markup on war goods (steel, bows, shields, food).
 * 25% when the border first smells of war (tension 60), scaling to 50% on
 * the brink — and after peace the spike decays across the 72h armistice
 * instead of snapping off. 1 in peacetime; the market closes outright once
 * the war itself starts (see openStall), so wartime returns 1.
 */
function warPriceMultiplier(merchant) {
  try {
    const kingdomId = kingdomIdOf(merchant);
    if (isKingdomAtWar(kingdomId)) return 1; // market closed in wartime anyway
    const Tension = require("../../kingdoms/Tension.Kingdoms");
    const heat = Tension.hottestTensionFor(kingdomId) / 100;
    if (heat * 100 >= WAR_PRICE_TENSION) {
      return 1.25 + 0.25 * heat;
    }
    const remaining = armisticeRemainingMs(kingdomId);
    if (remaining > 0 && Tension.ARMISTICE_MS > 0) {
      return 1 + 0.5 * (remaining / Tension.ARMISTICE_MS);
    }
    return 1;
  } catch {
    return 1;
  }
}

function isWarGood(name) {
  const upper = String(name ?? "").toUpperCase();
  return WAR_GOOD_KEYWORDS.some((kw) => upper.includes(kw));
}

/** True when the stall currently charges war prices (for the warning). */
function warPricesActive(merchant) {
  return warPriceMultiplier(merchant) > 1;
}

/** Looming war or its aftermath — the warning names the reason. */
function warPriceWarning(merchant) {
  try {
    const Tension = require("../../kingdoms/Tension.Kingdoms");
    if (Tension.hottestTensionFor(kingdomIdOf(merchant)) >= WAR_PRICE_TENSION) {
      return "War looms — steel and bread cost war prices at this stall.";
    }
    return "The war is over but prices haven't settled — steel and bread still cost war prices.";
  } catch {
    return "Steel and bread cost war prices at this stall.";
  }
}

// Scarcity pricing: nearly sold out costs more, overstock gets a markdown.
// The merchant's stock IS their live inventory, so the price always tells
// the truth about the shelf.
function scarcityPricing(merchant, wareId) {
  let stock = 0;
  try {
    stock = merchant.getInventory?.()?.getAmount?.(wareId) ?? 0;
  } catch {
    stock = 0;
  }
  if (stock <= 2) return { mult: 1.25, note: "scarce — nearly sold out" };
  if (stock <= 8) return { mult: 1.1, note: null };
  if (stock >= 50) return { mult: 0.9, note: "surplus — priced to move" };
  return { mult: 1.0, note: null };
}

// Demand-board pricing: open economy:demand orders for this ware mean
// buyers are desperate — the stall prices it in (capped, never gouging).
function demandPricing(wareId) {
  try {
    const Demand = require("../../economy/Demand.Economy");
    const open = Demand.getOpen({ itemId: wareId }).length;
    if (open > 0) {
      return {
        mult: Math.min(1.3, 1 + 0.1 * open),
        note: open === 1 ? "high demand" : `high demand (${open} open orders)`,
      };
    }
  } catch {
    // Economy plugin absent — no demand pressure.
  }
  return { mult: 1.0, note: null };
}

// Food words for the seasonal table.
const FOOD_KEYWORDS = [
  "BREAD",
  "MEAT",
  "FISH",
  "TUNA",
  "LOBSTER",
  "SHRIMP",
  "PIKE",
  "CAKE",
  "POTATO",
  "STEW",
  "APPLE",
  "CABBAGE",
];

/**
 * Seasonal food prices, by real-world month (northern-hemisphere harvest
 * rhythm, the way a medieval market thinks): harvest glut in autumn,
 * lean winter stores, spring planting hunger, summer plenty. Small —
// food should breathe with the year, not swing with it.
 */
function seasonalPricing(name) {
  const upper = String(name ?? "").toUpperCase();
  if (!FOOD_KEYWORDS.some((kw) => upper.includes(kw))) {
    return { mult: 1.0, note: null };
  }
  const month = new Date().getMonth(); // 0-11
  if (month >= 8 && month <= 10) return { mult: 0.9, note: "harvest plenty" }; // Sep-Nov
  if (month >= 11 || month <= 1) return { mult: 1.1, note: "winter stores" }; // Dec-Feb
  if (month >= 2 && month <= 4) return { mult: 1.05, note: null }; // Mar-May
  return { mult: 1.0, note: null }; // Jun-Aug: summer plenty
}

/** Journal a price move, but only when it actually moved (avoids spam). */
function journalPriceMove(merchant, wareName, newBase) {
  try {
    const { getJournal } = require("../lib/CitizenJournal");
    const key = "citizens:base-price";
    const old = Number(merchant.getAttribute?.(key));
    merchant.setAttribute?.(key, String(newBase));
    if (Number.isFinite(old) && old > 0 && old !== newBase) {
      const move = (newBase - old) / old;
      if (Math.abs(move) >= 0.15) {
        const dir = move > 0 ? "Raised" : "Lowered";
        getJournal().log(
          merchant.getUsername?.() ?? "?",
          "price",
          `${dir} the price of ${wareName} to ${newBase} coins — ${move > 0 ? "the market tightened" : "stock is moving slowly"}.`,
          { data: { ware: wareName, from: old, to: newBase } }
        );
      }
    }
  } catch {
    // Journaling must never break the stall.
  }
}

function buildStallInterface() {
  const { widgets, add } = createWidgetGroup(GROUP_ID);
  const root = add(COMPONENT.ROOT, -1, {
    rawWidth: 560,
    rawHeight: 360,
    width: 560,
    height: 360,
    xPositionMode: 1,
    yPositionMode: 1,
  });
  add(COMPONENT.TITLE, root, {
    type: TYPE_TEXT,
    rawX: 16,
    rawY: 12,
    rawWidth: 528,
    rawHeight: 22,
    width: 528,
    height: 22,
    text: "",
    fontId: 496,
    textColor: 0xffd27f,
    textShadowed: true,
  });
  add(COMPONENT.SUBTITLE, root, {
    type: TYPE_TEXT,
    rawX: 16,
    rawY: 34,
    rawWidth: 528,
    rawHeight: 16,
    width: 528,
    height: 16,
    text: "Citizen merchant — wares for coins",
    fontId: 494,
    textColor: 0xe8ded0,
    textShadowed: true,
  });
  for (let row = 0; row < COMPONENT.MAX_WARES; row++) {
    const y = 64 + row * 64;
    add(COMPONENT.ROW_BASE + row * COMPONENT.ROW_STRIDE + 0, root, {
      type: TYPE_GRAPHIC,
      rawX: 16,
      rawY: y,
      rawWidth: 40,
      rawHeight: 36,
      width: 40,
      height: 36,
      itemQuantityMode: 0,
    });
    add(COMPONENT.ROW_BASE + row * COMPONENT.ROW_STRIDE + 1, root, {
      type: TYPE_TEXT,
      rawX: 64,
      rawY: y,
      rawWidth: 320,
      rawHeight: 20,
      width: 320,
      height: 20,
      text: "",
      fontId: 494,
      textColor: 0xffffff,
      textShadowed: true,
    });
    add(COMPONENT.ROW_BASE + row * COMPONENT.ROW_STRIDE + 2, root, {
      type: TYPE_TEXT,
      rawX: 64,
      rawY: y + 20,
      rawWidth: 320,
      rawHeight: 18,
      width: 320,
      height: 18,
      text: "",
      fontId: 494,
      textColor: 0xe8ded0,
      textShadowed: true,
    });
    add(COMPONENT.ROW_BASE + row * COMPONENT.ROW_STRIDE + 3, root, {
      type: TYPE_TEXT,
      rawX: 400,
      rawY: y + 8,
      rawWidth: 64,
      rawHeight: 22,
      width: 64,
      height: 22,
      text: "Buy",
      fontId: 494,
      textColor: 0x7fd27f,
      textShadowed: true,
      actions: BUY_OPS,
      flags: OP_FLAGS,
    });
    add(COMPONENT.ROW_BASE + row * COMPONENT.ROW_STRIDE + 4, root, {
      type: TYPE_TEXT,
      rawX: 472,
      rawY: y + 8,
      rawWidth: 64,
      rawHeight: 22,
      width: 64,
      height: 22,
      text: "Sell",
      fontId: 494,
      textColor: 0xd27f7f,
      textShadowed: true,
      actions: SELL_OPS,
      flags: OP_FLAGS,
    });
  }
  add(COMPONENT.CLOSE, root, {
    type: TYPE_TEXT,
    rawX: 480,
    rawY: 324,
    rawWidth: 64,
    rawHeight: 22,
    width: 64,
    height: 22,
    text: "Close",
    fontId: 494,
    textColor: 0xffffff,
    textShadowed: true,
    actions: ["Close"],
    flags: FLAG_OP1,
  });
  add(COMPONENT.HINT, root, {
    type: TYPE_TEXT,
    rawX: 16,
    rawY: 326,
    rawWidth: 440,
    rawHeight: 18,
    width: 440,
    height: 18,
    text: "Stock is the merchant's own — when it's gone, they must restock.",
    fontId: 494,
    textColor: 0x9a8f7d,
    textShadowed: true,
  });
  return { groupId: GROUP_ID, widgets, scroll: [] };
}

function renderStall(api, player, session) {
  const sender = player.getPacketSender();
  const merchant = session.merchant;
  const merchantName = merchant.getUsername?.() ?? "Merchant";
  sender.sendString(`${merchantName}'s Stall`, uid(COMPONENT.TITLE));
  // Favorites get first pick of the new stock — said on the stall itself.
  const memory = getMemory();
  const standing = memory.standing(
    merchantName,
    player.getUsername?.() ?? "?"
  );
  if (standing === "favorite") {
    sender.sendString(
      "First pick of today's new stock, friend.",
      uid(COMPONENT.SUBTITLE)
    );
  } else {
    sender.sendString(
      "Citizen merchant — wares for coins",
      uid(COMPONENT.SUBTITLE)
    );
  }
  session.wares.forEach((ware, row) => {
    const stock = merchant.getInventory?.()?.getAmount?.(ware.id) ?? 0;
    const note = ware.priceNote
      ? ` · <col=${/loyalty discount|haggled|surplus|harvest plenty/.test(ware.priceNote) ? "7fd27f" : "ff7f7f"}>${ware.priceNote}</col>`
      : "";
    sender
      .sendItemOnInterface(rowUid(row, 0), ware.id, 0, Math.max(0, stock))
      .sendString(ware.name, rowUid(row, 1))
      .sendString(
        `${ware.price} coins each${note} · ${stock > 0 ? `${stock} in stock` : "<col=ff0000>SOLD OUT</col>"}`,
        rowUid(row, 2)
      );
    for (let part = 0; part <= 4; part++) {
      sender.sendInterfaceDisplayState(rowUid(row, part), false);
    }
  });
  for (let row = session.wares.length; row < COMPONENT.MAX_WARES; row++) {
    for (let part = 0; part <= 4; part++) {
      sender.sendInterfaceDisplayState(rowUid(row, part), true);
    }
  }
}

function openStall(api, player, merchant) {
  if (player.busy?.()) {
    return;
  }
  const stallMerchantName = merchant.getUsername?.() ?? "?";
  const stallPlayerName = player.getUsername?.() ?? "?";
  // Enemies don't get served. The merchant refuses outright.
  try {
    const { isEnemy } = require("../lib/CitizenBonds");
    if (isEnemy(stallMerchantName, stallPlayerName)) {
      player.sendMessage(`${stallMerchantName}: I don't serve your kind. Leave.`);
      try {
        merchant.forceChat?.("I don't serve enemies.");
      } catch {
        // Non-fatal.
      }
      return;
    }
  } catch {
    // Non-fatal — fall through to normal handling.
  }
  if (isKingdomAtWar(kingdomIdOf(merchant))) {
    player.sendMessage("The market is closed while the kingdom is at war.");
    return;
  }
  // Citizen memory: regulars are greeted by name and get a loyalty
  // discount; grudges pay cold prices. Every opening counts as a meeting.
  const memory = getMemory();
  const merchantName = merchant.getUsername?.() ?? "?";
  const playerName = player.getUsername?.() ?? "?";
  memory.recordMeeting(merchantName, playerName);
  // Opinions have teeth: merchants refuse to serve players they despise.
  if (memory.standing(merchantName, playerName) === "hostile") {
    player.sendMessage("I don't serve your kind here. Leave.");
    return;
  }
  const wares = merchantWares(api, merchant);
  if (wares.length === 0) {
    player.sendMessage("The merchant has nothing to sell right now.");
    return;
  }
  if (warPricesActive(merchant)) {
    player.sendMessage(warPriceWarning(merchant));
  }
  const multiplier = memory.priceMultiplier(merchantName, playerName);
  // Personality haggles too: greedy merchants drive a harder bargain,
  // easygoing ones give a little slack. Reads the merchant's seeded
  // personality — the same person every session.
  let haggleEdge = 1;
  let haggleNote = null;
  try {
    const { humanizerProfile } = require("../lib/humanizer");
    const personality = merchant.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
    haggleEdge = humanizerProfile(personality).haggleEdge ?? 1;
    if (haggleEdge > 1.01) haggleNote = "drives a hard bargain";
  } catch {
    // Fall through with no markup.
  }
  // Haggled one-time discount (granted in chat, voiced by the LLM, decided
  // data-tier). Consumed here — the next opening pays list again.
  let haggledPct = 0;
  try {
    haggledPct = memory.consumeHaggle?.(merchantName, playerName) ?? 0;
  } catch {
    haggledPct = 0;
  }
  const haggleMult = haggledPct > 0 ? 1 - haggledPct / 100 : 1;
  const loyaltyNote =
    multiplier < 1 ? "loyalty discount" : multiplier > 1 ? "cold prices" : null;
  const pricedWares = wares.map((ware) => {
    const notes = [ware.marketNote, loyaltyNote, haggleNote];
    if (haggledPct > 0) notes.push(`haggled ${haggledPct}% off`);
    return {
      ...ware,
      price: Math.max(
        1,
        Math.round(ware.price * multiplier * haggleEdge * haggleMult)
      ),
      priceNote: notes.filter(Boolean).join(" · ") || null,
    };
  });
  const greeting = memory.greetingFor(merchantName, playerName);
  if (greeting) {
    try {
      merchant.forceChat?.(greeting);
    } catch (error) {
      // Cosmetic.
    }
  }
  const session = { merchant, wares: pricedWares };
  sessions.set(player, session);
  player.getPacketSender().sendSubInterface(OVERLAY_HOST_UID, GROUP_ID, 0);
  renderStall(api, player, session);
  api.log?.("[citizens] stall opened", {
    player: playerName,
    merchant: merchantName,
    wares: pricedWares.map((w) => `${w.name}@${w.price}`),
    priceMultiplier: multiplier,
  });
}

function closeStall(player, message) {
  sessions.delete(player);
  try {
    player.getPacketSender()?.closeInterface(GROUP_ID);
  } catch (error) {
    // Already closed.
  }
  if (message) {
    try {
      player.sendMessage?.(message);
    } catch (error) {
      // Cosmetic.
    }
  }
}

function checkStall(api, player, session) {
  const merchant = session.merchant;
  if (!isMerchantAvailable(merchant)) {
    closeStall(player, "The merchant has packed up.");
    return null;
  }
  if (!nearby(player, merchant)) {
    closeStall(player, "You moved too far from the merchant.");
    return null;
  }
  return merchant;
}

function buyFromMerchant(api, player, ware, amount) {
  const session = sessions.get(player);
  if (!session) {
    return;
  }
  const merchant = checkStall(api, player, session);
  if (!merchant) {
    return;
  }
  const merchantInv = merchant.getInventory();
  const stock = merchantInv?.getAmount?.(ware.id) ?? 0;
  if (stock <= 0) {
    player.sendMessage("Sold out — the merchant is restocking.");
    renderStall(api, player, session);
    return;
  }
  const playerInv = player.getInventory();
  const coins = playerInv?.getAmount?.(COINS) ?? 0;
  const afford = Math.floor(coins / ware.price);
  if (afford <= 0) {
    player.sendMessage("You can't afford that.");
    return;
  }
  let qty = Math.min(
    Math.max(1, Math.floor(amount)),
    stock,
    afford,
    MAX_ACTION_AMOUNT
  );
  const definition = api.core.ItemDefinition.forId(ware.id);
  if (definition?.isStackable?.() === true) {
    if (!playerInv.containsNumber(ware.id) && playerInv.getFreeSlots() <= 0) {
      playerInv.full();
      return;
    }
  } else {
    qty = Math.min(qty, playerInv.getFreeSlots());
    if (qty <= 0) {
      playerInv.full();
      return;
    }
  }
  const cost = qty * ware.price;
  merchantInv.deleteNumber(ware.id, qty);
  playerInv.deleteNumber(COINS, cost);
  merchantInv.adds(COINS, cost);
  playerInv.adds(ware.id, qty);
  // Big spenders become known: generosity gossip, once per tier.
  try {
    const memory = getMemory();
    const crossed = memory.recordSpend(
      merchant.getUsername?.() ?? "?",
      player.getUsername?.() ?? "?",
      cost
    );
    if (crossed.length > 0) {
      memory.seedGossip({
        kingdomId: kingdomIdOf(merchant),
        kind: GOSSIP_GENEROSITY,
        subject: player.getUsername?.() ?? "?",
        text: `spends like a lord at ${merchant.getUsername?.() ?? "the"}'s stall — a generous patron!`,
        holder: merchant.getUsername?.() ?? "",
      });
      merchant.forceChat?.(
        `${player.getUsername?.() ?? "Friend"}! Generous as ever — the street will hear of it!`
      );
    }
  } catch (error) {
    // Cosmetic.
  }
  api.log?.("[citizens] stall sale", {
    merchant: merchant.getUsername?.(),
    buyer: player.getUsername?.(),
    ware: ware.id,
    qty,
    cost,
    merchantCoins: merchantInv.getAmount(COINS),
  });
  // Economic journaling: the merchant remembers real transactions, so the
  // foreground LLM talks about business truthfully.
  try {
    const { getJournal } = require("../lib/CitizenJournal");
    const mName = merchant.getUsername?.() ?? "?";
    const pName = player.getUsername?.() ?? "?";
    getJournal().log(
      mName,
      "trade",
      `Sold ${qty} x ${ware.name} to ${pName} for ${cost} coins.`,
      { with: pName, data: { itemId: ware.id, qty, cost, side: "sell" } }
    );
  } catch {
    // Non-fatal.
  }
  player.sendMessage(`You buy ${qty} x ${ware.name} for ${cost} coins.`);
  renderStall(api, player, session);
}

function sellToMerchant(api, player, ware, amount) {
  const session = sessions.get(player);
  if (!session) {
    return;
  }
  const merchant = checkStall(api, player, session);
  if (!merchant) {
    return;
  }
  const playerInv = player.getInventory();
  const held = playerInv?.getAmount?.(ware.id) ?? 0;
  if (held <= 0) {
    player.sendMessage(`You have no ${ware.name} to sell.`);
    return;
  }
  const sellPrice = Math.max(1, Math.floor(ware.price * SELL_TAX));
  const merchantInv = merchant.getInventory();
  const merchantCoins = merchantInv?.getAmount?.(COINS) ?? 0;
  const canPay = Math.floor(merchantCoins / sellPrice);
  if (canPay <= 0) {
    player.sendMessage("The merchant can't afford to buy that right now.");
    return;
  }
  const definition = api.core.ItemDefinition.forId(ware.id);
  if (
    definition?.isStackable?.() !== true &&
    !merchantInv.containsNumber(ware.id) &&
    merchantInv.getFreeSlots() <= 0
  ) {
    player.sendMessage("The merchant has no room for that.");
    return;
  }
  const qty = Math.min(
    Math.max(1, Math.floor(amount)),
    held,
    canPay,
    MAX_ACTION_AMOUNT
  );
  const payout = qty * sellPrice;
  playerInv.deleteNumber(ware.id, qty);
  merchantInv.deleteNumber(COINS, payout);
  merchantInv.adds(ware.id, qty);
  playerInv.adds(COINS, payout);
  api.log?.("[citizens] stall buyback", {
    merchant: merchant.getUsername?.(),
    seller: player.getUsername?.(),
    ware: ware.id,
    qty,
    payout,
  });
  try {
    const { getJournal } = require("../lib/CitizenJournal");
    const mName = merchant.getUsername?.() ?? "?";
    const pName = player.getUsername?.() ?? "?";
    getJournal().log(
      mName,
      "trade",
      `Bought ${qty} x ${ware.name} from ${pName} for ${payout} coins.`,
      { with: pName, data: { itemId: ware.id, qty, cost: payout, side: "buy" } }
    );
  } catch {
    // Non-fatal.
  }
  player.sendMessage(`You sell ${qty} x ${ware.name} for ${payout} coins.`);
  renderStall(api, player, session);
}

function rowActionFor(buttonId) {
  for (let row = 0; row < COMPONENT.MAX_WARES; row++) {
    if (buttonId === rowUid(row, 3)) return { row, side: "buy" };
    if (buttonId === rowUid(row, 4)) return { row, side: "sell" };
  }
  return null;
}

function onStallButton(event) {
  const api = pluginApi;
  if (!api || !event) {
    return;
  }
  const { player, buttonId, action } = event;
  const session = sessions.get(player);
  if (!session) {
    return true;
  }
  if (buttonId === uid(COMPONENT.CLOSE)) {
    closeStall(player);
    return true;
  }
  const target = rowActionFor(buttonId);
  if (!target) {
    return true;
  }
  const ware = session.wares[target.row];
  if (!ware) {
    return true;
  }
  const op = Number(action);
  if (op === 3) {
    // "Buy X" / "Sell X": ask for an amount, then run the trade.
    try {
      player.setEnteredAmountAction({
        execute: (entered) => {
          if (target.side === "buy") {
            buyFromMerchant(api, player, ware, entered);
          } else {
            sellToMerchant(api, player, ware, entered);
          }
        },
      });
      player
        .getPacketSender()
        .sendEnterAmountPrompt(
          target.side === "buy"
            ? `How many ${ware.name} would you like to buy?`
            : `How many ${ware.name} would you like to sell?`
        );
    } catch (error) {
      // Prompt unavailable — fall back to a single.
      if (target.side === "buy") {
        buyFromMerchant(api, player, ware, 1);
      } else {
        sellToMerchant(api, player, ware, 1);
      }
    }
    return true;
  }
  const qty = op === 2 ? 5 : 1;
  if (target.side === "buy") {
    buyFromMerchant(api, player, ware, qty);
  } else {
    sellToMerchant(api, player, ware, qty);
  }
  return true;
}

function onTradePlayerOption(event) {
  const api = pluginApi;
  if (!api || !event || event.option !== TRADE_OPTION_SLOT || event.handled) {
    return;
  }
  const { player, target } = event;
  if (player?.isPlayerBot?.() === true) {
    return;
  }
  if (!isMerchantCitizen(target)) {
    return; // Not ours — leave the option alone for other plugins.
  }
  event.handled = true;
  openStall(api, player, target);
}

function syncTradeOption(player) {
  if (!player || player.isPlayerBot?.() === true) {
    return;
  }
  if (tradeOptionSent.has(player)) {
    return;
  }
  try {
    player.getPacketSender()?.sendPlayerOption(TRADE_OPTION_SLOT, "Trade", false);
    tradeOptionSent.add(player);
  } catch (error) {
    // Retry next tick.
  }
}

function onInterfaceClose(event) {
  if (event?.player && sessions.has(event.player)) {
    sessions.delete(event.player);
  }
}

function onPlayerLogoutEvent(event) {
  const player = event?.player;
  if (!player) {
    return;
  }
  if (sessions.has(player)) {
    sessions.delete(player);
    return;
  }
  // A merchant logging out closes every stall it was serving.
  if (!isMerchantCitizen(player)) {
    return;
  }
  for (const [viewer, session] of Array.from(sessions)) {
    if (session.merchant === player) {
      closeStall(viewer, "The merchant has left.");
    }
  }
}

function stallButtonIds() {
  const ids = [uid(COMPONENT.CLOSE)];
  for (let row = 0; row < COMPONENT.MAX_WARES; row++) {
    ids.push(rowUid(row, 3), rowUid(row, 4));
  }
  return ids;
}

function initMerchantShops(api) {
  pluginApi = api;
  api.registerCustomInterface(buildStallInterface());
  api.onPlayerProcess(({ player }) => syncTradeOption(player));
  api.onPlayerOption(onTradePlayerOption);
  api.onInterfaceActionButton(stallButtonIds(), onStallButton);
  api.onCustomEvent("interface:close", onInterfaceClose);
  api.onPlayerLogout(onPlayerLogoutEvent);
  api.onPlayerDisconnect(onPlayerLogoutEvent);
  api.log?.("[citizens] merchant stalls ready");
}

module.exports = {
  initMerchantShops,
  // Exported for tests / review.
  GROUP_ID,
  TRADE_OPTION_SLOT,
  marketStallWares,
  priceWithMarketStack,
};
