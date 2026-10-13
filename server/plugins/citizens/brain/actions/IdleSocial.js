"use strict";

/**
 * IdleSocial — the art of hanging around. Walks to a social anchor (court,
 * tavern) and lingers: occasional personality-flavoured chatter on log-normal
 * gaps, drifting a few tiles now and then, reacting to war alerts by
 * gathering closer to the anchor's heart.
 *
 * Used directly by the courtier_attend and tavern_social activities, and as a
 * delegate by CitizenRoutine's social phases.
 */

const { playerState } = require("../../../bots/brain/ActionState");
const {
  requestMovement,
  clearMovementRequest,
} = require("../../../bots/behaviours/navigation/BotNavigation");
const { isKingdomAtWar } = require("../../CitizenEvents");
const { siteTile, kingdomIdOf } = require("../CitizenSites");
const { ATTR_CITIZEN_PERSONALITY } = require("../../constants");
const SlotCapacity = require("../CitizenSlotCapacity");
const { sayPublic } = require("../../chat/CitizenSayPublic");
const {
  agentRng,
  logNormalJitter,
  noisyTile,
  chance,
  humanizerProfile,
} = require("../../lib/humanizer");

const ARRIVE_RADIUS = 3;

const TAVERN_LINES = Object.freeze([
  "Ale's decent tonight.",
  "Heard the strangest rumour about the river...",
  "Another round? I'm buying. Well — almost.",
  "You ever wonder why the gods went quiet?",
  "My back's killing me. Getting old.",
  "Quiet in here for a weeknight.",
  "They say the king's men are hiring. Again.",
]);

const COURT_LINES = Object.freeze([
  "The court never sleeps, does it?",
  "Have you seen the steward? I need a word.",
  "Politics. Give me an honest day's work instead.",
  "They say the succession question is... delicate.",
  "Mind your manners past those doors.",
]);

const COURT_LINES_WAR = Object.freeze([
  "War. The court reeks of fear and perfume.",
  "They're mustering the guard. Stay close to the walls.",
]);

const MARKET_LINES = Object.freeze([
  "Just looking today.",
  "Prices are up again, I swear.",
  "Smell that bread...",
  "Mind the pickpockets, friend.",
  "Good crowd today.",
]);

function linesFor(anchorKind, atWar) {
  if (anchorKind === "court") {
    return atWar ? COURT_LINES_WAR : COURT_LINES;
  }
  if (anchorKind === "market") {
    return MARKET_LINES;
  }
  return TAVERN_LINES;
}

function atTile(player, tile, radius = ARRIVE_RADIUS) {
  const loc = player.getLocation();
  return (
    loc.getZ() === (tile.z ?? 0) &&
    Math.max(Math.abs(loc.getX() - tile.x), Math.abs(loc.getY() - tile.y)) <= radius
  );
}

/**
 * Pick a distinct standing tile near the shared anchor. Citizens claiming
 * the same anchor land on distinct spiral-ring slots (structural de-dup),
 * so a tavern fills up like a crowd, not a single stacked tile. Falls back
 * to uncoordinated noise when the anchor's slots are full.
 */
function pickSocialSpot(player, anchor, radius, rng, activityId, releaseFirst) {
  if (releaseFirst) {
    try {
      SlotCapacity.releaseFor(player);
    } catch {
      // Best-effort; a stuck claim degrades to the stale backstop.
    }
  }
  try {
    const claim = SlotCapacity.claimSlot(
      player,
      activityId,
      Math.round(anchor.x),
      Math.round(anchor.y),
      Math.round(anchor.z ?? 0),
      rng
    );
    if (claim && Number.isFinite(claim.x) && Number.isFinite(claim.y)) {
      return { x: claim.x, y: claim.y, z: claim.z, claimed: true };
    }
  } catch {
    // Claim failure degrades to noise — never a break.
  }
  const tile = noisyTile(anchor.x, anchor.y, radius, rng);
  return { x: tile.x, y: tile.y, z: anchor.z ?? 0, claimed: false };
}

