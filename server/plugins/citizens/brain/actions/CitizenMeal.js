"use strict";

/**
 * CitizenMeal — eating as a first-class activity.
 *
 * Jon's correction (2026-10-08): there is no hunger in RuneScape, there's
 * just hitpoints. Citizens eat when HP is low — from inventory, on the spot,
 * like a player clicking food mid-fight. No mandatory walk to the market;
 * no meal-break timer.
 *
 * Flow: hurt -> decision layer picks citizen_meal -> eat bread from own
 * inventory right where they stand (visible eat lines) -> done. Out of
 * food? Walk to a personal spot near the market and buy a loaf from a
 * bread-selling merchant citizen (real coin/item transfer) -> eat -> done.
 *
 * Non-repeat: it completes and the brain re-decides.
 */

const { playerState } = require("../../../bots/brain/ActionState");
const {
  requestMovement,
  clearMovementRequest,
} = require("../../../bots/behaviours/navigation/BotNavigation");
const { siteTile } = require("../CitizenSites");
const {
  ATTR_CITIZEN_PERSONALITY,
  ATTR_CITIZEN_ROLE,
  ROLE_MERCHANT,
} = require("../../constants");
const {
  hpPercent,
  breadCount,
  eat,
  attemptFeed,
  sellsFood,
  HURT_AT,
} = require("../CitizenNeeds");
const {
  agentRng,
  logNormalJitter,
  personalSpot,
  humanizerProfile,
} = require("../../lib/humanizer");

const ARRIVE_RADIUS = 6;
// If resupply can't complete (no sellers, no coins) the activity still ends.
const GIVE_UP_MS = 3 * 60 * 1000;

const EAT_LINES = Object.freeze([
  "*munches*",
  "Nothing like food when you're hurting.",
  "That'll patch me up.",
]);

const FULL_HP_LINES = Object.freeze([
  "Good. Back to it.",
  "Right — where was I?",
  "Patched up.",
]);

function atTile(player, tile, radius) {
  const loc = player.getLocation();
  return (
    loc.getZ() === (tile.z ?? 0) &&
    Math.max(Math.abs(loc.getX() - tile.x), Math.abs(loc.getY() - tile.y)) <= radius
  );
}

function walkTo(player, tile, username) {
  // Personal spot near the market — not the anchor tile itself. Eighteen
  // citizens buying bread should not stand on the same tile.
  const spot = personalSpot(username, tile.x, tile.y, 4, 10);
  requestMovement(player, spot.x, spot.y, {
    reason: "citizen_meal",
    basicPather: true,
    z: tile.z ?? 0,
  });
}

/** Bread-selling merchant citizens in view — the resupply source. */
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
        saidEat: false,
      };
    });
  }

  const action = {
    id: "citizenMeal",
    update(ctx) {
      const { player, nowMs } = ctx;
      const state = botState(player);
      const username = player.getUsername?.() ?? "unknown";

      // Not hurt? Nothing to do — like a player with full HP.
      if (hpPercent(player) >= HURT_AT) {
        if (!state.saidFull) {
          state.saidFull = true;
          try {
            const line = FULL_HP_LINES[Math.floor(state.rng() * FULL_HP_LINES.length)];
            player.forceChat?.(line);
          } catch {
            // Cosmetic only.
          }
        }
        return "success";
      }

      if (!state.giveUpAt) {
        state.giveUpAt = nowMs + GIVE_UP_MS;
      }

      // Have food? Eat on the spot — no walk, like clicking food mid-fight.
      if (breadCount(player) > 0) {
        if (!state.saidEat) {
          state.saidEat = true;
          try {
            const line = EAT_LINES[Math.floor(state.rng() * EAT_LINES.length)];
            player.forceChat?.(line);
          } catch {
            // Cosmetic only.
          }
        }
        eat(player);
        // Eat until patched up or out of food.
        if (hpPercent(player) >= HURT_AT || breadCount(player) <= 0) {
          return "success";
        }
        return "running";
      }

      // Out of food and hurt: resupply at the market, then eat.
      const market = siteTile(player, "market");
      if (!market) {
        return "success"; // no market — nothing we can do
      }
      if (!atTile(player, market, ARRIVE_RADIUS)) {
        walkTo(player, market, username);
        return "running";
      }
      if (nowMs >= state.giveUpAt) {
        return "success"; // no sellers, no coins — day goes on
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
