/**
 * Shattered Relics' minigame fragments: Barbarian Pest Wars, Rogues' Chompy Farm and Mother's Magic
 * Fossils (data/league-shattered.json `minigameEffects`; Wiki /Fragments). Each level's number in
 * the cache (Fragments.equippedValue) is the percent more a minigame pays (`minigame:points`: Pest
 * Control, Soul Wars, the Tithe Farm, the Mage Training Arena) or the percent likelier a find is
 * (`minigame:chance`: the Motherlode Mine's golden nuggets, Fossil Island's fossils). Rogues'
 * Chompy Farm also counts a chompy kill several times (`big-chompy-bird-hunting:kill-credit`).
 */
const Fragments = require("./Fragments.LeagueMode");
const { data } = require("./Shattered.LeagueMode");

function effects() {
  return data.minigameEffects;
}

/** The percent more an equipped fragment gives, the first whose `covers(effect)` is true, or null. */
function percentFor(player, covers) {
  for (const effect of Object.values(effects())) {
    if (!covers(effect)) continue;
    const percent = Fragments.equippedValue(player, effect.fragment);
    if (percent !== null) return percent;
  }
  return null;
}

/** `minigame:points` { player, minigame, points }: the points a minigame is about to award, raised. */
function morePoints(request) {
  if (!(request.points > 0)) return;
  const percent = percentFor(request.player, (effect) => effect.points?.includes(request.minigame));
  if (percent !== null) request.points = Math.floor((request.points * (100 + percent)) / 100);
}

function likelier(request) {
  const percent = percentFor(request.player, (effect) => effect.chances?.[request.minigame]?.includes(request.kind));
  if (percent !== null) request.multiplier *= (100 + percent) / 100;
}

/** A chompy kill counts 2, 3 or 4 times by the fragment's level. */
function chompyKills(request) {
  const effect = effects().roguesChompyFarm;
  const level = Fragments.equippedLevel(request.player, effect.fragment);
  if (level > 0) request.kills = Math.max(request.kills, effect.chompyKills[level - 1]);
}

module.exports = function attach(api) {
  api.onCustomEvent("minigame:points", morePoints);
  api.onCustomEvent("minigame:chance", likelier);
  api.onCustomEvent("big-chompy-bird-hunting:kill-credit", chompyKills);
};

module.exports._test = { morePoints, likelier, chompyKills };
