"use strict";

/**
 * CitizenObserve — the brain action for real astronomical observation.
 *
 * Complements (does not duplicate):
 *   - CitizenResearch (brain): runs science EXPERIMENTS in the laboratory.
 *   - CitizenDayNightLife: stargazing FLAVOR lines on clear nights.
 *   - This action: walks to the kingdom's real OBSERVATORY at night,
 *     observes the sky (human-paced), and creates REAL star charts —
 *     persistent records with real navigation effects.
 *
 * Flow per tick:
 *   - Only astronomers (registered) or curious citizens observe.
 *   - Daytime → honest no-op (astronomers sleep by day, work by night).
 *   - Walk to the observatory tile (deterministic, near the market).
 *   - Observe in rounds: each round advances a real observation session;
 *     completing one creates a real star chart via CitizenAstronomy.
 *   - After OBSERVE_ROUNDS or GIVE_UP_MS, walk home.
 *
 * Zero LLM. Tick-safe: every engine read guarded, per-action try/catch
 * in the brain.
 */

const { playerState } = require("../../../bots/brain/ActionState");
const {
  requestMovement,
  clearMovementRequest,
} = require("../../../bots/behaviours/navigation/BotNavigation");
const { siteTile, kingdomIdOf } = require("../CitizenSites");
const { ATTR_CITIZEN_PERSONALITY } = require("../../constants");
const {
  agentRng,
  humanizerProfile,
} = require("../../lib/humanizer");

const GIVE_UP_MS = 10 * 60 * 1000;
const OBSERVE_ROUNDS = 3;
const ARRIVE_RADIUS = 8;
const OBSERVE_COOLDOWN_MS = 20000; // human-paced observation
const WISDOM_PER_ROUND = 1;

function astroApi() {
  try {
    return require("../../lib/CitizenAstronomy");
  } catch {
    return null;
  }
}

function isNightTime(nowMs) {
  try {
    const DayNight = require("../../lib/CitizenDayNight");
    if (typeof DayNight.isNight === "function") return !!DayNight.isNight(nowMs);
  } catch { /* fall through */ }
  const h = new Date(nowMs).getHours();
  return h >= 21 || h < 5;
}

function atTile(player, tile, radius = ARRIVE_RADIUS) {
  try {
    const p = player.getPosition?.() ?? player.position;
    if (!p || !tile) return false;
    const dx = (p.x ?? 0) - tile.x;
    const dy = (p.y ?? 0) - tile.y;
    return Math.hypot(dx, dy) <= radius;
  } catch {
    return false;
  }
}

function walkTo(player, tile) {
  try {
    requestMovement(player, { x: tile.x, y: tile.y, z: tile.z ?? 0 });
  } catch {}
}

function stopWalking(player) {
  try {
    clearMovementRequest(player);
  } catch {}
}

function homeTileFor(player) {
  try {
    return siteTile(player, "market") ?? { x: 3200, y: 3200, z: 0 };
  } catch {
    return { x: 3200, y: 3200, z: 0 };
  }
}

function createCitizenObserveAction(spec, world) {
  function botState(player) {
    return playerState(action, player, () => {
      const personality = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
      return {
        rng: agentRng(`observe:${player.getUsername?.() ?? "unknown"}`),
        human: humanizerProfile(personality),
        personality,
        giveUpAt: 0,
        phase: "outbound", // outbound -> observing -> returning -> done
        roundsDone: 0,
        lastObserveAt: 0,
        observatoryTile: null,
        homeTile: null,
        isAstronomer: false,
      };
    });
  }

  const action = {
    id: "citizenObserve",
    update(ctx) {
      const { player, nowMs } = ctx;
      const Astro = astroApi();
      if (!Astro) return "success"; // no astronomy system, nothing to do
      const state = botState(player);
      const username = player.getUsername?.() ?? player?.username ?? "citizen";

      if (!state.giveUpAt) {
        state.giveUpAt = nowMs + GIVE_UP_MS;
        state.homeTile = homeTileFor(player);
        const kingdomId = kingdomIdOf(player);
        state.isAstronomer = !!Astro.astronomerFor(username);
        if (!kingdomId) {
          state.phase = "returning";
        } else {
          const obs = Astro.observatoryFor(kingdomId);
          state.observatoryTile = obs?.tile ?? null;
          if (!state.observatoryTile) state.phase = "returning";
          else if (!state.isAstronomer) {
            // Register curious onlookers as astronomers (honest first visit).
            const curiosity = state.personality?.curious ?? 0;
            if (curiosity >= Astro.ASTRONOMER_MIN_CURIOSITY) {
              Astro.registerAstronomer(username, kingdomId);
              state.isAstronomer = true;
            } else {
              state.phase = "returning"; // not curious, not an astronomer
            }
          }
        }
      }

      if (nowMs > state.giveUpAt) {
        stopWalking(player);
        return "success";
      }

      // Daytime: astronomers rest. Honest — the sky isn't out.
      if (!isNightTime(nowMs) && state.phase !== "returning") {
        stopWalking(player);
        return "success";
      }

      switch (state.phase) {
        case "outbound": {
          if (atTile(player, state.observatoryTile)) {
            stopWalking(player);
            state.phase = "observing";
            state.lastObserveAt = 0; // observe immediately on arrival
            return "running";
          }
          walkTo(player, state.observatoryTile);
          return "running";
        }
        case "observing": {
          if (state.roundsDone >= OBSERVE_ROUNDS) {
            // Session complete: create a real star chart.
            try {
              const kingdomId = kingdomIdOf(player);
              const astro = Astro.astronomerFor(username);
              const wisdom = astro?.wisdom ?? 10;
              const quality = Math.max(1, Math.min(10, Math.round(wisdom / 10)));
              Astro.createChart(username, kingdomId, quality);
            } catch { /* chart creation failed, still done */ }
            state.phase = "returning";
            return "running";
          }
          if (nowMs - state.lastObserveAt < OBSERVE_COOLDOWN_MS) return "running";
          state.lastObserveAt = nowMs;
          state.roundsDone++;
          Astro.gainWisdom(username, WISDOM_PER_ROUND);
          // Face the sky: a small flavor emote, real engine call, guarded.
          try {
            player.playEmote?.(1128); // stargaze-ish; guarded
          } catch {}
          return "running";
        }
        case "returning": {
          if (atTile(player, state.homeTile)) {
            stopWalking(player);
            return "success";
          }
          walkTo(player, state.homeTile);
          return "running";
        }
        default: {
          stopWalking(player);
          return "success";
        }
      }
    },
  };

  return action;
}

module.exports = { createCitizenObserveAction };
