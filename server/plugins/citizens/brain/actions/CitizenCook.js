"use strict";

/**
 * CitizenCook — cook raw food for real Cooking XP, the RuneScape way.
 *
 * Citizens catch raw fish, hunt raw meat, or buy raw food from players. When
 * the decision layer picks citizen_cook, the citizen works a full cooking
 * run: withdraw raw food from the bank when the pack is empty, find a nearby
 * fire (lit by firemaking — the loop feeds itself) or a permanent range,
 * then cooks via the real Cooking plugin's bot entry point (startBotCooking)
 * — the same pattern upstream's Smelt.js uses. Real cooked food lands in the
 * inventory and real Cooking XP flows through SkillManager, so the level-up
 * celebration fires for citizens exactly as it does for players.
 *
 * Cooked food is what citizens eat to heal (CitizenMeal), so cooking feeds
 * the survival loop: fish -> fire -> cook -> eat. A human cooks what they've
 * got on the nearest fire.
 *
 * Flow per tick:
 *   - Cooking already active (isCookingActive) -> "running", wait it out.
 *   - Best cookable recipe from inventory -> find a fire/range, walk to it,
 *     start the bot session.
 *   - No raw food in the pack but the bank holds some -> walk to the bank,
 *     widen via the shared bank action's withdraw, then cook next ticks.
 *   - No raw food anywhere -> "success" (done, brain re-decides — likely
 *     fishing).
 *   - No fire or range nearby -> "success" (re-decide — the brain may pick
 *     firemaking if the citizen holds logs).
 *   - Give up after GIVE_UP_MS so a bad spot never stalls the day.
 *
 * Non-repeat: works one full cooking run, then the brain re-decides (usually
 * the meal hinge, since the pack is full of fresh food).
 *
 * Zero LLM. Tick-safe: every engine read guarded, per-action try/catch in
 * the brain.
 */

const { playerState } = require("../../../bots/brain/ActionState");
const {
  requestMovement,
  clearMovementRequest,
} = require("../../../bots/behaviours/navigation/BotNavigation");
const { createBankAction } = require("../../../bots/brain/actions/Bank");
const { resolveCatalogObjectIds } = require("../../../bots/brain/BotObjectCatalog");
const { siteTile, kingdomIdOf } = require("../CitizenSites");
const { ATTR_CITIZEN_PERSONALITY } = require("../../constants");
const {
  agentRng,
  personalSpot,
  humanizerProfile,
} = require("../../lib/humanizer");

// If no food cooks in this long, the fire is cursed — move on.
const GIVE_UP_MS = 6 * 60 * 1000;
const BANK_ARRIVE_RADIUS = 8;
const INTERACT_COOLDOWN_MS = 4000;

let COOK_IDS = null;
function cookObjectIds(Cooking) {
  if (COOK_IDS) return COOK_IDS;
  try {
    if (Array.isArray(Cooking?.COOK_OBJECT_IDS)) {
      COOK_IDS = Object.freeze([...Cooking.COOK_OBJECT_IDS]);
      return COOK_IDS;
    }
  } catch {
    // fall through to the catalog
  }
  try {
    COOK_IDS = Object.freeze(
      resolveCatalogObjectIds({ catalog: "range" }).concat(
        resolveCatalogObjectIds({ catalog: "fire" })
      )
    );
  } catch {
    COOK_IDS = Object.freeze([]);
  }
  return COOK_IDS;
}

function cookingPlugin() {
  try {
    return require("../../../skills/Cooking.plugin");
  } catch {
    return null;
  }
}

function bankApi() {
  try {
    return require("../../../../src/main/typescript/elvarg/game/model/container/impl/Bank")
      .Bank;
  } catch {
    return null;
  }
}

