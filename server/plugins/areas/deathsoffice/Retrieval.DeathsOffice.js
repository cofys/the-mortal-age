"use strict";

/**
 * Death's Office's item retrieval interface (death_office, 669, over inv death_permanent). As
 * captured (rsprox recordings 86, 89, 1751, 4266):
 * - opening: if2 -1, the office's inventory, toplevel_mainmodal_open, the modal, and the item
 *   list's events (op1 and Examine);
 * - an item worth under 100k is taken whole at once; a dearer one is selected instead (if2 its
 *   slot, if3 Death's fee for one), and a free one taken after clears the selection;
 * - taking leaves its slot empty: the office doesn't close up;
 * - Take-All with nothing stored: "There's nothing here to take."; with only free items it takes
 *   what fits; with paid items it closes the office and asks "Death will charge N coins." (the
 *   fee for every paid item stored) with "Pay Death's fee." / "Cancel". Paying takes what fits,
 *   charges for the paid items taken ("Payment has been taken from your bank: N coins", Death's
 *   payment sound 10 cycles on) and reopens the office.
 * UNVERIFIED (no capture): 1, 5, X and All on a selected item take that many and charge for them
 * at once, and the messages when nothing fits or nothing covers the fee.
 */
const Common = require("./Common.DeathsOffice");

const OFFICE_INV = 636;
const OFFICE_SLOTS = 120;
const EXAMINE_OP = 10;
const MESSAGE = {
  empty: "There's nothing here to take.",
  noSpace: "You don't have enough inventory space.",
  cannotPay: "You don't have enough coins with you or in your bank to pay the fee.",
};

function isOpen(player) {
  return player.getPacketSender().isSubInterfaceOpen(Common.ID.officeInterface);
}

function sendOffice(player, office) {
  player.getPacketSender().sendInventory(OFFICE_INV, OFFICE_SLOTS, office.map((entry) => (entry ? { id: entry.id, amount: entry.amount } : null)));
}

function select(player, slot, fee) {
  const sender = player.getPacketSender();
  sender.sendConfig(Common.VARP.if3, fee);
  sender.sendConfig(Common.VARP.if2, slot);
}

function clearSelection(player) {
  if (player.getPacketSender().getVarp?.(Common.VARP.if2) !== -1) select(player, -1, 0);
}

function selectedSlot(player) {
  return player.getPacketSender().getVarp?.(Common.VARP.if2) ?? -1;
}

/** Opening closes the chatbox first (the dialogue that led here), as live. */
function open(player) {
  const { office } = Common.state(player);
  const sender = player.getPacketSender();
  sender.sendInterfaceRemoval();
  sender.sendConfig(Common.VARP.if2, -1);
  sendOffice(player, office);
  sender.sendInterfaceScript(Common.SCRIPT.mainModalOpen, [-1, -1]);
  sender.sendSubInterface(Common.COMPONENT.mainModal, Common.ID.officeInterface, Common.MODAL);
  sender.sendInterfaceFlagsRange(Common.COMPONENT.officeItems, 0, OFFICE_SLOTS - 1, Common.OP1 | Common.OP10);
}

/** Moves up to `count` of an office slot into the inventory; returns how many. */
function takeFromOffice(player, slot, count) {
  const request = { player, slot, count, taken: 0 };
  Common.api().emitCustomEvent("gravestones:office-take", request);
  return request.taken;
}

/** How many of `entry` the inventory can take right now. */
function room(player, entry) {
  const inventory = player.getInventory();
  if (Common.core().ItemDefinition.forId(entry.id).isStackable()) {
    return inventory.getAmount(entry.id) > 0 || inventory.getFreeSlots() > 0 ? entry.amount : 0;
  }
  return Math.min(entry.amount, inventory.getFreeSlots());
}

function charge(player, fee) {
  if (fee <= 0) return true;
  const paid = Common.payFee(player, fee);
  if (!paid.source) {
    player.sendMessage(MESSAGE.cannotPay);
    return false;
  }
  player.sendMessage(paid.message);
  return true;
}

/** Takes `count` of `slot`, charging Death's fee for each one taken. */
function take(player, slot, count) {
  const entry = Common.state(player).office[slot];
  if (!entry || count <= 0) return;
  const taking = Math.min(count, room(player, entry));
  if (taking <= 0) {
    player.sendMessage(MESSAGE.noSpace);
    return;
  }
  if (!charge(player, entry.fee * taking)) return;
  takeFromOffice(player, slot, taking);
  if (entry.fee > 0) Common.sound(player, Common.PAYMENT_SOUND, Common.PAYMENT_SOUND_DELAY);
  const office = Common.state(player).office;
  if (!office[slot] || entry.fee === 0) clearSelection(player);
  sendOffice(player, office);
}

