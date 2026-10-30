const STATE_ATTRIBUTE = "sailing:schematics";
let pluginApi;
let resolved;

function api() { return pluginApi; }
function core() { return pluginApi.core; }
function cacheId(kind, name) {
  const value = core().CacheDefinitions[kind](name);
  if (value === null || value === undefined) throw new Error(`Missing schematic cache name: ${name}`);
  return value;
}
function rows() {
  if (resolved) return resolved;
  resolved = require("../data/lost-schematics.json").map(row => ({
    ...row,
    itemId: cacheId("getObjId", row.gameval),
    learnedVarbit: cacheId("getVarbitId", row.learned),
    buildRowIds: row.buildRows.map(name => cacheId("getDbRowId", name)),
    box: row.box && {
      ...row.box,
      closedId: cacheId("getLocId", row.box.closed),
      openId: cacheId("getLocId", row.box.open),
      unlockedVarbit: cacheId("getVarbitId", row.box.unlocked),
      hintId: cacheId("getObjId", row.box.hintItem),
      keyId: cacheId("getObjId", row.box.keyItem),
    },
  }));
  return resolved;
}
function state(player) {
  const value = player.getAttribute(STATE_ATTRIBUTE);
  return {
    learned: Array.isArray(value?.learned) ? value.learned.filter(key => rows().some(row => row.key === key)) : [],
    opened: Array.isArray(value?.opened) ? value.opened.filter(key => rows().some(row => row.key === key && row.box)) : [],
  };
}
function learned(player, row) { return state(player).learned.includes(row.key); }
function opened(player, row) { return state(player).opened.includes(row.key); }
function markLearned(player, row) {
  const value = state(player);
  if (!value.learned.includes(row.key)) value.learned.push(row.key);
  player.setAttribute(STATE_ATTRIBUTE, value);
  player.getPacketSender().sendVarbit(row.learnedVarbit, 1);
}
function markOpened(player, row) {
  const value = state(player);
  if (!value.opened.includes(row.key)) value.opened.push(row.key);
  player.setAttribute(STATE_ATTRIBUTE, value);
  player.getPacketSender().sendVarbit(row.box.unlockedVarbit, 1);
}
function has(player, itemId) {
  return player.getInventory().getAmount(itemId) > 0
    || player.getBanks().some(bank => bank && bank.getAmount(itemId) > 0)
    || player.getEquipment().getAmount(itemId) > 0;
}
function rowForItem(itemId) { return rows().find(row => row.itemId === itemId); }
function canItemRead({ player, item, itemId, slot, interfaceId }) {
  const { Inventory, CacheDefinitions } = core();
  return (interfaceId === Inventory.INTERFACE_ID || interfaceId === CacheDefinitions.getComponentId("inventory:items"))
    && player.getInventory().getItems()[slot] === item && item?.getId() === itemId
    && item.getAmount() > 0 && !player.busy();
}
function itemBox(player, itemId, text) {
  const { DialogueChainBuilder, ItemStatementDialogue } = core();
  player.getDialogueManager().startDialogues(new DialogueChainBuilder().add(new ItemStatementDialogue(0, itemId, text)));
}
function restore({ player }) {
  for (const row of rows()) {
    player.getPacketSender().sendVarbit(row.learnedVarbit, learned(player, row) ? 1 : 0);
    if (row.box) player.getPacketSender().sendVarbit(row.box.unlockedVarbit, opened(player, row) ? 1 : 0);
  }
}
function attach(api) {
  pluginApi = api;
  api.persistAttribute(STATE_ATTRIBUTE, { learned: [], opened: [] });
  api.onPlayerLogin(restore);
  api.onCustomEvent("player:bootstrap-complete", restore);
}
module.exports = { attach, api, core, rows, state, learned, opened, markLearned, markOpened, has, rowForItem, canItemRead, itemBox, STATE_ATTRIBUTE };
