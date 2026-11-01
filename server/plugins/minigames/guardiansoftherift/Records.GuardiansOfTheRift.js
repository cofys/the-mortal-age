"use strict";

/**
 * What a player keeps between games: the rifts closed (varp total_gotr_kills), the elemental and
 * catalytic energy banked for the Rewards Guardian ("Total elemental energy" in the end-of-game
 * messages), the times they've searched the rift, the abyssal-pearl balance that is the
 * minigame's shop currency, and the permanent gotr_perm_0 settings (talisman toggles, the
 * colourful fade, the needle and Cordelia's contact).
 *
 * Varps aren't saved here, so each one is an attribute re-sent at login.
 */

const Shared = require("./Shared.GuardiansOfTheRift");

const RIFTS_CLOSED_ATTRIBUTE = "guardians-of-the-rift:rifts-closed";
const ELEMENTAL_POINTS_ATTRIBUTE = "guardians-of-the-rift:elemental-points";
const CATALYTIC_POINTS_ATTRIBUTE = "guardians-of-the-rift:catalytic-points";
const SEARCHES_ATTRIBUTE = "guardians-of-the-rift:searches";
/**
 * Abyssal pearls are the minigame's reward currency (Wiki: Guardians of the Rift#Rewards).
 * The shop currency's own attribute name, so Shopkeepers' point-currency convention and the
 * Omnishop both read the same saved balance.
 */
const PEARLS_ATTRIBUTE = "shop-currency:Abyssal pearls";
/** The name ShopManager registers for shops whose currency is "Abyssal pearls". */
const PEARL_CURRENCY = "ABYSSAL PEARLS";
/** Permanent varbits by gameval name. */
const SETTINGS_ATTRIBUTE = "guardians-of-the-rift:settings";

function number(player, key) {
  return Math.max(0, Math.trunc(Number(player.getAttribute(key)) || 0));
}

function riftsClosed(player) {
  return number(player, RIFTS_CLOSED_ATTRIBUTE);
}

function addRiftClosed(player) {
  const closed = riftsClosed(player) + 1;
  player.setAttribute(RIFTS_CLOSED_ATTRIBUTE, closed);
  Shared.setVarp(player, Shared.VARP.RIFTS_CLOSED, closed);
  return closed;
}

function points(player) {
  return { elemental: number(player, ELEMENTAL_POINTS_ATTRIBUTE), catalytic: number(player, CATALYTIC_POINTS_ATTRIBUTE) };
}

function setPoints(player, elemental, catalytic) {
  player.setAttribute(ELEMENTAL_POINTS_ATTRIBUTE, Math.max(0, elemental));
  player.setAttribute(CATALYTIC_POINTS_ATTRIBUTE, Math.max(0, catalytic));
}

/** Players already checked for the old inventory item this session. */
const legacyChecked = new WeakSet();

/**
 * Before pearls were a saved balance they were the abyssal_pearl item in the inventory or bank.
 * Move every legacy stack into the balance and take the items in the same operation, then ask
 * persistence for one snapshot: an upgraded account keeps the currency it had earned.
 */
function migrateLegacyPearls(player) {
  if (!player || legacyChecked.has(player)) return 0;
  legacyChecked.add(player);
  const pearl = Shared.obj(Shared.ITEM.PEARL);
  const note = Shared.core().ItemDefinition.forId(pearl)?.getNoteId?.() ?? -1;
  const ids = note > 0 ? [pearl, note] : [pearl];

  let converted = 0;
  const inventory = player.getInventory?.();
  if (inventory) {
    let removed = 0;
    for (const id of ids) {
      const held = Number(inventory.getAmount?.(id) ?? 0);
      if (held <= 0) continue;
      inventory.delete(id, held);
      removed += held;
    }
    if (removed > 0) {
      inventory.refreshItems?.();
      converted += removed;
    }
  }

  const searchTab = Shared.core().Bank?.BANK_SEARCH_TAB_INDEX ?? -1;
  for (const [tab, bank] of (player.getBanks?.() ?? []).entries()) {
    if (!bank || tab === searchTab) continue;
    let removed = 0;
    for (const id of ids) {
      const held = Number(bank.getAmount?.(id) ?? 0);
      if (held <= 0) continue;
      bank.delete(id, held);
      removed += held;
    }
    if (removed > 0) {
      bank.refreshItems?.();
      converted += removed;
    }
  }

  if (converted > 0) {
    addPearls(player, converted);
    player.sendMessage?.(`Your ${Shared.formatNumber(converted)} abyssal pearls are now kept in your currency balance.`);
    Shared.api().emitCustomEvent("persistence:save", { player, reason: "guardians-of-the-rift-pearl-migration" });
  }
  return converted;
}