/** Cooking level, 1 when unreadable (shrimp-only — safe fallback). */
function cookingLevel(player) {
  try {
    const Skill = require("../../../../src/main/typescript/elvarg/game/model/Skill")
      .Skill;
    const mgr = player.getSkillManager?.();
    if (!mgr || !Skill || typeof mgr.getCurrentLevel !== "function") return 1;
    const lvl = mgr.getCurrentLevel(Skill.COOKING);
    return Number.isInteger(lvl) && lvl > 0 ? lvl : 1;
  } catch {
    return 1;
  }
}

function invAmount(player, itemId) {
  try {
    return player.getInventory?.()?.getAmount?.(itemId) ?? 0;
  } catch {
    return 0;
  }
}

/** Total of itemId across all bank tabs (bounded). */
function bankAmount(player, itemId) {
  let total = 0;
  try {
    const Bank = bankApi();
    const tabs = Bank?.TOTAL_BANK_TABS ?? 9;
    for (let tab = 0; tab < tabs - 1; tab++) {
      const bank = player.getBank?.(tab);
      if (!bank) continue;
      const slot = bank.getSlotForItemId?.(itemId) ?? -1;
      if (slot < 0) continue;
      const stack = bank.getItems?.()[slot];
      if (!stack || stack.getId?.() !== itemId) continue;
      total += stack.getAmount?.() ?? 0;
    }
  } catch {
    // treat as empty
  }
  return total;
}

/**
 * Best recipe the citizen can cook right now: highest Cooking level at or
 * under their level with at least one raw food in the pack. A human cooks
 * the best food they've got.
 */
function bestInventoryRecipe(Cooking, player) {
  const recipes = [...(Cooking?.COOKING_RECIPES ?? [])].sort(
    (a, b) => (b.level ?? 0) - (a.level ?? 0)
  );
  const level = cookingLevel(player);
  for (const recipe of recipes) {
    if ((recipe.level ?? 99) > level) continue;
    if (invAmount(player, recipe.rawId) > 0) return recipe;
  }
  return null;
}

/**
 * Raw food the inventory can currently cook.
 */
function rawFoodFromInventory(Cooking, player) {
  const recipes = [...(Cooking?.COOKING_RECIPES ?? [])].sort(
    (a, b) => (b.level ?? 0) - (a.level ?? 0)
  );
  const level = cookingLevel(player);
  let total = 0;
  for (const recipe of recipes) {
    if ((recipe.level ?? 99) > level) continue;
    total += invAmount(player, recipe.rawId);
  }
  return total;
}

/**
 * Withdraw plan from the bank: best level-gated raw food the bank can supply.
 * Tops the inventory toward a full cooking run (28 slots of food).
 */
function bestBankPlan(Cooking, player) {
  const recipes = [...(Cooking?.COOKING_RECIPES ?? [])].sort(
    (a, b) => (b.level ?? 0) - (a.level ?? 0)
  );
  const level = cookingLevel(player);
  for (const recipe of recipes) {
    if ((recipe.level ?? 99) > level) continue;
    const want = Math.max(1, 28 - invAmount(player, recipe.rawId));
    const inBank = bankAmount(player, recipe.rawId);
    const take = Math.min(want, inBank);
    if (take < 1) continue;
    return {
      recipe,
      withdraw: [
        { item: recipe.rawId, amount: invAmount(player, recipe.rawId) + take },
      ],
    };
  }
  return null;
}

/** Cheapest honest answer to "does this citizen have raw food to cook?" */
function cookableFood(Cooking, player) {
  const inv = rawFoodFromInventory(Cooking, player);
  if (inv > 0) return inv;
  const plan = bestBankPlan(Cooking, player);
  if (!plan) return 0;
  let total = 0;
  const recipes = [...(Cooking?.COOKING_RECIPES ?? [])];
  const level = cookingLevel(player);
  for (const recipe of recipes) {
    if ((recipe.level ?? 99) > level) continue;
    total += invAmount(player, recipe.rawId) + bankAmount(player, recipe.rawId);
  }
  return total;
}

/**
 * Nearest fire or range the citizen can cook on. Prefers ranges (permanent)
 * over fires (burn out), then nearest. rangeOnly recipes (bread) need a
 * real range — fires won't do.
 */
