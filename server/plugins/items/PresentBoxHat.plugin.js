"use strict";

// Revision 241 clientscripts.sym: [clientscript,item_transmog_init].
const ITEM_TRANSMOG_INIT_SCRIPT = 6857;
const CHANGE_MESSAGE = "You change the style of your Present box hat.";
const STYLE_NAMES = ["festive", "simple", "icy", "antisanta"];
const sessions = new WeakMap();

function cacheData(api) {
  const cache = api.core.CacheDefinitions;
  const table = cache.getDbTableId("item_transmog");
  const column = name => cache.getDbColumn(table, name);
  const rows = STYLE_NAMES.map(name => cache.getDbRow(cache.getDbRowId(`xmas24_present_hat_${name}`)));
  if (rows.some(row => !row)) throw new Error("Present box hat style data missing from active cache");
  const group = rows[0].int(column("group"));
  const styles = new Map(rows.map(row => [row.int(column("group_id")), row.int(column("namedobj"))]));
  return {
    styles, group,
    interfaceId: cache.getInterfaceId("item_transmog"),
    entries: cache.getComponentId("item_transmog:entries_clickzones"),
    objectVarp: cache.getVarpId("item_transmog_active_obj"),
    inventoryWidget: cache.getComponentId("inventory:items"),
  };
}

function open(api, event) {
  const {player, item, slot, interfaceId} = event;
  const data = cacheData(api);
  const container = (interfaceId === api.core.Inventory.INTERFACE_ID || interfaceId === data.inventoryWidget) ? player.getInventory() :
    interfaceId === api.core.Equipment.INVENTORY_INTERFACE_ID ? player.getEquipment() : null;
  if (!container || container.getItems()[slot] !== item || ![...data.styles.values()].includes(item.getId())) return false;
  if (player.busy()) return;
  const sender = player.getPacketSender();
  sender.sendConfig(data.objectVarp, item.getId());
  sender.sendInterface(data.interfaceId);
  sender.sendInterfaceFlagsRange(data.entries, 0, data.styles.size - 1, 2);
  sender.sendClientScript(ITEM_TRANSMOG_INIT_SCRIPT, data.group);
  sessions.set(player, {container, slot, item, id:item.getId(), amount:item.getAmount(), meta:JSON.stringify(item.getMeta()), data});
}

function select(api, event) {
  const state = sessions.get(event.player);
  if (!state || event.buttonId !== state.data.entries || (event.opId ?? event.action) !== 1) return;
  event.handled = true;
  const {player} = event;
  if (player.getInterfaceId() !== state.data.interfaceId || player.getStatus() !== api.core.PlayerStatus.NONE || player.getHitpoints() <= 0 ||
      state.container.getItems()[state.slot] !== state.item || state.item.getId() !== state.id ||
      state.item.getAmount() !== state.amount || JSON.stringify(state.item.getMeta()) !== state.meta) {
    sessions.delete(player);
    return;
  }
  const next = state.data.styles.get(event.slot);
  if (next === undefined || next === state.id) return;
  state.item.setId(next);
  state.id = next;
  state.container.refreshItems();
  if (state.container === player.getEquipment()) {
    api.core.BonusManager.update(player);
    player.getUpdateFlag().flag(api.core.Flag.APPEARANCE);
  }
  player.getPacketSender().sendConfig(state.data.objectVarp, next);
  player.sendMessage(CHANGE_MESSAGE);
}

function closed({player, interfaceId}) {
  const state = sessions.get(player);
  if (state && interfaceId === state.data.interfaceId) sessions.delete(player);
}
function changed({player, interfaceId}) {
  const state = sessions.get(player);
  if (state && interfaceId !== state.data.interfaceId) sessions.delete(player);
}
function logout({player}) { sessions.delete(player); }

module.exports = {
  name:"PresentBoxHat",
  register(api) {
    api.onItemAction("Present box hat", {Change:open.bind(null, api)});
    api.onInterfaceActionClick(select.bind(null, api));
    api.onCustomEvent("interface:closed", closed);
    api.onCustomEvent("interface:changed", changed);
    api.onPlayerLogout(logout);
  },
};
