"use strict";

/**
 * Kovac's reward shop (interface 753), paid for in Foundry Reputation (varp 3436).
 *
 * The stock is the cache's: enum 4379 lists each entry's struct, with its item (param 1636) or
 * mould (1637) and its cost (1638). The interface draws itself from those and the varps
 * (script 6083); the server keeps the selection (varp 3435), the filter (varbit 13915), the
 * points and the bought moulds' varbits right.
 *
 * rsprox captures (recording 96):
 * - Shop (op5) opens 753 after toplevel_mainmodal_open, sets OP1-4 on the list (0-312) and OP1
 *   on the filter dropdown (0-12), then runs reward_shop_init.
 * - A list entry is 13 components: op1 on sub s selects entry s / 13 + 1 (varp 3435). For
 *   items, op2-op4 buy 1, 5 or 10 straight away.
 * - Buy (753:15) buys the selected entry. An item: varp 3436 drops, "Kovac hands you your
 *   reward." and synth 2114. A mould: its unlock varbit is set, the selection clears, varp
 *   3436 drops, "Kovac hands you a mould, which you add to the library of moulds you already
 *   have stored here." and synth 2114.
 * - Short of reputation: "You do not have enough Foundry Reputation to buy that." (synth 2277).
 * - A filter option is component 1 + 2i of the dropdown: it sets varbit 13915 to i and clears
 *   the selection (script 6085).
 */

const Shared = require("./Shared.GiantsFoundry");
const Mould = require("./Mould.GiantsFoundry");

const STOCK_ENUM = 4379;
const PARAM = { ITEM: 1636, MOULD: 1637, COST: 1638, PARENT_ENUM: 1628 };
const MOULD_TABS = new Map([[4373, 0], [4374, 1], [4375, 2]]);
const COMPONENT = { BUY: 15, LIST: 22, DROPDOWN: 25 };
const LIST_PER_ENTRY = 13;
const LIST_LAST = 312;
const DROPDOWN_LAST = 12;
const IF_EVENT_OP1 = 1 << 1;
const IF_EVENT_OP1_TO_OP4 = (1 << 1) | (1 << 2) | (1 << 3) | (1 << 4);
const SCRIPT_MAINMODAL_OPEN = 2524;
const SCRIPT_SHOP_INIT = 6082;
const SCRIPT_SHOP_SETUP = 6083;
const SOUND_BOUGHT = 2114;
const SOUND_REFUSED = 2277;
/** Buy 1, 5 and 10 are list ops 2-4. */
const QUANTITY_BY_OP = new Map([[2, 1], [3, 5], [4, 10]]);
const DWARF_CANNON = "dwarf_cannon";
const DOUBLE_AMMO_MOULD = 27012;

const MESSAGE = {
  ITEM: "Kovac hands you your reward.",
  MOULD: "Kovac hands you a mould, which you add to the library of moulds you already have stored here.",
  TOO_POOR: "You do not have enough Foundry Reputation to buy that.",
  /** Not captured. */
  NO_SPACE: "You don't have enough inventory space for that.",
  NEEDS_CANNON: "You need to complete Dwarf Cannon to use the double ammo mould.",
};

let stock = null;

/** The shop's entries by list index (1-24). */
function entries() {
  if (stock) return stock;
  const { CacheDefinitions } = Shared.core();
  stock = new Map();
  for (const [index, structId] of CacheDefinitions.getEnumValues(STOCK_ENUM)) {
    const params = CacheDefinitions.getStructParams(Number(structId));
    const mouldStruct = Number(params.get(PARAM.MOULD)) || 0;
    const entry = {
      index: Number(index),
      itemId: Number(params.get(PARAM.ITEM)) || -1,
      cost: Number(params.get(PARAM.COST)) || 0,
      mould: null,
    };
    if (mouldStruct > 0) {
      const parent = Number(CacheDefinitions.getStructParams(mouldStruct).get(PARAM.PARENT_ENUM));
      const tab = MOULD_TABS.get(parent);
      if (tab !== undefined) entry.mould = { struct: mouldStruct, tab, varbit: Mould.unlockVarbit(tab, mouldStruct) };
    }
    stock.set(entry.index, entry);
  }
  return stock;
}

function isOpen(player) {
  return player.getInterfaceId() === Shared.INTERFACE.REWARD_SHOP;
}

function open(player) {
  const sender = player.getPacketSender();
  const group = Shared.INTERFACE.REWARD_SHOP;
  Shared.set(player, Shared.VARBIT.SHOP_FILTER, 0);
  sender.sendConfig(Shared.VARP.SHOP_SELECTED, 0);
  sender.sendConfig(Shared.VARP.REPUTATION, Shared.reputation(player));
  sender.sendInterfaceScript(SCRIPT_MAINMODAL_OPEN, [-1, -3]);
  sender.sendInterface(group);
  sender.sendInterfaceFlagsRange((group << 16) | COMPONENT.LIST, 0, LIST_LAST, IF_EVENT_OP1_TO_OP4);
  sender.sendInterfaceFlagsRange((group << 16) | COMPONENT.DROPDOWN, 0, DROPDOWN_LAST, IF_EVENT_OP1);
  sender.sendClientScript(SCRIPT_SHOP_INIT);
}

