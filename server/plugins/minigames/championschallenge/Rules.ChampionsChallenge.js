"use strict";

/**
 * Each champion's rule (Wiki, Champions' Challenge; Larxus's rule lines in his transcript):
 * - combat styles ("only Melee", "no Magic", ...): an attack in another style is refused with a
 *   game message and Larxus reminding the player, as captured for the Giant: "You're only allowed
 *   to use Melee in this duel!" and "I believe I mentioned you're only allowed to use Melee in this
 *   duel." The "not allowed" wording follows the Wiki's Earth Warrior line;
 * - no Prayer (Earth Warrior) and no special attacks (Imp): prayers are turned off on the way
 *   down, and turning one on again is refused the same way;
 * - what may be carried (Ghoul: a weapon equipped and nothing carried; Lesser Demon: no weapons,
 *   armour or materials; Leon d'Cour: only what is worn): the statue refuses anything else with
 *   Larxus's transcript line, and equipping armour or a weapon in the fight is refused (Wiki,
 *   Lesser Demon Champion).
 * Rules apply in the arena of a basement with that champion's challenge on.
 */
const Common = require("./Common.ChampionsChallenge");

const STYLES = Object.freeze({ Melee: "MELEE", Ranged: "RANGED", Magic: "MAGIC" });

/** Larxus's statue lines (transcript variants) for what a fight forbids carrying. */
const CARRY_REFUSALS = Object.freeze({
  weapons: "climbing-down-the-champion-statue-attempting-to-enter-the-fight-with-the-ghoul-champion-with-items-other-than-a-weapon",
  noEquipment: "climbing-down-the-champion-statue-attempting-to-enter-the-fight-with-the-lesser-demon-champion-with-weapons-or-armour",
  materials: "climbing-down-the-champion-statue-attempting-to-enter-the-fight-with-the-lesser-demon-champion-with-materials-to-make-weapons-or-armour",
  wornOnly: "climbing-down-the-champion-statue-attempting-to-enter-the-fight-with-the-human-champion-with-any-unequipped-item",
});

const WEAPON_MESSAGE = "You're not supposed to be using any weapons!";
const ARMOUR_MESSAGE = "You're not supposed to be using any armour!";

/**
 * The Lesser Demon refuses the materials used to make equipment as well as the equipment
 * itself (Wiki), including the fletching supplies it names. The cache's item categories catch
 * logs, ores, bars and arrow/bolt tips; the rest are named materials and the tools that work
 * them. Runes and potions are absent on purpose: the Wiki's strategy is to take those in.
 */
const MATERIAL_CATEGORY = Object.freeze({ LOGS: 22, ORE: 91, BAR: 151, BOLT_TIPS: 530, FEATHER: 532, ARROW_TIPS: 968, KNIFE: 2178 });
const MATERIAL_CATEGORIES = new Set(Object.values(MATERIAL_CATEGORY));
const MATERIAL_NAME = /(?:\b(?:logs?|ore|bars?|arrowtips?|bolt tips?|dragonhide|cowhide|dragon leather|leather|hides?|flax|wool|bow string|arrow shaft|headless arrow|unfinished|knife|chisel|hammer|needle|thread|mould|glassblowing pipe|feather)\b|\(u\))/i;
const ALSO_REFUSED_ITEMS = new Set(["imbued heart", "saturated heart"]);

/** The session `player` is fighting in, or null. Required lazily: the gallery requires this file. */
function fightOf(player) {
  const session = require("./Gallery.ChampionsChallenge").sessionOf(player);
  return session?.challenge && session.inArena(player.getLocation()) ? session : null;
}

const slotOf = (item) => item?.getDefinition?.()?.getEquipmentType?.()?.getSlot?.() ?? -1;
const isWeapon = (item) => slotOf(item) === Common.core.Equipment.WEAPON_SLOT;
const isEquipment = (item) => slotOf(item) >= 0;

const nameOf = (item) => String(item?.getDefinition?.()?.getName?.() ?? "").toLowerCase();

/** A weapon's or armour's ingredients, or a tool for working them (Wiki: Lesser Demon Champion). */
function isEquipmentMaterial(item) {
  const id = item?.getId?.();
  const category = Number.isInteger(id) ? Common.core.CacheDefinitions?.getItem?.(id)?.category : -1;
  if (MATERIAL_CATEGORIES.has(category)) return true;
  return MATERIAL_NAME.test(nameOf(item));
}

