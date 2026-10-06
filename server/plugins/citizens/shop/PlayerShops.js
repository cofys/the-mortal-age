"use strict";

/**
 * PlayerShops — PLAYER-OWNED market stalls.
 *
 * Citizen merchants run finite-inventory stalls (MerchantShops.js); now
 * players can own one too. Buy a pitch in a kingdom's market, stock it from
 * your inventory, set your prices, hire a citizen to mind it while you're
 * offline — the till pays their wages and the weekly rent automatically, and
 * the crown takes its 5% market tax on every sale (kingdom:tax-collected, the
 * same event the realm sim's steward emits).
 *
 * The stall interface reuses the MerchantShops widget pattern (same row
 * layout, same session shape { ownerKey, wares }); the seller is just a
 * player instead of a citizen merchant. Stock lives in the JSON store
 * (PlayerShopStore.js), not an inventory, so the stall keeps trading while
 * the owner is offline — as long as a hired hand minds it.
 *
 * Player commands (::shop ...):
 *   buy <kingdom>     lease a stall (upfront cost + weekly rent from the till)
 *   stock <item> [n]  move items from your inventory into stall stock
 *   unstock <item> [n] take items back out of stall stock
 *   price <item> <n>  set a ware's price (clamped to 10%-1000% of reference)
 *   hire [name]       hire an unemployed commoner of the stall's kingdom
 *   fire              dismiss your employee
 *   collect [n]       take coins out of the till
 *   claim             collect stock/coins returned from a closed stall
 *   info              your stall's stock, prices, till, employee, rent
 *   list [kingdom]    stalls currently open for trade
 *   browse <owner>    open another player's stall as a customer
 *   manage            open your own stall (what customers see)
 *   close             give up the stall; stock + till wait for ::shop claim
 *
 * Cross-plugin talk (custom events only, AGENTS.md):
 *   out: economy:price-query { itemId, respond(price|null) }  (reference prices)
 *   out: kingdom:tax-collected { kingdomId, amount, source: "player-stall" }
 *   in:  interface:close  (drop the viewer's session)
 *
 * Note: api.log?.() never reaches the log file — this module logs with
 * console.info / console.warn instead.
 */

const Store = require("./PlayerShopStore");
const { processUpkeep, releaseEmployee } = require("./PlayerShopUpkeep");
const KingdomStore = require("../../kingdoms/KingdomStore");
const { getDirector } = require("../director/CitizenDirector");
const { isKingdomAtWar } = require("../CitizenEvents");
const { ATTR_CITIZEN_ROLE, ROLE_COMMONER } = require("../constants");
const {
  FLAG_OP1,
  FLAG_OP2,
  FLAG_OP3,
  TYPE_GRAPHIC,
  TYPE_TEXT,
  createWidgetGroup,
} = require("../../interface/widgetGroup");

const ATTR_STALL_OWNER = "shop:stall-owner";
const ATTR_STALL_EMPLOYEE = "shop:stall-employee";

const GROUP_ID = 30011;
const OVERLAY_HOST_UID = (161 << 16) | 34;
const COINS = 995;
const MAX_ACTION_AMOUNT = 5000;
// Upkeep sweep every ~6 minutes; wall-clock math makes it idempotent.
const UPKEEP_TICK_TICKS = 600;

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
const uid = (component) => (GROUP_ID << 16) | component;
const rowUid = (row, part) =>
  uid(COMPONENT.ROW_BASE + row * COMPONENT.ROW_STRIDE + part);

const BUY_OPS = ["Buy 1", "Buy 5", "Buy X"];
const OP_FLAGS = FLAG_OP1 | FLAG_OP2 | FLAG_OP3;

let pluginApi = null;
/** viewer player -> { ownerKey, wares: [{ id, name }] } */
const sessions = new Map();

function ownerKeyOf(player) {
  return Store.keyOf(player.getUsername?.() ?? "");
}

function kingdomName(kingdomId) {
  return KingdomStore.getKingdom(kingdomId)?.name ?? kingdomId;
}

function notifyOwner(stall, message) {
  try {
    const player = pluginApi?.core?.World?.getPlayerByName?.(stall.owner);
    player?.sendMessage?.(message);
  } catch {
    // Offline owner: the message is lost, the store record isn't.
  }
}

