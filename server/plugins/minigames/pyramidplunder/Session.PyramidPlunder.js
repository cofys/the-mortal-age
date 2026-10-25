"use strict";

/**
 * The run's lifecycle: an Area over the eight rooms runs the five-minute timer (500 ticks,
 * which the client's overlay bar counts as well), and the run ends on time out, on leaving the
 * rooms by any other way (teleports included, as the Wiki allows), on logout and on death.
 * Ending closes every container and door again for that player and returns them in front of
 * the northern panel; loot already taken stays. A player found in the rooms with no run (a
 * login after a crash) is put outside too. Each tick also springs the room's speartrap on a
 * player who walked onto it armed (the trap loc doesn't block movement).
 *
 * Wiki: https://oldschool.runescape.wiki/w/Pyramid_Plunder
 */

const Common = require("./Common.PyramidPlunder");
const Passages = require("./Passages.PyramidPlunder");

/** The client extrapolates the bar; resend the elapsed time now and then to keep it exact. */
const TIMER_RESYNC_TICKS = 50;
const ROOMS_AREA = { minX: 1918, maxX: 1985, minY: 4416, maxY: 4482, z: 0 };

function inRooms(player) {
  const at = player.getLocation();
  return Common.roomAt(at.getX(), at.getY(), at.getZ()) !== 0;
}

/** Per tick: the timer, or putting out a player who has no run here. */
function tick(player) {
  const run = Common.sessionOf(player);
  if (!run) {
    if (inRooms(player)) player.moveTo(Common.location(Common.DATA.outside));
    return;
  }
  const elapsed = Common.elapsedTicks(run);
  if (elapsed >= Common.DATA.timerTicks) {
    Common.endRun(player, { timedOut: true });
    return;
  }
  if (elapsed % TIMER_RESYNC_TICKS === 0) Common.sendTimer(player, run);
  guardTrap(player, run);
}

/** Remembers the last tile off the trap; stepping onto it armed springs it. */
function guardTrap(player, run) {
  const at = player.getLocation();
  const trap = Common.roomData(run.room).trap;
  if (!Passages.onTrap(trap, at.getX(), at.getY())) {
    run.lastSafe = { x: at.getX(), y: at.getY(), z: at.getZ() };
    return;
  }
  // Armed (ntk_trap_active 1) until this room's disarm; walking over a disarmed trap is safe.
  if (!run.trapDisarmed && Common.varbitOf(player, Common.ids().varbit.trap) === 1) Passages.springTrap(player, run);
}

function createArea() {
  const { Area, Boundary } = Common.getCore();
  class PyramidPlunderRooms extends Area {
    process(mobile) {
      if (mobile.isPlayer()) tick(mobile.getAsPlayer());
    }

    /** Teleported or walked out another way: the run is over. */
    postLeave(mobile) {
      if (!mobile.isPlayer()) return;
      const player = mobile.getAsPlayer();
      if (Common.sessionOf(player) && !inRooms(player)) Common.endRun(player, { keepPosition: true });
    }
  }
  return new PyramidPlunderRooms([
    new Boundary(ROOMS_AREA.minX, ROOMS_AREA.maxX, ROOMS_AREA.minY, ROOMS_AREA.maxY, ROOMS_AREA.z),
  ]);
}

function onPlayerLogout(event) {
  Common.endRun(event.player);
}

function onPlayerDeath(event) {
  Common.endRun(event.player, { keepPosition: true });
}

/** A crash saved the player inside: they wake outside, with no run. */
function onPlayerLogin(event) {
  const player = event.player;
  player.setAttribute(Common.RUN_ATTRIBUTE, null);
  if (inRooms(player)) player.moveTo(Common.location(Common.DATA.outside));
  if (player.getAttribute(Common.PLAYED_ATTRIBUTE) === true) Common.send(player, Common.ids().varbit.playedBefore, 1);
}

module.exports = function registerSession(api) {
  Common.bind(api);
  api.persistAttribute(Common.PLAYED_ATTRIBUTE, false);
  api.persistAttribute(Common.TIMED_OUT_ATTRIBUTE, false);
  api.registerArea(createArea());
  api.onPlayerLogout(onPlayerLogout);
  api.onPlayerDisconnect(onPlayerLogout);
  api.onPlayerDeath(onPlayerDeath);
  api.onPlayerLogin(onPlayerLogin);
};

module.exports._test = { TIMER_RESYNC_TICKS, ROOMS_AREA, tick, guardTrap, createArea, onPlayerLogout, onPlayerDeath, onPlayerLogin };
