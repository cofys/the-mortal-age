/**
 * Fire Sale (https://oldschool.runescape.wiki/w/Fire_Sale), Trailblazer Reloaded's tier 3 relic:
 * every shop with the standard shop interface that takes coins sells for nothing (its stock still
 * limits what can be bought), what it sells comes noted when it can be (the Wiki's toggle has no
 * button in this interface: ours, always on), and shops no longer buy anything for coins. Tokkul
 * and the other currencies are untouched, as are costs outside shops.
 */
const Common = require("./Common.LeagueRelics");

let effect;

function applies(request) {
  return request.currency === effect.currency && Common.effectActive(request.player, effect);
}

function free(request) {
  if (applies(request)) request.price = 0;
}

function deliverNoted(request) {
  if (applies(request)) request.deliverId = Common.noted(request.deliverId);
}

function refuseSale(request) {
  if (request.player && applies(request)) request.sellable = false;
}

/** The shop shows nothing to be had for selling. */
function noSellPrice(request) {
  if (request.player && applies(request)) request.price = 0;
}

module.exports = function attach(api) {
  effect = Common.data.effects.fireSale;
  api.onCustomEvent("shop:buy-price", free);
  api.onCustomEvent("shop:delivery", deliverNoted);
  api.onCustomEvent("shop:can-sell", refuseSale);
  api.onCustomEvent("shop:sell-price", noSellPrice);
};
