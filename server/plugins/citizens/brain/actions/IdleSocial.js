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

function createIdleSocialAction(spec, world) {
  const anchorKind = ["court", "tavern", "market"].includes(spec.anchorKind)
    ? spec.anchorKind
    : "tavern";
  const chatterMinMs = Math.max(1000, Number(spec.chatterMinMs ?? 60000));
  const chatterMaxMs = Math.max(chatterMinMs, Number(spec.chatterMaxMs ?? 240000));

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
      if (!state.spot || (atWar && state.spot.loose === true)) {
        const radius = atWar ? 2 : 6;
        const tile = noisyTile(anchor.x, anchor.y, radius, state.rng);
        state.spot = { x: tile.x, y: tile.y, z: anchor.z ?? 0, loose: atWar !== true };
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
          const tile = noisyTile(anchor.x, anchor.y, atWar ? 2 : 6, state.rng);
          state.spot = { x: tile.x, y: tile.y, z: anchor.z ?? 0, loose: atWar !== true };
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
            player.forceChat?.(pool[Math.floor(state.rng() * pool.length)]);
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
      }
    },
  };

  return action;
}

module.exports = {
  createIdleSocialAction,
};
