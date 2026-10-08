"use strict";

/**
 * CitizenMeal — the meal break as a first-class activity.
 *
 * Hungry -> the decision layer picks citizen_meal -> walk to the kingdom
 * market (a real sites.json anchor, never an invented tile) -> eat from own
 * inventory or buy a loaf from a bread-selling merchant citizen (real coin
 * and item transfer via CitizenNeeds.attemptFeed) -> done.
 *
 * Non-repeat: it completes (fed, or gave up after a few minutes hungry and
 * broke — the needs lines make that visible) and the brain re-decides.
 */

const { playerState } = require("../../../bots/brain/ActionState");
const {
  requestMovement,
  clearMovementRequest,
} = require("../../../bots/behaviours/navigation/BotNavigation");
const { siteTile, kingdomIdOf } = require("../CitizenSites");
const {
  ATTR_CITIZEN_PERSONALITY,
  ATTR_CITIZEN_ROLE,
  ROLE_MERCHANT,
} = require("../../constants");
const {
  needsFor,
  attemptFeed,
  sellsFood,
  HUNGRY_AT,
} = require("../CitizenNeeds");
const {
  agentRng,
  logNormalJitter,
  noisyTile,
  humanizerProfile,
} = require("../../lib/humanizer");

const ARRIVE_RADIUS = 6;
// A meal break that can't complete (no bread, no sellers, no coins) still
// ends — standing at the market forever is the old bug in a new coat.
const GIVE_UP_MS = 3 * 60 * 1000;

const FULL_LINES = Object.freeze([
  "Good. Back to it.",
  "Right — where was I?",
  "That'll keep me going.",
]);

function atTile(player, tile, radius) {
  const loc = player.getLocation();
  return (
    loc.getZ() === (tile.z ?? 0) &&
    Math.max(Math.abs(loc.getX() - tile.x), Math.abs(loc.getY() - tile.y)) <= radius
  );
}

function walkTo(player, tile) {
  const noisy = noisyTile(tile.x, tile.y, 3, null);
  requestMovement(player, noisy.x, noisy.y, {
    reason: "citizen_meal",
    basicPather: true,
    z: tile.z ?? 0,
  });
}

/** Bread-selling merchant citizens in view — the meal's food source. */
function localProvisioners(player) {
  const out = [];
  for (const local of player.getLocalPlayers?.() ?? []) {
    if (local === player || local?.isPlayerBot?.() !== true) {
      continue;
    }
    try {
      if (
        local.getAttribute?.(ATTR_CITIZEN_ROLE) === ROLE_MERCHANT &&
        sellsFood(local)
      ) {
        out.push(local);
      }
    } catch {
      // A broken read skips one candidate, not the meal.
    }
  }
  return out;
}

function createCitizenMealAction(spec, world) {
  function botState(player) {
    return playerState(action, player, () => {
      const personality = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
      return {
        rng: agentRng(`meal:${player.getUsername?.() ?? "unknown"}`),
        human: humanizerProfile(personality),
        giveUpAt: 0,
        saidFull: false,
      };
    });
  }

  const action = {
    id: "citizenMeal",
    update(ctx) {
      const { player, nowMs } = ctx;
      const state = botState(player);
      const market = siteTile(player, "market");
      if (!market) {
        return "failed"; // no market anchor for this kingdom
      }
      if (!state.giveUpAt) {
        state.giveUpAt = nowMs + GIVE_UP_MS;
      }
      if (!atTile(player, market, ARRIVE_RADIUS)) {
        walkTo(player, market);
        return "running";
      }
      const needs = needsFor(player);
      if (!needs || needs.hunger >= HUNGRY_AT) {
        if (!state.saidFull && needs) {
          state.saidFull = true;
          try {
            const line = FULL_LINES[Math.floor(state.rng() * FULL_LINES.length)];
            player.forceChat?.(line);
          } catch {
            // Cosmetic only.
          }
        }
        return "success";
      }
      if (nowMs >= state.giveUpAt) {
        // Hungry and broke, sellers nowhere — the needs system already says
        // so out loud. End the activity; the citizen gets on with their day.
        return "success";
      }
      attemptFeed(player, localProvisioners(player));
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
  createCitizenMealAction,
};
