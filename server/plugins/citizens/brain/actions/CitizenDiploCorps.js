"use strict";

/**
 * CitizenDiploCorps — the brain action for diplomatic-corps hall sessions.
 *
 * Complements (does not duplicate):
 *   - CitizenDiplomats (brain-adjacent): envoys travel on real missions —
 *     departing, negotiating abroad, returning. That is foreign service.
 *   - CitizenObserve-style profession actions: working the trade.
 *   - This action: corps MEMBERS walk to the kingdom's diplomatic-corps
 *     hall (near the court anchor) and hold hall sessions in human-paced
 *     rounds — ambassadors review the protocol code and teach protocol
 *     classes, envoys study. Non-members and suspended members honestly
 *     return home (the hall is members-only).
 *
 * Flow per tick:
 *   - Only corps members in good standing proceed. Others return home.
 *   - Walk to the corps-hall tile (near the court anchor).
 *   - Session rounds (human-paced 8s): ambassadors review protocol and
 *     teach; envoys study. Rounds are the visible social layer — real
 *     economics (dues, reviews, mediation, claims) run on the slow tick.
 *   - After SESSION_ROUNDS or GIVE_UP_MS, walk home.
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
const SESSION_ROUNDS = 3;
const ARRIVE_RADIUS = 8;
const ROUND_COOLDOWN_MS = 8000; // human-paced sessions

function corpsApi() {
  try {
    return require("../../lib/CitizenDiplomaticCorps");
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

function createCitizenDiploCorpsAction(spec, world) {
  function botState(player) {
    return playerState(action, player, () => {
      const personality = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
      return {
        rng: agentRng(`diplocorps:${player.getUsername?.() ?? "unknown"}`),
        human: humanizerProfile(personality),
        personality,
        giveUpAt: 0,
        phase: "outbound", // outbound -> session -> returning -> done
        roundsDone: 0,
        lastRoundAt: 0,
        hallTile: null,
        homeTile: null,
        kingdomId: null,
        isMember: false,
        rank: null,
      };
    });
  }

  const action = {
    id: "citizenDiploCorps",
    update(ctx) {
      const { player, nowMs } = ctx;
      if (!player) return "success";
      const Corps = corpsApi();
      if (!Corps) return "success"; // no corps system, nothing to do
      const state = botState(player);
      const username = player.getUsername?.() ?? player?.username ?? "citizen";

      if (!state.giveUpAt) {
        state.giveUpAt = nowMs + GIVE_UP_MS;
        state.homeTile = homeTileFor(player);
        state.kingdomId = kingdomIdOf(player);
        state.isMember = Corps.isGuildMember(username);
        state.rank = Corps.guildRankOf(username);
        const mem = Corps.memberOf(username);
        if (!state.kingdomId || !state.isMember || (mem && mem.suspended)) {
          state.phase = "returning"; // members in good standing only
        } else {
          state.hallTile = Corps.hallTileFor(state.kingdomId);
          if (!state.hallTile) state.phase = "returning";
        }
      }

      if (nowMs > state.giveUpAt && state.phase !== "returning") {
        stopWalking(player);
        state.phase = "returning";
        return "running";
      }

      switch (state.phase) {
        case "outbound": {
          if (atTile(player, state.hallTile)) {
            stopWalking(player);
            state.phase = "session";
            state.lastRoundAt = nowMs - ROUND_COOLDOWN_MS; // first round immediately
            return "running";
          }
          walkTo(player, state.hallTile);
          return "running";
        }
        case "session": {
          if (state.roundsDone >= SESSION_ROUNDS) {
            state.phase = "returning";
            return "running";
          }
          if (nowMs - state.lastRoundAt < ROUND_COOLDOWN_MS) return "running";
          state.lastRoundAt = nowMs;
          state.roundsDone++;
          // Session content is the visible social layer: ambassadors review
          // the protocol code and teach; envoys study. Real economics run on
          // the life tick.
          try {
            if (state.roundsDone === SESSION_ROUNDS && state.rank === Corps.RANK_AMBASSADOR) {
              const { getJournal } = require("../../lib/CitizenJournal");
              getJournal().log(username, "diplocorps", `${username} led the final protocol session at the ${state.kingdomId} diplomatic corps hall.`, {
                data: { rank: state.rank, kingdomId: state.kingdomId },
              });
            }
          } catch { /* journaling is optional */ }
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

module.exports = { createCitizenDiploCorpsAction };
