"use strict";

/**
 * CitizenExcavate — the brain action for real archaeology.
 *
 * Complements (does not duplicate):
 *   - CitizenExplorers: expeditions and discovery rolls (this only digs
 *     sites founded from REAL discoveries — never invented geography).
 *   - CitizenArt: gallery flavor (this is the museum/artifact record layer).
 *   - CitizenArchaeologyLife (slow tick): ambient excavation when nobody
 *     is running this brain action.
 *
 * Flow per tick:
 *   - Only registered archaeologists (or curious/scholarly citizens who
 *     register on arrival) dig. Others honestly return home.
 *   - Walk to the richest active dig-site tile in the citizen's kingdom.
 *   - Dig in rounds (human-paced 8s): each round works one artifact slot.
 *     Artifacts are REAL persistent records with real coin values.
 *   - After DIG_ROUNDS or GIVE_UP_MS, walk home.
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
const DIG_ROUNDS = 3;
const ARRIVE_RADIUS = 8;
const DIG_COOLDOWN_MS = 8000; // human-paced digging

function archApi() {
  try {
    return require("../../lib/CitizenArchaeology");
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

function createCitizenExcavateAction(spec, world) {
  function botState(player) {
    return playerState(action, player, () => {
      const personality = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
      return {
        rng: agentRng(`excavate:${player.getUsername?.() ?? "unknown"}`),
        human: humanizerProfile(personality),
        personality,
        giveUpAt: 0,
        phase: "outbound", // outbound -> digging -> returning -> done
        roundsDone: 0,
        lastDigAt: 0,
        siteTile: null,
        siteId: null,
        homeTile: null,
        kingdomId: null,
        isArchaeologist: false,
        found: 0,
      };
    });
  }

  const action = {
    id: "citizenExcavate",
    update(ctx) {
      const { player, nowMs } = ctx;
      if (!player) return "success";
      const Arch = archApi();
      if (!Arch) return "success"; // no archaeology system, nothing to do
      const state = botState(player);
      const username = player.getUsername?.() ?? player?.username ?? "citizen";

      if (!state.giveUpAt) {
        state.giveUpAt = nowMs + GIVE_UP_MS;
        state.homeTile = homeTileFor(player);
        state.kingdomId = kingdomIdOf(player);
        state.isArchaeologist = Arch.isArchaeologist(username);
        if (!state.kingdomId) {
          state.phase = "returning";
        } else if (!state.isArchaeologist) {
          // Register curious/scholarly citizens as archaeologists (honest first visit).
          const curiosity = state.personality?.curiosity ?? state.personality?.curious ?? 0;
          const scholarly = state.personality?.scholarliness ?? state.personality?.wisdom ?? 0;
          if (curiosity >= 0.5 || scholarly >= 0.5) {
            Arch.registerArchaeologist(username, state.kingdomId);
            state.isArchaeologist = true;
          } else {
            state.phase = "returning"; // not a digger
          }
        }
        if (state.phase !== "returning") {
          // Work the richest active site — a human digs where the finds are.
          const sites = Arch.activeSites(state.kingdomId).sort((a, b) => b.richness - a.richness);
          const site = sites[0];
          if (!site || !site.tile) {
            state.phase = "returning"; // no open dig, head home honestly
          } else {
            state.siteId = site.id;
            state.siteTile = site.tile;
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
          if (atTile(player, state.siteTile)) {
            stopWalking(player);
            state.phase = "digging";
            state.lastDigAt = nowMs - DIG_COOLDOWN_MS; // dig immediately on arrival
            return "running";
          }
          walkTo(player, state.siteTile);
          return "running";
        }
        case "digging": {
          if (state.roundsDone >= DIG_ROUNDS) {
            state.phase = "returning";
            return "running";
          }
          if (nowMs - state.lastDigAt < DIG_COOLDOWN_MS) return "running";
          state.lastDigAt = nowMs;
          state.roundsDone++;
          try {
            const res = Arch.excavate(username, state.siteId);
            if (res.ok) {
              state.found++;
              try {
                const Rep = require("../../lib/CitizenReputation");
                if (res.major) Rep.awardDeed?.(username, "relichunter");
              } catch { /* fame optional */ }
            } else {
              // Site exhausted or gone cold mid-session — head home honestly.
              state.phase = "returning";
              return "running";
            }
          } catch { /* dig failed, round still spent */ }
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

module.exports = { createCitizenExcavateAction };
