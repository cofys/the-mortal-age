"use strict";

/**
 * CitizenInvent — the brain action for inventing.
 *
 * Complements (does not duplicate) CitizenEngineers: that module runs
 * machine-shop flavor (scripted work emotes near players). This is the
 * PHYSICAL brain action — the citizen actually walks to the workshop,
 * invests REAL materials from their real inventory into a research
 * project, and the project progresses on the slow tick (real time).
 *
 * Flow per tick:
 *   - Walk to the kingdom workshop (deterministic tile near the market).
 *   - If the citizen has an active research project: tinker on it
 *     (human-paced, grants a small progress boost for hands-on work).
 *   - If no active project: pick the best blueprint they can afford
 *     (materials in inventory + crafting level), consume the REAL
 *     materials, and start the project.
 *   - No affordable blueprint → walk home, done honestly.
 *   - After WORK_ROUNDS tinkering rounds or GIVE_UP_MS, walk home.
 *
 * Research completion happens on the slow tick (CitizenInventionLife),
 * which grants the real Crafting XP, creates the invention record, and
 * issues the patent. This action is the physical "doing the work" half.
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
const TINKER_COOLDOWN_MS = 12000; // human-paced tinkering

// Preferred blueprint order (by fame value, highest first).
const BLUEPRINT_PREFERENCE = [
  "siege_ram_plans",
  "ore_washer",
  "war_horn",
  "seed_dibbler",
  "precision_chisel",
  "reinforced_axe",
  "improved_pickaxe",
];

function inventionsApi() {
  try {
    return require("../../lib/CitizenInventions");
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

function realCraftingLevel(player) {
  try {
    return player?.getSkills?.()?.getLevel?.("crafting") ?? player?.skills?.crafting ?? 1;
  } catch {
    return 1;
  }
}

/** Best affordable blueprint, or null. */
function affordableBlueprint(player, Inventions) {
  const inv = player?.getInventory?.();
  if (!inv) return null;
  const craftingLevel = realCraftingLevel(player);
  const kingdomId = kingdomIdOf(player);
  for (const bpId of BLUEPRINT_PREFERENCE) {
    const bp = Inventions.blueprint(bpId);
    if (!bp) continue;
    if (craftingLevel < bp.craftingLevel) continue;
    // Science gate: some blueprints need a kingdom science discovery first.
    try {
      if (typeof Inventions.isBlueprintUnlocked === "function" && !Inventions.isBlueprintUnlocked(bpId, kingdomId)) continue;
    } catch { /* gate unreadable — allow */ }
    let ok = true;
    for (const [itemId, amount] of Object.entries(bp.materials)) {
      if (countItem(inv, Number(itemId)) < amount) {
        ok = false;
        break;
      }
    }
    if (ok) return bpId;
  }
  return null;
}

/** Consume the blueprint's real materials from inventory. */
function consumeMaterials(player, Inventions, bpId) {
  const bp = Inventions.blueprint(bpId);
  if (!bp) return;
  const inv = player?.getInventory?.();
  if (!inv) return;
  for (const [itemId, amount] of Object.entries(bp.materials)) {
    takeItem(inv, Number(itemId), amount);
  }
}

function workshopTileFor(player, Inventions) {
  try {
    const kingdomId = kingdomIdOf(player);
    return Inventions.workshopTile(kingdomId);
  } catch {
    return null;
  }
}

function createCitizenInventAction(spec, world) {
  function botState(player) {
    return playerState(action, player, () => {
      const personality = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
      return {
        rng: agentRng(`invent:${player.getUsername?.() ?? "unknown"}`),
        human: humanizerProfile(personality),
        personality,
        giveUpAt: 0,
        phase: "outbound", // outbound -> working -> returning -> done
        roundsDone: 0,
        lastTinkerAt: 0,
        workshopTile: null,
        homeTile: null,
        projectId: null,
      };
    });
  }

  const action = {
    id: "citizenInvent",
    update(ctx) {
      const { player, nowMs } = ctx;
      const Inventions = inventionsApi();
      if (!Inventions) return "success"; // no invention system, nothing to do
      const state = botState(player);
      const username = player.getUsername?.() ?? player?.username ?? "citizen";

      if (!state.giveUpAt) {
        state.giveUpAt = nowMs + GIVE_UP_MS;
        state.workshopTile = workshopTileFor(player, Inventions);
        try {
          state.homeTile = siteTile(player, "market") ?? { x: 3200, y: 3200, z: 0 };
        } catch {
          state.homeTile = { x: 3200, y: 3200, z: 0 };
        }
        // Resume an existing project if there is one.
        try {
          const existing = Inventions.projectsFor(username);
          if (existing.length > 0) state.projectId = existing[0].id;
        } catch { /* best-effort */ }
      }
      if (nowMs >= state.giveUpAt) {
        try { clearMovementRequest(player); } catch { /* best-effort */ }
        return "success";
      }

      // No workshop tile — can't invent without a workshop.
      if (!state.workshopTile) return "success";

      const px = player.getX?.() ?? 0;
      const py = player.getY?.() ?? 0;

      // --- phase: outbound (walk to workshop) ---
      if (state.phase === "outbound") {
        const dx = state.workshopTile.x - px, dy = state.workshopTile.y - py;
        if (Math.sqrt(dx * dx + dy * dy) <= ARRIVE_RADIUS) {
          state.phase = "working";
          return "running";
        }
        try {
          requestMovement(player, state.workshopTile.x, state.workshopTile.y);
        } catch { /* best-effort */ }
        return "running";
      }

      // --- phase: working ---
      if (state.phase === "working") {
        if (state.roundsDone >= WORK_ROUNDS) {
          state.phase = "returning";
          return "running";
        }
        if (nowMs - state.lastTinkerAt < TINKER_COOLDOWN_MS) {
          return "running"; // pacing — research takes time
        }
        state.lastTinkerAt = nowMs;
        state.roundsDone++;

        // If no active project, try to start one.
        if (!state.projectId) {
          const bpId = affordableBlueprint(player, Inventions);
          if (!bpId) {
            // Nothing affordable — honest end.
            state.phase = "returning";
            return "running";
          }
          // Consume real materials, then start the project.
          consumeMaterials(player, Inventions, bpId);
          try {
            const project = Inventions.startResearch(username, bpId);
            if (project) state.projectId = project.id;
          } catch { /* best-effort */ }
          return "running";
        }

        // Tinker on the active project: hands-on work grants a small boost.
        try {
          const result = Inventions.progressResearch(state.projectId, 1);
          // progressResearch returns the invention if the project completed.
          if (result && result.label && !result.progressTicks) {
            // Research complete! Grant real Crafting XP.
            const bp = Inventions.blueprint(result.blueprintId);
            if (bp) {
              try {
                player?.getSkills?.()?.addXp?.("crafting", bp.xp);
              } catch { /* XP is best-effort */ }
            }
            state.projectId = null; // project done, can start a new one
          }
        } catch {
          state.projectId = null; // project vanished, re-evaluate next round
        }
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
  createCitizenInventAction,
};