function clickItem(event) {
  const { player } = event;
  if (!isOpen(player)) return;
  const slot = Number.isInteger(event.slot) ? event.slot : -1;
  const entry = Common.state(player).office[slot];
  if (!entry) return;
  if ((event.opId ?? event.action) === EXAMINE_OP) {
    player.sendMessage(Common.core().ItemDefinition.forId(entry.id).getExamine());
    return;
  }
  if (entry.fee > 0) {
    select(player, slot, entry.fee);
    return;
  }
  take(player, slot, entry.amount);
}

function takeSelected(player, count) {
  if (!isOpen(player)) return;
  const slot = selectedSlot(player);
  const entry = Common.state(player).office[slot];
  if (entry) take(player, slot, Math.min(count, entry.amount));
}

function takeOne({ player }) {
  takeSelected(player, 1);
}

function takeFive({ player }) {
  takeSelected(player, 5);
}

function takeAllSelected({ player }) {
  takeSelected(player, Number.MAX_SAFE_INTEGER);
}

function takeX({ player }) {
  if (!isOpen(player) || selectedSlot(player) < 0) return;
  player.setEnteredAmountAction({ execute: (amount) => takeSelected(player, amount) });
  player.getPacketSender().sendEnterAmountPrompt("How many would you like to take?");
}

/** Take-All: every stored item that fits, in slot order, charging only for the paid ones taken. */
function takeEverything({ player }) {
  if (!isOpen(player)) return;
  const { office } = Common.state(player);
  if (!office.some(Boolean)) {
    player.sendMessage(MESSAGE.empty);
    return;
  }
  const quoted = office.reduce((sum, entry) => sum + (entry ? entry.fee * entry.amount : 0), 0);
  if (quoted <= 0) {
    takeWhatFits(player);
    return;
  }
  player.getPacketSender().closeInterface(Common.ID.officeInterface);
  Common.choose(player, `Death will charge ${Common.formatCoins(quoted)} coins.`,
    ["Pay Death's fee.", () => {
      takeWhatFits(player);
      open(player);
    }],
    ["Cancel", () => {}],
  );
}

/** What Take-All moves: each stored stack in turn, as far as the inventory holds it. */
function plan(player, office) {
  const inventory = player.getInventory();
  let free = inventory.getFreeSlots();
  const stacked = new Set();
  const moves = [];
  office.forEach((entry, slot) => {
    if (!entry) return;
    if (Common.core().ItemDefinition.forId(entry.id).isStackable()) {
      if (!stacked.has(entry.id) && inventory.getAmount(entry.id) === 0) {
        if (free === 0) return;
        free--;
      }
      stacked.add(entry.id);
      moves.push({ slot, count: entry.amount, fee: entry.fee });
      return;
    }
    const count = Math.min(entry.amount, free);
    if (count <= 0) return;
    free -= count;
    moves.push({ slot, count, fee: entry.fee });
  });
  return moves;
}

function takeWhatFits(player) {
  const moves = plan(player, Common.state(player).office);
  if (moves.length === 0) {
    player.sendMessage(MESSAGE.noSpace);
    return;
  }
  const fee = moves.reduce((sum, move) => sum + move.fee * move.count, 0);
  if (!charge(player, fee)) return;
  for (const { slot, count } of moves) takeFromOffice(player, slot, count);
  if (fee > 0) Common.sound(player, Common.PAYMENT_SOUND, Common.PAYMENT_SOUND_DELAY);
  clearSelection(player);
  if (isOpen(player)) sendOffice(player, Common.state(player).office);
}

function attach(api) {
  Common.bind(api);
  const { COMPONENT } = Common;
  api.onInterfaceActionButton(COMPONENT.officeItems, clickItem);
  api.onInterfaceActionButton(COMPONENT.officeTake1, takeOne);
  api.onInterfaceActionButton(COMPONENT.officeTake5, takeFive);
  api.onInterfaceActionButton(COMPONENT.officeTakeX, takeX);
  api.onInterfaceActionButton(COMPONENT.officeTakeAll, takeAllSelected);
  api.onInterfaceActionButton(COMPONENT.officeTakeEverything, takeEverything);
}

module.exports = { attach, open };
