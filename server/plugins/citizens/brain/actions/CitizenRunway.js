"use strict";

/**
 * CitizenRunway — the brain action for real runway fashion-show production.
 *
 * Complements (does not duplicate):
 *   - CitizenFashion: garment catalog, weekly trends, clothing shops, style
 *     competitions (this never crafts garments or runs competitions — it
 *     walks designers to the runway and stages shows).
 *   - CitizenTheater: playhouses, plays, touring troupes (this is the
 *     parallel runway venue/show system for fashion).
 *   - CitizenRunwayLife (slow tick): designer/model registration, ambient
 *     collection drafting, house formation, ateliers, touring, and show
 *     settlement when nobody runs this action.
 *
 * Flow per tick:
 *   - Only registered designers (or house members) stage. Others honestly
 *     return home.
 *   - Walk to the runway venue tile in the citizen's kingdom.
 *   - Stage in rounds (human-paced 8s): each round works toward the house's
 *     next booked runway show. With no booking, the designer holds an open
 *     fitting (keeps the house visible, no economics).
 *   - After STAGE_ROUNDS or GIVE_UP_MS, walk home.
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
const STAGE_ROUNDS = 3;
const ARRIVE_RADIUS = 8;
const STAGE_COOLDOWN_MS = 8000; // human-paced staging

function runwayApi() {
  try {
    return require("../../lib/CitizenRunways");
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

/** Find the house this citizen belongs to (home kingdom first). */
function houseForCitizen(Runways, username) {
  try {
    return Runways.houseForDesigner(username);
  } catch {
    return null;
  }
}

function createCitizenRunwayAction(spec, world) {
  function botState(player) {
    return playerState(action, player, () => {
      const personality = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
      return {
        rng: agentRng(`runway:${player.getUsername?.() ?? "unknown"}`),
        human: humanizerProfile(personality),
        personality,
        giveUpAt: 0,
        phase: "outbound", // outbound -> staging -> returning -> done
        roundsDone: 0,
        lastStageAt: 0,
        venueTile: null,
        houseName: null,
        nextShowId: null,
        homeTile: null,
        kingdomId: null,
      };
    });
  }

  const action = {
    id: "citizenRunway",
    update(ctx) {
      const { player, nowMs } = ctx;
      if (!player) return "success";
      const Runways = runwayApi();
      if (!Runways) return "success"; // no runway system, nothing to do
      const state = botState(player);
      const username = player.getUsername?.() ?? player?.username ?? "citizen";

      if (!state.giveUpAt) {
        state.giveUpAt = nowMs + GIVE_UP_MS;
        state.homeTile = homeTileFor(player);
        state.kingdomId = kingdomIdOf(player);
        if (!state.kingdomId) {
          state.phase = "returning";
        } else if (!Runways.isDesigner(username) && !houseForCitizen(Runways, username)) {
          state.phase = "returning"; // not a designer, nothing to stage
        } else {
          const house = houseForCitizen(Runways, username);
          if (house) state.houseName = house.name;
          const venue = Runways.ensureVenue(state.kingdomId);
          state.venueTile = venue?.tile ?? null;
          // stage toward the house's next booked show, if any
          try {
            if (house) {
              const upcoming = Runways.upcomingShows(state.kingdomId)
                .filter((s) => String(s.houseName).toLowerCase() === house.nameLower);
              if (upcoming.length) state.nextShowId = upcoming[0].id;
            }
          } catch { /* no booking, open fitting */ }
          if (!state.venueTile) state.phase = "returning";
        }
      }

      if (nowMs > state.giveUpAt && state.phase !== "returning") {
        stopWalking(player);
        state.phase = "returning";
        return "running";
      }

      switch (state.phase) {
        case "outbound": {
          if (atTile(player, state.venueTile)) {
            stopWalking(player);
            state.phase = "staging";
            state.lastStageAt = nowMs - STAGE_COOLDOWN_MS; // stage immediately on arrival
            return "running";
          }
          walkTo(player, state.venueTile);
          return "running";
        }
        case "staging": {
          if (state.roundsDone >= STAGE_ROUNDS) {
            state.phase = "returning";
            return "running";
          }
          if (nowMs - state.lastStageAt < STAGE_COOLDOWN_MS) return "running";
          state.lastStageAt = nowMs;
          state.roundsDone++;
          // Staging is the visible work: a flourish emote on the runway.
          // The economics (tickets, revenue) live on the show records.
          try {
            if (state.rng() < 0.4) player.performEmote?.("bow");
          } catch { /* emotes are best-effort */ }
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

module.exports = { createCitizenRunwayAction };
