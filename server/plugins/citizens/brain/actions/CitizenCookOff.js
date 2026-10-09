"use strict";

/**
 * CitizenCookOff — the brain action for live cook-off competition.
 *
 * Complements (does not duplicate):
 *   - CitizenCuisine: master chefs, signature dishes, restaurants, food
 *     critics, MONTHLY "best dish" showcases (this never runs showcases —
 *     chefs here duel live with mystery ingredients and judging panels).
 *   - CitizenCookOffLife (slow tick): scheduling, auto-entry, resolution,
 *     prizes, announcements when nobody runs this action.
 *   - CitizenCook (brain action): individual cooking skill XP.
 *
 * Flow per tick:
 *   - Only entered chefs compete. Others honestly return home.
 *   - Walk to the market-square cook-off venue in the citizen's kingdom.
 *   - Cook 3 rounds (human-paced 8s): each round records a deterministic
 *     score via CitizenCookOffs.recordRoundScore (real Cooking level +
 *     real creativity trait).
 *   - After 3 rounds or GIVE_UP_MS, walk home.
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
const COOK_ROUNDS = 3;
const ARRIVE_RADIUS = 8;
const ROUND_COOLDOWN_MS = 8000; // human-paced cooking

function cookOffsApi() {
  try {
    return require("../../lib/CitizenCookOffs");
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

function venueTileFor(player) {
  // Cook-offs set up stalls on the market square.
  try {
    const t = siteTile(player, "market");
    if (t) return { x: t.x + 4, y: t.y + 4, z: t.z ?? 0 };
  } catch { /* fall through */ }
  return null;
}

function cookingLevel(player) {
  try {
    const Skill = require("../../../../src/main/typescript/elvarg/game/model/Skill").Skill;
    const mgr = player.getSkillManager?.();
    if (!mgr || !Skill || typeof mgr.getCurrentLevel !== "function") return 1;
    const lvl = mgr.getCurrentLevel(Skill.COOKING);
    return Number.isInteger(lvl) && lvl > 0 ? lvl : 1;
  } catch {
    return 1;
  }
}

function creativityOf(personality) {
  try {
    return Math.max(0, Math.min(1, Number(personality?.creativity ?? personality?.creative ?? 0)));
  } catch { return 0; }
}

const ROUND_NAMES = ["appetizer", "main", "dessert"];

function createCitizenCookOffAction(spec, world) {
  function botState(player) {
    return playerState(action, player, () => {
      const personality = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
      return {
        rng: agentRng(`cookoff:${player.getUsername?.() ?? "unknown"}`),
        human: humanizerProfile(personality),
        personality,
        giveUpAt: 0,
        phase: "outbound", // outbound -> cooking -> returning -> done
        roundsDone: 0,
        lastRoundAt: 0,
        venueTile: null,
        homeTile: null,
        cookOffId: null,
      };
    });
  }

  const action = {
    id: "citizenCookOff",
    update(ctx) {
      const { player, nowMs } = ctx;
      if (!player) return "success";
      const CookOffs = cookOffsApi();
      if (!CookOffs) return "success";
      const state = botState(player);
      const username = player.getUsername?.() ?? player?.username ?? "citizen";

      if (!state.giveUpAt) {
        state.giveUpAt = nowMs + GIVE_UP_MS;
        state.homeTile = homeTileFor(player);
        const kid = kingdomIdOf(player);
        const open = kid ? CookOffs.openCookOff(kid) : null;
        const entered = open && open.entries.some((e) => e.chef === username);
        if (!entered) {
          state.phase = "returning"; // not entered — walk home honestly
        } else {
          state.cookOffId = open.id;
          state.venueTile = venueTileFor(player);
          if (!state.venueTile) state.phase = "returning"; // no venue, no duel
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
            state.phase = "cooking";
            state.lastRoundAt = 0; // cook immediately on arrival
            return "running";
          }
          walkTo(player, state.venueTile);
          return "running";
        }
        case "cooking": {
          if (!atTile(player, state.venueTile)) {
            state.phase = "outbound"; // drifted away, walk back
            return "running";
          }
          if (nowMs - state.lastRoundAt >= ROUND_COOLDOWN_MS && state.roundsDone < COOK_ROUNDS) {
            state.lastRoundAt = nowMs;
            const roundName = ROUND_NAMES[state.roundsDone];
            try {
              CookOffs.recordRoundScore(
                state.cookOffId, username, roundName,
                cookingLevel(player), creativityOf(state.personality));
            } catch { /* scoring is safe */ }
            state.roundsDone += 1;
          }
          if (state.roundsDone >= COOK_ROUNDS) {
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

module.exports = { createCitizenCookOffAction };
