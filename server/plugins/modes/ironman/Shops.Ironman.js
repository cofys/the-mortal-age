/**
 * Where items come from other players or the server: an Ironman buys only a shop's own stock,
 * never what players sold to it (Wiki); no Grand Exchange (Wiki); no presets (this server's
 * loadouts).
 */
const Common = require("./Common.Ironman");

function buyLimit(request) {
  if (!Common.isIron(request.player)) return;
  const own = Math.min(request.available, request.original);
  if (own < request.limit) {
    request.limit = own;
    request.message = Common.message("shopStock");
  }
}

/** Presets (this server's PvP loadouts) hand out items, so an Ironman can't use them. */
function presets(request) {
  if (!Common.isIron(request.player)) return;
  request.allow = false;
  request.message = Common.message("presets");
}

function grandExchange(request) {
  if (!Common.isIron(request.player)) return;
  request.allow = false;
  request.message = Common.message("grandExchange");
}

module.exports = function attach(api) {
  api.onCustomEvent("shop:buy-limit", buyLimit);
  api.onCustomEvent("grand-exchange:can-open", grandExchange);
  api.onCustomEvent("presets:can-use", presets);
};
