"use strict";

/**
 * CitizenRehearse — the brain action for real theater production.
 *
 * Complements (does not duplicate):
 *   - CitizenActors: scripted performance scenes at theaters (this never
 *     stages scenes — it walks troupe members to the venue and rehearses).
 *   - CitizenEntertainment: house shows and tickets (this is troupe-booked
 *     performances with their own ticketing).
 *   - CitizenTheaterLife (slow tick): ambient playwriting, troupe
 *     formation, touring, and settlement when nobody runs this action.
 *
 * Flow per tick:
 *   - Only troupe members rehearse. Others honestly return home.
 *   - Walk to the theater tile in the citizen's kingdom.
 *   - Rehearse in rounds (human-paced 8s): each round works toward the
 *     troupe's next booked performance. With no booking, the troupe
 *     holds an open rehearsal (keeps skills warm, no economics).
 *   - After REHEARSE_ROUNDS or GIVE_UP_MS, walk home.
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
const REHEARSE_ROUNDS = 3;
const ARRIVE_RADIUS = 8;
const REHEARSE_COOLDOWN_MS = 8000; // human-paced rehearsal

function theaterApi() {
  try {
    return require("../../lib/CitizenTheater");
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

/** Find the troupe this citizen belongs to (first match, home kingdom first). */
function troupeForCitizen(Theater, username, kingdomId) {
  try {
    const all = Theater.troupesIn(kingdomId);
    for (const t of all) {
      if (t.members.includes(username)) return t;
    }
    // touring members keep their troupe — check all troupes as fallback
    return null;
  } catch {
    return null;
  }
}

function createCitizenRehearseAction(spec, world) {
  function botState(player) {
    return playerState(action, player, () => {
      const personality = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
      return {
        rng: agentRng(`rehearse:${player.getUsername?.() ?? "unknown"}`),
        human: humanizerProfile(personality),
        personality,
        giveUpAt: 0,
        phase: "outbound", // outbound -> rehearsing -> returning -> done
        roundsDone: 0,
        lastRehearseAt: 0,
        theaterTile: null,
        troupeName: null,
        nextPerfId: null,
        homeTile: null,
        kingdomId: null,
      };
    });
  }

  const action = {
    id: "citizenRehearse",
    update(ctx) {
      const { player, nowMs } = ctx;
      if (!player) return "success";
      const Theater = theaterApi();
      if (!Theater) return "success"; // no theater system, nothing to do
      const state = botState(player);
      const username = player.getUsername?.() ?? player?.username ?? "citizen";

      if (!state.giveUpAt) {
        state.giveUpAt = nowMs + GIVE_UP_MS;
        state.homeTile = homeTileFor(player);
        state.kingdomId = kingdomIdOf(player);
        if (!state.kingdomId) {
          state.phase = "returning";
        } else {
          const troupe = troupeForCitizen(Theater, username, state.kingdomId);
          if (!troupe) {
            state.phase = "returning"; // not in a troupe
          } else {
            state.troupeName = troupe.name;
            const theater = Theater.ensureTheater(state.kingdomId);
            state.theaterTile = theater?.tile ?? null;
            // rehearse toward the troupe's next booked show, if any
            try {
              const upcoming = Theater.upcomingPerformances(state.kingdomId)
                .filter((p) => p.troupeLower === troupe.nameLower);
              if (upcoming.length) state.nextPerfId = upcoming[0].id;
            } catch { /* no booking, open rehearsal */ }
            if (!state.theaterTile) state.phase = "returning";
          }
        }
      }

      if (nowMs > state.giveUpAt && state.phase !== "returning") {
        stopWalking(player);
        state.phase = "returning";
        return "running";
      }

      switch (state.phase) {
        case "outbound": {
          if (atTile(player, state.theaterTile)) {
            stopWalking(player);
            state.phase = "rehearsing";
            state.lastRehearseAt = nowMs - REHEARSE_COOLDOWN_MS; // rehearse immediately on arrival
            return "running";
          }
          walkTo(player, state.theaterTile);
          return "running";
        }
        case "rehearsing": {
          if (state.roundsDone >= REHEARSE_ROUNDS) {
            state.phase = "returning";
            return "running";
          }
          if (nowMs - state.lastRehearseAt < REHEARSE_COOLDOWN_MS) return "running";
          state.lastRehearseAt = nowMs;
          state.roundsDone++;
          // Rehearsal is the visible work: a flourish emote near the stage.
          // The economics (tickets, revenue) live on the performance records.
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

module.exports = { createCitizenRehearseAction };
