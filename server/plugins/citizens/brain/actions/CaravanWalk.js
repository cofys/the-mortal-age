"use strict";

/**
 * CaravanWalk — the caravan crew's body. A merchant or guard citizen tagged
 * with the caravan:duty attribute (see lib/CaravanJourney) walks the trade
 * caravan's road: each brain tick it reads its duty caravan's current target
 * waypoint and walks toward it with a normal movement request. When it
 * reaches the waypoint it holds until the data tier advances the caravan.
 *
 * The duty is scored at 95 in CitizenDecisions (ACT_CARAVAN), so this
 * activity wins while the citizen is on duty and drops the moment the duty
 * tag is cleared (arrival, or the run failing).
 */

const { playerState } = require("../../../bots/brain/ActionState.PlayerBots.js");
const {
  requestMovement,
  clearMovementRequest,
} = require("../../../bots/behaviours/navigation/Navigation.PlayerBots.js");
const { ATTR_CARAVAN_DUTY } = require("../../constants");
const SlotCapacity = require("../CitizenSlotCapacity");
const { personalSpot } = require("../../lib/humanizer");

const ARRIVE_RADIUS = 3;
// Slot namespace for caravan waypoints (citizen-activities.json carries
// slotCapacity 6: six distinct spiral tiles around the waypoint).
const ACT_CARAVAN = "citizen_caravan";

/**
 * Distinct standing tile at the caravan's current waypoint. The whole crew
 * walks the same waypoint — without this they pile onto the leader's exact
 * tile. Claims a slot; falls back to a per-citizen 1-3 tile offset when the
 * waypoint's slots are full. Re-claiming the same waypoint refreshes the
 * same slot (stable); a new waypoint releases the old claim and claims new.
 */
function crewSpotFor(player, waypoint) {
  try {
    const claim = SlotCapacity.claimSlot(
      player,
      ACT_CARAVAN,
      Math.round(waypoint.x),
      Math.round(waypoint.y),
      Math.round(waypoint.z ?? 0)
    );
    if (claim && Number.isFinite(claim.x) && Number.isFinite(claim.y)) {
      return { x: claim.x, y: claim.y, z: claim.z };
    }
  } catch {
    // Claim failure degrades to the personal ring — never a break.
  }
  const name = player.getUsername?.() ?? "unknown";
  const spot = personalSpot(name, waypoint.x, waypoint.y, 1, 3);
  return { x: spot.x, y: spot.y, z: waypoint.z ?? 0 };
}

function dutyCaravanId(player) {
  try {
    const id = player.getAttribute?.(ATTR_CARAVAN_DUTY);
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

/** The waypoint the duty caravan is currently walking toward, or null. */
function caravanTarget(player) {
  const dutyId = dutyCaravanId(player);
  if (!dutyId) return null;
  let caravan = null;
  try {
    caravan = require("../../lib/CitizenTradeCaravans").getCaravanById(dutyId);
  } catch {
    return null;
  }
  if (!caravan?.visible || !Array.isArray(caravan.walkPath)) return null;
  const wp = caravan.walkPath[caravan.waypointIndex];
  if (!wp || !Number.isFinite(wp.x) || !Number.isFinite(wp.y)) return null;
  return wp;
}

function atTile(player, tile, radius = ARRIVE_RADIUS) {
  const loc = player.getLocation();
  return (
    loc.getZ() === (tile.z ?? 0) &&
    Math.max(Math.abs(loc.getX() - tile.x), Math.abs(loc.getY() - tile.y)) <= radius
  );
}

function createCaravanWalkAction(spec, world) {
  function botState(player) {
    return playerState(action, player, () => ({}));
  }

  const action = {
    id: "caravanWalk",
    update(ctx) {
      const { player } = ctx;
      botState(player);
      const target = caravanTarget(player);
      if (!target) {
        return "failed"; // no duty, or the caravan is gone — re-decide
      }
      if (player.getForceMovement?.() != null) {
        return "running";
      }
      if (player.getMovementQueue?.()?.size?.() > 0) {
        return "running";
      }
      if (atTile(player, target)) {
        return "running"; // hold the waypoint until the data tier moves on
      }
      // Follow-distance cap: the crew spreads around the waypoint instead of
      // stacking the leader's exact tile.
      const dest = crewSpotFor(player, target);
      requestMovement(player, dest.x, dest.y, {
        reason: "caravan_walk",
        basicPather: true,
        z: dest.z ?? 0,
      });
      return "running";
    },
    stop(ctx) {
      if (ctx?.player) {
        clearMovementRequest(ctx.player);
        try {
          SlotCapacity.releaseFor(ctx.player); // duty over: free the waypoint slot
        } catch {
          // Best-effort.
        }
      }
    },
  };

  return action;
}

module.exports = {
  createCaravanWalkAction,
};
