"use strict";

/**
 * The lab as an Area: only players inside pay for its per-tick work.
 *
 * - The HUD (882) is up while the player is in the lab proper, from y 9319 (rsprox captures:
 *   it opens a tick after the player steps past the lobby and closes as they step back).
 * - While the player is not working a station, live re-sends the three stations' idle loops
 *   every tick (machinery_alchemy01_retort01_idle01 and the agitator's and alembic's); while a
 *   station runs it sends none. A station's own work, the lever loops and the digweed patches
 *   tick through their units.
 * - Leaving (walking out, teleporting, logging out) pauses a station and withers any digweed:
 *   it can't leave the lab (Wiki).
 */

const Shared = require("./Shared.Mixology");
const Stations = require("./Stations.Mixology");
const Mixer = require("./Mixer.Mixology");
const Digweed = require("./Digweed.Mixology");

const MACHINE_IDLE = [
  [Shared.LOC.RETORT, "machinery_alchemy01_retort01_idle01"],
  [Shared.LOC.AGITATOR, "machinery_alchemy01_agitator01_idle01"],
  [Shared.LOC.ALEMBIC, "machinery_alchemy01_alembic01_idle01"],
];

function openHud(player) {
  player.getPacketSender().sendSubInterface(Shared.OVERLAY_HUD_UID, Shared.INTERFACE.HUD, 1);
}

function closeHud(player) {
  player.getPacketSender().closeSubInterface(Shared.OVERLAY_HUD_UID);
}

function idleMachines(player) {
  for (const [loc, sequence] of MACHINE_IDLE) Shared.animateLoc(player, loc, sequence);
}

function processPlayer(player) {
  const now = Shared.tick();
  if (!Stations.isWorking(player)) idleMachines(player);
  Stations.tick(player, now);
  Mixer.tick(player, now);
  Digweed.tick(player, now);
}

function enterLab(player) {
  openHud(player);
  Mixer.showMixers(player);
  idleMachines(player);
}

function leaveLab(player) {
  closeHud(player);
  Stations.stop(player);
  Digweed.leaveLab(player);
}

function createArea() {
  const { Area, Boundary } = Shared.core();
  const lab = Shared.LAB;
  class MixologyLab extends Area {
    process(mobile) {
      if (mobile.isPlayer()) processPlayer(mobile.getAsPlayer());
    }

    postEnter(mobile) {
      if (mobile.isPlayer()) enterLab(mobile.getAsPlayer());
    }

    postLeave(mobile) {
      if (mobile.isPlayer()) leaveLab(mobile.getAsPlayer());
    }
  }
  return new MixologyLab([new Boundary(lab.minX, lab.maxX, lab.minY, lab.maxY, lab.z)]);
}

module.exports = function attachArea(api) {
  api.registerArea(createArea());
};
