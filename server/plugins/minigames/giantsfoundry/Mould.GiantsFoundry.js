"use strict";

/**
 * The mould jig and its setup interface (718).
 *
 * The parts, their levels and their stats are the cache's own: enums 4373 (forte), 4374 (blade)
 * and 4375 (tip) list each part's struct, which carries its name (param 1621), Smithing level
 * (1622) and stats on the Broad-Narrow (1625), Heavy-Light (1626) and Spiked-Flat (1627)
 * axes. The client's scripts read the same data; the server checks a pick as script 6100 does
 * (bought and high enough level) and echoes it into the selection varbits (rsprox captures:
 * each click is answered with its varbit on the same tick).
 *
 * - Tabs: side_menu (718:12) sub / 9 is the tab, 0 forte, 1 blade, 2 tip.
 * - Parts: content (718:9) sub / 17 + 1 is the part's index in the tab's enum (script 6098).
 * - Set (718:6) needs all three parts and a commission; it sets the jig up (mould_state 0 -> 1).
 */

const Shared = require("./Shared.GiantsFoundry");

const TABS = [
  { varbit: Shared.VARBIT.MOULD_FORTE, enumId: 4373, firstLocked: 4297, unlockFirst: Shared.VARBIT.UNLOCK_FORTE_FIRST },
  { varbit: Shared.VARBIT.MOULD_BLADE, enumId: 4374, firstLocked: 4308, unlockFirst: Shared.VARBIT.UNLOCK_BLADE_FIRST },
  { varbit: Shared.VARBIT.MOULD_TIP, enumId: 4375, firstLocked: 4319, unlockFirst: Shared.VARBIT.UNLOCK_TIP_FIRST },
];
/** Five moulds of each kind are bought from Kovac (script 6099); the rest are there from the start. */
const LOCKED_PER_TAB = 5;

const PARAM = { NAME: 1621, LEVEL: 1622, BROAD: 1625, HEAVY: 1626, SPIKED: 1627 };
/** Commission words (enum 4372): 1-3 read an axis' negative end, 4-6 its positive end. */
const WORD_AXIS = [null, PARAM.BROAD, PARAM.HEAVY, PARAM.SPIKED, PARAM.BROAD, PARAM.HEAVY, PARAM.SPIKED];

const COMPONENT = { RESET: 5, SET: 6, CONTENT: 9, SIDE_MENU: 12 };
const SIDE_MENU_PER_TAB = 9;
const CONTENT_PER_PART = 17;
const SIDE_MENU_LAST = 63;
const CONTENT_LAST = 544;
const IF_EVENT_OP1 = 1 << 1;
const SCRIPT_MAINMODAL_OPEN = 2524;

const MESSAGE = {
  NO_COMMISSION: "You need a commission before you can set up the mould.",
  TALK_TO_KOVAC: "Maybe I should talk with Kovac first before messing around with anything.",
};

let parts = null;

/** Each tab's parts by index (1-based, as the enums and selection varbits count them). */
function allParts() {
  if (parts) return parts;
  const { CacheDefinitions } = Shared.core();
  parts = TABS.map((tab) => {
    const byIndex = new Map();
    for (const [index, structId] of CacheDefinitions.getEnumValues(tab.enumId)) {
      const params = CacheDefinitions.getStructParams(Number(structId));
      byIndex.set(Number(index), {
        index: Number(index),
        structId: Number(structId),
        name: String(params.get(PARAM.NAME) ?? ""),
        level: Number(params.get(PARAM.LEVEL)) || 1,
        stats: {
          [PARAM.BROAD]: Number(params.get(PARAM.BROAD)) || 0,
          [PARAM.HEAVY]: Number(params.get(PARAM.HEAVY)) || 0,
          [PARAM.SPIKED]: Number(params.get(PARAM.SPIKED)) || 0,
        },
      });
    }
    return byIndex;
  });
  return parts;
}

function part(tab, index) {
  return allParts()[tab]?.get(index) ?? null;
}

/** The unlock varbit a bought mould sets, or null for a part every player has (script 6099). */
function unlockVarbit(tab, structId) {
  const spec = TABS[tab];
  const offset = structId - spec.firstLocked;
  return offset >= 0 && offset < LOCKED_PER_TAB ? spec.unlockFirst + offset : null;
}

function isUnlocked(player, tab, structId) {
  const varbit = unlockVarbit(tab, structId);
  return varbit === null || Shared.get(player, varbit) !== 0;
}

/** Script 6100: a part can be picked once bought and with the Smithing level for it. */
function canUse(player, tab, candidate) {
  return candidate !== null && isUnlocked(player, tab, candidate.structId)
    && Shared.currentLevel(player, "SMITHING") >= candidate.level;
}

