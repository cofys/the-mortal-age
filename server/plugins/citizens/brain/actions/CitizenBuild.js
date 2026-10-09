"use strict";

/**
 * CitizenBuild — carpentry: build real furniture from real planks for real
 * Construction XP, the RuneScape way.
 *
 * Citizens with a hammer and saw work as carpenters: they pick the best
 * furniture their Construction level allows, fetch planks and nails from
 * the bank when the pack runs dry, and build via the real Construction
 * plugin's bot entry point (buildFurnitureBot) — the same pattern upstream's
 * Smelt.js uses. Materials are really deleted, the furniture item really
 * lands in the inventory, and real Construction XP flows through
 * SkillManager, so the level-up celebration fires for citizens exactly as
 * it does for players.
 *
 * Ties to the housing system (lib/CitizenHomes.js): the carpenter trade is
 * what crafts the furniture citizens furnish their homes with. Carpenters
 * bank what they build and it enters the trade economy; citizens whose own
 * home still has empty furniture slots lean into building first (see the
 * decision-layer scoring).
 *
 * Flow per tick:
 *   - Inventory full -> walk to bank, deposit, continue.
 *   - Best buildable from pack materials -> build it, human-paced.
 *   - Pack dry -> walk to bank, withdraw planks + nails (+ tools if the
 *     bank has them), continue.
 *   - Nothing buildable anywhere -> "success" (done, brain re-decides).
 *   - Give up after GIVE_UP_MS so a bad carpentry day never stalls the day.
 *
 * Non-repeat: works one carpentry run, then the brain re-decides.
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

// If nothing gets built in this long, the timber yard is cursed — move on.
const GIVE_UP_MS = 10 * 60 * 1000;
const BANK_ARRIVE_RADIUS = 8;
// Human pacing between builds — slower than a metronome.
const BUILD_COOLDOWN_MS = 8000;
// Pack space reserved for tools + finished furniture while fetching timber.
const PACK_RESERVE_SLOTS = 4;

function constructionPlugin() {
  try {
    return require("../../../skills/Construction.plugin");
  } catch {
    return null;
  }
}

function bankApi() {
  try {
    return require("../../../src/main/typescript/elvarg/game/model/container/impl/Bank")
      .Bank;
  } catch {
    return null;
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
    // fall through
  }
  return total;
}

function invFull(player) {
  try {
    return player.getInventory?.()?.isFull?.() === true;
  } catch {
    return false;
  }
}

/** Construction level, 1 when unreadable (crude-chair-only — safe fallback). */
function buildLevel(player) {
  try {
    const Construction = constructionPlugin();
    if (Construction?.constructionLevel) return Construction.constructionLevel(player);
  } catch {
    // fall through
  }
  return 1;
}

function hasTools(player, Construction) {
  const hammer = Construction?.HAMMER_ID ?? 2347;
  const saw = Construction?.SAW_ID ?? 8794;
  return invAmount(player, hammer) > 0 && invAmount(player, saw) > 0;
}

/**
 * Withdraw plan from the bank: best level-gated furniture the bank's
 * planks can supply. Tops the pack toward a full building run (filling
 * every free slot past the reserve with planks), matches nails to the
 * planks, and fetches a hammer/saw when the citizen doesn't carry them.
 */
