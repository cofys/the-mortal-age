"use strict";

/**
 * Where a player's death storage lives, all in saved attributes:
 * - the grave: where it stands, what it holds, the time left, whether the fee is paid, and the
 *   inventory and equipment layout from before the death (for "Auto-equip & sort");
 * - Death's Office: up to 120 stacks from graves that collapsed;
 * - Death's Coffer: coins credited for sacrificed items;
 * - the grave style bought from Death, and whether the player has met him.
 */
const Common = require("./Common.Gravestones");

const GRAVE_ATTRIBUTE = "gravestones:grave";
const OFFICE_ATTRIBUTE = "gravestones:office";
const COFFER_ATTRIBUTE = "gravestones:coffer";
const STYLE_ATTRIBUTE = "gravestones:style";
const MET_DEATH_ATTRIBUTE = "gravestones:met-death";
const TUTORIAL_ATTRIBUTE = "gravestones:tutorial";

const STYLE = { BASIC: 0, ANGEL: 1 };

function grave(player) {
  const held = player.getAttribute(GRAVE_ATTRIBUTE);
  return held && Array.isArray(held.items) ? held : null;
}

function setGrave(player, held) {
  player.setAttribute(GRAVE_ATTRIBUTE, held ?? null);
  Common.api().emitCustomEvent("persistence:save", { player, reason: "grave-storage" });
}

/** Death's Office's 120 slots; a slot taken from stays empty (null), as live. */
function office(player) {
  const held = player.getAttribute(OFFICE_ATTRIBUTE);
  return Array.isArray(held) ? held : [];
}

function setOffice(player, records) {
  while (records.length > 0 && !records[records.length - 1]) records.pop();
  player.setAttribute(OFFICE_ATTRIBUTE, records.length > 0 ? records : null);
  Common.api().emitCustomEvent("persistence:save", { player, reason: "death-retrieval" });
}

/**
 * Sends `records` to Death's Office: onto a stack of the same item, else into the first empty
 * slot. It holds 120 stacks; "items from an expired gravestone [are] deleted when the limit is
 * reached" (Wiki: Death's Office).
 */
function sendToOffice(player, records) {
  if (records.length === 0) return;
  const held = office(player).slice();
  for (const entry of records) {
    const same = held.find((stack) => stack && Common.sameStack(stack, entry));
    if (same) {
      same.amount = Math.min(Common.MAX_STACK, same.amount + entry.amount);
      continue;
    }
    const empty = held.findIndex((stack) => !stack);
    if (empty >= 0) held[empty] = { ...entry };
    else if (held.length < Common.OFFICE_SLOTS) held.push({ ...entry });
  }
  setOffice(player, held);
}

function coffer(player) {
  return Math.max(0, Number(player.getAttribute(COFFER_ATTRIBUTE)) || 0);
}

function setCoffer(player, amount) {
  player.setAttribute(COFFER_ATTRIBUTE, Math.max(0, Math.trunc(amount)) || null);
  Common.api().emitCustomEvent("persistence:save", { player, reason: "death-coffer" });
}

function style(player) {
  return player.getAttribute(STYLE_ATTRIBUTE) === STYLE.ANGEL ? STYLE.ANGEL : STYLE.BASIC;
}

function setStyle(player, value) {
  player.setAttribute(STYLE_ATTRIBUTE, value === STYLE.ANGEL ? STYLE.ANGEL : null);
  Common.setVarbit(player, "type", style(player));
}

function metDeath(player) {
  return player.getAttribute(MET_DEATH_ATTRIBUTE) === true;
}

function setMetDeath(player) {
  player.setAttribute(MET_DEATH_ATTRIBUTE, true);
}

/** Set from the first death that loses items until the player leaves Death's Office. */
function inTutorial(player) {
  return player.getAttribute(TUTORIAL_ATTRIBUTE) === true;
}

function setTutorial(player, active) {
  player.setAttribute(TUTORIAL_ATTRIBUTE, active ? true : null);
}

function attach(api) {
  Common.bind(api);
  for (const key of [GRAVE_ATTRIBUTE, OFFICE_ATTRIBUTE, COFFER_ATTRIBUTE, STYLE_ATTRIBUTE, MET_DEATH_ATTRIBUTE, TUTORIAL_ATTRIBUTE]) {
    api.persistAttribute(key);
  }
}

module.exports = {
  attach, grave, setGrave, office, setOffice, sendToOffice, coffer, setCoffer, style, setStyle,
  metDeath, setMetDeath, inTutorial, setTutorial, STYLE,
};
