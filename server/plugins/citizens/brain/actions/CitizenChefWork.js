"use strict";

/**
 * CitizenChefWork — the brain action for master-chef citizens creating
 * real signature dishes.
 *
 * The visible "chef at work" half. The slow tick (CitizenCuisineLife)
 * handles competitions, critic reviews, and menu management; this action
 * is what a nearby player actually sees:
 *
 * Flow per tick:
 *   - Walk to the kingdom restaurant (deterministic tile near the market).
 *   - Pick the best dish type the chef can afford (REAL ingredients from
 *     REAL inventory, resolved defensively from engine item tables).
 *   - Cook the dish (human-paced 8s cooldown), consuming REAL ingredients,
 *     creating a REAL dish record, granting REAL Cooking XP.
 *   - Add the dish to the restaurant menu.
 *   - After WORK_ROUNDS rounds or GIVE_UP_MS, walk home.
 *
 * Zero LLM. Tick-safe: every engine read guarded, per-action try/catch
 * in the brain.
 *
 * No-overlap: CitizenCooks.js owns the flavor layer (trade assignment,
 * hawking, meal-of-day). CitizenCook.js owns individual cooking skill.
 * This owns the real signature-dish production layer.
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
const WORK_ROUNDS = 3;
const ARRIVE_RADIUS = 8;
const COOK_COOLDOWN_MS = 8000; // human-paced cooking

function cuisineApi() {
  try {
    return require("../../lib/CitizenCuisine");
  } catch {
    return null;
  }
}

/** The restaurant tile for this citizen's kingdom (defensive). */
function workTileFor(player) {
  try {
    return siteTile(player, "market");
  } catch {
    return null;
  }
}

/** Cooking level of the player (defensive). */
function cookingLevel(player) {
  try {
    const skills = player?.skills ?? player?.getSkills?.();
    if (skills?.getLevel) return skills.getLevel("cooking");
    if (typeof skills?.cooking === "number") return skills.cooking;
    return player?.getLevel?.("cooking") ?? 1;
  } catch {
    return 1;
  }
}

/** Creativity trait 0-1 (defensive). */
function creativityOf(personality) {
  try {
    return Math.max(0, Math.min(1, Number(personality?.creativity ?? personality?.openness ?? 0.3)));
  } catch {
    return 0.3;
  }
}

/** Count of an item id in the player's real inventory (defensive). */
function countItem(player, itemId) {
  if (itemId == null) return 0;
  try {
    const inv = player?.inventory ?? player?.getInventory?.();
    if (!inv) return 0;
    if (typeof inv.count === "function") return inv.count(itemId) ?? 0;
    if (typeof inv.getAmount === "function") return inv.getAmount(itemId) ?? 0;
    if (Array.isArray(inv.items)) {
      return inv.items.filter((i) => (i?.id ?? i?.itemId) === itemId)
        .reduce((s, i) => s + (i?.amount ?? i?.count ?? 1), 0);
    }
    return 0;
  } catch {
    return 0;
  }
}

/** Remove items from the player's real inventory (defensive). */
function removeItem(player, itemId, amount) {
  if (itemId == null || amount <= 0) return false;
  try {
    const inv = player?.inventory ?? player?.getInventory?.();
    if (!inv) return false;
    if (typeof inv.remove === "function") { inv.remove(itemId, amount); return true; }
    if (typeof inv.delete === "function") { inv.delete(itemId, amount); return true; }
    return false;
  } catch {
    return false;
  }
}

/**
 * Can the chef afford this dish's ingredients? Returns { ok, missing }.
 * Ingredient kinds that don't resolve to real item IDs are treated as
 * unavailable (honest — never invent).
 */
function canAffordDish(Cuisine, player, type) {
  try {
    const def = Cuisine.DISHES[type];
    if (!def) return { ok: false, missing: [type] };
    const ids = Cuisine.ingredientIds();
    if (!ids) return { ok: false, missing: ["engine-unavailable"] };
    const missing = [];
    for (const [kind, need] of Object.entries(def.ingredients)) {
      const id = ids[kind];
      if (id == null || countItem(player, id) < need) missing.push(kind);
    }
    return { ok: missing.length === 0, missing };
  } catch {
    return { ok: false, missing: ["error"] };
  }
}