/** Script 6105: one part's score for one commission word. */
function wordScore(candidate, word) {
  const axis = WORD_AXIS[word];
  if (!axis || !candidate) return 0;
  const value = candidate.stats[axis];
  if (word <= 3) return value < 0 ? -value : 0;
  return value > 0 ? value : 0;
}

/** The mould's score for the commission: every selected part's match with both words. */
function score(selection, words) {
  let total = 0;
  for (let tab = 0; tab < TABS.length; tab++) {
    const candidate = part(tab, selection[tab]);
    for (const word of words) total += wordScore(candidate, word);
  }
  return total;
}

function selectionOf(player) {
  return TABS.map((tab) => Shared.get(player, tab.varbit));
}

function playerScore(player) {
  const words = [Shared.get(player, Shared.VARBIT.COMMISSION_WORD_1), Shared.get(player, Shared.VARBIT.COMMISSION_WORD_2)];
  return score(selectionOf(player), words);
}

function clearSelection(player) {
  for (const tab of TABS) Shared.set(player, tab.varbit, 0);
}

function hasCommission(player) {
  return Shared.get(player, Shared.VARBIT.COMMISSION_WORD_1) !== 0;
}

function open(player) {
  const sender = player.getPacketSender();
  const group = Shared.INTERFACE.MOULD;
  sender.sendInterfaceScript(SCRIPT_MAINMODAL_OPEN, [-1, -3]);
  sender.sendInterface(group);
  sender.sendInterfaceFlagsRange((group << 16) | COMPONENT.SIDE_MENU, 0, SIDE_MENU_LAST, IF_EVENT_OP1);
  sender.sendInterfaceFlagsRange((group << 16) | COMPONENT.CONTENT, 0, CONTENT_LAST, IF_EVENT_OP1);
}

function isOpen(player) {
  return player.getInterfaceId() === Shared.INTERFACE.MOULD;
}

function setupJig({ player }) {
  if (!Shared.questComplete(player)) {
    Shared.playerSays(player, MESSAGE.TALK_TO_KOVAC);
    return;
  }
  open(player);
}

/** "Check" on a jig already set up shows the setup again (no capture of this option). */
function checkJig({ player }) {
  if (!Shared.questComplete(player)) return false;
  open(player);
  return true;
}

function selectTab({ player, slot }) {
  if (!isOpen(player)) return;
  const tab = Math.floor(Number(slot) / SIDE_MENU_PER_TAB);
  if (tab < 0 || tab >= TABS.length) return;
  Shared.set(player, Shared.VARBIT.MOULD_TAB, tab);
}

function selectPart({ player, slot }) {
  if (!isOpen(player) || Shared.get(player, Shared.VARBIT.MOULD_STATE) !== 0) return;
  const tab = Shared.get(player, Shared.VARBIT.MOULD_TAB);
  const index = Math.floor(Number(slot) / CONTENT_PER_PART) + 1;
  const candidate = part(tab, index);
  if (!canUse(player, tab, candidate)) return;
  Shared.set(player, TABS[tab].varbit, index);
}

function reset({ player }) {
  if (!isOpen(player) || Shared.get(player, Shared.VARBIT.MOULD_STATE) !== 0) return;
  clearSelection(player);
}

function setMould({ player }) {
  if (!isOpen(player)) return;
  if (!hasCommission(player)) {
    player.getPacketSender().sendInterfaceRemoval();
    Shared.statement(player, MESSAGE.NO_COMMISSION);
    return;
  }
  const selection = selectionOf(player);
  if (selection.some((index, tab) => !canUse(player, tab, part(tab, index)))) return;
  if (Shared.get(player, Shared.VARBIT.MOULD_STATE) === 0) Shared.set(player, Shared.VARBIT.MOULD_STATE, 1);
  player.getPacketSender().sendInterfaceRemoval();
  Shared.step(player, "mould-set");
}

module.exports = function attachMould(api) {
  const group = Shared.INTERFACE.MOULD << 16;
  api.onObjectInteraction("Mould jig (Empty)", { Setup: setupJig });
  api.onObjectInteraction("Mould jig (Setup)", { Check: checkJig });
  api.onInterfaceActionButton(group | COMPONENT.SIDE_MENU, selectTab);
  api.onInterfaceActionButton(group | COMPONENT.CONTENT, selectPart);
  api.onInterfaceActionButton(group | COMPONENT.RESET, reset);
  api.onInterfaceActionButton(group | COMPONENT.SET, setMould);
};

Object.assign(module.exports, {
  TABS, allParts, part, unlockVarbit, isUnlocked, wordScore, score, selectionOf, playerScore, clearSelection,
  hasCommission, MESSAGE,
});