function openShop({ player }) {
  if (!Shared.questComplete(player)) return false;
  open(player);
  return true;
}

/**
 * Talk-to's "I'd like to buy something." ends in the transcript's open_shop. The conversation
 * closes its chatbox after this handler, so the shop opens on the next tick.
 */
function openFromDialogue(request) {
  if (request.action !== "open_shop" || request.target !== "Giants' Foundry Reward Shop") return;
  request.handled = true;
  request.end = true;
  const { player } = request;
  Shared.later(1, () => open(player));
}

function selected(player) {
  return player.getPacketSender().getVarp?.(Shared.VARP.SHOP_SELECTED) ?? 0;
}

function refuse(player, message) {
  Shared.sound(player, SOUND_REFUSED);
  player.sendMessage(message);
}

function canAfford(player, cost) {
  if (Shared.reputation(player) >= cost) return true;
  refuse(player, MESSAGE.TOO_POOR);
  return false;
}

function buyMould(player, entry) {
  if (Shared.get(player, entry.mould.varbit) !== 0) return;
  if (!canAfford(player, entry.cost)) return;
  Shared.set(player, entry.mould.varbit, 1);
  player.getPacketSender().sendConfig(Shared.VARP.SHOP_SELECTED, 0);
  Shared.setReputation(player, Shared.reputation(player) - entry.cost);
  Shared.api().emitCustomEvent("persistence:save", { player, reason: "reward-shop" });
  player.sendMessage(MESSAGE.MOULD);
  Shared.sound(player, SOUND_BOUGHT);
  player.getPacketSender().sendClientScript(SCRIPT_SHOP_SETUP, 1);
}

function questComplete(player, key) {
  const request = { player, key, complete: false };
  Shared.api().emitCustomEvent("quest:is-complete", request);
  return request.complete === true;
}

function buyItem(player, entry, quantity) {
  const { ItemDefinition } = Shared.core();
  if (entry.itemId === DOUBLE_AMMO_MOULD && !questComplete(player, DWARF_CANNON)) {
    refuse(player, MESSAGE.NEEDS_CANNON);
    return;
  }
  const cost = entry.cost * quantity;
  if (!canAfford(player, cost)) return;
  const inventory = player.getInventory();
  const stackable = ItemDefinition.forId(entry.itemId)?.isStackable?.() === true;
  const slots = stackable ? (inventory.contains(entry.itemId) ? 0 : 1) : quantity;
  if (inventory.getFreeSlots() < slots) {
    refuse(player, MESSAGE.NO_SPACE);
    return;
  }
  Shared.setReputation(player, Shared.reputation(player) - cost);
  Shared.api().emitCustomEvent("persistence:save", { player, reason: "reward-shop" });
  inventory.adds(entry.itemId, quantity);
  inventory.refreshItems();
  player.sendMessage(MESSAGE.ITEM);
  Shared.sound(player, SOUND_BOUGHT);
  Shared.api().emitCustomEvent("collection-log:obtain", { player, itemId: entry.itemId, amount: quantity });
}

function buy(player, index, quantity) {
  const entry = entries().get(index);
  if (!entry) return;
  if (entry.mould) buyMould(player, entry);
  else if (entry.itemId > 0) buyItem(player, entry, quantity);
}

function clickList({ player, slot, action }) {
  if (!isOpen(player)) return;
  const index = Math.floor(Number(slot) / LIST_PER_ENTRY) + 1;
  if (!entries().has(index)) return;
  const quantity = QUANTITY_BY_OP.get(Number(action));
  if (quantity) {
    buy(player, index, quantity);
    return;
  }
  player.getPacketSender().sendConfig(Shared.VARP.SHOP_SELECTED, index);
}

function clickBuy({ player }) {
  if (!isOpen(player)) return;
  buy(player, selected(player), 1);
}

function clickFilter({ player, slot }) {
  if (!isOpen(player)) return;
  const filter = Math.floor((Number(slot) - 1) / 2);
  if (filter < 0) return;
  Shared.set(player, Shared.VARBIT.SHOP_FILTER, filter);
  player.getPacketSender().sendConfig(Shared.VARP.SHOP_SELECTED, 0);
}

module.exports = function attachRewardShop(api) {
  const group = Shared.INTERFACE.REWARD_SHOP << 16;
  api.onNpcInteraction(Shared.NPC.KOVAC_NAME, { Shop: openShop });
  api.onCustomEvent("npc-dialogue:action", openFromDialogue);
  api.onInterfaceActionButton(group | COMPONENT.LIST, clickList);
  api.onInterfaceActionButton(group | COMPONENT.BUY, clickBuy);
  api.onInterfaceActionButton(group | COMPONENT.DROPDOWN, clickFilter);
};

Object.assign(module.exports, { entries, buy, open, MESSAGE });