function pearls(player) {
  migrateLegacyPearls(player);
  return number(player, PEARLS_ATTRIBUTE);
}

/** Sets the balance outright: a shop's price is a target, so a retry can't take twice. */
function setPearls(player, value) {
  const next = Math.max(0, Math.trunc(Number(value) || 0));
  player.setAttribute(PEARLS_ATTRIBUTE, next);
  return next;
}

function addPearls(player, amount) {
  return setPearls(player, pearls(player) + Math.max(0, Math.trunc(Number(amount) || 0)));
}

/** Takes `amount` pearls if the whole price is there; a refused purchase changes nothing. */
function spendPearls(player, amount) {
  const price = Math.max(0, Math.trunc(Number(amount) || 0));
  const balance = pearls(player);
  if (price <= 0) return true;
  if (balance < price) return false;
  setPearls(player, balance - price);
  return true;
}

function searches(player) {
  return number(player, SEARCHES_ATTRIBUTE);
}

function addSearches(player, count) {
  player.setAttribute(SEARCHES_ATTRIBUTE, searches(player) + count);
}

function settings(player) {
  const value = player.getAttribute(SETTINGS_ATTRIBUTE);
  return value && typeof value === "object" ? value : {};
}

function setting(player, varbit) {
  return Number(settings(player)[varbit]) || 0;
}

function setSetting(player, varbit, value) {
  const next = { ...settings(player) };
  if (value) next[varbit] = value;
  else delete next[varbit];
  player.setAttribute(SETTINGS_ATTRIBUTE, next);
  Shared.setVarbit(player, varbit, value);
}

function login({ player }) {
  migrateLegacyPearls(player);
  Shared.setVarp(player, Shared.VARP.RIFTS_CLOSED, riftsClosed(player));
  for (const [varbit, value] of Object.entries(settings(player))) Shared.setVarbit(player, varbit, Number(value) || 0);
}

/** The balance as the shop layer's currency handler sees it. */
const pearlCurrency = {
  name: "Abyssal pearls",
  amount: pearls,
  add: addPearls,
  remove: (player, value) => spendPearls(player, value),
};

module.exports = {
  RIFTS_CLOSED_ATTRIBUTE, ELEMENTAL_POINTS_ATTRIBUTE, CATALYTIC_POINTS_ATTRIBUTE, SEARCHES_ATTRIBUTE,
  SETTINGS_ATTRIBUTE, PEARLS_ATTRIBUTE, PEARL_CURRENCY, pearlCurrency,
  riftsClosed, addRiftClosed, points, setPoints, pearls, setPearls, addPearls, spendPearls,
  migrateLegacyPearls, login,
  searches, addSearches, setting, setSetting,
  attach(api) {
    api.persistAttribute(RIFTS_CLOSED_ATTRIBUTE, 0);
    api.persistAttribute(ELEMENTAL_POINTS_ATTRIBUTE, 0);
    api.persistAttribute(CATALYTIC_POINTS_ATTRIBUTE, 0);
    api.persistAttribute(SEARCHES_ATTRIBUTE, 0);
    api.persistAttribute(PEARLS_ATTRIBUTE, 0);
    api.persistAttribute(SETTINGS_ATTRIBUTE, {});
    // Own the currency Shopkeeper's point-currency convention would otherwise create. This
    // plugin loads after Shopkeepers (dependsOn) so its handler is the one left registered.
    api.registerShopCurrency(PEARL_CURRENCY, pearlCurrency);
    api.onPlayerLogin(login);
  },
};