/** A stall trades when its owner is online, or a hired hand minds it. */
function isStallOpen(stall) {
  if (!stall) return false;
  if (stall.employee) return true;
  try {
    return !!pluginApi?.core?.World?.getPlayerByName?.(stall.owner);
  } catch {
    return false;
  }
}

function findEmployeeBot(stall) {
  try {
    const bots = getDirector()?.onlineBotsForKingdom?.(stall.kingdomId) ?? [];
    const want = String(stall.employee ?? "").toLowerCase();
    return bots.find((b) => String(b.getUsername?.() ?? "").toLowerCase() === want) ?? null;
  } catch {
    return null;
  }
}

function resolveItemId(api, text) {
  const raw = String(text ?? "").trim();
  if (/^\d+$/.test(raw)) return Number(raw);
  const key = raw.toUpperCase().replace(/[\s-]+/g, "_");
  return api.core.ItemIds[key] ?? null;
}

function itemName(api, itemId) {
  return api.core.ItemDefinition.forId(itemId)?.getName?.() ?? `Item ${itemId}`;
}

/** Economy reference price first, the item's base value as the fallback. */
function referencePrice(api, itemId) {
  let price = null;
  try {
    api.emitCustomEvent("economy:price-query", {
      itemId,
      respond: (p) => {
        price = p;
      },
    });
  } catch {
    // Economy plugin absent — fall back below.
  }
  if (Number.isFinite(price) && price > 0) return Math.floor(price);
  const base = api.core.ItemDefinition.forId(itemId)?.getValue?.();
  return Number.isFinite(base) && base > 0 ? Math.floor(base) : null;
}

function defaultPrice(api, itemId) {
  return referencePrice(api, itemId) ?? 1;
}

// ---------------------------------------------------------------------------
// The stall interface (MerchantShops widget pattern, GROUP_ID 30011)
// ---------------------------------------------------------------------------

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
    text: "",
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
    text: "Player-owned stock — profits land in the owner's till; 5% market tax goes to the crown.",
    fontId: 494,
    textColor: 0x9a8f7d,
    textShadowed: true,
  });
  return { groupId: GROUP_ID, widgets, scroll: [] };
}

function stallWares(api, stall) {
  return Object.keys(stall.stock ?? {}).map((key) => {
    const id = Number(key);
    return { id, name: itemName(api, id) };
  });
}

function renderStall(api, player, session) {
  const stall = Store.getStall(session.ownerKey);
  if (!stall) {
    closeStall(player, "The stall has closed.");
    return;
  }
  const sender = player.getPacketSender();
  sender.sendString(`${stall.owner}'s Stall`, uid(COMPONENT.TITLE));
  sender.sendString(
    `Player-run market stall · ${kingdomName(stall.kingdomId)}` +
      (stall.employee ? ` · minded by ${stall.employee}` : ""),
    uid(COMPONENT.SUBTITLE)
  );
  session.wares.forEach((ware, row) => {
    const stock = stall.stock?.[ware.id] ?? 0;
    const price = stall.prices?.[ware.id] ?? 0;
    sender
      .sendItemOnInterface(rowUid(row, 0), ware.id, 0, Math.max(0, stock))
      .sendString(ware.name, rowUid(row, 1))
      .sendString(
        `${price} coins each · ${stock > 0 ? `${stock} in stock` : "<col=ff0000>SOLD OUT</col>"}`,
        rowUid(row, 2)
      );
    for (let part = 0; part <= 3; part++) {
      sender.sendInterfaceDisplayState(rowUid(row, part), false);
    }
  });
  for (let row = session.wares.length; row < COMPONENT.MAX_WARES; row++) {
    for (let part = 0; part <= 3; part++) {
      sender.sendInterfaceDisplayState(rowUid(row, part), true);
    }
  }
}

