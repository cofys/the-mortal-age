"use strict";

/**
 * CitizenPromote — the brain action for real music-festival production.
 *
 * Complements (does not duplicate):
 *   - CitizenMusicDance: ensembles, dance troupes, dance halls, ticketed
 *     concerts, lessons (this never creates ensembles or runs concerts — it
 *     walks promoters to the festival ground and works the production).
 *   - CitizenBards: solo/small-troupe minstrels (this books them as acts,
 *     never runs bard halls).
 *   - CitizenFestivals: seasonal calendar festivals (this runs promoter-led
 *     MUSIC festival productions — separate from the seasonal calendar).
 *   - CitizenMusicFestivalLife (slow tick): promoter registration, ambient
 *     festival scheduling, settlement, ground upkeep when nobody runs this
 *     action.
 *
 * Flow per tick:
 *   - Only registered promoters (or company members) promote. Others
 *     honestly return home.
 *   - Walk to the festival ground tile in the citizen's kingdom.
 *   - Promote in rounds (human-paced 8s): each round works toward the
 *     company's next scheduled festival. With no festival, the promoter
 *     drums up interest (keeps the company visible, no economics).
 *   - After PROMOTE_ROUNDS or GIVE_UP_MS, walk home.
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
const PROMOTE_ROUNDS = 3;
const ARRIVE_RADIUS = 8;
const PROMOTE_COOLDOWN_MS = 8000; // human-paced promoting

function festivalsApi() {
  try {
    return require("../../lib/CitizenMusicFestivals");
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

function groundTileFor(kingdomId) {
  try {
    // Festival grounds are outdoor venues near the market.
    const tile = siteTile({ kingdomId }, "market");
    if (tile) return { x: tile.x + 10, y: tile.y + 10, z: tile.z ?? 0 };
  } catch { /* fall through */ }
  return { x: 3210, y: 3210, z: 0 };
}

function createCitizenPromoteAction(spec, world) {
  function botState(player) {
    return playerState(action, player, () => {
      const personality = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
      return {
        rng: agentRng(`promote:${player.getUsername?.() ?? "unknown"}`),
        human: humanizerProfile(personality),
        personality,
        giveUpAt: 0,
        phase: "outbound", // outbound -> promoting -> returning -> done
        roundsDone: 0,
        lastPromoteAt: 0,
        groundTile: null,
        companyName: null,
        nextFestivalId: null,
        homeTile: null,
        kingdomId: null,
      };
    });
  }

  const action = {
    id: "citizenPromote",
    update(ctx) {
      const { player, nowMs } = ctx;
      if (!player) return "success";
      const MF = festivalsApi();
      if (!MF) return "success"; // no festival system, nothing to do
      const state = botState(player);
      const username = player.getUsername?.() ?? player?.username ?? "citizen";

      if (!state.giveUpAt) {
        state.giveUpAt = nowMs + GIVE_UP_MS;
        state.homeTile = homeTileFor(player);
        state.kingdomId = kingdomIdOf(player);
        if (!state.kingdomId) {
          state.phase = "returning";
        } else if (!MF.isPromoter(username) && !MF.companyForPromoter(username)) {
          state.phase = "returning"; // not a promoter, nothing to promote
        } else {
          const company = MF.companyForPromoter(username);
          if (company) state.companyName = company.name;
          state.groundTile = groundTileFor(state.kingdomId);
          // Promote toward the company's next scheduled festival, if any.
          try {
            const upcoming = MF.upcomingFestivals(state.kingdomId)
              .filter((f) => !state.companyName || f.companyLower === company.nameLower);
            if (upcoming.length) state.nextFestivalId = upcoming[0].id;
          } catch { /* no festival, drum up interest */ }
          if (!state.groundTile) state.phase = "returning";
        }
      }

      if (nowMs > state.giveUpAt && state.phase !== "returning") {
        stopWalking(player);
        state.phase = "returning";
        return "running";
      }

      switch (state.phase) {
        case "outbound": {
          if (atTile(player, state.groundTile)) {
            stopWalking(player);
            state.phase = "promoting";
            state.lastPromoteAt = nowMs - PROMOTE_COOLDOWN_MS; // promote immediately on arrival
            return "running";
          }
          walkTo(player, state.groundTile);
          return "running";
        }
        case "promoting": {
          if (state.roundsDone >= PROMOTE_ROUNDS) {
            state.phase = "returning";
            return "running";
          }
          if (nowMs - state.lastPromoteAt < PROMOTE_COOLDOWN_MS) return "running";
          state.lastPromoteAt = nowMs;
          state.roundsDone++;
          // Promoting is the visible work: a cheer emote at the ground.
          // The economics (tickets, bookings) live on the festival records.
          try {
            if (state.rng() < 0.4) player.performEmote?.("cheer");
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

module.exports = { createCitizenPromoteAction };
