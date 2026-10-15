"use strict";

/**
 * The grave's options and its interface (gravestone_generic): Check opens it, Loot takes the
 * free items, both from up to 7 tiles away. In the interface an item click takes it (Examine is
 * op 10), the free button takes every free item, the pay button pays the fee or, once paid,
 * takes the paid items.
 */
const Common = require("./Common.Gravestones");
const Grave = require("./Grave.Gravestones");

const EXAMINE_OP = 10;

function reachGrave(event) {
  if (Grave.owns(event.player, event.npc)) event.range = Grave.ACCESS_RANGE;
}

function check({ player, npc }) {
  if (!Grave.owns(player, npc)) return false;
  Grave.open(player);
  return true;
}

function loot({ player, npc }) {
  if (!Grave.owns(player, npc)) return false;
  Grave.loot(player);
  return true;
}

function clickItem(event) {
  const { player } = event;
  if (!Grave.isOpen(player)) return;
  const slot = Number.isInteger(event.slot) ? event.slot : -1;
  if ((event.opId ?? event.action) === EXAMINE_OP) {
    if (event.itemId > 0) player.sendMessage(Common.definition(event.itemId).getExamine());
    return;
  }
  Grave.takeSlot(player, slot);
}

function takeFree({ player }) {
  if (Grave.isOpen(player)) Grave.takeFree(player);
}

function pay({ player }) {
  if (Grave.isOpen(player)) Grave.payOrTake(player);
}

function close({ player }) {
  Grave.close(player);
}

function attach(api) {
  Common.bind(api);
  api.onNpcRoute(reachGrave);
  api.onNpcInteraction("Grave", { Check: check, Loot: loot });
  api.onInterfaceActionButton([Common.COMPONENT.freeItems, Common.COMPONENT.payItems], clickItem);
  api.onInterfaceActionButton(Common.COMPONENT.freeButton, takeFree);
  api.onInterfaceActionButton(Common.COMPONENT.payButton, pay);
  api.onInterfaceActionButton(Common.COMPONENT.close, close);
}

module.exports = { attach };
