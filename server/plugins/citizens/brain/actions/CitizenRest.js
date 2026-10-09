"use strict";

/**
 * CitizenRest — the rest break as a first-class activity.
 *
 * Weary -> the decision layer picks citizen_rest -> walk home (the citizen's
 * real home tile from brain state) -> linger with human timing, recovering
 * energy through CitizenNeeds.addEnergy -> done when rested or the break
 * runs long.
 *
 * Non-repeat: it completes and the brain re-decides. Rest is visible (the
 * needs system already complains out loud when weary; the rest lines below
 * mark the recovery), never frozen silence.
 */

const { playerState } = require("../../../bots/brain/ActionState");
const {
  requestMovement,
  clearMovementRequest,
} = require("../../../bots/behaviours/navigation/BotNavigation");
const { ATTR_CITIZEN_PERSONALITY } = require("../../constants");
const { needsFor, addEnergy } = require("../CitizenNeeds");
const { sayPublic } = require("../../chat/CitizenSayPublic");
const {
  agentRng,
  logNormalJitter,
  personalSpot,
  humanizerProfile,
} = require("../../lib/humanizer");

const ARRIVE_RADIUS = 4;
// Rested enough to get back to it.
const RESTED_AT = 55;
// A rest break that can't finish (needs missing etc.) still ends.
const GIVE_UP_MS = 8 * 60 * 1000;
// Recovery cadence while resting: +6 energy every 30s (~12/min against the
// 10/hr awake decay) — a weary citizen is back on their feet in minutes,
// like a player sitting out a few inventory loads.
const RECOVER_EVERY_MS = 30 * 1000;
const RECOVER_AMOUNT = 6;

const REST_LINES = Object.freeze([
  "Just resting my eyes...",
  "Five more minutes. Then back to it.",
  "My feet are killing me.",
  "Nothing like sitting down after a long shift.",
]);

function atTile(player, tile, radius) {
  const loc = player.getLocation();
  return (
    loc.getZ() === (tile.z ?? 0) &&
    Math.max(Math.abs(loc.getX() - tile.x), Math.abs(loc.getY() - tile.y)) <= radius
  );
}

function walkTo(player, tile, username) {
  // Home is already per-citizen, but the exact home tile still stacks when
  // citizens share a household. Personal offset keeps them apart.
  const spot = personalSpot(username, tile.x, tile.y, 1, 4);
  requestMovement(player, spot.x, spot.y, {
    reason: "citizen_rest",
    basicPather: true,
    z: tile.z ?? 0,
  });
}

function createCitizenRestAction(spec, world) {
  function botState(player) {
    return playerState(action, player, () => {
      const personality = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
      return {
        rng: agentRng(`rest:${player.getUsername?.() ?? "unknown"}`),
        human: humanizerProfile(personality),
        giveUpAt: 0,
        nextRecoverAt: 0,
        nextLineAt: 0,
      };
    });
  }

  const action = {
    id: "citizenRest",
    update(ctx) {
      const { player, nowMs } = ctx;
      const state = botState(player);
      const home = ctx.state?.home;
      if (!home) {
        return "failed"; // nowhere to rest
      }
      if (!state.giveUpAt) {
        state.giveUpAt = nowMs + GIVE_UP_MS;
      }
      if (!atTile(player, home, ARRIVE_RADIUS)) {
        walkTo(player, home, player.getUsername?.() ?? "unknown");
        return "running";
      }
      const needs = needsFor(player);
      if (needs && needs.energy >= RESTED_AT) {
        return "success";
      }
      if (nowMs >= state.giveUpAt) {
        return "success";
      }
      if (nowMs >= state.nextRecoverAt) {
        state.nextRecoverAt = nowMs + RECOVER_EVERY_MS;
        addEnergy(player, RECOVER_AMOUNT);
      }
      if (nowMs >= state.nextLineAt) {
        state.nextLineAt =
          nowMs + logNormalJitter(state.rng, 90000, state.human.tempoSigma);
        try {
          sayPublic(player, 
            REST_LINES[Math.floor(state.rng() * REST_LINES.length)]
          );
        } catch {
          // Cosmetic only.
        }
      }
      return "running";
    },
    stop(ctx) {
      if (ctx?.player) {
        clearMovementRequest(ctx.player);
      }
    },
  };

  return action;
}

module.exports = {
  createCitizenRestAction,
};
