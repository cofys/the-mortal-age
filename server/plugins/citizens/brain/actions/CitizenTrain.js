"use strict";

/**
 * CitizenTrain — the brain action for real athletic training.
 *
 * Complements (does not duplicate):
 *   - CitizenSports: year-round leagues, fixtures, tables, betting (this
 *     never runs leagues — athletes here train and may appear in them).
 *   - CitizenAthleticsLife (slow tick): ambient registration, training,
 *     and record attempts when nobody runs this action.
 *   - CitizenHealth: sickness/HP (this only raises fitness numbers).
 *
 * Flow per tick:
 *   - Only registered athletes train. Others honestly return home.
 *   - Walk to the stadium tile in the citizen's kingdom.
 *   - Train in rounds (human-paced 8s): each round raises fitness + skill.
 *   - After TRAIN_ROUNDS or GIVE_UP_MS, walk home.
 *
 * Zero LLM. Tick-safe: every engine read guarded.
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
const TRAIN_ROUNDS = 3;
const ARRIVE_RADIUS = 8;
const TRAIN_COOLDOWN_MS = 8000; // human-paced training

function athleticsApi() {
  try {
    return require("../../lib/CitizenAthletics");
  } catch {
    return null;
  }
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
    requestMovement(player, tile.x, tile.y, { z: tile.z ?? 0 });
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

function createCitizenTrainAction(spec, world) {
  function botState(player) {
    return playerState(action, player, () => {
      const personality = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
      return {
        rng: agentRng(`train:${player.getUsername?.() ?? "unknown"}`),
        human: humanizerProfile(personality),
        personality,
        giveUpAt: 0,
        phase: "outbound", // outbound -> training -> returning -> done
        roundsDone: 0,
        lastTrainAt: 0,
        stadiumTile: null,
        homeTile: null,
        kingdomId: null,
      };
    });
  }

  const action = {
    id: "citizenTrain",
    update(ctx) {
      const { player, nowMs } = ctx;
      if (!player) return "success";
      const Athletics = athleticsApi();
      if (!Athletics) return "success";
      const state = botState(player);
      const username = player.getUsername?.() ?? player?.username ?? "citizen";

      if (!state.giveUpAt) {
        state.giveUpAt = nowMs + GIVE_UP_MS;
        state.homeTile = homeTileFor(player);
        state.kingdomId = kingdomIdOf(player);
        if (!Athletics.isAthlete(username)) {
          state.phase = "returning"; // not an athlete, walk home honestly
        } else if (!state.kingdomId) {
          state.phase = "returning";
        } else {
          const tile = Athletics.stadiumTile(state.kingdomId);
          state.stadiumTile = tile;
          if (!tile) state.phase = "returning"; // no stadium, no training
        }
      }

      if (nowMs > state.giveUpAt && state.phase !== "returning") {
        stopWalking(player);
        state.phase = "returning";
        return "running";
      }

      switch (state.phase) {
        case "outbound": {
          if (atTile(player, state.stadiumTile)) {
            state.phase = "training";
            state.lastTrainAt = 0; // train immediately on arrival
            return "running";
          }
          walkTo(player, state.stadiumTile);
          return "running";
        }
        case "training": {
          if (!atTile(player, state.stadiumTile)) {
            state.phase = "outbound"; // drifted away, walk back
            return "running";
          }
          if (nowMs - state.lastTrainAt >= TRAIN_COOLDOWN_MS) {
            state.lastTrainAt = nowMs;
            state.roundsDone += 1;
            try { Athletics.trainAthlete(username, nowMs); } catch { /* train is safe */ }
            // Humanizer: brief pause between rounds happens via cooldown
          }
          if (state.roundsDone >= TRAIN_ROUNDS) {
            stopWalking(player);
            state.phase = "returning";
          }
          return "running";
        }
        case "returning": {
          if (atTile(player, state.homeTile)) {
            stopWalking(player);
            state.phase = "done";
            return "success";
          }
          walkTo(player, state.homeTile);
          return "running";
        }
        default:
          return "success";
      }
    },
  };

  return action;
}

module.exports = { createCitizenTrainAction };