/** Consume the dish's ingredients from the real inventory. */
function consumeIngredients(Cuisine, player, type) {
  try {
    const def = Cuisine.DISHES[type];
    const ids = Cuisine.ingredientIds();
    if (!def || !ids) return false;
    for (const [kind, need] of Object.entries(def.ingredients)) {
      const id = ids[kind];
      if (id == null || !removeItem(player, id, need)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Grant real Cooking XP (defensive). */
function grantCookingXp(player, amount) {
  try {
    const sm = player?.skillManager ?? player?.getSkillManager?.();
    if (sm?.addXp) { sm.addXp("cooking", amount); return true; }
    if (typeof player?.addXp === "function") { player.addXp("cooking", amount); return true; }
    return false;
  } catch {
    return false;
  }
}

function createCitizenChefWorkAction(spec, world) {
  function botState(player) {
    if (!player) return null;
    return playerState(action, player, () => {
      const personality = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
      return {
        rng: agentRng(`chef:${player.getUsername?.() ?? "unknown"}`),
        human: humanizerProfile(personality),
        personality,
        giveUpAt: 0,
        phase: "outbound", // outbound -> cooking -> returning -> done
        roundsDone: 0,
        lastCookAt: 0,
        workTile: null,
        homeTile: null,
        currentType: null,
      };
    });
  }

  function isNear(player, tile, radius) {
    try {
      const p = player?.getPosition?.() ?? player?.position;
      if (!p || !tile) return false;
      const dx = (p.x ?? 0) - (tile.x ?? 0);
      const dy = (p.y ?? 0) - (tile.y ?? 0);
      return Math.hypot(dx, dy) <= (radius ?? ARRIVE_RADIUS);
    } catch {
      return false;
    }
  }

  function pickDish(Cuisine, player, nowMs) {
    try {
      let best = null;
      let bestValue = -1;
      for (const type of Cuisine.DISH_TYPES) {
        const check = canAffordDish(Cuisine, player, type);
        if (!check.ok) continue;
        const lvl = cookingLevel(player);
        const q = Cuisine.dishQuality(lvl, creativityOf(botState(player).personality));
        const value = Cuisine.dishValue(type, q, 0);
        if (value > bestValue) {
          bestValue = value;
          best = type;
        }
      }
      return best;
    } catch {
      return null;
    }
  }

  const action = {
    id: "citizenChefWork",
    canStart(player) {
      try {
        const Cuisine = cuisineApi();
        if (!Cuisine) return false;
        // Master chefs (or high cooking) do this work.
        const lvl = cookingLevel(player);
        if (lvl < 30) return false;
        const st = botState(player);
        const now = Date.now();
        if (st.giveUpAt && now > st.giveUpAt) return false;
        return true;
      } catch {
        return false;
      }
    },
    tick(player, nowMs) {
      if (!player) return "failed";
      const st = botState(player);
      if (!st) return "failed";
      const Cuisine = cuisineApi();
      if (!Cuisine) return "failed";
      const now = nowMs ?? Date.now();

      if (!st.giveUpAt) st.giveUpAt = now + GIVE_UP_MS;
      if (now > st.giveUpAt) {
        clearMovementRequest(player);
        return "success"; // give up honestly
      }

      switch (st.phase) {
        case "outbound": {
          if (!st.workTile) {
            st.workTile = workTileFor(player);
            st.homeTile = personalSpot(player);
          }
          if (!st.workTile) return "failed";
          if (isNear(player, st.workTile, ARRIVE_RADIUS)) {
            st.phase = "cooking";
            break;
          }
          requestMovement(player, st.workTile.x, st.workTile.y, { z: st.workTile.z ?? 0 });
          return "running";
        }
        case "cooking": {
          if (st.roundsDone >= WORK_ROUNDS) {
            st.phase = "returning";
            break;
          }
          if (now - st.lastCookAt < COOK_COOLDOWN_MS) return "running";
          const type = pickDish(Cuisine, player, now);
          if (!type) {
            // Can't afford anything — honest end of work.
            st.phase = "returning";
            break;
          }
          if (!consumeIngredients(Cuisine, player, type)) {
            st.phase = "returning";
            break;
          }
          const lvl = cookingLevel(player);
          const q = Cuisine.dishQuality(lvl, creativityOf(st.personality));
          const dish = Cuisine.createDish(type, player.getUsername?.() ?? "unknown", q, now);
          if (dish) {
            try {
              const kid = kingdomIdOf(player);
              Cuisine.addToMenu(kid, dish.id);
            } catch { /* menu add is best-effort */ }
            grantCookingXp(player, 40 + q * 5);
            // Award master-chef title if qualified.
            if (lvl >= Cuisine.CHEF_MASTER_LEVEL) {
              Cuisine.awardMasterChef(player.getUsername?.() ?? "unknown");
            }
          }
          st.lastCookAt = now;
          st.roundsDone += 1;
          return "running";
        }
        case "returning": {
          if (!st.homeTile) return "success";
          if (isNear(player, st.homeTile, ARRIVE_RADIUS)) {
            clearMovementRequest(player);
            return "success";
          }
          requestMovement(player, st.homeTile.x, st.homeTile.y, { z: st.homeTile.z ?? 0 });
          return "running";
        }
        default:
          return "success";
      }
      return "running";
    },
  };
  return action;
}

module.exports = { createCitizenChefWorkAction };
