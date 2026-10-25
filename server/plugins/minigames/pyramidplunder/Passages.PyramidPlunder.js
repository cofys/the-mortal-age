"use strict";

/**
 * The ways through a room:
 * - **Speartrap** (Pass; ntk_trap_active 1 armed from the room's start, as captured live): the
 *   disarm takes six ticks - "You carefully try..." a tick in, the work animation (synth 1220) at
 *   two and four, then at six the Thieving roll (10 XP): "You deactivate the trap!" (synth 2387)
 *   with the player walking across that tick, and the varbit to 0 two ticks later for the rest
 *   of the room; or "You fail to deactivate the trap." and the spears hit for 1-4. The trap loc
 *   doesn't block, so walking onto it while armed springs it (Session pushes the player back).
 * - **Tomb doors** (ntk_tomb_door1..4; ntk_doorN_state 0 locked, 1 open): Pick-lock, easier with
 *   a lockpick, which halves the XP. One door per room leads on (drawn when the run starts);
 *   after three dead ends the fourth always leads on. The
 *   next room needs its Thieving level. In room 8 the doors lead out, after a confirmation.
 * - **Tomb door exits** (ntk_tomb_door_exit, Leave Tomb / Quick-leave) end the run outside, and
 *   the antechamber exits (ntk_antechamber_exit) take the player out of a lobby.
 *
 * Wiki: https://oldschool.runescape.wiki/w/Speartrap, https://oldschool.runescape.wiki/w/Tomb_Door
 */

const Common = require("./Common.PyramidPlunder");

const TRAP_XP = 10;
/** Ticks a lock pick takes. */
const ACTION_TICKS = 2;
/** The captured disarm: the first line, the two work animations, the result, the trap down. */
const DISARM = { tryAt: 1, workAt: [2, 4], resultAt: 6, downAt: 8 };

function runIn(player, location) {
  const run = Common.sessionOf(player);
  if (!run || Common.roomAt(location.x, location.y, location.z) !== run.room) return null;
  return run;
}

// --- The speartrap

/** The tile across the 2x2 trap from the player. */
function crossingTile(trap, at) {
  if (trap.horizontal) {
    const y = Math.max(trap.y, Math.min(trap.y + 1, at.y));
    return { x: at.x < trap.x ? trap.x + 2 : trap.x - 1, y };
  }
  const x = Math.max(trap.x, Math.min(trap.x + 1, at.x));
  return { x, y: at.y < trap.y ? trap.y + 2 : trap.y - 1 };
}

/** The trap covers 2x2 tiles from its south-west corner. */
function onTrap(trap, x, y) {
  return x >= trap.x && x <= trap.x + 1 && y >= trap.y && y <= trap.y + 1;
}

/** Walking onto an armed trap: the spears hit and the player is pushed back where they came from. */
function springTrap(player, run, random = Math.random) {
  player.sendMessage(Common.MESSAGES.trapFail);
  Common.hit(player, Common.rollHit(random));
  const back = run.lastSafe ?? Common.roomData(run.room).entry;
  player.moveTo(Common.location(back));
}

function passTrap(event, random = Math.random) {
  const player = event.player;
  const run = runIn(player, event.location);
  if (!run) return true;
  const v = Common.ids().varbit;
  // Already disarmed for this room: Pass just walks across.
  if (run.trapDisarmed || Common.varbitOf(player, v.trap) === 0) {
    walkAcross(player, run);
    return true;
  }
  if (!Common.takeAction(run, DISARM.resultAt)) return true;
  const at = player.getLocation();
  const origin = { x: at.getX(), y: at.getY() };
  const still = () => {
    if (Common.sessionOf(player) !== run) return false;
    const now = player.getLocation();
    return now.getX() === origin.x && now.getY() === origin.y;
  };
  Common.later(DISARM.tryAt, () => still() && player.sendMessage(Common.MESSAGES.trapTry));
  for (const tick of DISARM.workAt) {
    Common.later(tick, () => {
      if (!still()) return;
      player.performAnimation(new (Common.getCore().Animation)(Common.ids().anim.pick));
      Common.sound(player, Common.ids().sound.trapWork);
    });
  }
  Common.later(DISARM.resultAt, () => {
    if (!still()) return;
    if (!Common.roll(Common.chanceOf("speartrap", Common.thievingLevel(player), run.room), random)) {
      player.sendMessage(Common.MESSAGES.trapFail);
      Common.hit(player, Common.rollHit(random));
      return;
    }
    run.trapDisarmed = true;
    player.sendMessage(Common.MESSAGES.trapDisarmed);
    Common.sound(player, Common.ids().sound.trapDisarmed);
    Common.addXp(player, "THIEVING", TRAP_XP);
    walkAcross(player, run);
    Common.later(DISARM.downAt - DISARM.resultAt, () => {
      if (Common.sessionOf(player) === run && run.trapDisarmed) Common.send(player, v.trap, 0);
    });
  });
  return true;
}

/**
 * Walks the player over the trap to the tile across from them, as a forced walk: the map
 * blocks ordinary walking over the trap, and live shows the player walking across on the
 * disarm's tick.
 */
