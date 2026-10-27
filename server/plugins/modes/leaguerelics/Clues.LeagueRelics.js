/**
 * The clue scroll perks Treasure Seeker (Trailblazer Reloaded) and Treasure Arbiter (Raging
 * Echoes) share (Wiki): a clue-dropping NPC and an impling jar give each of their clue scrolls at
 * least 1 time in 15, clue nests, geodes and bottles come 10 times as often, every trail has its
 * tier's fewest steps, and every reward casket rolls its tier's most times.
 */
const Common = require("./Common.LeagueRelics");

const CLUE_SCROLL = /^clue scroll \(/i;

module.exports = function attachClues(api, effect) {
  const active = (player) => Common.effectActive(player, effect);
  api.onCustomEvent("npc-drops:tertiary-chance", (request) => {
    if (Array.isArray(request.rules) && active(request.player)) request.rules.push({ pattern: CLUE_SCROLL, outOf: effect.clueOneIn });
  });
  api.onCustomEvent("hunter:impling-clue-chance", (request) => {
    if (active(request.player)) request.oneIn = Math.min(request.oneIn, effect.clueOneIn);
  });
  api.onCustomEvent("treasure-trails:vessel-chance", (request) => {
    if (active(request.player)) request.multiplier *= effect.vesselMultiplier;
  });
  api.onCustomEvent("treasure-trails:trail-length", (request) => {
    if (active(request.player)) request.length = request.minimum;
  });
  api.onCustomEvent("treasure-trails:casket-rolls", (request) => {
    if (active(request.player)) request.rolls = request.maximum;
  });
};
