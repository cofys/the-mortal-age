"use strict";

/**
 * The staircase between Aldarin (1388, 2915) and the lab, and Clanila who minds it.
 *
 * rsprox captures (recordings 821, 1107, 4184, 4186):
 * - Climb-down, the first time: Clanila stops the player ("Hey! Where do you think you're
 *   going?"), the Wiki's "Transcript:Clanila" entering variant. With 60 Herblore she lets them
 *   in: varbit 11335 (mm_introduction_complete) is set on her last line and the player goes
 *   down as they close it. Below 60 the transcript ends with its level message.
 * - Climbing either way: the screen fades out (fade_overlay, script 948 [0, 255, 0, 0, 50]),
 *   two ticks later the player is moved (down to 1388, 9313; up to 1388, 2918), a tick later
 *   it fades back in, and the overlay closes two ticks after that.
 */

const Shared = require("./Shared.Mixology");

const ENTRANCE_VARIANT = "standard-dialogue-attempting-to-enter-the-alchemical-society-for-the-first-time";
/** "Transcript:Clanila" steps, by id. */
const STEP = { TOO_LOW: "K7Ytht", SKILLED: "pvQsKk", ENTERS: "N2NpqG" };
const REQUIRED_LEVEL = 60;

const OVERLAY_ATMOSPHERE_UID = (161 << 16) | 1;
const FADE_OVERLAY = 174;
const FADE_SCRIPT = 948;
const FADE_CYCLES = 50;
const MOVE_TICKS = 2;
const FADE_IN_TICKS = 3;
const CLOSE_OVERLAY_TICKS = 5;

function fade(player, out) {
  const args = out ? [0, 255, 0, 0, FADE_CYCLES] : [0, 0, 0, 255, FADE_CYCLES];
  player.getPacketSender().sendSubInterface(OVERLAY_ATMOSPHERE_UID, FADE_OVERLAY, 1, { postScripts: [{ scriptId: FADE_SCRIPT, args }] });
}

/** Fade out, move, fade back in. */
function climb(player, tile) {
  const { Task, TaskManager, Location } = Shared.core();
  const movement = player.getMovementQueue();
  fade(player, true);
  movement.setBlockMovement(true).reset();
  let ticks = 0;
  TaskManager.submit(new (class extends Task {
    constructor() { super(1, player, false); }
    execute() {
      ticks++;
      if (!player.isRegistered()) {
        this.stop();
        return;
      }
      if (ticks === MOVE_TICKS) player.moveTo(new Location(tile.x, tile.y, Shared.LAB.z));
      if (ticks === FADE_IN_TICKS) {
        movement.setBlockMovement(false);
        fade(player, false);
      }
      if (ticks >= CLOSE_OVERLAY_TICKS) {
        player.getPacketSender().closeSubInterface(OVERLAY_ATMOSPHERE_UID);
        this.stop();
      }
    }
    stop() {
      movement.setBlockMovement(false);
      super.stop();
    }
  })());
}

function climbDown(event) {
  const { player } = event;
  if (event.objectId !== Shared.OBJECT.STAIRS_DOWN) return false;
  if (Shared.get(player, Shared.VARBIT.INTRODUCTION_COMPLETE) === 1) {
    climb(player, Shared.LOC.STAIRS_BOTTOM);
    return true;
  }
  if (!Shared.npcSays(player, Shared.NPC.CLANILA, ENTRANCE_VARIANT)) climb(player, Shared.LOC.STAIRS_BOTTOM);
  return true;
}

function climbUp(event) {
  if (event.objectId !== Shared.OBJECT.STAIRS_UP) return false;
  climb(event.player, Shared.LOC.STAIRS_TOP);
  return true;
}

function isClanila(npcId) {
  return npcId === Shared.NPC.CLANILA;
}

/** Wiki: 60 Herblore, not boostable. */
function answerCondition({ npcId, player, stepId }) {
  if (!isClanila(npcId)) return null;
  const skilled = Shared.herbloreBase(player) >= REQUIRED_LEVEL;
  if (stepId === STEP.TOO_LOW) return !skilled;
  if (stepId === STEP.SKILLED) return skilled;
  return null;
}

/** Her last line lets the player in: the flag is set and they go down as they close it. */
function letIn(request) {
  if (!isClanila(request.npcId) || request.stepId !== STEP.ENTERS) return;
  request.handled = true;
  request.end = true;
  const { player } = request;
  Shared.set(player, Shared.VARBIT.INTRODUCTION_COMPLETE, 1);
  climb(player, Shared.LOC.STAIRS_BOTTOM);
}

module.exports = function attachStairs(api) {
  api.onObjectInteraction("Staircase", { "Climb-down": climbDown, "Climb-up": climbUp });
  api.onNpcDialogueCondition(answerCondition);
  api.onCustomEvent("npc-dialogue:action", letIn);
};