function walkAcross(player, run) {
  if (player.getForceMovement?.()) return;
  const { Location, ForceMovement, ForceMovementTask, TaskManager } = Common.getCore();
  const room = Common.roomData(run.room);
  const at = player.getLocation();
  const tile = crossingTile(room.trap, { x: at.getX(), y: at.getY() });
  const dx = tile.x - at.getX();
  const dy = tile.y - at.getY();
  const steps = Math.max(Math.abs(dx), Math.abs(dy));
  const direction = dy > 0 ? 0 : dx > 0 ? 1 : dy < 0 ? 2 : 3;
  player.getMovementQueue().reset?.();
  TaskManager.submit(new ForceMovementTask(player, Math.max(1, steps),
    new ForceMovement(new Location(at.getX(), at.getY(), at.getZ()), new Location(dx, dy), 0, 30 * steps, direction, Common.ids().anim.walk)));
}

// --- Tomb doors

function doorNumber(objectId) {
  return Common.ids().tombDoors.get(objectId);
}

/** Leads on: this room's exit for everyone, or the fourth door once the other three failed. */
function leadsOn(player, run, door) {
  if (run.exits[run.room - 1] === door) return true;
  const opened = Common.ids().varbit.doors.filter((id, i) => i + 1 !== door && Common.varbitOf(player, id) === 1);
  return opened.length === 3;
}

function nextRoom(player, run) {
  const next = run.room + 1;
  Common.later(1, () => {
    if (Common.sessionOf(player) === run) Common.enterRoom(player, run, next);
  });
}

function pickLock(event, random = Math.random) {
  const door = doorNumber(event.objectId);
  if (door === undefined) return false;
  const player = event.player;
  const run = runIn(player, event.location);
  if (!run) return true;
  if (run.room >= Common.LAST_ROOM) {
    confirmLeave(player, Common.MESSAGES.lastRoomDoor);
    return true;
  }
  const next = Common.roomData(run.room + 1);
  if (Common.baseThievingLevel(player) < next.level) {
    player.sendMessage(Common.MESSAGES.level(next.level));
    return true;
  }
  const varbit = Common.ids().varbit.doors[door - 1];
  if (Common.varbitOf(player, varbit) === 1) {
    if (leadsOn(player, run, door)) nextRoom(player, run);
    else player.sendMessage(Common.MESSAGES.deadEnd);
    return true;
  }
  if (!Common.takeAction(run, ACTION_TICKS)) return true;
  const lockpick = player.getInventory().getAmount(Common.ids().item.lockpick) > 0;
  player.sendMessage(lockpick ? Common.MESSAGES.lockpick : Common.MESSAGES.noLockpick);
  player.performAnimation(new (Common.getCore().Animation)(Common.ids().anim.pick));
  const chance = Common.chanceOf(lockpick ? "doorLockpick" : "door", Common.thievingLevel(player), run.room);
  if (!Common.roll(chance, random)) {
    player.sendMessage(Common.MESSAGES.doorFail);
    return true;
  }
  Common.send(player, varbit, 1);
  Common.sound(player, Common.ids().sound.door);
  if (event.object && Common.ids().anim.door !== null) {
    player.getPacketSender().sendObjectAnimation(event.object, new (Common.getCore().Animation)(Common.ids().anim.door));
  }
  const xp = Common.roomData(run.room).doorXp;
  Common.addXp(player, "THIEVING", lockpick ? xp / 2 : xp);
  if (leadsOn(player, run, door)) nextRoom(player, run);
  else player.sendMessage(Common.MESSAGES.deadEnd);
  return true;
}

// --- Exits

/** The tomb's way out asks first, as live does. */
function confirmLeave(player, question) {
  Common.getApi().sendMultiChatboxPrompt(player, question,
    "Yes, I'm out of here.", () => leaveNow(player),
    "Ah, I think I'll stay a little longer here.", () => {});
}

function leaveNow(player) {
  if (!Common.endRun(player)) player.moveTo(Common.location(Common.DATA.outside));
}

function leaveTomb(event) {
  if (event.objectId === Common.ids().tombExit) {
    if (event.option?.toLowerCase() === "quick-leave") leaveNow(event.player);
    else confirmLeave(event.player, Common.MESSAGES.leaveTomb);
    return true;
  }
  if (event.objectId === Common.ids().antechamberExit) {
    event.player.moveTo(Common.location(Common.DATA.outside));
    return true;
  }
  return false;
}

module.exports = function registerPassages(api) {
  Common.bind(api);
  api.onObjectInteraction("Speartrap", { Pass: passTrap });
  api.onObjectInteraction("Tomb Door", {
    "Pick-lock": pickLock,
    Enter: pickLock,
    "Leave Tomb": leaveTomb,
    "Quick-leave": leaveTomb,
  });
};

module.exports.onTrap = onTrap;
module.exports.springTrap = springTrap;
module.exports._test = { TRAP_XP, ACTION_TICKS, DISARM, walkAcross, confirmLeave, leaveNow, crossingTile, onTrap, springTrap, passTrap, leadsOn, pickLock, leaveTomb };