function openStall(api, player, stall) {
  if (player.busy?.()) {
    return;
  }
  if (isKingdomAtWar(stall.kingdomId)) {
    player.sendMessage("The market is closed while the kingdom is at war.");
    return;
  }
  if (!isStallOpen(stall)) {
    player.sendMessage(
      "The stall is closed — the owner is away and no hand minds it."
    );
    return;
  }
  const wares = stallWares(api, stall);
  if (wares.length === 0) {
    player.sendMessage("The stall is empty — the owner hasn't stocked it yet.");
    return;
  }
  sessions.set(player, { ownerKey: stall.ownerKey, wares });
  player.getPacketSender().sendSubInterface(OVERLAY_HOST_UID, GROUP_ID, 0);
  renderStall(api, player, sessions.get(player));
  console.info("[player-shops] stall opened", {
    stall: stall.owner,
    viewer: player.getUsername?.(),
  });
}

function closeStall(player, message) {
  sessions.delete(player);
  try {
    player.getPacketSender()?.closeInterface(GROUP_ID);
  } catch {
    // Already closed.
  }
  if (message) {
    try {
      player.sendMessage?.(message);
    } catch {
      // Cosmetic.
    }
  }
}

function buyFromStall(api, player, ware, amount) {
  const session = sessions.get(player);
  if (!session) {
    return;
  }
  const stall = Store.getStall(session.ownerKey);
  if (!stall || !isStallOpen(stall)) {
    closeStall(player, "The stall has closed.");
    return;
  }
  if (isKingdomAtWar(stall.kingdomId)) {
    closeStall(player, "The market is closed while the kingdom is at war.");
    return;
  }
  const stock = stall.stock?.[ware.id] ?? 0;
  const price = stall.prices?.[ware.id] ?? 0;
  if (stock <= 0 || price <= 0) {
    player.sendMessage("Sold out.");
    renderStall(api, player, session);
    return;
  }
  const playerInv = player.getInventory();
  const coins = playerInv?.getAmount?.(COINS) ?? 0;
  const afford = Math.floor(coins / price);
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
  const cost = qty * price;
  const tax = Math.floor(cost * Store.MARKET_TAX_RATE);
  stall.stock[ware.id] = stock - qty;
  stall.till = (stall.till ?? 0) + (cost - tax);
  Store.save();
  playerInv.deleteNumber(COINS, cost);
  playerInv.adds(ware.id, qty);
  if (tax > 0) {
    try {
      api.emitCustomEvent("kingdom:tax-collected", {
        kingdomId: stall.kingdomId,
        amount: tax,
        source: "player-stall",
      });
    } catch {
      // The treasury misses a coin; the sale stands.
    }
  }
  console.info("[player-shops] sale", {
    stall: stall.owner,
    buyer: player.getUsername?.(),
    ware: ware.id,
    qty,
    cost,
    tax,
    till: stall.till,
  });
  player.sendMessage(`You buy ${qty} x ${ware.name} for ${cost} coins.`);
  renderStall(api, player, session);
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
  let target = null;
  for (let row = 0; row < COMPONENT.MAX_WARES; row++) {
    if (buttonId === rowUid(row, 3)) {
      target = { row };
      break;
    }
  }
  if (!target) {
    return true;
  }
  const ware = session.wares[target.row];
  if (!ware) {
    return true;
  }
  const op = Number(action);
  if (op === 3) {
    try {
      player.setEnteredAmountAction({
        execute: (entered) => buyFromStall(api, player, ware, entered),
      });
      player
        .getPacketSender()
        .sendEnterAmountPrompt(`How many ${ware.name} would you like to buy?`);
    } catch {
      buyFromStall(api, player, ware, 1);
    }
    return true;
  }
  buyFromStall(api, player, ware, op === 2 ? 5 : 1);
  return true;
}