function findCookSpot(world, player, Cooking, recipe) {
  try {
    const loc = player.getLocation?.();
    if (!loc) return null;
    const ids = cookObjectIds(Cooking);
    if (!ids.length) return null;
    const candidates =
      world?.objectSearch?.findCandidatesByIds?.(player, ids, {
        regionRadius: 2,
        z: loc.getZ?.(),
        privateArea: player.getPrivateArea?.() ?? null,
      }) ?? [];
    let best = null;
    let bestScore = Number.MAX_SAFE_INTEGER;
    for (const object of candidates) {
      const objectLoc = object?.getLocation?.();
      if (!objectLoc || objectLoc.getZ?.() !== loc.getZ?.()) continue;
      // Bread dough needs a range — skip fires for rangeOnly recipes.
      if (recipe?.rangeOnly) {
        const name = object?.getDefinition?.()?.getName?.() ?? "";
        if (!/range|stove/i.test(name)) continue;
      }
      const dx = objectLoc.getX() - loc.getX();
      const dy = objectLoc.getY() - loc.getY();
      const distSq = dx * dx + dy * dy;
      // Ranges (permanent) beat fires (temporary): small preference bonus.
      const name = object?.getDefinition?.()?.getName?.() ?? "";
      const isRange = /range|stove/i.test(name);
      const score = distSq - (isRange ? 50 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = object;
      }
    }
    return best;
  } catch {
    return null;
  }
}

function atTile(player, tile, radius) {
  try {
    const loc = player.getLocation?.();
    if (!loc) return false;
    return (
      (loc.getZ?.() ?? 0) === (tile.z ?? 0) &&
      Math.max(Math.abs(loc.getX() - tile.x), Math.abs(loc.getY() - tile.y)) <=
        radius
    );
  } catch {
    return false;
  }
}

function walkToBank(player, tile) {
  const username = player.getUsername?.() ?? "unknown";
  // Personal spot near the bank — the cook crew shouldn't stack on one tile.
  const spot = personalSpot(username, tile.x, tile.y, 4, 10);
  try {
    requestMovement(player, spot.x, spot.y, {
      reason: "citizen_cook_bank",
      basicPather: true,
      z: tile.z ?? 0,
    });
    return true;
  } catch {
    return false;
  }
}