function bestBankPlan(Construction, player) {
  const recipes = [...(Construction?.CONSTRUCTION_RECIPES ?? [])].sort(
    (a, b) => (b.level ?? 0) - (a.level ?? 0)
  );
  const level = buildLevel(player);
  const hammer = Construction?.HAMMER_ID ?? 2347;
  const saw = Construction?.SAW_ID ?? 8794;
  const nail = Construction?.NAIL_ID ?? 4819;
  for (const recipe of recipes) {
    if ((recipe.level ?? 99) > level) continue;
    const plankId = recipe.materials?.[0]?.[0];
    const planksPer = recipe.materials?.[0]?.[1] ?? 1;
    const nailsPer = recipe.materials?.[1]?.[1] ?? 0;
    if (!plankId || planksPer < 1) continue;
    const freeSlots = freeSlotsOf(player);
    const want = Math.max(1, freeSlots - PACK_RESERVE_SLOTS);
    const take = Math.min(want, bankAmount(player, plankId));
    if (take < planksPer) continue; // not even one build's worth
    const builds = Math.floor(take / planksPer);
    const withdraw = [
      {
        item: plankId,
        amount: invAmount(player, plankId) + builds * planksPer,
      },
    ];
    if (nailsPer > 0) {
      const nailTake = Math.min(
        builds * nailsPer,
        bankAmount(player, nail)
      );
      if (nailTake >= nailsPer) {
        withdraw.push({
          item: nail,
          amount: invAmount(player, nail) + nailTake,
        });
      }
    }
    if (invAmount(player, hammer) <= 0 && bankAmount(player, hammer) > 0) {
      withdraw.push({ item: hammer, amount: 1 });
    }
    if (invAmount(player, saw) <= 0 && bankAmount(player, saw) > 0) {
      withdraw.push({ item: saw, amount: 1 });
    }
    return { recipe, withdraw };
  }
  return null;
}

/**
 * Cheapest honest answer to "does this citizen have furniture to build?"
 * Pack materials first, then what a bank run could supply.
 */
function buildableFurniture(Construction, player) {
  const best = bestPackBuildable(Construction, player);
  if (best) return best;
  const plan = bestBankPlan(Construction, player);
  return plan ? plan.recipe : null;
}

function bestPackBuildable(Construction, player) {
  try {
    return Construction?.findBestBuildable?.(player) ?? null;
  } catch {
    return null;
  }
}