function stallButtonIds() {
  const ids = [uid(COMPONENT.CLOSE)];
  for (let row = 0; row < COMPONENT.MAX_WARES; row++) {
    ids.push(rowUid(row, 3));
  }
  return ids;
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
  // An owner logging out with no hired hand closes the stall for its viewers.
  if (player.isPlayerBot?.() === true) {
    return;
  }
  const stall = Store.getStall(ownerKeyOf(player));
  if (stall && !stall.employee) {
    for (const [viewer, session] of Array.from(sessions)) {
      if (session.ownerKey === stall.ownerKey) {
        closeStall(viewer, "The stall has closed — the owner left.");
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Upkeep hooks (the slow clock itself lives in PlayerShopUpkeep.js)
// ---------------------------------------------------------------------------

/** Wire the upkeep module to live bots/players; the store stays the source of truth. */
function shopHooks() {
  return {
    findEmployeeBot: (stall) => findEmployeeBot(stall),
    notifyOwner: (stall, message) => notifyOwner(stall, message),
    clearEmployeeMark: (bot) => {
      try {
        bot.setAttribute?.(ATTR_STALL_EMPLOYEE, null);
      } catch {
        // Cosmetic.
      }
    },
  };
}

function startUpkeepTask(api) {
  const Task = api.core.Task;
  api.core.TaskManager.submit(
    new (class extends Task {
      constructor() {
        super(UPKEEP_TICK_TICKS, false);
      }
      execute() {
        try {
          processUpkeep(shopHooks());
        } catch (error) {
          console.warn("[player-shops] upkeep sweep failed", error?.message ?? error);
        }
      }
    })()
  );
}

// ---------------------------------------------------------------------------
// ::shop commands
// ---------------------------------------------------------------------------

const SHOP_USAGE =
  "Market stalls: ::shop buy <kingdom> | stock <item> [n] | unstock <item> [n] | " +
  "price <item> <n> | hire [name] | fire | collect [n] | claim | info | " +
  "list [kingdom] | browse <owner> | manage | close";

function requireStall(player) {
  const stall = Store.getStall(ownerKeyOf(player));
  if (!stall) {
    player.sendMessage("You don't own a market stall. Lease one with ::shop buy <kingdom>.");
    return null;
  }
  return stall;
}

/** Split trailing numeric token: ["iron","sword","10"] -> { item: "iron sword", amount: "10" }. */
function splitItemAndAmount(tokens) {
  const rest = [...tokens];
  let amount = null;
  if (rest.length > 1 && /^\d+$/.test(rest[rest.length - 1])) {
    amount = rest.pop();
  }
  return { item: rest.join(" "), amount };
}

function buyStall(api, player, kingdomArg) {
  if (Store.getStall(ownerKeyOf(player))) {
    player.sendMessage("You already own a market stall — one per trader.");
    return;
  }
  const arg = String(kingdomArg ?? "").trim().toLowerCase();
  const kingdom = KingdomStore.getKingdoms().find(
    (k) => k.id === arg || String(k.name ?? "").toLowerCase() === arg
  );
  if (!kingdom) {
    player.sendMessage("Unknown kingdom. Choose one of:");
    for (const k of KingdomStore.getKingdoms()) {
      const { upfront, weeklyRent } = Store.stallCosts(k.id);
      player.sendMessage(`  ${k.id} (${k.name}) — ${upfront} coins, ${weeklyRent}/week rent`);
    }
    return;
  }
  const { upfront, weeklyRent } = Store.stallCosts(kingdom.id);
  const coins = player.getInventory()?.getAmount?.(COINS) ?? 0;
  if (coins < upfront) {
    player.sendMessage(
      `A stall in ${kingdom.name} costs ${upfront} coins — you carry ${coins}.`
    );
    return;
  }
  player.getInventory().deleteNumber(COINS, upfront);
  const key = ownerKeyOf(player);
  Store.upsertStall({
    owner: player.getUsername(),
    ownerKey: key,
    kingdomId: kingdom.id,
    createdAt: Date.now(),
    stock: {},
    prices: {},
    till: 0,
    employee: null,
    lastWageAt: Date.now(),
    lastRentAt: Date.now(),
    rentDebt: 0,
  });
  Store.save();
  try {
    player.setAttribute(ATTR_STALL_OWNER, kingdom.id);
  } catch {
    // Cosmetic; the store is the source of truth.
  }
  player.sendMessage(
    `You lease a market stall in ${kingdom.name} for ${upfront} coins. ` +
      `Rent is ${weeklyRent} coins a week, taken from your till automatically. ` +
      `Stock it with ::shop stock, price wares with ::shop price.`
  );
  console.info("[player-shops] stall bought", {
    owner: player.getUsername(),
    kingdom: kingdom.id,
    upfront,
  });
}

function stockStall(api, player, itemArg, amountArg) {
  const stall = requireStall(player);
  if (!stall) return;
  const itemId = resolveItemId(api, itemArg);
  if (!Number.isInteger(itemId) || itemId <= 0) {
    player.sendMessage(`Unknown item: ${itemArg}. Usage: ::shop stock <item> [amount]`);
    return;
  }
  if (itemId === COINS) {
    player.sendMessage("Coins go straight in the till — use ::shop collect to take them out.");
    return;
  }
  const definition = api.core.ItemDefinition.forId(itemId);
  if (!definition) {
    player.sendMessage(`Unknown item: ${itemArg}.`);
    return;
  }
  if (definition.isTradeable?.() === false) {
    player.sendMessage(`${definition.getName?.() ?? "That"} can't be sold at a stall.`);
    return;
  }
  const carried = player.getInventory()?.getAmount?.(itemId) ?? 0;
  let qty = amountArg ? Math.floor(Number(amountArg)) : carried;
  if (!(qty > 0)) {
    player.sendMessage(`You carry no ${definition.getName?.() ?? itemArg}.`);
    return;
  }
  qty = Math.min(qty, carried);
  const isNew = !(itemId in (stall.stock ?? {}));
  if (isNew && Object.keys(stall.stock ?? {}).length >= Store.MAX_WARES) {
    player.sendMessage(
      `A stall holds ${Store.MAX_WARES} ware types — unstock something first (::shop unstock).`
    );
    return;
  }
  player.getInventory().deleteNumber(itemId, qty);
  stall.stock = stall.stock ?? {};
  stall.prices = stall.prices ?? {};
  stall.stock[itemId] = (stall.stock[itemId] ?? 0) + qty;
  if (!(itemId in stall.prices)) {
    stall.prices[itemId] = defaultPrice(api, itemId);
  }
  Store.save();
  const name = definition.getName?.() ?? itemArg;
  player.sendMessage(
    `Stocked ${qty} x ${name} (${stall.stock[itemId]} in the stall @ ${stall.prices[itemId]} coins). ` +
      `Change the price with ::shop price ${name} <n>.`
  );
  console.info("[player-shops] stocked", { stall: stall.owner, item: itemId, qty });
}

function unstockStall(api, player, itemArg, amountArg) {
  const stall = requireStall(player);
  if (!stall) return;
  const itemId = resolveItemId(api, itemArg);
  const inStall = stall.stock?.[itemId] ?? 0;
  if (!(inStall > 0)) {
    player.sendMessage(`Your stall holds no ${itemArg}.`);
    return;
  }
  let qty = amountArg ? Math.floor(Number(amountArg)) : inStall;
  qty = Math.min(qty, inStall);
  const playerInv = player.getInventory();
  const definition = api.core.ItemDefinition.forId(itemId);
  if (definition?.isStackable?.() === true) {
    if (!playerInv.containsNumber(itemId) && playerInv.getFreeSlots() <= 0) {
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
  stall.stock[itemId] = inStall - qty;
  playerInv.adds(itemId, qty);
  Store.save();
  player.sendMessage(`Took ${qty} x ${itemName(api, itemId)} back out of the stall.`);
}

function priceStall(api, player, itemArg, priceArg) {
  const stall = requireStall(player);
  if (!stall) return;
  const itemId = resolveItemId(api, itemArg);
  const stocked = (stall.stock?.[itemId] ?? 0) > 0 || itemId in (stall.prices ?? {});
  if (!stocked) {
    player.sendMessage(`Your stall doesn't carry ${itemArg} — stock it first.`);
    return;
  }
  const wanted = Math.floor(Number(priceArg));
  if (!(wanted >= 1)) {
    player.sendMessage("Usage: ::shop price <item> <price> — price must be at least 1 coin.");
    return;
  }
  const ref = referencePrice(api, itemId);
  const anchor = ref ?? Math.max(1, api.core.ItemDefinition.forId(itemId)?.getValue?.() ?? 1);
  const clamped = Store.clampPrice(anchor, wanted);
  stall.prices = stall.prices ?? {};
  stall.prices[itemId] = clamped;
  Store.save();
  const name = itemName(api, itemId);
  if (clamped !== wanted) {
    const lo = Math.max(1, Math.floor(anchor * Store.PRICE_MIN_RATIO));
    const hi = Math.floor(anchor * Store.PRICE_MAX_RATIO);
    player.sendMessage(
      `${name}: ${wanted} is outside the fair range (${lo}–${hi}) — price set to ${clamped}.`
    );
  } else {
    player.sendMessage(`${name} now sells for ${clamped} coins each.`);
  }
  console.info("[player-shops] price set", { stall: stall.owner, item: itemId, price: clamped });
}

function hireEmployee(api, player, nameArg) {
  const stall = requireStall(player);
  if (!stall) return;
  if (stall.employee) {
    player.sendMessage(`${stall.employee} already minds your stall — ::shop fire to let them go.`);
    return;
  }
  const director = getDirector();
  if (!director) {
    player.sendMessage("The citizen population isn't awake right now — try again later.");
    return;
  }
  let candidates = [];
  try {
    candidates = (director.onlineBotsForKingdom(stall.kingdomId, ROLE_COMMONER) ?? []).filter(
      (bot) =>
        bot.getAttribute?.(ATTR_CITIZEN_ROLE) === ROLE_COMMONER &&
        !bot.getAttribute?.(ATTR_STALL_EMPLOYEE) &&
        !Store.isEmployed(bot.getUsername?.() ?? "")
    );
  } catch {
    candidates = [];
  }
  if (nameArg) {
    const want = String(nameArg).toLowerCase();
    const chosen = candidates.find(
      (b) => String(b.getUsername?.() ?? "").toLowerCase() === want
    );
    if (!chosen) {
      player.sendMessage(`No unemployed commoner named ${nameArg} is about. Try ::shop hire to see who's looking.`);
      return;
    }
    const name = chosen.getUsername();
    stall.employee = name;
    try {
      chosen.setAttribute?.(ATTR_STALL_EMPLOYEE, stall.ownerKey);
    } catch {
      // The store is the source of truth.
    }
    Store.save();
    try {
      chosen.forceChat?.(
        `I'll mind ${player.getUsername()}'s stall — ${Store.DAILY_WAGE} coins a day, mind.`
      );
    } catch {
      // A quiet hire.
    }
    player.sendMessage(
      `${name} now minds your stall while you're away. Wages (${Store.DAILY_WAGE} coins a day) come out of the till automatically.`
    );
    console.info("[player-shops] employee hired", { stall: stall.owner, employee: name });
    return;
  }
  if (candidates.length === 0) {
    player.sendMessage(
      `No unemployed commoners are about in ${kingdomName(stall.kingdomId)} right now — try again later.`
    );
    return;
  }
  player.sendMessage(`Unemployed commoners in ${kingdomName(stall.kingdomId)} (${Store.DAILY_WAGE} coins/day):`);
  for (const bot of candidates.slice(0, 5)) {
    player.sendMessage(`  ${bot.getUsername()} — ::shop hire ${bot.getUsername()}`);
  }
}

function fireEmployee(api, player) {
  const stall = requireStall(player);
  if (!stall) return;
  if (!stall.employee) {
    player.sendMessage("Nobody works your stall.");
    return;
  }
  const name = stall.employee;
  releaseEmployee(stall, "fired", shopHooks());
  Store.save();
  player.sendMessage(`${name} is let go.`);
}

function collectTill(api, player, amountArg) {
  const stall = requireStall(player);
  if (!stall) return;
  const till = stall.till ?? 0;
  if (till <= 0) {
    player.sendMessage("The till is empty.");
    return;
  }
  let amount = amountArg ? Math.floor(Number(amountArg)) : till;
  if (!(amount >= 1)) {
    player.sendMessage("Usage: ::shop collect [amount]");
    return;
  }
  amount = Math.min(amount, till);
  player.getInventory().adds(COINS, amount);
  stall.till = till - amount;
  Store.save();
  player.sendMessage(`You take ${amount} coins from the till (${stall.till} left).`);
}

function claimReturns(api, player) {
  const key = ownerKeyOf(player);
  const pending = Store.takeReturns(key);
  if (pending.length === 0) {
    player.sendMessage("Nothing is waiting for you.");
    return;
  }
  const playerInv = player.getInventory();
  const leftover = [];
  for (const { id, qty } of pending) {
    let take = qty;
    if (id === COINS) {
      // Coins stack, but a full inventory holding none still needs one slot.
      const held = playerInv.getAmount?.(COINS) ?? 0;
      if (held <= 0 && playerInv.getFreeSlots() <= 0) take = 0;
    } else {
      const definition = api.core.ItemDefinition.forId(id);
      if (definition?.isStackable?.() !== true) {
        take = Math.min(take, playerInv.getFreeSlots());
      } else if (!playerInv.containsNumber(id) && playerInv.getFreeSlots() <= 0) {
        take = 0;
      }
    }
    if (take > 0) {
      playerInv.adds(id, take);
      player.sendMessage(`Claimed ${take} x ${itemName(api, id)}.`);
    }
    if (take < qty) leftover.push({ id, qty: qty - take });
  }
  if (leftover.length > 0) {
    Store.addReturns(key, leftover);
    player.sendMessage("Your inventory is full — the rest waits. Free space and ::shop claim again.");
  }
  Store.save();
}

function showInfo(api, player) {
  const stall = requireStall(player);
  if (!stall) return;
  const { weeklyRent } = Store.stallCosts(stall.kingdomId);
  player.sendMessage(`[Shop] Your stall in ${kingdomName(stall.kingdomId)} — ${isStallOpen(stall) ? "OPEN" : "CLOSED (you're away, no hand hired)"}:`);
  const ids = Object.keys(stall.stock ?? {});
  if (ids.length === 0) {
    player.sendMessage("  No wares stocked — ::shop stock <item> [amount]");
  }
  for (const key of ids) {
    const id = Number(key);
    player.sendMessage(
      `  ${itemName(api, id)}: ${stall.stock[key]} in stock @ ${stall.prices?.[key] ?? "?"} coins`
    );
  }
  const dueIn = Math.max(0, Math.ceil(((stall.lastRentAt ?? Date.now()) + Store.WEEK_MS - Date.now()) / Store.DAY_MS));
  player.sendMessage(
    `  Till: ${stall.till ?? 0} coins · Employee: ${stall.employee ?? "none"} · ` +
      `Rent: ${weeklyRent}/week (next in ~${dueIn}d)` +
      ((stall.rentDebt ?? 0) > 0 ? ` · BACK RENT OWED: ${stall.rentDebt}` : "")
  );
}

function listStalls(api, player, kingdomArg) {
  const arg = String(kingdomArg ?? "").trim().toLowerCase();
  const stalls = Store.getAllStalls().filter(
    (s) => !arg || s.kingdomId === arg || kingdomName(s.kingdomId).toLowerCase() === arg
  );
  if (stalls.length === 0) {
    player.sendMessage(arg ? "No player stalls in that kingdom." : "No player owns a stall yet — ::shop buy <kingdom> to be the first.");
    return;
  }
  player.sendMessage("[Shop] Player stalls open for trade:");
  for (const stall of stalls.slice(0, 20)) {
    const wares = Object.keys(stall.stock ?? {}).length;
    player.sendMessage(
      `  ${stall.owner} — ${kingdomName(stall.kingdomId)} (${wares} ware${wares === 1 ? "" : "s"})` +
        (isStallOpen(stall) ? "" : " [closed]") +
        ` — ::shop browse ${stall.owner}`
    );
  }
}

function browseStall(api, player, ownerArg) {
  const target = Store.getStall(String(ownerArg ?? "").trim());
  if (!target) {
    player.sendMessage(`No market stall owned by ${ownerArg}. Try ::shop list.`);
    return;
  }
  openStall(api, player, target);
}

function closeOwnStall(api, player) {
  const stall = requireStall(player);
  if (!stall) return;
  const entries = Object.entries(stall.stock ?? {})
    .filter(([, qty]) => qty > 0)
    .map(([id, qty]) => ({ id: Number(id), qty }));
  if ((stall.till ?? 0) > 0) {
    entries.push({ id: COINS, qty: stall.till });
  }
  Store.addReturns(stall.ownerKey, entries);
  releaseEmployee(stall, "closed", shopHooks());
  Store.removeStall(stall.ownerKey);
  Store.save();
  try {
    player.setAttribute(ATTR_STALL_OWNER, null);
  } catch {
    // Cosmetic.
  }
  for (const [viewer, session] of Array.from(sessions)) {
    if (session.ownerKey === stall.ownerKey) {
      closeStall(viewer, "The stall has closed.");
    }
  }
  player.sendMessage("Your stall is closed. Stock and till are waiting — ::shop claim to collect.");
  console.info("[player-shops] stall closed by owner", { stall: stall.owner });
}

function onShopCommand({ player, parts }) {
  const api = pluginApi;
  if (!api || !player) return true;
  if (player.isPlayerBot?.() === true) return true; // citizens don't run shops
  const sub = String(parts[1] ?? "manage").toLowerCase();
  try {
    switch (sub) {
      case "buy": {
        buyStall(api, player, (parts.slice(2).join(" ") || "").trim());
        return true;
      }
      case "stock": {
        const { item, amount } = splitItemAndAmount(parts.slice(2));
        if (!item) player.sendMessage("Usage: ::shop stock <item> [amount]");
        else stockStall(api, player, item, amount);
        return true;
      }
      case "unstock": {
        const { item, amount } = splitItemAndAmount(parts.slice(2));
        if (!item) player.sendMessage("Usage: ::shop unstock <item> [amount]");
        else unstockStall(api, player, item, amount);
        return true;
      }
      case "price": {
        const { item, amount } = splitItemAndAmount(parts.slice(2));
        if (!item || !amount) player.sendMessage("Usage: ::shop price <item> <price>");
        else priceStall(api, player, item, amount);
        return true;
      }
      case "hire":
        hireEmployee(api, player, parts.slice(2).join(" ").trim() || null);
        return true;
      case "fire":
        fireEmployee(api, player);
        return true;
      case "collect":
        collectTill(api, player, parts[2]);
        return true;
      case "claim":
        claimReturns(api, player);
        return true;
      case "info":
        showInfo(api, player);
        return true;
      case "list":
        listStalls(api, player, parts.slice(2).join(" ").trim());
        return true;
      case "browse":
        if (!parts[2]) player.sendMessage("Usage: ::shop browse <owner> — or ::shop list to find stalls.");
        else browseStall(api, player, parts.slice(2).join(" ").trim());
        return true;
      case "manage": {
        const stall = requireStall(player);
        if (stall) openStall(api, player, stall);
        return true;
      }
      case "close":
        closeOwnStall(api, player);
        return true;
      default:
        player.sendMessage(SHOP_USAGE);
        return true;
    }
  } catch (error) {
    console.warn("[player-shops] command failed", {
      sub,
      player: player.getUsername?.(),
      error: error?.message ?? error,
    });
    player.sendMessage("Something went wrong with that shop command — try again.");
    return true;
  }
}

/** Reconcile the shop:stall-owner attribute on login (repossessions happen offline). */
function onPlayerLogin(event) {
  const player = event?.player;
  if (!player || player.isPlayerBot?.() === true) return;
  try {
    const stall = Store.getStall(ownerKeyOf(player));
    const attr = player.getAttribute?.(ATTR_STALL_OWNER);
    if (stall && !attr) {
      player.setAttribute(ATTR_STALL_OWNER, stall.kingdomId);
    } else if (!stall && attr) {
      player.setAttribute(ATTR_STALL_OWNER, null);
      const pending = Store.peekReturns(ownerKeyOf(player));
      player.sendMessage(
        pending.length > 0
          ? "Your market stall is gone. Your stock is waiting — type ::shop claim."
          : "Your market stall is gone."
      );
    }
  } catch {
    // Cosmetic.
  }
}

function initPlayerShops(api) {
  pluginApi = api;
  Store.load();
  api.registerCustomInterface(buildStallInterface());
  api.onInterfaceActionButton(stallButtonIds(), onStallButton);
  api.onCustomEvent("interface:close", onInterfaceClose);
  api.onPlayerLogout(onPlayerLogoutEvent);
  api.onPlayerDisconnect(onPlayerLogoutEvent);
  api.onPlayerLogin(onPlayerLogin);
  api.registerCommand("shop", onShopCommand, api.core.PlayerRights.NONE, SHOP_USAGE);
  startUpkeepTask(api);
  console.info("[player-shops] player stalls ready");
}

module.exports = {
  initPlayerShops,
  // Exported for tests / review.
  GROUP_ID,
  ATTR_STALL_OWNER,
  ATTR_STALL_EMPLOYEE,
  SHOP_USAGE,
};
