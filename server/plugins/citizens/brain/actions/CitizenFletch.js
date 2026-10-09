"use strict";

/**
 * CitizenFletch — cut logs into arrow shafts and bows for real Fletching XP,
 * the RuneScape way.
 *
 * Citizens chop logs (woodcutting byproduct, bought from players, banked
 * from earlier trips). When the decision layer picks citizen_fletch, the
 * citizen works a full fletching run: withdraw logs from the bank when the
 * pack is empty (fetching a knife too if they don't carry one), then works
 * via the real Fletching plugin's bot entry point (startBotFletching) — the
 * same pattern upstream's Smelt.js uses. Real arrow shafts/bows land in the
 * inventory and real Fletching XP flows through SkillManager, so the
 * level-up celebration fires for citizens exactly as it does for players.
 *
 * Fletching is inventory work — no station needed, a citizen cuts wherever
 * they are. The work chains naturally from woodcutting: chop logs ->
 * fletch the best thing the level allows. The session always picks the
 * highest-level knife-on-logs recipe the citizen's level and logs allow,
 * and the brain re-decides between runs, so a citizen works their way up
 * the chain the way a human would.
 *
 * Flow per tick:
 *   - Fletching session already active (isFletchingActive) -> "running".
 *   - Best doable recipe from inventory -> start the bot session.
 *   - No workable logs in the pack but the bank holds some -> walk
 *     to the bank, widen via the shared bank action's withdraw, then cut
 *     next ticks.
 *   - No logs anywhere -> "success" (done, brain re-decides — likely
 *     woodcutting or trading).
 *   - Give up after GIVE_UP_MS so a bad bank day never stalls the day.
 *
 * Non-repeat: works one full fletching run, then the brain re-decides
 * (usually the bank hinge, since the pack is full of fresh shafts/bows).
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

// If no log gets cut in this long, the bank is cursed — move on.
const GIVE_UP_MS = 6 * 60 * 1000;
const BANK_ARRIVE_RADIUS = 8;

// Full pack target: knife-on-logs is 1 log per action, so 27 logs fills
// the pack honestly (knife rides along, not consumed).
const LOG_PACK_TARGET = 27;

function fletchingPlugin() {
  try {
    return require("../../../skills/Fletching.plugin");
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

/** Fletching level, 1 when unreadable (arrow-shaft-only — safe fallback). */
function fletchingLevel(player) {
  try {
    const Skill = require("../../../../src/main/typescript/elvarg/game/model/Skill")
      .Skill;
    const mgr = player.getSkillManager?.();
    if (!mgr || !Skill || typeof mgr.getCurrentLevel !== "function") return 1;
    const lvl = mgr.getCurrentLevel(Skill.FLETCHING);
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
 * Knife item id, resolved from the recipe table (the knife is the
 * non-consumed requirement on every log recipe).
 */
function knifeId(Fletching) {
  try {
    const recipes = Fletching?.FLETCHING_RECIPES ?? [];
    for (const r of recipes) {
      if (Number.isInteger(r?.needsId)) return r.needsId;
    }
  } catch {
    // fall through
  }
  return null;
}

function sortedRecipes(Fletching) {
  return [...(Fletching?.FLETCHING_RECIPES ?? [])].sort(
    (a, b) => (b.level ?? 0) - (a.level ?? 0)
  );
}

/**
 * Best recipe the citizen can work right now: highest level at or under
 * their level with the log in the pack (plus a knife). A human fletches
 * the best thing they've got the logs for.
 */
function bestInventoryRecipe(Fletching, player) {
  const level = fletchingLevel(player);
  const knife = knifeId(Fletching);
  if (!Number.isInteger(knife) || invAmount(player, knife) <= 0) return null;
  for (const recipe of sortedRecipes(Fletching)) {
    if ((recipe.level ?? 99) > level) continue;
    if (!Number.isInteger(recipe.inputId)) continue;
    if (invAmount(player, recipe.inputId) <= 0) continue;
    return recipe;
  }
  return null;
}

/**
 * Fletching work the inventory can currently do: logs of level-gated
 * recipes the citizen holds, provided a knife is in the pack.
 */
function fletchMaterialsFromInventory(Fletching, player) {
  const level = fletchingLevel(player);
  const knife = knifeId(Fletching);
  if (!Number.isInteger(knife) || invAmount(player, knife) <= 0) return 0;
  let total = 0;
  for (const recipe of sortedRecipes(Fletching)) {
    if ((recipe.level ?? 99) > level) continue;
    if (!Number.isInteger(recipe.inputId)) continue;
    total += invAmount(player, recipe.inputId);
  }
  return total;
}

function packTotal(player, itemId, target) {
  return Math.max(0, Math.min(target - invAmount(player, itemId), bankAmount(player, itemId)));
}

/**
 * Withdraw plan from the bank: best level-gated recipe achievable with
 * pack+bank combined. Tops the inventory toward a full fletching run —
 * 27 logs — and fetches a knife if the citizen doesn't carry one. No knife
 * in pack or bank means no plan: a knife is non-negotiable.
 */
function bestBankPlan(Fletching, player) {
  const level = fletchingLevel(player);
  const knife = knifeId(Fletching);
  const hasKnifeInPack = Number.isInteger(knife) && invAmount(player, knife) > 0;
  const hasKnifeInBank = Number.isInteger(knife) && bankAmount(player, knife) > 0;
  if (!hasKnifeInPack && !hasKnifeInBank) return null;
  for (const recipe of sortedRecipes(Fletching)) {
    if ((recipe.level ?? 99) > level) continue;
    if (!Number.isInteger(recipe.inputId)) continue;
    const inputAvail =
      invAmount(player, recipe.inputId) + bankAmount(player, recipe.inputId);
    if (inputAvail < 1) continue;
    const withdraw = [];
    const take = packTotal(player, recipe.inputId, LOG_PACK_TARGET);
    if (take >= 1) {
      withdraw.push({
        item: recipe.inputId,
        amount: invAmount(player, recipe.inputId) + take,
      });
    }
    if (
      Number.isInteger(knife) &&
      invAmount(player, knife) <= 0 &&
      bankAmount(player, knife) >= 1
    ) {
      withdraw.push({ item: knife, amount: 1 });
    }
    if (!withdraw.length) continue;
    return { recipe, withdraw };
  }
  return null;
}

/**
 * Cheapest honest answer to "does this citizen have logs to fletch?":
 * logs-worth of work, pack first, then bank. A missing knife zeroes it —
 * no knife, no fletching.
 */
function fletchMaterials(Fletching, player) {
  const inv = fletchMaterialsFromInventory(Fletching, player);
  if (inv > 0) return inv;
  const plan = bestBankPlan(Fletching, player);
  if (!plan) return 0;
  return (
    invAmount(player, plan.recipe.inputId) +
    bankAmount(player, plan.recipe.inputId)
  );
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
  // Personal spot near the bank — the fletching crew shouldn't stack.
  const spot = personalSpot(username, tile.x, tile.y, 4, 10);
  try {
    requestMovement(player, spot.x, spot.y, {
      reason: "citizen_fletch_bank",
      basicPather: true,
      z: tile.z ?? 0,
    });
    return true;
  } catch {
    return false;
  }
}

function createCitizenFletchAction(spec, world) {
  function botState(player) {
    return playerState(action, player, () => {
      const personality = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
      return {
        rng: agentRng(`fletch:${player.getUsername?.() ?? "unknown"}`),
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
    id: "citizenFletch",
    update(ctx) {
      const { player, nowMs } = ctx;
      const Fletching = fletchingPlugin();
      if (!Fletching?.startBotFletching) {
        return "failed"; // Fletching plugin not loaded
      }
      const state = botState(player);
      if (!state.giveUpAt) {
        state.giveUpAt = nowMs + GIVE_UP_MS;
      }
      if (nowMs >= state.giveUpAt) {
        stopWithdraw(state, ctx);
        return "success"; // bad bank day — move on, don't stall
      }

      // A fletching session is already running — wait it out.
      let active = false;
      try {
        active = Fletching.isFletchingActive?.(player) === true;
      } catch {
        active = false;
      }
      if (active) return "running";

      // Workable logs in the pack? Cut the best of them.
      const recipe = bestInventoryRecipe(Fletching, player);
      if (recipe) {
        if (state.withdrawing) stopWithdraw(state, ctx);
        return workLogs(ctx, state, Fletching, recipe);
      }

      // No workable logs in the pack — check the bank before giving up.
      const plan = bestBankPlan(Fletching, player);
      if (!plan) return "success"; // nothing to cut anywhere; re-decide
      return withdrawLogs(ctx, state, plan);
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

  function withdrawLogs(ctx, state, plan) {
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
      // logs and cutting resumes next tick, or the day moves on.
      stopWithdraw(state, ctx);
      return "running";
    }
    return "running";
  }

  function workLogs(ctx, state, Fletching, recipe) {
    const { player } = ctx;
    const amount = invAmount(player, recipe.inputId);
    if (amount <= 0) return "running"; // pack changed; next tick re-decides
    // Same shape as upstream Smelt.js: hand the session to the skill plugin
    // directly — no interface clicking.
    try {
      const started = Fletching.startBotFletching?.(player, amount);
      if (started) {
        try {
          world?.log?.("citizen_fletch", {
            citizen: player.getUsername?.(),
            kingdom: kingdomIdOf(player),
            input: recipe.inputId,
            output: recipe.outputId,
            items: amount,
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
  createCitizenFletchAction,
  // exposed for tests
  _fletchMaterialsFromInventory: fletchMaterialsFromInventory,
  _bestInventoryRecipe: bestInventoryRecipe,
  _bestBankPlan: bestBankPlan,
  _fletchMaterials: fletchMaterials,
  _fletchingLevel: fletchingLevel,
  _knifeId: knifeId,
};
