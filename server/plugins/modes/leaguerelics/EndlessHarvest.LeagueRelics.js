/**
 * Endless Harvest (https://oldschool.runescape.wiki/w/Endless_Harvest_(Trailblazer_Reloaded_League)),
 * Trailblazer Reloaded's tier 1 relic: what Mining, Woodcutting and Fishing gather is doubled, with
 * the experience of the second resource, and goes straight to the bank (the inventory when the
 * bank is full). It hears the skills' `storage:gather` (with the skill and the resource's XP) and
 * `storage:room`, so a full inventory does not stop the gathering. What an open container (a coal
 * bag) already took stays there; the rest and the extra go to the bank.
 */
const Common = require("./Common.LeagueRelics");

let core;
let effect;
let skills;

function active(player) {
  return Common.effectActive(player, effect);
}

function harvested(skill) {
  if (!skills) skills = new Set(effect.skills.map((name) => core.Skill[name]).filter(Boolean));
  return skills.has(skill);
}

/**
 * Twice the resource: what is left after any open container, and the extra, to the bank when it has
 * room, else the inventory takes what fits. The extra pays its XP only when it was placed.
 */
function gather(request) {
  const { player, itemId, amount, skill, xp } = request;
  if (!harvested(skill) || !active(player)) return;
  const left = Math.max(0, amount - request.stored);
  const extra = amount * (effect.multiplier - 1);
  let placed = 0;
  if (Common.bank(player, itemId, left + extra)) {
    request.stored = amount;
    placed = extra;
  } else {
    placed = Math.max(0, Math.min(extra, player.getInventory().getAddableAmount(new core.Item(itemId, left + extra)) - left));
    if (placed > 0) player.getInventory().adds(itemId, placed);
  }
  if (placed > 0 && xp > 0) player.getSkillManager().addExperiences(skill, (xp * placed) / amount);
}

/** `storage:room`: the bank's room counts, so a full inventory keeps gathering. */
function room(request) {
  if (!request.room && active(request.player) && Common.bankHasRoom(request.player, request.itemId)) request.room = true;
}

module.exports = function attach(api) {
  core = api.core;
  effect = Common.data.effects.endlessHarvest;
  api.onCustomEvent("storage:gather", gather);
  api.onCustomEvent("storage:room", room);
};