function createCitizenCookAction(spec, world) {
  function botState(player) {
    return playerState(action, player, () => {
      const personality = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
      return {
        rng: agentRng(`cook:${player.getUsername?.() ?? "unknown"}`),
        human: humanizerProfile(personality),
        giveUpAt: 0,
        withdrawing: false,
        withdrawDelegate: null,
        lastClickAt: 0,
        cookSpot: null,
      };
    });
  }

  function stopWithdraw(state, ctx) {
    try {
      state.withdrawDelegate?.stop?.(ctx);
    } catch {
      // best effort
    }
    state.withdrawDelegate = null;
    state.withdrawing = false;
  }

  const action = {
    id: "citizenCook",
    update(ctx) {
      const { player, nowMs } = ctx;
      const Cooking = cookingPlugin();
      if (!Cooking?.startBotCooking) {
        return "failed"; // Cooking plugin not loaded
      }
      const state = botState(player);
      if (!state.giveUpAt) {
        state.giveUpAt = nowMs + GIVE_UP_MS;
      }
      if (nowMs >= state.giveUpAt) {
        stopWithdraw(state, ctx);
        return "success"; // bad cook day — move on, don't stall
      }

      // A cooking session is already running — wait it out.
      let active = false;
      try {
        active = Cooking.isCookingActive?.(player) === true;
      } catch {
        active = false;
      }
      if (active) return "running";

      // Raw food in the pack? Cook the best of it.
      const recipe = bestInventoryRecipe(Cooking, player);
      if (recipe) {
        if (state.withdrawing) stopWithdraw(state, ctx);
        return cookFood(ctx, state, Cooking, recipe);
      }

      // No raw food in the pack — check the bank before giving up.
      const plan = bestBankPlan(Cooking, player);
      if (!plan) return "success"; // nothing to cook anywhere; re-decide
      return withdrawFood(ctx, state, plan);
    },
    stop(ctx) {
      try {
        const player = ctx?.player;
        if (player) {
          const st = playerState(action, player, () => null);
          if (st?.withdrawDelegate) {
            try {
              st.withdrawDelegate.stop?.(ctx);
            } catch {
              // best effort
            }
          }
        }
      } catch {
        // best effort
      }
      if (ctx?.player) {
        clearMovementRequest(ctx.player);
      }
    },
  };

  function withdrawFood(ctx, state, plan) {
    const { player } = ctx;
    const bank = siteTile(player, "bank");
    if (!bank) {
      return "failed"; // no bank anchor for this kingdom
    }
    if (!state.withdrawing) {
      if (!atTile(player, bank, BANK_ARRIVE_RADIUS)) {
        walkToBank(player, bank);
        return "running";
      }
      state.withdrawing = true;
      state.withdrawDelegate = createBankAction(
        { withdraw: plan.withdraw },
        world
      );
    }
    let result = "running";
    try {
      result = state.withdrawDelegate.update(ctx);
    } catch {
      result = "failed";
    }
    if (result === "success" || result === "failed") {
      // Withdraw leg over (or booth unreachable) — either the pack now has
      // raw food and cooking resumes next tick, or the day moves on.
      stopWithdraw(state, ctx);
      return "running";
    }
    return "running";
  }

  function cookFood(ctx, state, Cooking, recipe) {
    const { player, nowMs } = ctx;

    // Find a fire or range to cook on. No spot nearby — re-decide (the brain
    // may pick firemaking if the citizen holds logs).
    const spot = findCookSpot(world, player, Cooking, recipe);
    if (!spot) return "success";

    const spotLoc = spot.getLocation?.();
    if (!spotLoc) return "success";

    // Let in-flight movement finish first.
    try {
      if (player.getForceMovement?.() != null) return "running";
      if (player.getMovementQueue?.()?.size?.() > 0) return "running";
    } catch {
      // fall through and try the cook
    }
    if (nowMs - state.lastClickAt < INTERACT_COOLDOWN_MS) {
      return "running";
    }
    state.lastClickAt = nowMs;
    // Same shape as upstream Smelt.js: walk into range, then fire the real
    // object interaction and start the bot cooking session directly.
    try {
      const queue = player.getMovementQueue?.();
      if (!queue) return "running";
      queue.walkToObject(spot, {
        execute: () => {
          try {
            world.emitObjectInteraction?.({
              player,
              object: spot,
              objectId: spot.getId(),
              clickType: 1,
              location: {
                x: spotLoc.getX(),
                y: spotLoc.getY(),
                z: spotLoc.getZ(),
              },
              sourceLocation: {
                x: player.getLocation().getX(),
                y: player.getLocation().getY(),
                z: player.getLocation().getZ(),
              },
              handled: false,
            });
          } catch {
            // interaction is best-effort; the session is the real work
          }
          try {
            const started = Cooking.startBotCooking?.(player, spot, recipe);
            if (started) {
              try {
                world?.log?.("citizen_cook", {
                  citizen: player.getUsername?.(),
                  kingdom: kingdomIdOf(player),
                  food: recipe.rawId,
                  recipe: recipe.name,
                });
              } catch {
                // non-fatal
              }
            }
          } catch {
            // next tick retries
          }
        },
      });
    } catch {
      return "running";
    }
    return "running";
  }

  return action;
}

module.exports = {
  createCitizenCookAction,
  // exposed for tests
  _rawFoodFromInventory: rawFoodFromInventory,
  _bestInventoryRecipe: bestInventoryRecipe,
  _bestBankPlan: bestBankPlan,
  _cookableFood: cookableFood,
  _cookingLevel: cookingLevel,
  _findCookSpot: findCookSpot,
};