/** The imbued heart is equipment in all but name for this fight (Wiki). */
const isAlsoRefused = (item) => ALSO_REFUSED_ITEMS.has(nameOf(item));

/** Tells the player off, as the captured Giant fight does: a game message and Larxus's line. */
function remind(player, phrase) {
  player.sendMessage(`You're ${phrase} in this duel!`);
  Common.larxusSays(player, `I believe I mentioned you're ${phrase} in this duel.`);
}

/** The rule phrase for an attack style, or null when the champion allows it. */
function styleRefusal(champion, type) {
  const { only, not } = champion.rule;
  const { CombatType } = Common.core;
  if (only && type !== CombatType[STYLES[only]]) return `only allowed to use ${only}`;
  if (not && type === CombatType[STYLES[not]]) return `not allowed to use ${not}`;
  return null;
}

/** The area's say on an attack in the arena: the champion's style rule. */
function canAttack(session, attacker, target, method) {
  if (!session?.challenge || !attacker?.isPlayer?.() || target !== session.champion || !method?.type) return null;
  const phrase = styleRefusal(session.challenge, method.type());
  if (!phrase) return null;
  remind(attacker.getAsPlayer(), phrase);
  return false;
}

/** The statue's refusal (a transcript variant) for what the player carries, or null. */
function entryRefusal(champion, player) {
  const carry = champion.rule.carry;
  if (!carry) return null;
  const worn = player.getEquipment().getValidItems();
  const carried = player.getInventory().getValidItems();
  if (carry === "weapons") {
    // Wiki (Champions' Challenge and Ghoul Champion): only a weapon equipped, empty inventory.
    const allowed = worn.every(isWeapon) && carried.length === 0;
    return allowed ? null : CARRY_REFUSALS.weapons;
  }
  if (carry === "noEquipment") {
    // Wiki (Lesser Demon Champion): no weapons or armour, and no materials to make them.
    if (worn.length > 0 || carried.some(isEquipment)) return CARRY_REFUSALS.noEquipment;
    if (carried.some(isEquipmentMaterial) || carried.some(isAlsoRefused)) return CARRY_REFUSALS.materials;
    return null;
  }
  return carried.length === 0 ? null : CARRY_REFUSALS.wornOnly;
}

/** On the way down: prayers off for the Earth Warrior, the special attack bar off for the Imp. */
function prepare(champion, player) {
  const { CombatSpecial, PrayerHandler } = Common.core;
  if (champion.rule.prayer) PrayerHandler.resetAll(player);
  if (champion.rule.special && player.isSpecialActivated()) {
    player.setSpecialActivated(false);
    CombatSpecial.updateBar(player);
  }
}

function noPrayer(event) {
  const session = fightOf(event.player);
  if (!session?.challenge.rule.prayer) return;
  event.disabled = true;
  event.message = "You're not allowed to use Prayer in this duel!";
  Common.larxusSays(event.player, "I believe I mentioned you're not allowed to use Prayer in this duel.");
}

function noSpecialAttack(event) {
  const session = fightOf(event.player);
  if (!session?.challenge.rule.special) return;
  event.disabled = true;
  event.message = "You're not allowed to use Special Attacks in this duel!";
  Common.larxusSays(event.player, "I believe I mentioned you're not allowed to use Special Attacks in this duel.");
}

/** Wiki (Lesser Demon Champion): equipment smuggled in can't be put on. */
function equipRule(event) {
  const session = fightOf(event.player);
  const carry = session?.challenge.rule.carry;
  if (carry !== "noEquipment" && carry !== "weapons") return;
  const weapon = event.slot === Common.core.Equipment.WEAPON_SLOT;
  if (carry === "weapons" && weapon) return;
  event.allow = false;
  event.player.sendMessage(weapon ? WEAPON_MESSAGE : ARMOUR_MESSAGE);
}

function attachRules(api) {
  api.onPrayerDisabled(noPrayer);
  api.onSpecialAttackDisabled(noSpecialAttack);
  api.onCanEquip(equipRule);
}

module.exports = { attachRules, canAttack, entryRefusal, isEquipmentMaterial, prepare, styleRefusal };
