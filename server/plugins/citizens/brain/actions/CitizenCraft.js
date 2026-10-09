"use strict";

/**
 * CitizenCraft — cut uncut gems for real Crafting XP, the RuneScape way.
 *
 * Citizens pick up uncut gems (mining byproduct, bought from players, banked
 * from earlier trips). When the decision layer picks citizen_craft, the
 * citizen works a full cutting run: withdraw gems (and a chisel, if needed)
 * from the bank when the pack is empty, then cuts via the real Crafting
 * plugin's bot entry point (startBotCrafting) — the same pattern upstream's
 * Smelt.js uses. Real cut gems land in the inventory and real Crafting XP
 * flows through SkillManager, so the level-up celebration fires for citizens
 * exactly as it does for players.
 *
 * Crafting is inventory work — no station needed, a citizen cuts gems
 * wherever they are. The one tool that matters is the chisel.
 *
 * Flow per tick:
 *   - Cutting already active (isCraftingActive) -> "running", wait it out.
 *   - Best cuttable recipe from inventory -> start the bot session.
 *   - No gems in the pack but the bank holds some -> walk to the bank,
 *     widen via the shared bank action's withdraw, then cut next ticks.
 *   - No gems anywhere -> "success" (done, brain re-decides — likely mining).
 *   - Give up after GIVE_UP_MS so a bad spot never stalls the day.
 *
 * Non-repeat: works one full cutting run, then the brain re-decides (usually
 * the bank hinge, since the pack is full of fresh gems).
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
const { siteTile, kingdomIdOf } = require("../CitizenSites");
const { ATTR_CITIZEN_PERSONALITY } = require("../../constants");
const {
  agentRng,
  personalSpot,
  humanizerProfile,
} = require("../../lib/humanizer");

// If no gem gets cut in this long, the bank is cursed — move on.
const GIVE_UP_MS = 6 * 60 * 1000;
const BANK_ARRIVE_RADIUS = 8;

// Standard chisel item id (matches ItemIds.CHISEL in the engine).
const CHISEL_ITEM_ID = 1755;

function craftingPlugin() {
  try {
    return require("../../../skills/Crafting.plugin");
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

/** Crafting level, 1 when unreadable (opal-only — safe fallback). */
function craftingLevel(player) {
  try {
    const Skill = require("../../../../src/main/typescript/elvarg/game/model/Skill")
      .Skill;
    const mgr = player.getSkillManager?.();
    if (!mgr || !Skill || typeof mgr.getCurrentLevel !== "function") return 1;
    const lvl = mgr.getCurrentLevel(Skill.CRAFTING);
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

function hasChisel(player) {
  return invAmount(player, CHISEL_ITEM_ID) > 0;
}

/**
 * Best recipe the citizen can cut right now: highest Crafting level at or
 * under their level with at least one uncut gem in the pack. A human cuts
 * the best gem they've got.
 */
function bestInventoryRecipe(Crafting, player) {
  const recipes = [...(Crafting?.CRAFTING_RECIPES ?? [])].sort(
    (a, b) => (b.level ?? 0) - (a.level ?? 0)
  );
  const level = craftingLevel(player);
  for (const recipe of recipes) {
    if ((recipe.level ?? 99) > level) continue;
    if (invAmount(player, recipe.uncutId) > 0) return recipe;
  }
  return null;
}

/**
 * Gems the inventory can currently cut (chisel assumed present).
 */
function gemsFromInventory(Crafting, player) {
  const recipes = [...(Crafting?.CRAFTING_RECIPES ?? [])].sort(
    (a, b) => (b.level ?? 0) - (a.level ?? 0)
  );
  const level = craftingLevel(player);
  let total = 0;
  for (const recipe of recipes) {
    if ((recipe.level ?? 99) > level) continue;
    total += invAmount(player, recipe.uncutId);
  }
  return total;
}

/**
 * Withdraw plan from the bank: best level-gated gem the bank can supply.
 * Tops the inventory toward a full cutting run (27 slots + chisel), and
 * fetches a chisel when the citizen doesn't carry one.
 */
function bestBankPlan(Crafting, player) {
  const recipes = [...(Crafting?.CRAFTING_RECIPES ?? [])].sort(
    (a, b) => (b.level ?? 0) - (a.level ?? 0)
  );
  const level = craftingLevel(player);
  for (const recipe of recipes) {
    if ((recipe.level ?? 99) > level) continue;
    const want = Math.max(1, 27 - invAmount(player, recipe.uncutId));
    const inBank = bankAmount(player, recipe.uncutId);
    const take = Math.min(want, inBank);
    if (take < 1) continue;
    const withdraw = [
      { item: recipe.uncutId, amount: invAmount(player, recipe.uncutId) + take },
    ];
    if (!hasChisel(player) && bankAmount(player, CHISEL_ITEM_ID) > 0) {
      withdraw.push({ item: CHISEL_ITEM_ID, amount: 1 });
    }
    return { recipe, withdraw };
  }
  return null;
}

/** Cheapest honest answer to "does this citizen have gems to cut?" */
function craftableGems(Crafting, player) {
  const inv = gemsFromInventory(Crafting, player);
  if (inv > 0) return inv;
  const plan = bestBankPlan(Crafting, player);
  if (!plan) return 0;
  let total = 0;
  const recipes = [...(Crafting?.CRAFTING_RECIPES ?? [])];
  const level = craftingLevel(player);
  for (const recipe of recipes) {
    if ((recipe.level ?? 99) > level) continue;
    total += invAmount(player, recipe.uncutId) + bankAmount(player, recipe.uncutId);
  }
  return total;
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
  // Personal spot near the bank — the craft crew shouldn't stack on one tile.
  const spot = personalSpot(username, tile.x, tile.y, 4, 10);
  try {
    requestMovement(player, spot.x, spot.y, {
      reason: "citizen_craft_bank",
      basicPather: true,
      z: tile.z ?? 0,
    });
    return true;
  } catch {
    return false;
  }
}

function createCitizenCraftAction(spec, world) {
  function botState(player) {
    return playerState(action, player, () => {
      const personality = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
      return {
        rng: agentRng(`craft:${player.getUsername?.() ?? "unknown"}`),
        human: humanizerProfile(personality),
        giveUpAt: 0,
        withdrawing: false,
        withdrawDelegate: null,
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
    id: "citizenCraft",
    update(ctx) {
      const { player, nowMs } = ctx;
      const Crafting = craftingPlugin();
      if (!Crafting?.startBotCrafting) {
        return "failed"; // Crafting plugin not loaded
      }
      const state = botState(player);
      if (!state.giveUpAt) {
        state.giveUpAt = nowMs + GIVE_UP_MS;
      }
      if (nowMs >= state.giveUpAt) {
        stopWithdraw(state, ctx);
        return "success"; // bad bank day — move on, don't stall
      }

      // A cutting session is already running — wait it out.
      let active = false;
      try {
        active = Crafting.isCraftingActive?.(player) === true;
      } catch {
        active = false;
      }
      if (active) return "running";

      // No chisel in the pack or the bank — can't cut. Re-decide.
      if (!hasChisel(player) && bankAmount(player, CHISEL_ITEM_ID) <= 0) {
        return "success";
      }

      // Gems in the pack? Cut the best of them.
      const recipe = bestInventoryRecipe(Crafting, player);
      if (recipe && hasChisel(player)) {
        if (state.withdrawing) stopWithdraw(state, ctx);
        return cutGems(ctx, state, Crafting, recipe);
      }

      // No gems in the pack — check the bank before giving up.
      const plan = bestBankPlan(Crafting, player);
      if (!plan) return "success"; // nothing to cut anywhere; re-decide
      return withdrawGems(ctx, state, plan);
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

  function withdrawGems(ctx, state, plan) {
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
      // gems and cutting resumes next tick, or the day moves on.
      stopWithdraw(state, ctx);
      return "running";
    }
    return "running";
  }

  function cutGems(ctx, state, Crafting, recipe) {
    const { player } = ctx;
    const amount = invAmount(player, recipe.uncutId);
    if (amount <= 0) return "running"; // pack changed; next tick re-decides
    // Same shape as upstream Smelt.js: hand the session to the skill plugin
    // directly — no interface clicking.
    try {
      const started = Crafting.startBotCrafting?.(player, amount);
      if (started) {
        try {
          world?.log?.("citizen_craft", {
            citizen: player.getUsername?.(),
            kingdom: kingdomIdOf(player),
            gem: recipe.uncutId,
            gems: amount,
          });
        } catch {
          // non-fatal
        }
      }
    } catch {
      // next tick retries
    }
    return "running";
  }

  return action;
}

module.exports = {
  createCitizenCraftAction,
  // exposed for tests
  _gemsFromInventory: gemsFromInventory,
  _bestInventoryRecipe: bestInventoryRecipe,
  _bestBankPlan: bestBankPlan,
  _craftableGems: craftableGems,
  _craftingLevel: craftingLevel,
  _hasChisel: hasChisel,
};
