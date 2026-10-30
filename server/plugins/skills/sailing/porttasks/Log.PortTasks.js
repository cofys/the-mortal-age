// The cache's Captain's log (935): slot notices/details/Back are drawn by native CS2.
// Recorded opens: RSProx235/00948,03455,03461. The same held slots drive the ledger,
// log and port master; only the current selection is transient here.
const common = require("./Common.PortTasks");
const master = require("./PortMaster.PortTasks");

const LOG = 935;
const MENU = 7;
const CLOSE = 8;
const TASKS = 16;
const BACK = 23;
const CANCEL = 25;
const FLOATER = (161 << 16) | 18;
const TAB = 18572;
const FIRST_OPENED = 18573;
const OPENED_SLOT = 19135;
const WARNING_DISABLED = 18130;
const HIDE_POPUP = 8709;
const REDRAW = 8663;
const TAB_ATTRIBUTE = "port-tasks:log-tab";
const FIRST_OPENED_ATTRIBUTE = "port-tasks:log-first-opened";
const selections = new WeakMap();
let pluginApi;

function clearSelection(player) {
  selections.delete(player);
  player.getPacketSender().sendVarbit(OPENED_SLOT, 0);
}

function open(player, tab) {
  const sender = player.getPacketSender();
  sender.sendInterfaceRemoval();
  clearSelection(player);
  player.setAttribute(TAB_ATTRIBUTE, tab);
  player.setAttribute(FIRST_OPENED_ATTRIBUTE, true);
  common.sendSlots(player);
  sender.sendConfig(common.VARP_TASKS_COMPLETED, player.getAttribute(common.COMPLETED_ATTRIBUTE)?.total ?? 0);
  sender.sendVarbit(FIRST_OPENED, 1);
  sender.sendVarbit(TAB, tab);
  sender.sendSubInterface(FLOATER, LOG, 1);
  sender.sendInterfaceFlagsRange((LOG << 16) | MENU, 10, 12, 1 << 1);
  sender.sendInterfaceFlagsRange((LOG << 16) | TASKS, 0, 12, 1 << 1);
  sender.sendInterfaceScript(HIDE_POPUP);
}

function canRead({ player, slot, item, itemId }) {
  const current = player.getInventory().getItems()[slot];
  return !player.busy() && current === item && current?.getId() === itemId && current.getAmount() > 0;
}

function viewTasks(event) { if (canRead(event)) open(event.player, 1); }
function viewCharts(event) { if (canRead(event)) open(event.player, 0); }

function validSelection(player, selected) {
  return selected && selections.get(player) === selected
    && player.getPacketSender().isSubInterfaceOpen(LOG)
    && common.slots(player)[selected.index] === selected.slot;
}

function finishCancellation(player, selected) {
  if (!validSelection(player, selected)) return;
  master.cancel(player, selected.index);
}

// Native8707 listens only to port_tasks_general; slot ids/counters use other varps.
// Refresh the mounted log after every shared slot change, including completion or acceptance.
function taskSlotsChanged({ player }) {
  const sender = player.getPacketSender();
  if (!sender.isSubInterfaceOpen(LOG)) return;
  clearSelection(player);
  sender.sendInterfaceScript(REDRAW);
  sender.sendInterfaceScript(HIDE_POPUP);
}

function cancelSelected(player) {
  const selected = selections.get(player);
  if (!validSelection(player, selected)) return;
  const task = common.taskById(selected.slot.id);
  if (!task || task.cancellable === false) return;
  if (player.getPacketSender().getVarbit(WARNING_DISABLED) === 1) {
    finishCancellation(player, selected);
    return;
  }
  // Wiki confirms the warning setting; no cancellation dialogue was captured.
  pluginApi.sendMultiChatboxPrompt(player, "Cancel this port task?",
    "Yes, cancel the task.", () => finishCancellation(player, selected),
    "No, keep the task.", keepTask);
}

function keepTask() {}

function clickLog(event) {
  const { player, groupId, childId, slot, action } = event;
  if (groupId !== LOG || action !== 1 || !player.getPacketSender().isSubInterfaceOpen(LOG)) return;
  event.handled = true;
  const sender = player.getPacketSender();
  if (childId === CLOSE) {
    clearSelection(player);
    sender.closeInterface(LOG);
  } else if (childId === BACK) {
    clearSelection(player);
  } else if (childId === MENU && (slot === 10 || slot === 12)) {
    clearSelection(player);
    const tab = slot === 12 ? 1 : 0;
    player.setAttribute(TAB_ATTRIBUTE, tab);
    sender.sendVarbit(TAB, tab);
  } else if (childId === TASKS) {
    clearSelection(player);
    if (!Number.isInteger(slot) || slot < 0 || slot >= common.slotLimit(player)) return;
    const held = common.slots(player)[slot];
    if (!held || !common.taskById(held.id)) return;
    selections.set(player, { index: slot, slot: held });
    sender.sendVarbit(OPENED_SLOT, slot + 1);
  } else if (childId === CANCEL) cancelSelected(player);
}

function login({ player }) {
  selections.delete(player);
  player.getPacketSender().sendVarbit(TAB, player.getAttribute(TAB_ATTRIBUTE) ?? 0);
  player.getPacketSender().sendVarbit(FIRST_OPENED, player.getAttribute(FIRST_OPENED_ATTRIBUTE) ? 1 : 0);
  player.getPacketSender().sendVarbit(OPENED_SLOT, 0);
}

function logout({ player }) { selections.delete(player); }

function attach(api) {
  pluginApi = api;
  api.persistAttribute(TAB_ATTRIBUTE, 0);
  api.persistAttribute(FIRST_OPENED_ATTRIBUTE, false);
  api.onItemAction("Captain's log", { "View-tasks": viewTasks, "View-charts": viewCharts });
  api.onInterfaceActionClick(clickLog);
  api.onCustomEvent("port-tasks:slots-changed", taskSlotsChanged);
  api.onPlayerLogin(login);
  api.onPlayerLogout(logout);
}

module.exports = attach;
