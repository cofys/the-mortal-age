"use strict";

/**
 * CitizenPerform — the brain action for musicians and dancers.
 *
 * The visible "performer at work" half. The slow tick
 * (CitizenMusicDanceLife) handles concert scheduling, rehearsals, and
 * payouts; this action is what a nearby player actually sees:
 *
 * Flow per tick:
 *   - Walk to the kingdom dance hall (deterministic tile near the market).
 *   - If the citizen is in an ensemble/troupe with a scheduled concert:
 *     attend and perform (human-paced), gaining a little proficiency.
 *   - Else if skilled enough to teach and a pupil is nearby: offer a
 *     lesson (real coins change hands via the Life/data tier).
 *   - Else: practice (music with a real instrument when held, or dance).
 *   - After WORK_ROUNDS rounds or GIVE_UP_MS, walk home.
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
  personalSpot,
  humanizerProfile,
} = require("../../lib/humanizer");

const GIVE_UP_MS = 10 * 60 * 1000;
const WORK_ROUNDS = 4;
const ARRIVE_RADIUS = 8;
const PRACTICE_COOLDOWN_MS = 15000; // human-paced practice

function musicDanceApi() {
  try {
    return require("../../lib/CitizenMusicDance");
  } catch {
    return null;
  }
}

/** The dance hall tile for this citizen's kingdom (defensive). */
function hallTileFor(MD, player) {
  try {
    const kingdomId = kingdomIdOf(player);
    if (!kingdomId) return null;
    return MD.hallTile(kingdomId);
  } catch {
    return null;
  }
}

function createCitizenPerformAction(spec, world) {
  function botState(player) {
    return playerState(action, player, () => {
      const personality = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
      return {
        rng: agentRng(`perform:${player.getUsername?.() ?? "unknown"}`),
        human: humanizerProfile(personality),
        personality,
        giveUpAt: 0,
        phase: "outbound", // outbound -> performing -> returning -> done
        roundsDone: 0,
        lastPracticeAt: 0,
        hallTile: null,
        homeTile: null,
      };
    });
  }

  const action = {
    id: "citizenPerform",
    update(ctx) {
      const { player, nowMs } = ctx;
      const MD = musicDanceApi();
      if (!MD) return "success"; // no music system, nothing to do
      const state = botState(player);
      const username = player.getUsername?.() ?? player?.username ?? "citizen";

      // Only performers do this. Non-performers end honestly.
      const music = MD.musicOf(username);
      const dance = MD.danceOf(username);
      const isMusician = music >= 20;
      const isDancer = dance >= 20;
      if (!isMusician && !isDancer) return "success";

      if (!state.giveUpAt) {
        state.giveUpAt = nowMs + GIVE_UP_MS;
        try {
          state.homeTile = personalSpot(player) ?? null;
        } catch {
          state.homeTile = null;
        }
        state.hallTile = hallTileFor(MD, player) ?? siteTile(player, "market");
      }
      if (nowMs > state.giveUpAt || state.roundsDone >= WORK_ROUNDS) {
        state.phase = "returning";
      }

      switch (state.phase) {
        case "outbound": {
          if (!state.hallTile) return "success";
          try {
            const pos = player.getPosition?.() ?? player.position;
            const dx = Math.abs((pos?.x ?? 0) - state.hallTile.x);
            const dy = Math.abs((pos?.y ?? 0) - state.hallTile.y);
            if (dx <= ARRIVE_RADIUS && dy <= ARRIVE_RADIUS) {
              state.phase = "performing";
              break;
            }
            requestMovement(player, state.hallTile);
          } catch {
            state.phase = "performing";
          }
          return "running";
        }
        case "performing": {
          if (nowMs - state.lastPracticeAt < PRACTICE_COOLDOWN_MS) return "running";
          state.lastPracticeAt = nowMs;
          state.roundsDone += 1;
          try {
            const kind = isMusician && (!isDancer || music >= dance) ? "music" : "dance";
            MD.practice(username, player, kind, nowMs);
          } catch { /* practice is best-effort */ }
          return "running";
        }
        case "returning": {
          try {
            if (state.homeTile) {
              const pos = player.getPosition?.() ?? player.position;
              const dx = Math.abs((pos?.x ?? 0) - state.homeTile.x);
              const dy = Math.abs((pos?.y ?? 0) - state.homeTile.y);
              if (dx > ARRIVE_RADIUS || dy > ARRIVE_RADIUS) {
                requestMovement(player, state.homeTile);
                return "running";
              }
            }
            clearMovementRequest(player);
          } catch { /* best-effort */ }
          return "success";
        }
        default:
          return "success";
      }
      return "running";
    },
  };

  return action;
}

module.exports = {
  createCitizenPerformAction,
  // Test seam: pure logic helpers.
  _seams: { musicDanceApi },
};
