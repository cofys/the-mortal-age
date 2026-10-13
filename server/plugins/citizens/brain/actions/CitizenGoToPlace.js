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
const SlotCapacity = require("../CitizenSlotCapacity");
// Jon 2026-10-13 (Catherby water tiles): slot/personal-spot tiles around a
// dock can land in the sea — snap the final destination to walkable.
const CitizenTiles = require("../../lib/CitizenTiles");

const ARRIVE_RADIUS = 6;
const STUCK_MS = 4 * 60 * 1000;
const STICKY_MS = 90 * 60 * 1000;

// The activity that owns the gather spot of each kind, for destack slot
// claims. Same spot + same activity => same claim pool, so N citizens
// gathering at one place stand on N distinct slot tiles.
const GATHER_ACTIVITY_FOR_KIND = Object.freeze({
  tree: "citizen_chop",
  rock: "citizen_mine",
  fish: "citizen_fish",
});

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
        // Distinct slot tile at the shared gather place (destack); falls
        // back to the personal ring when the place's slots are full.
        let spot = null;
        const activityId = GATHER_ACTIVITY_FOR_KIND[kind];
        if (activityId) {
          try {
            const claim = SlotCapacity.claimSlot(
              player,
              activityId,
              Math.round(place.x),
              Math.round(place.y),
              Math.round(place.z ?? 0),
              rng
            );
            if (claim && Number.isFinite(claim.x) && Number.isFinite(claim.y)) {
              spot = { x: claim.x, y: claim.y };
            }
          } catch {
            // Claim failure degrades to the personal ring — never a break.
          }
        }
        if (!spot) {
          spot = personalSpot(name, place.x, place.y, 2, place.radius ?? 6);
        }
        // Jon 2026-10-13 (Catherby water tiles): a claimed slot or the
        // personal ring around a dock can sit in the sea — snap to the
        // nearest walkable tile so the citizen never walks onto water.
        try {
          const snapped = CitizenTiles.snapToWalkableTile(
            spot.x,
            spot.y,
            place.z ?? 0,
            12
          );
          if (snapped) spot = { x: snapped.x, y: snapped.y };
        } catch {
          // snap is best-effort; never breaks the trip
        }
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
      try {
        SlotCapacity.releaseFor(ctx.player); // arrived or gave up: free the slot
      } catch {
        // Best-effort.
      }
    },
  };

  return action;
}

module.exports = { createCitizenGoToPlaceAction };
