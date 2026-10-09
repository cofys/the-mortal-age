"use strict";

/**
 * CitizenTravel — travel between kingdom capitals by ship or caravan.
 *
 * Citizens are not rooted to one city. They travel: merchants seeking
 * better prices, families visiting kin, the curious seeing the world,
 * the desperate fleeing trouble. Travel takes real time, costs real
 * coins, and the roads are not safe.
 *
 * Flow per tick:
 *   - Already have a journey -> wait in transit (at the departure point).
 *     On arrival the slow tick moves the roster record; this action
 *     teleports the online traveler to the destination market and ends.
 *   - No journey -> pick a destination (decision layer's snapshot carries
 *     it, or choose the cheapest open route), walk to the dock (ship) or
 *     market gate (caravan), pay the fare, board.
 *   - Can't afford the fare -> "success" (done, brain re-decides).
 *   - Route closed by war -> "success" (no sailing into a war zone).
 *   - Give up after GIVE_UP_MS so a bad travel day never stalls the day.
 *
 * Non-repeat: one journey per activation, then the brain re-decides.
 *
 * Zero LLM. Tick-safe: every engine read guarded, per-action try/catch in
 * the brain.
 */

const { playerState } = require("../../../bots/brain/ActionState");
const {
  requestMovement,
} = require("../../../bots/behaviours/navigation/BotNavigation");
const { siteTile, kingdomIdOf, siteTileByKingdom } = require("../CitizenSites");
const { ATTR_CITIZEN_PERSONALITY } = require("../../constants");
const {
  agentRng,
  personalSpot,
  humanizerProfile,
} = require("../../lib/humanizer");
const Travel = require("../../lib/CitizenTravel");

// If the journey hasn't started in this long, the docks are cursed — move on.
const GIVE_UP_MS = 10 * 60 * 1000;
const ARRIVE_RADIUS = 6;
const DEPARTURE_SPREAD = 5;

/** Departure tile: the dock for ships, the market edge for caravans. */
function departureTile(player, mode) {
  if (mode === "ship") {
    const dock = siteTile(player, "dock");
    if (dock) return dock;
  }
  // Caravans muster at the market.
  return siteTile(player, "market");
}

function walkTo(player, x, y, z, reason) {
  const username = player.getUsername?.() ?? "unknown";
  const spot = personalSpot(username, x, y, DEPARTURE_SPREAD, 10);
  try {
    requestMovement(player, spot.x, spot.y, {
      reason,
      basicPather: true,
      z: z ?? 0,
    });
    return true;
  } catch {
    return false;
  }
}

function distSqTo(player, tile) {
  try {
    const loc = player.getLocation?.();
    if (!loc || !tile) return Number.MAX_SAFE_INTEGER;
    const dx = loc.getX() - tile.x;
    const dy = loc.getY() - tile.y;
    return dx * dx + dy * dy;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/** Teleport the traveler to the destination kingdom's market. */
function teleportToMarket(player, kingdomId) {
  try {
    const tile = siteTileByKingdom(kingdomId, "market");
    if (!tile) return false;
    const loc = player.getLocation?.();
    if (typeof player.teleport === "function") {
      player.teleport(tile.x, tile.y, tile.z ?? 0);
      return true;
    }
    if (loc && typeof loc.setX === "function") {
      loc.setX(tile.x);
      loc.setY(tile.y);
      if (typeof loc.setZ === "function") loc.setZ(tile.z ?? 0);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function createCitizenTravelAction(spec, world) {
  function botState(player) {
    return playerState(action, player, () => {
      const personality = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
      return {
        rng: agentRng(`travel:${player.getUsername?.() ?? "unknown"}`),
        human: humanizerProfile(personality),
        giveUpAt: 0,
        destination: spec?.destination ?? null,
        departed: false,
      };
    });
  }

  const action = {
    id: "citizenTravel",
    update(ctx) {
      const { player, nowMs } = ctx;
      const username = player.getUsername?.() ?? "unknown";
      const state = botState(player);
      if (!state.giveUpAt) state.giveUpAt = nowMs + GIVE_UP_MS;
      if (nowMs >= state.giveUpAt) {
        return "success"; // bad travel day — move on, don't stall
      }

      const homeKingdom = kingdomIdOf(player);

      // Already traveling: wait for the slow tick to process the arrival.
      // When the journey clears, teleport to the destination and finish.
      const journey = Travel.journeyOf(username);
      if (journey) {
        const stillActive = Travel.allJourneys().some(
          (j) => j && j.username === journey.username
        );
        if (!stillActive) {
          // Arrival was processed — move the body to match the record.
          teleportToMarket(player, journey.to);
          return "success";
        }
        // In transit: wait at the departure point.
        const dep = departureTile(player, journey.mode);
        if (dep && distSqTo(player, dep) > ARRIVE_RADIUS * ARRIVE_RADIUS) {
          walkTo(player, dep.x, dep.y, dep.z, "citizen_travel_wait");
        }
        return "running";
      }

      // No journey: plan one. Destination from the decision snapshot, or
      // the cheapest open route.
      let dest = state.destination;
      if (!dest || dest === homeKingdom) {
        dest = cheapestOpenDestination(homeKingdom, state.rng);
      }
      if (!dest) {
        return "success"; // nowhere open to go (war everywhere, or broke)
      }

      const route = Travel.routeBetween(homeKingdom, dest);
      if (!route) return "success";
      if (!Travel.routeOpen(homeKingdom, dest)) return "success";

      // Walk to the departure point, then board.
      const dep = departureTile(player, route.mode);
      if (!dep) return "success";
      if (distSqTo(player, dep) > ARRIVE_RADIUS * ARRIVE_RADIUS) {
        walkTo(player, dep.x, dep.y, dep.z, "citizen_travel_depart");
        return "running";
      }

      // Boarding: pay the fare, start the journey.
      const started = Travel.startJourney(username, homeKingdom, dest, nowMs, player);
      if (!started.ok) {
        return "success"; // can't afford it, or route closed mid-walk
      }

      // Peddlers carry goods.
      if (state.rng() < 0.4) {
        Travel.setCargo(username, Travel.buildCargo(state.rng));
      }

      state.departed = true;
      return "running";
    },
  };

  return action;
}

/** Cheapest open route from a kingdom, or null. Pure with rng. */
function cheapestOpenDestination(homeKingdom, rng) {
  const routes = Travel.routesFrom(homeKingdom).filter((r) =>
    Travel.routeOpen(r.from, r.to)
  );
  if (!routes.length) return null;
  routes.sort((a, b) => a.fare - b.fare);
  // Mostly the cheapest, sometimes a pricier one (humans aren't optimal).
  const r = rng ?? Math.random;
  const idx = r() < 0.7 ? 0 : Math.floor(r() * routes.length);
  return routes[idx].to;
}

module.exports = {
  createCitizenTravelAction,
  // exposed for tests
  _departureTile: departureTile,
  _cheapestOpenDestination: cheapestOpenDestination,
  _teleportToMarket: teleportToMarket,
  GIVE_UP_MS,
  ARRIVE_RADIUS,
};
