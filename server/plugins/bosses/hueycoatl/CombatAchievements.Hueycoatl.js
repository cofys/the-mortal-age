/**
 * The Hueycoatl's Combat Achievements the fight decides (task names and descriptions from the
 * cache, enums 3981-3986). Champion, Adept and Veteran finish from the kill count.
 *
 * - You're a wizard: every hit on her parts an earth spell.
 * - Is it a bird?: every hit with dragonbane weaponry (the dragon hunter weapons).
 * - Pillar Lover: the kill with the braziers lit ("whilst it is vulnerable").
 * - I'm your son: two pieces of Hueycoatl hide armour worn at the kill.
 * - Speed-Trialist / Speed-Chaser / Speed-Runner: 2:30 (250 ticks), the last two with five or
 *   three players or fewer in the arena.
 * - Perfect Hueycoatl: five kills in a row without leaving and without avoidable damage
 *   (lightning, the tail's slam, an off-prayer feather). The streak is what the slope's
 *   "Leave the encounter?" warning counts.
 */
const Shared = require("./Shared.Hueycoatl");

const SPEED_TICKS = 250;
const CHASER_TEAM = 5;
const RUNNER_TEAM = 3;
const PERFECT_KILLS = 5;
const ARMOUR_PIECES = 2;
const ARMOUR_PREFIX = "hueycoatl hide ";
const DRAGONBANE_PREFIX = "dragon hunter ";

let api = null;
let core = null;
/** player -> what this fight has seen of them. */
const fights = new WeakMap();

function stateOf(player) {
  if (!fights.has(player)) fights.set(player, { avoidable: false, notEarth: false, notDragonbane: false, hits: 0 });
  return fights.get(player);
}

function complete(player, task) {
  api.emitCustomEvent("combat-achievements:complete", { player, task });
}

/** A fresh fight for the player (they arrived, or the set respawned). */
function started(player) {
  fights.set(player, { avoidable: false, notEarth: false, notDragonbane: false, hits: 0 });
}

/** Leaving the encounter ends the perfect streak. */
function left(player) {
  player.setAttribute(Shared.STREAK_ATTRIBUTE, 0);
  fights.delete(player);
}

function avoidable(player) {
  stateOf(player).avoidable = true;
}

function itemName(item) {
  return item && item.getId() > 0 ? (core.ItemDefinition.forId(item.getId())?.getName?.() ?? "").toLowerCase() : "";
}

function isEarthSpell(spell) {
  const { CombatSpells } = core;
  return spell != null && [CombatSpells.EARTH_STRIKE, CombatSpells.EARTH_BOLT, CombatSpells.EARTH_BLAST,
    CombatSpells.EARTH_WAVE, CombatSpells.EARTH_SURGE].includes(spell);
}

/** A landed hit on one of her parts. */
function damaged(player, hit) {
  const state = stateOf(player);
  state.hits += 1;
  if (!isEarthSpell(hit.getSpell())) state.notEarth = true;
  if (!itemName(player.getEquipment().getItems()[core.Equipment.WEAPON_SLOT]).startsWith(DRAGONBANE_PREFIX)) {
    state.notDragonbane = true;
  }
}

function armourPieces(player) {
  return player.getEquipment().getItems().filter((item) => itemName(item).startsWith(ARMOUR_PREFIX)).length;
}

function killed(player, session, ticks, team) {
  const state = stateOf(player);
  if (ticks <= SPEED_TICKS) {
    complete(player, "Hueycoatl Speed-Trialist");
    if (team <= CHASER_TEAM) complete(player, "Hueycoatl Speed-Chaser");
    if (team <= RUNNER_TEAM) complete(player, "Hueycoatl Speed-Runner");
  }
  if (session.pillars?.lit) complete(player, "Pillar Lover");
  if (armourPieces(player) >= ARMOUR_PIECES) complete(player, "I'm your son");
  if (state.hits > 0 && !state.notEarth) complete(player, "You're a wizard");
  if (state.hits > 0 && !state.notDragonbane) complete(player, "Is it a bird?");
  const streak = state.avoidable ? 0 : Shared.counter(player, Shared.STREAK_ATTRIBUTE) + 1;
  player.setAttribute(Shared.STREAK_ATTRIBUTE, streak);
  if (streak >= PERFECT_KILLS) complete(player, "Perfect Hueycoatl");
  started(player);
}

function attach(pluginApi) {
  api = pluginApi;
  core = pluginApi.core;
  pluginApi.persistAttribute(Shared.STREAK_ATTRIBUTE, 0);
}

module.exports = { attach, started, left, avoidable, damaged, killed, _test: { isEarthSpell } };
