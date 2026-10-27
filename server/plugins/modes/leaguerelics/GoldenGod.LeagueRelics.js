/**
 * Golden God (https://oldschool.runescape.wiki/w/Golden_God_(Raging_Echoes_League)), Raging Echoes'
 * tier 4 relic:
 * - High and Low Level Alchemy need no runes and no Magic level, give 15% more coins, keep the item
 *   65% of the time, and cast again on what is left in the slot until the stack is gone or moved
 *   (walking and attacking do not stop it). A cast another plugin has turned into something else
 *   (Mage Training Arena's coins, a quest item) gets only the free runes and the level.
 * - 20,000 coins are offered on an altar as one dragon bone, with the altar's own experience (any
 *   altar one prays at gives the bone's burying experience), repeating while the coins last.
 * - What the coin shops sell (Fire Sale's shops) comes noted when it can be (ours: always on).
 * Not here: the casting pauses during production skilling (the Wiki's), which needs a skilling
 * state this server does not keep.
 */
const Common = require("./Common.LeagueRelics");

let core;
let effect;

function active(player) {
  return Common.effectActive(player, effect);
}

function alchemy(policy) {
  if (!active(policy.player)) return;
  policy.requiredLevel = 0;
  policy.freeRunes = true;
  if (!policy.allowed || !(policy.coins > 0)) return;
  // In hundredths, so 100 coins give 115 (1.15 itself is not exact in floating point).
  policy.coins = Math.floor((policy.coins * Math.round(effect.coinMultiplier * 100)) / 100);
  policy.keepItem = Math.random() < effect.keepChance;
  policy.recast = true;
}

function coinOffering(request) {
  if (request.itemId !== core.ItemIdentifiers.COINS || !active(request.player)) return;
  request.boneItemId = core.ItemIdentifiers[effect.offeringBone];
  request.cost = effect.offeringCost;
  request.anyAltar = true;
}

function deliverNoted(request) {
  if (request.currency === effect.currency && active(request.player)) request.deliverId = Common.noted(request.deliverId);
}

module.exports = function attach(api) {
  core = api.core;
  effect = Common.data.effects.goldenGod;
  api.onCustomEvent("magic:alchemy-policy", alchemy);
  api.onCustomEvent("bone-altars:offering", coinOffering);
  api.onCustomEvent("shop:delivery", deliverNoted);
};
