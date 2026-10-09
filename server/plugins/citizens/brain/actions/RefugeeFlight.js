"use strict";

/**
 * RefugeeFlight — the refugee's body. War's losers, on foot.
 *
 * Spawned by the citizens plugin's WarRefugees on kingdom:war-declared: the
 * defending kingdom's border-town commoners walk a waypoint route (border ->
 * road -> capital market) stored on the citizens:refugee-route attribute.
 * They move with scared haste, speak flight lines on the road and witness
 * lines once they reach the walls, then mill around the market begging bread
 * until the war ends (WarRefugees logs them out and drops their roster
 * records on kingdom:war-ended).
 *
 * Hunger comes from the needs system (they spawn starving and broke, so the
 * director's feeding pass leaves them visibly hungry); fear comes from mood.
 * This action only walks and talks.
 */

const { playerState } = require("../../../bots/brain/ActionState");
const { voiceFor, voiceLine } = require("../../lib/citizenVoice");
const { sayPublic } = require("../../chat/CitizenSayPublic");

const {
  requestMovement,
  clearMovementRequest,
} = require("../../../bots/behaviours/navigation/BotNavigation");
const { siteTile } = require("../CitizenSites");
const {
  ATTR_CITIZEN_PERSONALITY,
  ATTR_REFUGEE_ROUTE,
} = require("../../constants");
const {
  agentRng,
  logNormalJitter,
  noisyTile,
  chance,
  humanizerProfile,
} = require("../../lib/humanizer");

const ARRIVE_RADIUS = 3;

const FLIGHT_LINES = Object.freeze([
  "Keep moving! Don't stop!",
  "The walls! I can see the walls!",
  "Hurry. The smoke is behind us, not ahead.",
  "Don't look back. Just walk.",
  "Faster! They'll be on the road by dusk.",
]);

const WITNESS_LINES = Object.freeze([
  "They burned the border villages. I watched the thatch go up.",
  "The levy broke at the ford. There's nothing left north of here.",
  "My brother stood the wall. I don't know if he still stands.",
  "Press-gangs took my husband at the crossroads.",
  "The crows own the battlefield now. Don't go back for anything.",
]);

const BEGGING_LINES = Object.freeze([
  "Have you bread? Please. The children haven't eaten since the smoke.",
  "A crust, friend? Anything. We've walked three days.",
  "Is it true the city won't turn us away?",
  "They say the king feeds refugees at the gates. They say.",
]);

function atTile(player, tile, radius = ARRIVE_RADIUS) {
  const loc = player.getLocation();
  return (
    loc.getZ() === (tile.z ?? 0) &&
    Math.max(Math.abs(loc.getX() - tile.x), Math.abs(loc.getY() - tile.y)) <= radius
  );
}

function createRefugeeFlightAction(spec, world) {
  const chatterMinMs = Math.max(1000, Number(spec.chatterMinMs ?? 45000));
  const chatterMaxMs = Math.max(chatterMinMs, Number(spec.chatterMaxMs ?? 180000));

  function botState(player) {
    return playerState(action, player, () => {
      const personality = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
      return {
        rng: agentRng(`refugee:${player.getUsername?.() ?? "unknown"}`),
        human: humanizerProfile(personality),
        leg: 1, // route[0] is the border town we start on
        spot: null,
        nextChatAt: 0,
        nextDriftAt: 0,
      };
    });
  }

  function routeOf(player) {
    const route = player.getAttribute?.(ATTR_REFUGEE_ROUTE);
    return Array.isArray(route) && route.length >= 2 ? route : null;
  }

  function maybeChat(player, state, nowMs, pool, rate) {
    if (nowMs < state.nextChatAt) return;
    const gap = chatterMinMs + state.rng() * (chatterMaxMs - chatterMinMs);
    state.nextChatAt = nowMs + Math.round(gap / Math.max(0.2, state.human.chatRate));
    if (!chance(state.rng, rate)) return;
    try {
      { const _cvp = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {}; sayPublic(player, voiceLine(voiceFor(_cvp), { plain: [pool[Math.floor(state.rng() * pool.length)].slice(0, 120)] })); }
    } catch (error) {
      // Cosmetic only.
    }
  }

  function walkToward(player, tile) {
    requestMovement(player, tile.x, tile.y, {
      reason: "refugee_flight",
      basicPather: true,
      z: tile.z ?? 0,
    });
  }

  const action = {
    id: "refugeeFlight",
    update(ctx) {
      const { player, nowMs } = ctx;
      const state = botState(player);
      const route = routeOf(player);
      if (!route) {
        return "failed";
      }
      if (player.getForceMovement?.() != null) {
        return "running";
      }
      if (player.getMovementQueue?.()?.size?.() > 0) {
        return "running";
      }

      // Still on the road: scared haste toward the next waypoint.
      if (state.leg < route.length) {
        const target = route[state.leg];
        if (atTile(player, target)) {
          state.leg += 1;
          state.spot = null;
          return "running";
        }
        walkToward(player, target);
        maybeChat(player, state, nowMs, FLIGHT_LINES, 0.5);
        return "running";
      }

      // At the walls: mill around the market, witness and beg.
      const anchor = siteTile(player, "market") ?? route[route.length - 1];
      if (!state.spot) {
        const tile = noisyTile(anchor.x, anchor.y, 6, state.rng);
        state.spot = { x: tile.x, y: tile.y, z: anchor.z ?? 0 };
      }
      if (!atTile(player, state.spot)) {
        walkToward(player, state.spot);
        return "running";
      }
      if (nowMs >= state.nextDriftAt) {
        state.nextDriftAt =
          nowMs + logNormalJitter(state.rng, 120000, state.human.tempoSigma);
        if (chance(state.rng, 0.4)) {
          const tile = noisyTile(anchor.x, anchor.y, 6, state.rng);
          state.spot = { x: tile.x, y: tile.y, z: anchor.z ?? 0 };
          return "running";
        }
      }
      const pool =
        state.rng() < 0.5
          ? [...WITNESS_LINES, ...BEGGING_LINES]
          : [...BEGGING_LINES, ...WITNESS_LINES];
      maybeChat(player, state, nowMs, pool, 0.65);
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
  createRefugeeFlightAction,
};
