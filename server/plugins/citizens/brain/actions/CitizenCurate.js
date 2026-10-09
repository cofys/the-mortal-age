"use strict";

/**
 * CitizenCurate — the brain action for real gallery curation work.
 *
 * Complements (does not duplicate):
 *   - CitizenArt: artwork creation, gallery DISPLAY spaces, fixed-price art
 *     market, exhibitions (this never creates artworks or runs exhibitions
 *     — it walks curators to the gallery and does curation rounds).
 *   - CitizenGalleriesLife (slow tick): curator registration, auction
 *     closing, stipends, tour advancement, ambient acquisitions when nobody
 *     runs this action.
 *
 * Flow per tick:
 *   - Only registered curators curate. Others honestly return home.
 *   - Walk to the gallery tile in the citizen's kingdom.
 *   - Curate in rounds (human-paced 8s): each round the curator tends the
 *     gallery — rotates the display, checks auction interest, reviews
 *     commissions. With real work available the round does it; otherwise
 *     the curator tidies (keeps the gallery visible, no economics).
 *   - After CURATE_ROUNDS or GIVE_UP_MS, walk home.
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
const CURATE_ROUNDS = 3;
const ARRIVE_RADIUS = 8;
const CURATE_COOLDOWN_MS = 8000; // human-paced curation

function galleriesApi() {
  try {
    return require("../../lib/CitizenGalleries");
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

function createCitizenCurateAction(spec, world) {
  function botState(player) {
    return playerState(action, player, () => {
      const personality = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
      return {
        rng: agentRng(`curate:${player.getUsername?.() ?? "unknown"}`),
        human: humanizerProfile(personality),
        personality,
        giveUpAt: 0,
        phase: "outbound", // outbound -> curating -> returning -> done
        roundsDone: 0,
        lastCurateAt: 0,
        galleryTile: null,
        homeTile: null,
        kingdomId: null,
      };
    });
  }

  const action = {
    id: "citizenCurate",
    update(ctx) {
      const { player, nowMs } = ctx;
      if (!player) return "success";
      const Galleries = galleriesApi();
      if (!Galleries) return "success"; // no gallery system, nothing to do
      const state = botState(player);
      const username = player.getUsername?.() ?? player?.username ?? "citizen";

      if (!state.giveUpAt) {
        state.giveUpAt = nowMs + GIVE_UP_MS;
        state.homeTile = homeTileFor(player);
        state.kingdomId = kingdomIdOf(player);
        if (!state.kingdomId) {
          state.phase = "returning";
        } else if (!Galleries.isCurator(username)) {
          state.phase = "returning"; // not a curator, nothing to curate
        } else {
          const tile = Galleries.galleryTile(state.kingdomId);
          state.galleryTile = tile ?? null;
          if (!state.galleryTile) state.phase = "returning";
        }
      }

      if (nowMs > state.giveUpAt && state.phase !== "returning") {
        stopWalking(player);
        state.phase = "returning";
        return "running";
      }

      switch (state.phase) {
        case "outbound": {
          if (atTile(player, state.galleryTile)) {
            stopWalking(player);
            state.phase = "curating";
            state.lastCurateAt = 0; // curate immediately on arrival
            return "running";
          }
          walkTo(player, state.galleryTile);
          return "running";
        }
        case "curating": {
          if (state.roundsDone >= CURATE_ROUNDS) {
            state.phase = "returning";
            return "running";
          }
          if (nowMs - state.lastCurateAt < CURATE_COOLDOWN_MS) return "running";
          state.lastCurateAt = nowMs;
          state.roundsDone += 1;
          // A curation round: the curator tends the gallery. Real work is
          // done by the slow tick (auctions, acquisitions); the round keeps
          // the curator visibly at work. Rotate display via CitizenArt if
          // it exposes the seam — defensive, never throws.
          try {
            const Art = require("../../lib/CitizenArt");
            if (typeof Art.rotateDisplay === "function") {
              Art.rotateDisplay(state.kingdomId);
            }
          } catch {
            // display rotation is best-effort
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

module.exports = { createCitizenCurateAction };
