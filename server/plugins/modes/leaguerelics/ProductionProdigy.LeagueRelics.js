/**
 * Production Prodigy (https://oldschool.runescape.wiki/w/Production_Prodigy_(Trailblazer_Reloaded_League)),
 * Trailblazer Reloaded's tier 1 relic: Crafting, Smithing, Herblore, Fletching and Cooking are
 * boosted by 12 (invisible here: it counts wherever those skills check their level), the Wiki's
 * listed activities make everything at once with full XP, and each product has a 25% chance of
 * another, sent to the bank with its XP.
 */
const Common = require("./Common.LeagueRelics");

let core;
let effect;
let skills;

function active(player) {
  return Common.effectActive(player, effect);
}

function boosted(skill) {
  if (!skills) skills = new Set(effect.skills.map((name) => core.Skill[name]).filter(Boolean));
  return skills.has(skill);
}

function levelBoost(request) {
  if (boosted(request.skill) && active(request.player)) request.boost += effect.levelBoost;
}

function allAtOnce(request) {
  if (!active(request.player)) return;
  const actions = Common.batchActions(effect, request);
  if (actions) request.actions = Math.max(request.actions, actions);
}

/** A 25% chance of the same product again, banked (only when the bank has room), with its XP. */
function extraProduct({ player, skill, itemId, amount, xp }) {
  if (!boosted(skill) || !active(player) || Math.random() >= effect.extraChance) return;
  if (!Common.bank(player, itemId, amount)) return;
  if (xp > 0) player.getSkillManager().addExperiences(skill, xp);
}

module.exports = function attach(api) {
  core = api.core;
  effect = Common.data.effects.productionProdigy;
  api.onCustomEvent("skills:level-boost", levelBoost);
  api.onCustomEvent("skills:actions-per-cycle", allAtOnce);
  api.onCustomEvent("skills:produced", extraProduct);
};
