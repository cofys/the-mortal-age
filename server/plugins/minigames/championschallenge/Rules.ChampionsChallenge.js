"use strict";

/**
 * Each champion's rule (Wiki, Champions' Challenge; Larxus's rule lines in his transcript):
 * - combat styles ("only Melee", "no Magic", ...): an attack in another style is refused with a
 *   game message and Larxus reminding the player, as captured for the Giant: "You're only allowed
 *   to use Melee in this duel!" and "I believe I mentioned you're only allowed to use Melee in this
 *   duel." The "not allowed" wording follows the Wiki's Earth Warrior line;
 * - no Prayer (Earth Warrior) and no special attacks (Imp): prayers are turned off on the way
 *   down, and turning one on again is refused the same way;
 * - what may be carried (Ghoul: weapons only; Lesser Demon: no weapons or armour; Leon d'Cour:
 *   only what is worn): the statue refuses anything else with Larxus's transcript line, and
 *   equipping armour or a weapon in the fight is refused (Wiki, Lesser Demon Champion).
 * Rules apply in the arena of a basement with that champion's challenge on.
 */
const Common = require("./Common.ChampionsChallenge");

const STYLES = Object.freeze({ Melee: "MELEE", Ranged: "RANGED", Magic: "MAGIC" });

/** Larxus's statue lines (transcript variants) for what a fight forbids carrying. */
const CARRY_REFUSALS = Object.freeze({
  weapons: "climbing-down-the-champion-statue-attempting-to-enter-the-fight-with-the-ghoul-champion-with-items-other-than-a-weapon",
  noEquipment: "climbing-down-the-champion-statue-attempting-to-enter-the-fight-with-the-lesser-demon-champion-with-weapons-or-armour",
  wornOnly: "climbing-down-the-champion-statue-attempting-to-enter-the-fight-with-the-human-champion-with-any-unequipped-item",
});

const WEAPON_MESSAGE = "You're not supposed to be using any weapons!";
const ARMOUR_MESSAGE = "You're not supposed to be using any armour!";

/** The session `player` is fighting in, or null. Required lazily: the gallery requires this file. */
function fightOf(player) {
  const session = require("./Gallery.ChampionsChallenge").sessionOf(player);
  return session?.challenge && session.inArena(player.getLocation()) ? session : null;
}

const slotOf = (item) => item?.getDefinition?.()?.getEquipmentType?.()?.getSlot?.() ?? -1;
const isWeapon = (item) => slotOf(item) === Common.core.Equipment.WEAPON_SLOT;
const isEquipment = (item) => slotOf(item) >= 0;

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
  const { Equipment } = Common.core;
  const worn = player.getEquipment().getValidItems();
  const carried = player.getInventory().getValidItems();
  const allowed =
    carry === "weapons" ? worn.every((item) => slotOf(item) === Equipment.WEAPON_SLOT) && carried.every(isWeapon)
      : carry === "noEquipment" ? worn.length === 0 && !carried.some(isEquipment)
        : carried.length === 0;
  return allowed ? null : CARRY_REFUSALS[carry];
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

module.exports = { attachRules, canAttack, entryRefusal, prepare, styleRefusal };
