"use strict";

const { Animation, CacheDefinitions, ItemDefinition } = require("./Core.Construction");
const Ids = require("./Ids.Construction");
const House = require("./House.Construction");

// Bookcases (rsprox captures, cache scripts 7834-7843): Search opens poh_bookcase, which lists the
// books in enum 5210 and shows book i as found when bit i of varps 805, 261-266, 1037 (32 books
// each) is set. A click takes a copy: "You take: <col=ef1020>Name</col>" with
// poh_larder_examine, "You're already carrying a copy of that book." or "You have not found that
// book yet.". A book counts as found once the player has carried or banked it when they search a
// bookcase; the live game marks it when the book is first obtained.
const INTERFACE = Ids.iface("poh_bookcase");
const BOOKS_COMPONENT = 5;
const BOOK_ENUM = 5210;
// The varps the bookcase's script reads the found books from, in its order.
const FOUND_VARPS = ["macro_bee_pos_1", "if1", "if2", "if3", "if4", "if5", "if6", "pattern_varp"].map(Ids.varp);
const FOUND_ATTRIBUTE = "construction:books-found";
const TAKE_BOOK = Ids.seq("poh_larder_examine");

let books = null;

/** Book slot -> item id, from the cache. */
function bookList() {
  books ??= [...CacheDefinitions.getEnumValues(BOOK_ENUM)].sort(([a], [b]) => a - b);
  return books;
}

function foundBooks(player) {
  return new Set(player.getAttribute(FOUND_ATTRIBUTE) ?? []);
}

function holds(player, itemId) {
  if (player.getInventory().contains(itemId)) return true;
  return (player.getBanks?.() ?? []).some(bank => bank?.contains?.(itemId));
}

/** Books on the player or in their bank count as found from now on. */
function recordFound(player) {
  const found = foundBooks(player);
  for (const [slot, itemId] of bookList()) if (!found.has(slot) && holds(player, itemId)) found.add(slot);
  player.setAttribute(FOUND_ATTRIBUTE, [...found]);
  return found;
}

function sendFound(player, found) {
  FOUND_VARPS.forEach((varp, index) => {
    let value = 0;
    for (let bit = 0; bit < 32; bit++) if (found.has(index * 32 + bit)) value |= 1 << bit;
    player.getPacketSender().sendConfig(varp, value);
  });
}

function search(event) {
  const house = House.houseFor(event.player);
  const furniture = house?.getFurnitureAt(event.location, event.objectId, event.object?.getType() ?? 10);
  if (!furniture?.buildableKey.endsWith("_BOOKCASE")) return false;
  sendFound(event.player, recordFound(event.player));
  event.player.getPacketSender().sendInterface(INTERFACE);
  return true;
}

function interfaceClick(event) {
  if (event.groupId !== INTERFACE || event.childId !== BOOKS_COMPONENT) return;
  event.handled = true;
  const player = event.player;
  if (!House.houseFor(player)) return;
  const book = bookList().find(([slot]) => slot === event.slot);
  if (!book) return;
  const [slot, itemId] = book;
  if ((event.opId ?? event.action ?? 1) > 1) return player.sendMessage(ItemDefinition.forId(itemId)?.getExamine?.() ?? "It's a book.");
  if (!foundBooks(player).has(slot)) return player.sendMessage("You have not found that book yet.");
  if (player.getInventory().contains(itemId)) return player.sendMessage("You're already carrying a copy of that book.");
  if (player.getInventory().getFreeSlots() === 0) return player.sendMessage("You don't have enough inventory space.");
  player.getInventory().adds(itemId, 1);
  player.performAnimation(new Animation(TAKE_BOOK));
  player.sendMessage(`You take: <col=ef1020>${ItemDefinition.forId(itemId)?.getName?.() ?? "the book"}</col>`);
}

function attachBookcase(api) {
  api.persistAttribute(FOUND_ATTRIBUTE, []);
  api.onObjectInteraction("Bookcase", { Search: search });
  api.onInterfaceActionClick(interfaceClick);
}

Object.assign(module.exports, { attachBookcase });
