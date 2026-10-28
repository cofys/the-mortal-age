// A shipwright's Buy-boat: the Boat Emporium omnishop (sailing_boat_shop). The cache has the stock
// (a deed per boat type, its price in coins and the boat's row in table 166); Omnishop.plugin.js
// runs the shop, and this answers its events: the info text, the level and slot checks, and the
// delivery. From a live capture of a raft bought at Port Sarim (docs/sailing-osrs-reference.md).
const { Sailing } = require("../../../src/main/typescript/elvarg/game/content/sailing/Sailing");
const { content, randomBoatName, playSound } = require("./SailingContent.Sailing");
const { sendBoatVarbits } = require("./BoatVarbits.Sailing");

const SHOP = "sailing_boat_shop";
const SOUND_DELIVERED = 2114;
/** Boats a player can own by Sailing level (OSRS Wiki, Boat): 1 at 1, then 15, 50, 78 and 91. */
const SLOT_LEVELS = [1, 15, 50, 78, 91];
const MESSAGE = {
  delivered: (dock) => `Your brand new boat has been delivered to ${dock.name.replace(/^The /, "the ")}.`,
  /** Not captured. */
  level: (level, boat) => `You need a Sailing level of ${level} to buy ${boat}.`,
  /** Not captured. */
  slots: "You don't have a free boat slot.",
};

let core;
let pluginApi;
/** The dock of the shipwright each player is buying from. */
const buyingAt = new WeakMap();

function cache() {
  return core.CacheDefinitions;
}

/** A DB row's first value in a column, by the column's gameval name. */
function field(row, name) {
  const column = row ? cache().getDbColumn(row.tableId, name) : null;
  return column === null ? undefined : row.column(column)[0];
}

/**
 * A stock entry's boat: its boats.json type and its row in the boat table (166), which the
 * stock row names as its dynamic description.
 */
function boatOf(stock) {
  const stockRow = cache().getDbRow(cache().getDbRowId(stock));
  const boatRowId = Number(field(stockRow, "omnishop_stock_description_dynamic"));
  const type = content().boats.find((boat) => boat.sidepanelBoatType === boatRowId);
  const row = cache().getDbRow(boatRowId);
  return type && row ? { type, row } : undefined;
}

function slotsFor(player) {
  const level = player.getSkillManager().getMaxLevel(core.Skill.SAILING);
  return SLOT_LEVELS.filter((required) => level >= required).length;
}

function openShop({ player, npc, definition }) {
  // The resolved form's name: the spawned parent (14972) is nameless, its varbit form is Junior Jim.
  const name = (definition ?? npc.getCurrentDefinition?.(player))?.getName?.() ?? "";
  const dock = content().docks.find((candidate) => candidate.shipwright === name);
  if (!dock) return false;
  buyingAt.set(player, dock);
  pluginApi.emitCustomEvent("omnishop:open", { player, shop: SHOP });
}

/**
 * The info panel, as captured: "Sailing level: 1<br>Size: Tiny (1x3)<br>...", then boats.json
 * `shopNote` (the raft starts with a hold too, but live doesn't say so).
 */
function describe(request) {
  if (request.shop !== SHOP) return;
  const boat = boatOf(request.stock);
  if (!boat) return;
  const lines = [
    `Sailing level: ${field(boat.row, "level_required")}`,
    `Size: ${field(boat.row, "size_desc")}`,
    `Player capacity: ${field(boat.row, "player_capacity")}`,
    `Crew capacity: ${field(boat.row, "crew_capacity") ?? 0}`,
    `Facility slots: ${field(boat.row, "facility_amount")}`,
  ];
  if (boat.type.shopNote) lines.push("", boat.type.shopNote);
  request.description = lines.join("<br>");
}

function canBuy(request) {
  if (request.shop !== SHOP) return;
  const { player } = request;
  const boat = boatOf(request.stock);
  const level = Number(field(boat?.row, "level_required") ?? 1);
  request.unlock = true;
  if (!boat || !buyingAt.has(player)) {
    request.cancel = true;
  } else if (player.getSkillManager().getMaxLevel(core.Skill.SAILING) < level) {
    player.sendMessage(MESSAGE.level(level, field(boat.row, "inline_name")));
    request.cancel = true;
  } else if (player.getSailing().boats.length >= slotsFor(player)) {
    player.sendMessage(MESSAGE.slots);
    request.cancel = true;
  }
}

/** Paid for: the boat is moored at the shipwright's dock, and a message box shows its deed. */
function deliver(request) {
  if (request.shop !== SHOP) return;
  const { player } = request;
  const dock = buyingAt.get(player);
  const boat = boatOf(request.stock);
  request.handled = true;
  if (!dock || !boat || !Sailing.giveBoat(player, boat.type.type, dock.id, randomBoatName())) return;
  sendBoatVarbits(player);
  playSound(player, SOUND_DELIVERED);
  player.getPacketSender().sendInterfaceRemoval();
  const { DialogueChainBuilder, ItemStatementDialogue } = core;
  player.getDialogueManager().startDialogues(new DialogueChainBuilder().add(
    new ItemStatementDialogue(0, request.itemId, MESSAGE.delivered(dock)),
  ));
}

function bind(api) {
  core = api.core;
  pluginApi = api;
}

module.exports = { bind, openShop, describe, canBuy, deliver };