function freeSlotsOf(player) {
  try {
    const inv = player.getInventory?.();
    if (!inv) return 0;
    if (typeof inv.getFreeSlots === "function") return inv.getFreeSlots();
    if (typeof inv.freeSlots === "number") return inv.freeSlots;
    return 0;
  } catch {
    return 0;
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

function walkTo(player, x, y, z, reason, spread = 4) {
  const username = player.getUsername?.() ?? "unknown";
  const spot = personalSpot(username, x, y, spread, 10);
  try {
    requestMovement(player, spot.x, spot.y, {
      reason,
      basicPather: true,
      z: z ?? 0,
    });
    return true;
  } catch {
    return false;
  }
}

function createCitizenBuildAction(spec, world) {
  function botState(player) {
    return playerState(action, player, () => {
      const personality = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
      return {
        rng: agentRng(`build:${player.getUsername?.() ?? "unknown"}`),
        human: humanizerProfile(personality),
        giveUpAt: 0,
        banking: false,
        bankDelegate: null,
        withdrawing: false,
        withdrawDelegate: null,
        lastBuildAt: 0,
      };
    });
  }

  function stopBanking(state, ctx) {
    try {
      state.bankDelegate?.stop?.(ctx);
    } catch {
      // best effort
    }
    state.bankDelegate = null;
    state.banking = false;
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
    id: "citizenBuild",
    update(ctx) {
      const { player, nowMs } = ctx;
      const Construction = constructionPlugin();
      if (!Construction?.buildFurnitureBot) {
        return "failed"; // Construction plugin not loaded
      }
      const state = botState(player);
      if (!state.giveUpAt) state.giveUpAt = nowMs + GIVE_UP_MS;
      if (nowMs >= state.giveUpAt) {
        stopBanking(state, ctx);
        stopWithdraw(state, ctx);
        return "success"; // bad carpentry day — move on, don't stall
      }

      // Pockets full of finished furniture — bank it, then keep building.
      if (invFull(player)) {
        return bankFurniture(ctx, state);
      }
      if (state.banking) stopBanking(state, ctx);

      // Mid-withdrawal — let the bank delegate finish.
      if (state.withdrawing) {
        const plan = state.withdrawPlan;
        return withdrawMaterials(ctx, state, plan);
      }

      // Build the best furniture the pack materials cover.
      const best = bestPackBuildable(Construction, player);
      if (best) {
        return buildPiece(ctx, state, Construction, best);
      }

      // Pack's dry — fetch timber (and nails/tools) from the bank.
      const plan = bestBankPlan(Construction, player);
      if (!plan) return "success"; // nothing to build anywhere; re-decide
      return withdrawMaterials(ctx, state, plan);
    },
    stop(ctx) {
      try {
        const player = ctx?.player;
        if (player) {
          const st = playerState(action, player, () => null);
          if (st) {
            try {
              st.bankDelegate?.stop?.(ctx);
            } catch {
              // best effort
            }
            try {
              st.withdrawDelegate?.stop?.(ctx);
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

  function buildPiece(ctx, state, Construction, recipe) {
    const { player, nowMs } = ctx;
    // Pace the builds like a human, not a metronome — but the first build
    // of the run starts right away (lastBuildAt 0 = never built).
    if (state.lastBuildAt > 0 && nowMs - state.lastBuildAt < BUILD_COOLDOWN_MS)
      return "running";
    let result = null;
    try {
      result = Construction.buildFurnitureBot(player, recipe.key);
    } catch {
      result = { ok: false, reason: "error" };
    }
    state.lastBuildAt = nowMs;
    if (!result?.ok) {
      if (result?.reason === "materials" || result?.reason === "tools") {
        // Pack changed under us — the next tick re-decides (bank or done).
        return "running";
      }
      return "running"; // level/unknown — next tick re-evaluates
    }
    try {
      world?.log?.("citizen_build", {
        citizen: player.getUsername?.(),
        kingdom: kingdomIdOf(player),
        piece: recipe.name,
        xp: result.xp,
      });
    } catch {
      // non-fatal
    }
    return "running";
  }

  function bankFurniture(ctx, state) {
    const { player } = ctx;
    const bank = siteTile(player, "bank");
    if (!bank) {
      stopBanking(state, ctx);
      return "success"; // nowhere to stash it — call it a day
    }
    if (!state.banking) {
      if (!atTile(player, bank, BANK_ARRIVE_RADIUS)) {
        walkTo(player, bank.x, bank.y, bank.z, "citizen_build_bank");
        return "running";
      }
      state.banking = true;
      // Deposit everything — carpenters travel light; finished furniture
      // sells from the bank through the trade economy.
      state.bankDelegate = createBankAction({ deposit: "all" }, world);
    }
    let result = "running";
    try {
      result = state.bankDelegate.update(ctx);
    } catch {
      result = "failed";
    }
    if (result === "success" || result === "failed") {
      stopBanking(state, ctx);
      return "running";
    }
    return "running";
  }

  function withdrawMaterials(ctx, state, plan) {
    const { player } = ctx;
    const bank = siteTile(player, "bank");
    if (!bank) {
      stopWithdraw(state, ctx);
      return "failed"; // no bank anchor for this kingdom
    }
    if (!state.withdrawing) {
      if (!atTile(player, bank, BANK_ARRIVE_RADIUS)) {
        walkTo(player, bank.x, bank.y, bank.z, "citizen_build_withdraw");
        return "running";
      }
      state.withdrawing = true;
      state.withdrawPlan = plan;
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
      // timber and building resumes next tick, or the day moves on.
      stopWithdraw(state, ctx);
      return "running";
    }
    return "running";
  }

  return action;
}

module.exports = {
  createCitizenBuildAction,
  // exposed for tests
  _buildLevel: buildLevel,
  _hasTools: hasTools,
  _bestBankPlan: bestBankPlan,
  _buildableFurniture: buildableFurniture,
  _invAmount: invAmount,
  _bankAmount: bankAmount,
  BUILD_COOLDOWN_MS,
  GIVE_UP_MS,
};