function createIdleSocialAction(spec, world) {
  const anchorKind = ["court", "tavern", "market"].includes(spec.anchorKind)
    ? spec.anchorKind
    : "tavern";
  const chatterMinMs = Math.max(1000, Number(spec.chatterMinMs ?? 60000));
  const chatterMaxMs = Math.max(chatterMinMs, Number(spec.chatterMaxMs ?? 240000));
  // Slot namespace for the destack claim; set per activity in
  // citizen-activities.json so tavern/court/market capacities stay distinct.
  const slotActivityId =
    typeof spec.activityId === "string" && spec.activityId.length > 0
      ? spec.activityId
      : "citizen_social";

  function botState(player) {
    return playerState(action, player, () => {
      const personality = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
      return {
        rng: agentRng(`social:${player.getUsername?.() ?? "unknown"}`),
        human: humanizerProfile(personality),
        spot: null,
        nextChatAt: 0,
        nextDriftAt: 0,
      };
    });
  }

  const action = {
    id: "idleSocial",
    update(ctx) {
      const { player, nowMs } = ctx;
      const state = botState(player);
      const kingdomId = kingdomIdOf(player);
      const atWar = isKingdomAtWar(kingdomId);
      const anchor = siteTile(player, anchorKind) ?? siteTile(player, "tavern");
      if (!anchor) {
        return "failed";
      }

      if (player.getForceMovement?.() != null) {
        return "running";
      }
      if (player.getMovementQueue?.()?.size?.() > 0) {
        return "running";
      }

      // Pick a spot near the anchor (tighter when the kingdom is at war).
      // The spot is a claimed slot tile when the anchor has free slots, so
      // N citizens socializing at one tavern stand on N distinct tiles.
      if (!state.spot || (atWar && state.spot.loose === true)) {
        const radius = atWar ? 2 : 6;
        const releaseFirst = !!state.spot; // departing the old slot frees it
        const picked = pickSocialSpot(
          player,
          anchor,
          radius,
          state.rng,
          slotActivityId,
          releaseFirst
        );
        state.spot = { ...picked, loose: atWar !== true };
      } else if (state.spot.claimed) {
        // Refresh the claim while lingering: the same spot+citizen re-claims
        // the same slot, keeping the tile stable and the claim alive past
        // the stale-claim backstop.
        const refreshed = pickSocialSpot(
          player,
          anchor,
          atWar ? 2 : 6,
          state.rng,
          slotActivityId,
          false
        );
        if (refreshed.claimed) {
          state.spot = { ...refreshed, loose: state.spot.loose };
        }
      }
      if (!atTile(player, state.spot)) {
        requestMovement(player, state.spot.x, state.spot.y, {
          reason: "citizen_social",
          basicPather: true,
          z: state.spot.z,
        });
        return "running";
      }

      // Drift: humans don't root to a tile for an hour.
      if (nowMs >= state.nextDriftAt) {
        state.nextDriftAt =
          nowMs + logNormalJitter(state.rng, 120000, state.human.tempoSigma);
        if (chance(state.rng, 0.5)) {
          const picked = pickSocialSpot(
            player,
            anchor,
            atWar ? 2 : 6,
            state.rng,
            slotActivityId,
            true // drifting off the old slot frees it for someone else
          );
          state.spot = { ...picked, loose: atWar !== true };
          return "running";
        }
      }

      // Chatter on log-normal gaps, scaled by personality.
      if (nowMs >= state.nextChatAt) {
        const gap = chatterMinMs + state.rng() * (chatterMaxMs - chatterMinMs);
        state.nextChatAt =
          nowMs + Math.round(gap / Math.max(0.2, state.human.chatRate));
        const pool = linesFor(anchorKind, atWar);
        if (chance(state.rng, 0.65)) {
          try {
            sayPublic(player, pool[Math.floor(state.rng() * pool.length)]);
          } catch (error) {
            // Cosmetic only.
          }
        }
      }
      return "running";
    },
    stop(ctx) {
      if (ctx?.player) {
        clearMovementRequest(ctx.player);
        try {
          SlotCapacity.releaseFor(ctx.player); // leaving the anchor frees the slot
        } catch {
          // Best-effort.
        }
      }
    },
  };

  return action;
}

module.exports = {
  createIdleSocialAction,
};
