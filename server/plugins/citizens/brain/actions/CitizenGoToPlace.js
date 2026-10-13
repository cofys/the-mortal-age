"use strict";

/**
 * CitizenGoToPlace — walk to a gather place before the real skilling action.
 *
 * Prepend to citizen_chop / citizen_mine / citizen_fish in
 * citizen-activities.json:
 *   { "type": "citizenGoToPlace", "kind": "tree" }   // "tree" | "rock" | "fish"
 *
 * Place choice is deterministic per citizen per ~90 min bucket: a citizen has
 * "their spot" for a while, then drifts to another. Success on arrival, so
 * the next action in the activity (equipTool / interactObject / fish) starts
 * AT the place. Fails (brain re-picks) if there's no place or they're stuck.
 */

const { playerState } = require("../../../bots/brain/ActionState");
const {
  requestMovement,
  clearMovementRequest,
} = require("../../../bots/behaviours/navigation/BotNavigation");
const { pickPlace } = require("../CitizenSites");
const { agentRng, personalSpot } = require("../../lib/humanizer");

const ARRIVE_RADIUS = 6;
const STUCK_MS = 4 * 60 * 1000;
const STICKY_MS = 90 * 60 * 1000;

function createCitizenGoToPlaceAction(spec, world) {
  const kind = spec.kind;

  function st(player) {
    return playerState(action, player, () => ({ spot: null, giveUpAt: 0 }));
  }

  const action = {
    id: "citizenGoToPlace",
    update(ctx) {
      const { player, nowMs } = ctx;
      const s = st(player);
      const name = player.getUsername?.() ?? "unknown";

      if (!s.spot) {
        const rng = agentRng(`place:${name}:${kind}:${Math.floor(nowMs / STICKY_MS)}`);
        const place = pickPlace(player, kind, rng);
        if (!place) return "failed";
        const spot = personalSpot(name, place.x, place.y, 2, place.radius ?? 6);
        s.spot = { x: spot.x, y: spot.y, z: place.z, placeId: place.id };
        s.giveUpAt = nowMs + STUCK_MS;
        // TODO: shared ensureWorkTool(player, kind) here (see routine's fix),
        // so equipTool doesn't hit the silent no-axe stall.
      }

      const loc = player.getLocation();
      const arrived =
        loc.getZ() === s.spot.z &&
        Math.max(Math.abs(loc.getX() - s.spot.x), Math.abs(loc.getY() - s.spot.y)) <= ARRIVE_RADIUS;
      if (arrived) return "success";
      if (nowMs >= s.giveUpAt) return "failed";
      if (player.getMovementQueue?.()?.size?.() > 0) return "running";

      requestMovement(player, s.spot.x, s.spot.y, {
        reason: "citizen_trip",
        basicPather: true,
        z: s.spot.z,
      });
      return "running";
    },
    stop(ctx) {
      if (!ctx?.player) return;
      st(ctx.player).spot = null; // fresh pick next run (no stale state)
      clearMovementRequest(ctx.player);
    },
  };

  return action;
}

module.exports = { createCitizenGoToPlaceAction };
