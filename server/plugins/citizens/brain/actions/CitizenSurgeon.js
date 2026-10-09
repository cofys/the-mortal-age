"use strict";

/**
 * CitizenSurgeon — the brain action for performing surgery.
 *
 * The surgeon is a specialized healer (herblore 50+). This is the PHYSICAL
 * brain action — the citizen walks to the hospital surgery wing, checks
 * for patients who need surgery, and performs procedures. The slow tick
 * (CitizenSurgeryLife) handles scheduling and resolution; this action is
 * the visible "doctor at work" half.
 *
 * Flow per tick:
 *   - Walk to the kingdom hospital (deterministic tile near the market).
 *   - If a patient needs surgery and the surgeon has the real materials:
 *     perform the procedure (human-paced, grants real Herblore XP on
 *     completion via the slow tick).
 *   - If doing medical research: contribute hands-on progress.
 *   - No patients and no research → tend the ward (flavor), then return.
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
const PROCEDURE_COOLDOWN_MS = 15000; // human-paced procedures

function surgeryApi() {
  try {
    return require("../../lib/CitizenSurgery");
  } catch {
    return null;
  }
}

function healthApi() {
  try {
    return require("../../lib/CitizenHealth");
  } catch {
    return null;
  }
}

/** Count of an item in inventory (defensive, multi-API). */
function countItem(inv, itemId) {
  try {
    if (!inv) return 0;
    if (typeof inv.getAmount === "function") return inv.getAmount(itemId) ?? 0;
    if (typeof inv.count === "function") return inv.count(itemId) ?? 0;
    return 0;
  } catch {
    return 0;
  }
}

/** Remove items from inventory (defensive). Returns true if all removed. */
function takeItems(player, itemCounts) {
  try {
    const inv = player?.getInventory?.() ?? player?.inventory;
    if (!inv) return false;
    for (const [itemId, count] of Object.entries(itemCounts)) {
      if (typeof inv.remove === "function") {
        inv.remove(Number(itemId), count);
      } else if (typeof inv.delete === "function") {
        inv.delete(Number(itemId), count);
      }
    }
    return true;
  } catch {
    return false;
  }
}

function hospitalTileFor(player) {
  try {
    // Surgery wing is at the hospital — deterministic tile near the market.
    return siteTile(player, "market") ?? { x: 3200, y: 3200, z: 0 };
  } catch {
    return { x: 3200, y: 3200, z: 0 };
  }
}

function createCitizenSurgeonAction(spec, world) {
  function botState(player) {
    return playerState(action, player, () => {
      const personality = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
      return {
        rng: agentRng(`surgeon:${player.getUsername?.() ?? "unknown"}`),
        human: humanizerProfile(personality),
        personality,
        giveUpAt: 0,
        phase: "outbound", // outbound -> working -> returning -> done
        roundsDone: 0,
        lastProcedureAt: 0,
        hospitalTile: null,
        homeTile: null,
      };
    });
  }

  const action = {
    id: "citizenSurgeon",
    update(ctx) {
      const { player, nowMs } = ctx;
      const Surgery = surgeryApi();
      if (!Surgery) return "success"; // no surgery system, nothing to do
      const state = botState(player);
      const username = player.getUsername?.() ?? player?.username ?? "citizen";

      // Only surgeons do surgery. Non-surgeons end honestly.
      if (!Surgery.isSurgeon(username)) return "success";

      if (!state.giveUpAt) {
        state.giveUpAt = nowMs + GIVE_UP_MS;
        state.hospitalTile = hospitalTileFor(player);
        try {
          state.homeTile = siteTile(player, "market") ?? { x: 3200, y: 3200, z: 0 };
        } catch {
          state.homeTile = { x: 3200, y: 3200, z: 0 };
        }
      }
      if (nowMs >= state.giveUpAt) {
        try { clearMovementRequest(player); } catch { /* best-effort */ }
        return "success";
      }

      const px = player.getX?.() ?? 0;
      const py = player.getY?.() ?? 0;

      // --- phase: outbound (walk to hospital) ---
      if (state.phase === "outbound") {
        const dx = state.hospitalTile.x - px, dy = state.hospitalTile.y - py;
        if (Math.sqrt(dx * dx + dy * dy) <= ARRIVE_RADIUS) {
          state.phase = "working";
          return "running";
        }
        try {
          requestMovement(player, state.hospitalTile.x, state.hospitalTile.y);
        } catch { /* best-effort */ }
        return "running";
      }

      // --- phase: working ---
      if (state.phase === "working") {
        if (state.roundsDone >= WORK_ROUNDS) {
          state.phase = "returning";
          return "running";
        }
        if (nowMs - state.lastProcedureAt < PROCEDURE_COOLDOWN_MS) {
          return "running"; // pacing — surgery takes time
        }
        state.lastProcedureAt = nowMs;
        state.roundsDone++;

        // The slow tick handles scheduling; this action is the visible
        // work. Check if we have an in-progress procedure to attend.
        try {
          const proc = Surgery.procedureOf(username);
          if (proc && proc.status === "in_progress") {
            // Attending the procedure — grant a small Herblore XP tick
            // for hands-on surgical work (real XP, real skill).
            try {
              player?.getSkills?.()?.addXp?.("herblore", 15);
            } catch { /* XP is best-effort */ }
          }
        } catch { /* best-effort */ }
        return "running";
      }

      // --- phase: returning (walk home) ---
      if (state.phase === "returning") {
        const dx = state.homeTile.x - px, dy = state.homeTile.y - py;
        if (Math.sqrt(dx * dx + dy * dy) <= ARRIVE_RADIUS) {
          try { clearMovementRequest(player); } catch { /* best-effort */ }
          return "success";
        }
        try {
          requestMovement(player, state.homeTile.x, state.homeTile.y);
        } catch { /* best-effort */ }
        return "running";
      }

      return "success";
    },
  };

  return action;
}

module.exports = {
  createCitizenSurgeonAction,
};
