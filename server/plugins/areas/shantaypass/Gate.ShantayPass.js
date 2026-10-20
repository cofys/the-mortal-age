/**
 * The Shantay Pass gate (loc 4031, 4x1 at 3302-3305, 3116), as rsprox captures show it:
 *
 * - Going south into the desert takes a Shantay pass ("The guard takes your Shantay Pass as
 *   you go through the gate."). Without one, the gate guard says so. The elite Desert Diary
 *   lets a player through without a pass (Wiki).
 * - Until it is turned off, the desert warning (565, cws_warning_10) opens first, a tick after
 *   arriving. Each showing counts up varbit 3860 to 6; from then on it offers "Don't ask me
 *   this again", which sets 7: no more warnings.
 * - A tick after arriving (or after "Proceed regardless") the player steps onto the gate's row,
 *   the next tick through it, and a tick later faces the way they went. Going north is free.
 * - The guard's "Pass" does the same from wherever the player stands north of the gate.
 * - "Look-at" reads the billboard poster: three message boxes.
 */
const Common = require("./Common.ShantayPass");

const GATE_X = 3302;
const GATE_WIDTH = 4;
const GATE_Y = 3116;
const GATE_GUARD = 4648;

const WARNING = 565;
const WARNING_PROCEED = 17;
const WARNING_STAY_OUT = 18;
const WARNING_DONT_ASK = 20;
const WARNING_DONT_ASK_LAYER = (WARNING << 16) | 21;
const WARNING_VARBIT = 3860; // cws_warning_10
/** The showings after which the warning offers "Don't ask me this again". */
const WARNING_OFFER_TOGGLE = 6;
const WARNING_OFF = 7;
const SCRIPT_MAINMODAL_OPEN = 2524;
const WARNINGS_ATTRIBUTE = "shantay-pass:warnings";
const PENDING_ATTRIBUTE = "shantay-pass:pending-crossing";

const TOGGLED_OFF_MESSAGE = "You have toggled this warning screen off. You will not see this warning screen unless you speak to the Doomsayer in Lumbridge to turn it on again.";
const PASS_TAKEN_MESSAGE = "The guard takes your Shantay Pass as you go through the gate.";
const NO_PASS_LINE = "You need a Shantay pass to get through this gate. See Shantay, he will sell you one for a very reasonable price.";

const BILLBOARD = [
  "You look at the huge stone gate.<br>Near the gate is a large billboard poster, it reads:",
  "<col=800000>The Desert is a VERY Dangerous place. Do not enter if you are<br><col=800000>afraid of dying. Beware of high temperatures, sand storms, robbers,<br><col=800000>and slavers. No responsibility is taken by Shantay if anything bad<br><col=800000>should happen to you in any circumstances whatsoever.",
  "Despite this warning lots of people seem to pass through the gate.",
];

const DESERT_ROBES_TASK = "enter-the-desert-with-a-set-of-desert-robes-equi";
const FACE_SOUTH = [0, -1];
const FACE_NORTH = [0, 1];

/**
 * The two steps through the gate from `source`, the tile north or south of it the player
 * stands on: `desert` when they head south into the desert.
 */
function crossingFor(source) {
  if (!source || !Number.isInteger(source.x) || !Number.isInteger(source.y) || source.z !== 0) return null;
  if (source.x < GATE_X || source.x >= GATE_X + GATE_WIDTH) return null;
  if (source.y === GATE_Y + 1) return { desert: true, path: [[source.x, GATE_Y], [source.x, GATE_Y - 1]] };
  if (source.y === GATE_Y - 1) return { desert: false, path: [[source.x, GATE_Y], [source.x, GATE_Y + 1]] };
  return null;
}

function sourceOf(player) {
  const at = player.getLocation();
  return { x: at.getX(), y: at.getY(), z: at.getZ() };
}

function mayEnterDesert(player) {
  const core = Common.getCore();
  return Common.diaryComplete(player, "elite")
    || player.getInventory().getAmount(core.ItemIdentifiers.SHANTAY_PASS) > 0;
}

function wearsDesertRobes(player) {
  const { Equipment, ItemIdentifiers } = Common.getCore();
  const equipment = player.getEquipment();
  const worn = (slot) => equipment.get(slot)?.getId?.();
  return worn(Equipment.BODY_SLOT) === ItemIdentifiers.DESERT_SHIRT
    && worn(Equipment.LEG_SLOT) === ItemIdentifiers.DESERT_ROBE
    && worn(Equipment.FEET_SLOT) === ItemIdentifiers.DESERT_BOOTS;
}

/** The two steps, a tick apart, then facing on; the pass goes as the first step is taken. */
function walkThrough(player, crossing) {
  const core = Common.getCore();
  const queue = player.getMovementQueue();
  queue.reset();
  queue.setBlockMovement(true);
  if (crossing.desert && !Common.diaryComplete(player, "elite")) {
    player.getInventory().deleteNumber(core.ItemIdentifiers.SHANTAY_PASS, 1);
    player.getInventory().refreshItems();
    player.sendMessage(PASS_TAKEN_MESSAGE);
  }
  Common.step(player, crossing.path[0]);
  Common.later(player, 1, () => {
    Common.step(player, crossing.path[1]);
    if (crossing.desert && wearsDesertRobes(player)) {
      Common.getApi().emitCustomEvent("diary:task", { player, diary: "desert", task: DESERT_ROBES_TASK });
    }
    Common.later(player, 1, () => {
      queue.setBlockMovement(false);
      const at = player.getLocation();
      const [dx, dy] = crossing.desert ? FACE_SOUTH : FACE_NORTH;
      player.setPositionToFace(Common.tile(at.getX() + dx, at.getY() + dy, at.getZ()));
    });
  });
}

