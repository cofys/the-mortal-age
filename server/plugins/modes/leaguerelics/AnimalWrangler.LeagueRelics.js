/**
 * Animal Wrangler (https://oldschool.runescape.wiki/w/Animal_Wrangler_(Raging_Echoes_League)),
 * Raging Echoes' tier 1 relic: the Echo harpoon (a crystal harpoon with no requirement, in
 * Fishing's own table) that stands in for any fishing tool (bait still needed), a failed catch's
 * second 50% chance, catches a tick faster, fish straight to the bank (not karambwanji), half of
 * them cooked on the way when the harpoon says so (not the big trophy fish), food that never
 * burns, Hunter catches that never fail, box traps that lure faster (ours: every 2 ticks) with
 * double loot and XP, and impling jars that never break.
 */
const Common = require("./Common.LeagueRelics");
const EchoTool = require("./EchoTool.LeagueRelics");

let api;
let core;
let effect;
let unbanked;
let uncooked;

function active(player) {
  return Common.effectActive(player, effect);
}

/** The harpoon's fishing effects need the harpoon, carried or wielded (Wiki); the Hunter and Cooking ones do not. */
function withTool(player) {
  return active(player) && EchoTool.holdsTool(core, player, effect);
}

function ids(names) {
  return new Set(names.map((name) => core.ItemIdentifiers[name]).filter(Number.isInteger));
}

function secondChance(request) {
  if (!request.success && withTool(request.player) && Math.random() < effect.secondChance) request.success = true;
}

/** No tool for this spot? The Echo harpoon in hand is one. */
function tool(request) {
  if (request.variant || !withTool(request.player)) return;
  request.variant = { ids: [core.ItemIdentifiers[effect.tool]], level: 1, bonus: effect.harpoonBonus };
}

function interval(request) {
  if (withTool(request.player)) request.ticks -= effect.ticksFaster;
}

/** The catch goes to the bank, cooked half the time when the harpoon says so. */
function gather(request) {
  const { player, itemId, amount } = request;
  if (request.stored >= amount || request.skill !== core.Skill.FISHING || !withTool(player)) return;
  if (!unbanked) {
    unbanked = ids(effect.unbanked);
    uncooked = ids(effect.uncooked);
  }
  if (unbanked.has(itemId)) return;
  let banked = itemId;
  let cooking = null;
  if (EchoTool.mode(player, effect) === "cook" && !uncooked.has(itemId) && Math.random() < effect.cookChance) {
    const cooked = { rawId: itemId, cookedId: null, xp: null };
    api.emitCustomEvent("cooking:cooked", cooked);
    if (cooked.cookedId) {
      banked = cooked.cookedId;
      cooking = cooked.xp;
    }
  }
  const fish = amount - request.stored;
  if (Common.bank(player, banked, fish)) {
    request.stored = amount;
    if (cooking > 0) player.getSkillManager().addExperiences(core.Skill.COOKING, cooking * fish);
    return;
  }
  // The cooked fish has no room: the catch itself, as it is.
  if (banked !== itemId && Common.bank(player, itemId, fish)) request.stored = amount;
}

/** Fishing's room (`storage:room` for Fishing only): the bank takes the catch (a cooked one falls back to it). */
function room(request) {
  if (request.room || request.skill !== core.Skill.FISHING || !withTool(request.player)) return;
  if (!unbanked) {
    unbanked = ids(effect.unbanked);
    uncooked = ids(effect.uncooked);
  }
  if (!unbanked.has(request.itemId) && Common.bankHasRoom(request.player, request.itemId)) request.room = true;
}

function neverBurns(request) {
  if (active(request.player)) request.burn = false;
}

function catchChance(request) {
  if (active(request.player)) request.chance = 1;
}

function boxRewards(request) {
  if (request.kind !== "box" || !active(request.player)) return;
  request.rewards = request.rewards.map(([id, count]) => [id, count * effect.boxTrapMultiplier]);
  request.xp *= effect.boxTrapMultiplier;
}

function boxLure(request) {
  if (request.kind === "box" && active(request.player)) request.ticks = effect.boxTrapLureTicks;
}

function jarKept(request) {
  if (active(request.player)) request.kept = true;
}

module.exports = function attach(pluginApi) {
  api = pluginApi;
  core = api.core;
  effect = Common.data.effects.animalWrangler;
  EchoTool.attach(api, effect);
  api.onCustomEvent("fishing:attempt", secondChance);
  api.onCustomEvent("fishing:tool", tool);
  api.onCustomEvent("fishing:interval", interval);
  api.onCustomEvent("storage:gather", gather);
  api.onCustomEvent("storage:room", room);
  api.onCustomEvent("cooking:burn", neverBurns);
  api.onCustomEvent("hunter:catch-chance", catchChance);
  api.onCustomEvent("hunter:rewards", boxRewards);
  api.onCustomEvent("hunter:lure-interval", boxLure);
  api.onCustomEvent("hunter:jar-kept", jarKept);
};
