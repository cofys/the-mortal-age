"use strict";

/**
 * The lab books, their notes, and inspecting a finished potion.
 *
 * rsprox captures (recordings 821, 4177, 4187):
 * - Lab books (Search): synth 2582 and an item box "You take a set of lab notes from the
 *   bookshelf." with +1 Mixology lab notes. With a set already: "You search the bookshelf, but
 *   don't find anything worth reading." No room: "You don't have enough room to take anything
 *   from the bookshelf."
 * - Mixology lab notes (Read): mm_formulas (883) in the main modal after toplevel_mainmodal_open
 *   [-1, -1]; the interface draws the formulas itself.
 * - A finished potion (Inspect): an item box "It's a vial of <col=6800bf>Concentrated
 *   Mixalot</col>. ", with "Its quality has been improved!" after it once digweed went in.
 */

const Shared = require("./Shared.Mixology");

const SCRIPT_MAINMODAL_OPEN = 2524;
const SOUND_TAKE = 2582;
const MESSAGE = {
  TAKEN: "You take a set of lab notes from the bookshelf.",
  HAS_NOTES: "You search the bookshelf, but don't find anything worth reading.",
  NO_ROOM: "You don't have enough room to take anything from the bookshelf.",
  IMPROVED: "Its quality has been improved!",
};

function search({ player, objectId }) {
  if (objectId !== Shared.OBJECT.LAB_BOOKS_ID) return false;
  if (Shared.owns(player, Shared.ITEM.LAB_NOTES)) {
    player.sendMessage(MESSAGE.HAS_NOTES);
    return true;
  }
  const inventory = player.getInventory();
  if (inventory.getFreeSlots() < 1) {
    Shared.statement(player, MESSAGE.NO_ROOM);
    return true;
  }
  inventory.adds(Shared.ITEM.LAB_NOTES, 1);
  inventory.refreshItems();
  Shared.sound(player, SOUND_TAKE);
  Shared.itemStatement(player, Shared.ITEM.LAB_NOTES, MESSAGE.TAKEN);
  return true;
}

function read({ player }) {
  const sender = player.getPacketSender();
  sender.sendInterfaceScript(SCRIPT_MAINMODAL_OPEN, [-1, -1]);
  sender.sendInterface(Shared.INTERFACE.FORMULAS);
}

/** Inspect on a finished potion; unfinished ones share the name, so it falls through for them. */
function inspect({ player, item, itemId }) {
  const entry = Shared.potionByItem(itemId);
  if (!entry || entry.finished !== itemId) return false;
  const modifier = Shared.modifierName(Number(item?.getMetaValue?.(Shared.META.MODIFIER)) || 0);
  const improved = item?.getMetaValue?.(Shared.META.DIGWEED) === true ? MESSAGE.IMPROVED : "";
  const name = modifier ? `${modifier} ${entry.name}` : entry.name;
  Shared.itemStatement(player, itemId, `It's a vial of ${Shared.coloured(player, name)}. ${improved}`);
  return true;
}

function potionInspect(event) {
  if (event.handled || event.option !== "Inspect" || !Shared.isFinished(event.itemId)) return;
  if (inspect(event)) event.handled = true;
}

module.exports = function attachLabNotes(api) {
  api.onObjectInteraction(Shared.OBJECT.LAB_BOOKS, { Search: search });
  api.onItemAction("Mixology lab notes", { Read: read });
  api.onItemAction(potionInspect);
};
