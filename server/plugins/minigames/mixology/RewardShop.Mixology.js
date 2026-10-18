"use strict";

/**
 * Mixology Rewards: Supervisor Lalo's omnishop (DB row mixology_rewards), paid for in Mox, Aga
 * and Lye resin (varps 4416, 4415, 4414). The Omnishop plugin runs the interface; this unit
 * answers its three currencies, the info panel's descriptions (data/mastering-mixology.json,
 * as live sends them) and the potion storage unlock.
 *
 * - Potion storage is an unlock, not an item (its stock obj is mm_potion_storage_unlock_dummy):
 *   buying it sets varbit 11295 and "<col=06600c>You have unlocked potion storage within the
 *   bank!"; owned already, "<col=e00a19>You have already unlocked potion storage." (rsprox
 *   captures). The bank section itself is a later change.
 * - The other rewards are handed over as items; what they do is a later change too.
 */

const Shared = require("./Shared.Mixology");

const SHOP = "mixology_rewards";
const CURRENCY = {
  omnishop_currency_mixology_mox: "mox",
  omnishop_currency_mixology_aga: "aga",
  omnishop_currency_mixology_lye: "lye",
};
const POTION_STORAGE_STOCK = "mixology_stock_potion_storage";
const MESSAGE = {
  UNLOCKED: "You have unlocked potion storage within the bank!",
  ALREADY: "You have already unlocked potion storage.",
};

function open(player) {
  Shared.api().emitCustomEvent("omnishop:open", { player, shop: SHOP, handled: false });
}

function currency(request) {
  if (request.shop !== SHOP) return;
  const name = Shared.core().CacheDefinitions.getDbRowName(request.currency);
  const reagent = CURRENCY[name];
  if (!reagent) return;
  const { player } = request;
  request.balance = Shared.resin(player, reagent);
  request.set = (value) => Shared.setResin(player, reagent, value);
}

function describe(request) {
  if (request.shop !== SHOP) return;
  request.description = Shared.DATA.shopDescriptions[request.stock] ?? request.description;
}

function isPotionStorage(request) {
  return request.shop === SHOP && request.stock === POTION_STORAGE_STOCK;
}

function canBuy(request) {
  if (!isPotionStorage(request)) return;
  request.unlock = true;
  if (Shared.get(request.player, Shared.VARBIT.POTION_STORAGE) !== 1) return;
  request.cancel = true;
  request.player.sendMessage(`<col=${Shared.colours(request.player).lye}>${MESSAGE.ALREADY}`);
}

function purchase(request) {
  if (!isPotionStorage(request)) return;
  const { player } = request;
  request.handled = true;
  Shared.set(player, Shared.VARBIT.POTION_STORAGE, 1);
  player.sendMessage(`<col=${Shared.colours(player).aga}>${MESSAGE.UNLOCKED}`);
}

module.exports = function attachRewardShop(api) {
  api.onCustomEvent("omnishop:currency", currency);
  api.onCustomEvent("omnishop:describe", describe);
  api.onCustomEvent("omnishop:can-buy", canBuy);
  api.onCustomEvent("omnishop:purchase", purchase);
};

Object.assign(module.exports, { open, SHOP });
