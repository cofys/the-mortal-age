// The Crew Registrar and crew management (interface 938), as live (rsprox, the Pandemonium):
// Manage-crew, or "Can I manage my crew?" in the registrar's transcript, opens the interface;
// its client scripts draw the crew and recruits from the crew varbits and table 173, so the
// server sends only varbits. A crew list click selects a slot (18311, from 0), a recruits list
// click a crewmate (18310, from 1); Assign puts that crewmate in that slot and Clear empties it
// (its job too).
const common = require("./Common.Crew");

const GROUP = 938;
const CHILD_CREW_LIST = 6;
const CHILD_RECRUITS_LIST = 10;
const CHILD_ASSIGN = 14;
const CHILD_CLEAR = 15;
const MAIN_MODAL = (161 << 16) | 16;
const SCRIPT_MAINMODAL_OPEN = 2524;
const IF_EVENT_OP1 = 1 << 1;
const RECRUITS = 10;

const REGISTRAR_PAGE = "Crew Registrar";
/** The registrar's Talk-to forms (15244 resolves to them by the Pandemonium's progress). */
const REGISTRAR_IDS = new Set([15245, 15246]);
const NOT_RECRUITED = "You haven't recruited that crew member, so you can't add them to your current crew.";

function openCrewManagement(player) {
  const sender = player.getPacketSender();
  sender.sendVarbit(common.VARBIT.SELECTED_CREW, 1);
  common.sendVarbits(player);
  sender.sendInterfaceScript(SCRIPT_MAINMODAL_OPEN, [-1, -2]);
  player.setInterfaceId(GROUP);
  sender.sendSubInterface(MAIN_MODAL, GROUP, 0);
  sender.sendInterfaceFlagsRange((GROUP << 16) | CHILD_CREW_LIST, 0, common.MAX_SLOTS, IF_EVENT_OP1);
  sender.sendInterfaceFlagsRange((GROUP << 16) | CHILD_RECRUITS_LIST, 0, RECRUITS - 1, IF_EVENT_OP1);
  sender.sendVarbit(common.VARBIT.BUSY, 1);
}

function manageCrew({ player }) {
  openCrewManagement(player);
}

function selectVariant({ player, npcId }) {
  if (!REGISTRAR_IDS.has(npcId)) return null;
  return { page: REGISTRAR_PAGE, variant: common.pandemoniumDone(player) ? "standard-dialogue" : "before-completing-pandemonium" };
}

/** "With 40 Sailing:" / "Without 40 Sailing:" before managing a crew. */
function answerCondition({ player, npcId, text }) {
  if (!REGISTRAR_IDS.has(npcId)) return null;
  const match = /^(with|without) 40 sailing/i.exec(String(text ?? ""));
  if (!match) return null;
  const has = common.sailingLevel(player) >= 40;
  return match[1].toLowerCase() === "with" ? has : !has;
}

/**
 * The transcript's "Crew Management" interface. The conversation closes the chat once this step
 * is handled, which would close the interface too, so it opens a tick later.
 */
function onAction(event) {
  if (!REGISTRAR_IDS.has(event.npcId) || event.action !== "open_interface" || event.target !== "Crew Management") return;
  event.handled = true;
  event.end = true;
  const { player } = event;
  const { CountdownTask, TaskManager } = common.core();
  TaskManager.submit(new CountdownTask(player, 1, () => openCrewManagement(player)));
}

function assign(player, slot, crewId) {
  if (!common.isRecruited(player, crewId)) {
    player.sendMessage(NOT_RECRUITED);
    return;
  }
  if (slot < 0 || slot >= common.slotLimit(player)) return;
  common.update(player, (crew) => {
    if (crew.slots[slot] === crewId) return;
    // A crewmate in another slot moves to this one.
    const previous = crew.slots.indexOf(crewId);
    if (previous >= 0) {
      crew.slots[previous] = 0;
      crew.positions[previous] = common.POSITION.IDLE;
    }
    crew.slots[slot] = crewId;
    crew.positions[slot] = common.POSITION.IDLE;
  });
  common.core().PluginManager.emitCustomEvent("sailing:crew-changed", { player });
}

function clear(player, slot) {
  if (slot < 0 || slot >= common.MAX_SLOTS) return;
  common.update(player, (crew) => {
    crew.slots[slot] = 0;
    crew.positions[slot] = common.POSITION.IDLE;
  });
  common.core().PluginManager.emitCustomEvent("sailing:crew-changed", { player });
}

function clickCrewManagement(event) {
  if (event.groupId !== GROUP) return;
  const { player } = event;
  if (player.getInterfaceId?.() !== GROUP) return;
  event.handled = true;
  const sender = player.getPacketSender();
  switch (event.childId) {
    case CHILD_CREW_LIST:
      if (Number.isInteger(event.slot) && event.slot >= 0 && event.slot < common.MAX_SLOTS) {
        sender.sendVarbit(common.VARBIT.SELECTED_SLOT, event.slot);
      }
      break;
    case CHILD_RECRUITS_LIST:
      if (Number.isInteger(event.slot) && event.slot >= 0 && event.slot < RECRUITS) {
        sender.sendVarbit(common.VARBIT.SELECTED_CREW, event.slot + 1);
      }
      break;
    case CHILD_ASSIGN:
      assign(player, sender.getVarbit(common.VARBIT.SELECTED_SLOT), sender.getVarbit(common.VARBIT.SELECTED_CREW));
      break;
    case CHILD_CLEAR:
      clear(player, sender.getVarbit(common.VARBIT.SELECTED_SLOT));
      break;
    default:
      break;
  }
}

function crewManagementClosed({ player, interfaceId }) {
  if (interfaceId === GROUP) player.getPacketSender().sendVarbit(common.VARBIT.BUSY, 0);
}

function attach(api) {
  common.init(api);
  api.onNpcInteraction("Crew Registrar", { "Manage-crew": manageCrew });
  api.onNpcDialogueVariant(selectVariant);
  api.onNpcDialogueCondition(answerCondition);
  api.onCustomEvent("npc-dialogue:action", onAction);
  api.onInterfaceActionClick(clickCrewManagement);
  api.onCustomEvent("interface:closed", crewManagementClosed);
}

module.exports = attach;
module.exports.openCrewManagement = openCrewManagement;
module.exports.assign = assign;
module.exports.clear = clear;