function showWarning(player, crossing) {
  const sender = player.getPacketSender();
  const shown = Number(player.getAttribute(WARNINGS_ATTRIBUTE)) || 0;
  player.setAttribute(PENDING_ATTRIBUTE, crossing);
  if (shown >= WARNING_OFFER_TOGGLE) {
    sender.sendInterfaceDisplayState(WARNING_DONT_ASK_LAYER, false);
  } else {
    player.setAttribute(WARNINGS_ATTRIBUTE, shown + 1);
    sender.sendVarbit(WARNING_VARBIT, shown + 1);
  }
  sender.sendInterfaceScript(SCRIPT_MAINMODAL_OPEN, [-1, -1]);
  sender.sendInterface(WARNING);
}

/** A tick after arriving: the guard, the warning or straight through. */
function cross(player, crossing) {
  if (crossing.desert && !mayEnterDesert(player)) {
    Common.npcLine(player, GATE_GUARD, NO_PASS_LINE);
    return;
  }
  const warned = (Number(player.getAttribute(WARNINGS_ATTRIBUTE)) || 0) >= WARNING_OFF;
  if (crossing.desert && !warned) {
    showWarning(player, crossing);
    return;
  }
  walkThrough(player, crossing);
}

function goThrough(event) {
  const { player } = event;
  const crossing = crossingFor(sourceOf(player));
  if (!crossing) return false;
  player.getMovementQueue().reset();
  Common.later(player, 1, () => cross(player, crossing));
  return true;
}

/** The gate guard's "Pass": through the gate from where the player stands north of it. */
function passGuard(event) {
  const { player } = event;
  const at = player.getLocation();
  if (at.getZ() !== 0 || at.getY() <= GATE_Y) return false;
  const x = Math.min(GATE_X + GATE_WIDTH - 1, Math.max(GATE_X, at.getX()));
  const approach = [x, GATE_Y + 1];
  player.getMovementQueue().reset();
  walkThen(player, approach, () => cross(player, crossingFor({ x, y: GATE_Y + 1, z: 0 })));
  return true;
}

/** A step a tick towards `target`, then `action` a tick after arriving. */
function walkThen(player, target, action) {
  Common.later(player, 1, () => {
    const at = player.getLocation();
    if (at.getX() === target[0] && at.getY() === target[1]) {
      action();
      return;
    }
    Common.step(player, target);
    walkThen(player, target, action);
  });
}

function warningClick(event) {
  const buttonId = Number(event.buttonId ?? 0);
  if ((event.groupId ?? (buttonId >>> 16)) !== WARNING) return;
  const child = event.childId ?? (buttonId & 0xffff);
  const { player } = event;
  if (child === WARNING_DONT_ASK) {
    event.handled = true;
    player.setAttribute(WARNINGS_ATTRIBUTE, WARNING_OFF);
    player.getPacketSender().sendVarbit(WARNING_VARBIT, WARNING_OFF);
    player.sendMessage(TOGGLED_OFF_MESSAGE);
    return;
  }
  if (child !== WARNING_PROCEED && child !== WARNING_STAY_OUT) return;
  event.handled = true;
  const crossing = player.getAttribute(PENDING_ATTRIBUTE);
  player.setAttribute(PENDING_ATTRIBUTE, null);
  player.getPacketSender().sendInterfaceRemoval();
  if (child !== WARNING_PROCEED || !crossing) return;
  // The player may have walked off while the warning was up.
  const now = crossingFor(sourceOf(player));
  if (!now || now.desert !== crossing.desert || !mayEnterDesert(player)) return;
  walkThrough(player, now);
}

function lookAt({ player }) {
  const { DialogueChainBuilder, StatementDialogue, EndDialogue } = Common.getCore();
  const chain = new DialogueChainBuilder();
  BILLBOARD.forEach((text, index) => chain.add(new StatementDialogue(index, text)));
  chain.add(new EndDialogue(BILLBOARD.length));
  player.getDialogueManager().startDialogues(chain);
  return true;
}

function restoreWarningVarbit({ player }) {
  const shown = Number(player.getAttribute(WARNINGS_ATTRIBUTE)) || 0;
  if (shown > 0) player.getPacketSender().sendVarbit(WARNING_VARBIT, shown);
}

function attach(api) {
  api.persistAttribute(WARNINGS_ATTRIBUTE, 0);
  api.onObjectInteraction("Shantay pass", { "Go-through": goThrough, "Look-at": lookAt });
  api.onNpcInteraction("Shantay Guard", { Pass: passGuard });
  api.onInterfaceActionClick(warningClick);
  api.onPlayerLogin(restoreWarningVarbit);
}

module.exports = attach;
module.exports.crossingFor = crossingFor;
