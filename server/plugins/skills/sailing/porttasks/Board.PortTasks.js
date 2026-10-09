// A port's notice board (rsprox.net recordings): Inspect opens the board (941) with the player's
// eight tasks for it, drawn by cache script 8912 from their db rows; clicking one (941:3, slot
// = entry x 6) opens its details (942) drawn by script 8900, whose Accept answers the count
// dialog with 1 and closing it with 0. Accepting fills the first free slot and redraws the board.
const common = require("./Common.PortTasks");

const BOARD = 941;
const BOARD_TASKS = 3;
const BOARD_POPUP = 5;
const TASK_INFO = 942;
const MAIN_MODAL = (161 << 16) | 16;
const SCRIPT_MAINMODAL_OPEN = 2524;
const SCRIPT_BOARD_INIT = 8912;
const SCRIPT_TASK_INFO = 8900;
/** The board's children are 6 a task (the click's slot), 8 tasks. */
const CHILDREN_PER_TASK = 6;
const IF_EVENT_OP1 = 1 << 1;
const MODAL = 0;
const OVERLAY = 1;

/** The board the player last opened, for its clicks: its dock id. */
const openBoards = new WeakMap();

function uid(group, child) {
  return (group << 16) | child;
}

/** A random pick of `count` rows from a pool, none repeated. */
function pick(pool, count, exclude = []) {
  const left = pool.filter((row) => !exclude.includes(row));
  const picked = [];
  while (picked.length < count && left.length > 0) {
    picked.push(left.splice(Math.floor(Math.random() * left.length), 1)[0]);
  }
  return picked;
}

/**
 * The player's eight tasks on a board: kept until one is done (Ledger replaces it), first drawn
 * at random from the board's pool, which holds bounty tasks as well as courier tasks.
 */
function boardTasks(player, dockId) {
  const pool = common.DATA.boards[dockId] ?? [];
  const boards = { ...(player.getAttribute(common.BOARDS_ATTRIBUTE) ?? {}) };
  let rows = (boards[dockId] ?? []).filter((row) => pool.includes(row));
  if (rows.length < common.BOARD_SIZE) rows = [...rows, ...pick(pool, common.BOARD_SIZE - rows.length, rows)];
  boards[dockId] = rows;
  player.setAttribute(common.BOARDS_ATTRIBUTE, boards);
  return rows;
}

/** A finished task's entry on its board is drawn again (as the recordings show). */
function replaceOnBoard(player, task) {
  const boards = { ...(player.getAttribute(common.BOARDS_ATTRIBUTE) ?? {}) };
  const rows = boards[task.board];
  const at = rows?.indexOf(task.row) ?? -1;
  if (at < 0) return;
  const [next] = pick(common.DATA.boards[task.board] ?? [], 1, rows);
  if (next === undefined) return;
  boards[task.board] = rows.map((row, i) => (i === at ? next : row));
  player.setAttribute(common.BOARDS_ATTRIBUTE, boards);
}

function openBoard(player, dockId) {
  const rows = boardTasks(player, dockId);
  const sender = player.getPacketSender();
  openBoards.set(player, dockId);
  sender.sendInterfaceScript(SCRIPT_MAINMODAL_OPEN, [-1, -3]);
  player.setInterfaceId(BOARD);
  sender.sendSubInterface(MAIN_MODAL, BOARD, MODAL);
  sender.sendInterfaceScript(SCRIPT_BOARD_INIT, rows);
  sender.sendInterfaceFlagsRange(uid(BOARD, BOARD_TASKS), 0, common.BOARD_SIZE * CHILDREN_PER_TASK, IF_EVENT_OP1);
}

function inspectBoard({ player, objectId, location }) {
  if (!common.boardLocs.has(objectId)) return false;
  const dock = common.dockAt(location.x, location.y);
  if (!dock || !common.DATA.boards[dock.id]) return false;
  openBoard(player, dock.id);
  return true;
}

function clickBoard(event) {
  if (event.groupId !== BOARD || event.childId !== BOARD_TASKS) return;
  event.handled = true;
  const { player } = event;
  const dockId = openBoards.get(player);
  if (dockId === undefined || player.getInterfaceId?.() !== BOARD) return;
  const row = boardTasks(player, dockId)[Math.floor((event.slot ?? -1) / CHILDREN_PER_TASK)];
  const task = row !== undefined ? common.taskByRow(row) : undefined;
  if (!task) return;
  const sender = player.getPacketSender();
  sender.sendSubInterface(uid(BOARD, BOARD_POPUP), TASK_INFO, OVERLAY);
  sender.sendInterfaceScript(SCRIPT_TASK_INFO, [uid(BOARD, BOARD_POPUP), task.row, 0, 0]);
  player.setEnteredAmountAction({ execute: (amount) => answerTask(player, dockId, task, amount) });
}

/** Why the task can't be taken, or null. The refusals' wording is ours (not captured). */
function refusal(player, task) {
  const { Skill } = common.core();
  if (task.type !== "courier") return "Bounty tasks aren't available yet.";
  if (player.getSkillManager().getMaxLevel(Skill.SAILING) < task.level) {
    return `You need a Sailing level of ${task.level} to take on this task.`;
  }
  const held = common.slots(player);
  if (held.some((slot) => slot?.id === task.id)) return "You have already accepted this task.";
  if (held.slice(0, common.slotLimit(player)).every((slot) => slot)) {
    return "You can't take on any more port tasks right now.";
  }
  return null;
}

function answerTask(player, dockId, task, amount) {
  player.getPacketSender().closeSubInterface(uid(BOARD, BOARD_POPUP));
  if (amount !== 1) return;
  const refused = refusal(player, task);
  if (refused) {
    player.sendMessage(refused);
    return;
  }
  const held = common.slots(player);
  const free = held.findIndex((slot, i) => !slot && i < common.slotLimit(player));
  held[free] = { id: task.id, taken: 0, delivered: 0 };
  common.setSlots(player, held);
  player.sendMessage(`You have accepted the ${common.blue(task.name)} port task.`);
  openBoard(player, dockId);
}

function attach(api) {
  common.init(api);
  api.persistAttribute(common.BOARDS_ATTRIBUTE);
  api.onObjectInteraction("Notice board", { Inspect: inspectBoard });
  api.onInterfaceActionClick(clickBoard);
}

module.exports = attach;
module.exports.replaceOnBoard = replaceOnBoard;
module.exports.boardTasks = boardTasks;
module.exports.refusal = refusal;
