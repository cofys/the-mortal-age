"use strict";

/**
 * CitizenEngineerWork — the brain action for real infrastructure work.
 *
 * Complements (does not duplicate) CitizenConstruct: that module works on
 * REAL construction BUILDINGS (granary, barracks, walls...). This is the
 * PHYSICAL brain action on the REAL infrastructure layer — the citizen
 * walks to the kingdom's real infrastructure site, donates REAL materials
 * from their real inventory into the project stockpile, and does hands-on
 * work that advances REAL project progress. Grants real Construction XP.
 *
 * Flow per tick:
 *   - Find the kingdom's active infrastructure project (CitizenInfrastructure).
 *   - No active project → walk home, done honestly.
 *   - Walk to the infrastructure site (deterministic tile near the market).
 *   - Donate any project-needed materials from the real inventory
 *     (human-paced, one material kind per round).
 *   - Work on the project: hands-on progress + real Construction XP.
 *   - After WORK_ROUNDS or GIVE_UP_MS, walk home.
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
const WORK_ROUNDS = 4;
const ARRIVE_RADIUS = 8;
const WORK_COOLDOWN_MS = 12000; // human-paced work
const XP_PER_ROUND = 70; // real Construction XP per work round

function infraApi() {
  try {
    return require("../../lib/CitizenInfrastructure");
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
    if (typeof inv.contains === "function") return inv.contains(itemId) ? 1 : 0;
    return 0;
  } catch {
    return 0;
  }
}

/** Remove items from inventory (defensive, multi-API). Returns amount taken. */
function takeItem(inv, itemId, amount) {
  try {
    if (!inv) return 0;
    const have = countItem(inv, itemId);
    const take = Math.min(have, amount);
    if (take <= 0) return 0;
    if (typeof inv.deleteNumber === "function") inv.deleteNumber(itemId, take);
    else if (typeof inv.remove === "function") inv.remove(itemId, take);
    else if (typeof inv.delete === "function") inv.delete(itemId, take);
    else return 0;
    return take;
  } catch {
    return 0;
  }
}

function grantConstructionXp(player, amount) {
  try {
    player?.getSkills?.()?.addXp?.("construction", amount);
  } catch {}
  try {
    const Skilling = require("../../lib/CitizenSkilling");
    Skilling.grantXpWithCelebration?.(player, "construction", amount);
  } catch {}
}

function siteTileFor(player, Infra) {
  try {
    const kingdomId = kingdomIdOf(player);
    if (!kingdomId) return null;
    return Infra.siteTile(kingdomId);
  } catch {
    return null;
  }
}

function homeTileFor(player) {
  try {
    return siteTile(player, "market") ?? { x: 3200, y: 3200, z: 0 };
  } catch {
    return { x: 3200, y: 3200, z: 0 };
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

/** Find a material the project still needs that the citizen carries. */
function findDonatable(inv, project, Infra) {
  try {
    const spec = Infra.specFor(project.type);
    if (!spec) return null;
    for (const [itemId, need] of Object.entries(spec.materials)) {
      const donated = project.stockpile?.[itemId] ?? 0;
      const stillNeed = need - donated;
      if (stillNeed <= 0) continue;
      const have = countItem(inv, Number(itemId));
      if (have > 0) return { itemId: Number(itemId), amount: Math.min(have, stillNeed) };
    }
  } catch {}
  return null;
}

function createCitizenEngineerWorkAction(spec, world) {
  function botState(player) {
    return playerState(action, player, () => {
      const personality = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
      return {
        rng: agentRng(`engineer:${player.getUsername?.() ?? "unknown"}`),
        human: humanizerProfile(personality),
        personality,
        giveUpAt: 0,
        phase: "outbound", // outbound -> working -> returning -> done
        roundsDone: 0,
        lastWorkAt: 0,
        siteTile: null,
        homeTile: null,
        projectId: null,
      };
    });
  }

  const action = {
    id: "citizenEngineerWork",
    update(ctx) {
      const { player, nowMs } = ctx;
      const Infra = infraApi();
      if (!Infra) return "success"; // no infrastructure system, nothing to do
      const state = botState(player);
      const username = player.getUsername?.() ?? player?.username ?? "citizen";

      if (!state.giveUpAt) {
        state.giveUpAt = nowMs + GIVE_UP_MS;
        state.siteTile = siteTileFor(player, Infra);
        state.homeTile = homeTileFor(player);
        const kingdomId = kingdomIdOf(player);
        const proj = kingdomId ? Infra.activeProjectFor(kingdomId) : null;
        if (!proj || !state.siteTile) {
          // No active project or no site — honest no-op.
          state.phase = "returning";
        } else {
          state.projectId = proj.id;
        }
      }

      if (nowMs > state.giveUpAt) {
        stopWalking(player);
        return "success";
      }

      const proj = state.projectId ? Infra.project(state.projectId) : null;

      switch (state.phase) {
        case "outbound": {
          if (!proj) {
            state.phase = "returning";
            break;
          }
          if (atTile(player, state.siteTile)) {
            state.phase = "working";
            break;
          }
          walkTo(player, state.siteTile);
          return "running";
        }
        case "working": {
          if (!proj) {
            state.phase = "returning";
            break;
          }
          if (!atTile(player, state.siteTile)) {
            state.phase = "outbound";
            break;
          }
          if (nowMs - state.lastWorkAt < WORK_COOLDOWN_MS) return "running";
          state.lastWorkAt = nowMs;

          // 1. Donate materials from the real inventory (one kind per round).
          try {
            const inv = player.getInventory?.();
            const donatable = findDonatable(inv, proj, Infra);
            if (donatable) {
              const taken = takeItem(inv, donatable.itemId, donatable.amount);
              if (taken > 0) {
                Infra.donateMaterials(proj.id, { [donatable.itemId]: taken });
              }
            }
          } catch {}

          // 2. Hands-on work: real progress + real XP.
          try {
            Infra.workOnProject(proj.id, 2);
            grantConstructionXp(player, XP_PER_ROUND);
          } catch {}

          state.roundsDone += 1;
          if (state.roundsDone >= WORK_ROUNDS) {
            state.phase = "returning";
          }
          return "running";
        }
        case "returning": {
          stopWalking(player);
          if (state.homeTile && !atTile(player, state.homeTile)) {
            walkTo(player, state.homeTile);
            return "running";
          }
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

module.exports = { createCitizenEngineerWorkAction };
