"use strict";

/**
 * CitizenHerb — clean herbs and mix potions for real Herblore XP, the
 * RuneScape way.
 *
 * Citizens pick up grimy herbs (farming byproduct, bought from players,
 * banked from earlier trips). When the decision layer picks citizen_herb,
 * the citizen works a full herblore run: withdraw herbs, vials of water,
 * and secondaries from the bank when the pack is empty, then works via
 * the real Herblore plugin's bot entry point (startBotHerblore) — the same
 * pattern upstream's Smelt.js uses. Real potions land in the inventory and
 * real Herblore XP flows through SkillManager, so the level-up celebration
 * fires for citizens exactly as it does for players.
 *
 * Herblore is inventory work — no station needed, a citizen mixes wherever
 * they are. The work chains naturally: clean grimy herbs -> mix unfinished
 * potions -> finish potions with secondaries. The session always picks the
 * highest-tier work the citizen's level and materials allow (finishing
 * beats starting beats cleaning at the same level), and the brain
 * re-decides between runs, so a citizen works their way up the chain the
 * way a human would.
 *
 * Flow per tick:
 *   - Herblore session already active (isHerbloreActive) -> "running".
 *   - Best doable recipe from inventory -> start the bot session.
 *   - No workable materials in the pack but the bank holds some -> walk
 *     to the bank, widen via the shared bank action's withdraw, then mix
 *     next ticks.
 *   - No herbs anywhere -> "success" (done, brain re-decides — likely
 *     farming or trading).
 *   - Give up after GIVE_UP_MS so a bad bank day never stalls the day.
 *
 * Non-repeat: works one full herblore run, then the brain re-decides
 * (usually the bank hinge, since the pack is full of fresh potions).
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

// If no herb gets worked in this long, the bank is cursed — move on.
const GIVE_UP_MS = 6 * 60 * 1000;
const BANK_ARRIVE_RADIUS = 8;

// Full pack targets: cleaning needs nothing else, so 27 grimy; mixing
// needs a 1:1 partner, so 14+14 fills the pack honestly.
const CLEAN_PACK_TARGET = 27;
const MIX_PACK_TARGET = 14;

// A human finishes a potion before starting a new one, and starts one
// before cleaning — same-level ties break toward the higher-tier work.
const KIND_PRIORITY = { clean: 1, unfinished: 2, finished: 3 };

function herblorePlugin() {
  try {
    return require("../../../skills/Herblore.plugin");
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

/** Herblore level, 1 when unreadable (guam-only — safe fallback). */
function herbloreLevel(player) {
  try {
    const Skill = require("../../../../src/main/typescript/elvarg/game/model/Skill")
      .Skill;
    const mgr = player.getSkillManager?.();
    if (!mgr || !Skill || typeof mgr.getCurrentLevel !== "function") return 1;
    const lvl = mgr.getCurrentLevel(Skill.HERBLORE);
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

function sortedRecipes(Herblore) {
  return [...(Herblore?.HERBLORE_RECIPES ?? [])].sort(
    (a, b) =>
      b.level - a.level ||
      (KIND_PRIORITY[b.kind] ?? 0) - (KIND_PRIORITY[a.kind] ?? 0)
  );
}

/**
 * Best recipe the citizen can work right now: highest level at or under
 * their level with the input in the pack (plus the needs-item for mixing).
 * A human mixes the best potion they've got the stuff for.
 */
function bestInventoryRecipe(Herblore, player) {
  const level = herbloreLevel(player);
  for (const recipe of sortedRecipes(Herblore)) {
    if ((recipe.level ?? 99) > level) continue;
    if (invAmount(player, recipe.inputId) <= 0) continue;
    if (recipe.needsId && invAmount(player, recipe.needsId) <= 0) continue;
    return recipe;
  }
  return null;
}

/**
 * Herblore work the inventory can currently do: inputs of level-gated
 * recipes whose partner item (vial/secondary) is also in the pack.
 * Grimy herbs count on their own — cleaning needs nothing.
 */
function herbMaterialsFromInventory(Herblore, player) {
  const level = herbloreLevel(player);
  let total = 0;
  for (const recipe of sortedRecipes(Herblore)) {
    if ((recipe.level ?? 99) > level) continue;
    if (recipe.needsId && invAmount(player, recipe.needsId) <= 0) continue;
    total += invAmount(player, recipe.inputId);
  }
  return total;
}

function packTotal(player, itemId, target) {
  return Math.max(0, Math.min(target - invAmount(player, itemId), bankAmount(player, itemId)));
}

/**
 * Withdraw plan from the bank: best level-gated recipe achievable with
 * pack+bank combined. Tops the inventory toward a full herblore run —
 * cleaning takes 27 grimy, mixing takes 14+14 of herb and partner.
 */
function bestBankPlan(Herblore, player) {
  const level = herbloreLevel(player);
  for (const recipe of sortedRecipes(Herblore)) {
    if ((recipe.level ?? 99) > level) continue;
    const inputAvail =
      invAmount(player, recipe.inputId) + bankAmount(player, recipe.inputId);
    if (inputAvail < 1) continue;
    if (
      recipe.needsId &&
      invAmount(player, recipe.needsId) + bankAmount(player, recipe.needsId) < 1
    ) {
      continue;
    }
    const withdraw = [];
    if (recipe.kind === "clean") {
      const take = packTotal(player, recipe.inputId, CLEAN_PACK_TARGET);
      if (take >= 1) {
        withdraw.push({
          item: recipe.inputId,
          amount: invAmount(player, recipe.inputId) + take,
        });
      }
    } else {
      const takeInput = packTotal(player, recipe.inputId, MIX_PACK_TARGET);
      const takeNeeds = packTotal(player, recipe.needsId, MIX_PACK_TARGET);
      if (takeInput >= 1) {
        withdraw.push({
          item: recipe.inputId,
          amount: invAmount(player, recipe.inputId) + takeInput,
        });
      }
      if (takeNeeds >= 1) {
        withdraw.push({
          item: recipe.needsId,
          amount: invAmount(player, recipe.needsId) + takeNeeds,
        });
      }
    }
    if (!withdraw.length) continue;
    return { recipe, withdraw };
  }
  return null;
}

/**
 * Cheapest honest answer to "does this citizen have herbs to work?":
 * potions-worth of work, pack first, then bank.
 */
function herbMaterials(Herblore, player) {
  const inv = herbMaterialsFromInventory(Herblore, player);
  if (inv > 0) return inv;
  const plan = bestBankPlan(Herblore, player);
  if (!plan) return 0;
  const { recipe } = plan;
  const inputTotal =
    invAmount(player, recipe.inputId) + bankAmount(player, recipe.inputId);
  if (!recipe.needsId) return inputTotal;
  const needsTotal =
    invAmount(player, recipe.needsId) + bankAmount(player, recipe.needsId);
  return Math.min(inputTotal, needsTotal);
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
  // Personal spot near the bank — the herb crew shouldn't stack on one tile.
  const spot = personalSpot(username, tile.x, tile.y, 4, 10);
  try {
    requestMovement(player, spot.x, spot.y, {
      reason: "citizen_herb_bank",
      basicPather: true,
      z: tile.z ?? 0,
    });
    return true;
  } catch {
    return false;
  }
}

function createCitizenHerbAction(spec, world) {
  function botState(player) {
    return playerState(action, player, () => {
      const personality = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
      return {
        rng: agentRng(`herb:${player.getUsername?.() ?? "unknown"}`),
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
    id: "citizenHerb",
    update(ctx) {
      const { player, nowMs } = ctx;
      const Herblore = herblorePlugin();
      if (!Herblore?.startBotHerblore) {
        return "failed"; // Herblore plugin not loaded
      }
      const state = botState(player);
      if (!state.giveUpAt) {
        state.giveUpAt = nowMs + GIVE_UP_MS;
      }
      if (nowMs >= state.giveUpAt) {
        stopWithdraw(state, ctx);
        return "success"; // bad bank day — move on, don't stall
      }

      // A herblore session is already running — wait it out.
      let active = false;
      try {
        active = Herblore.isHerbloreActive?.(player) === true;
      } catch {
        active = false;
      }
      if (active) return "running";

      // Workable herbs in the pack? Work the best of them.
      const recipe = bestInventoryRecipe(Herblore, player);
      if (recipe) {
        if (state.withdrawing) stopWithdraw(state, ctx);
        return workHerbs(ctx, state, Herblore, recipe);
      }

      // No workable herbs in the pack — check the bank before giving up.
      const plan = bestBankPlan(Herblore, player);
      if (!plan) return "success"; // nothing to mix anywhere; re-decide
      return withdrawHerbs(ctx, state, plan);
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

  function withdrawHerbs(ctx, state, plan) {
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
      // herbs and mixing resumes next tick, or the day moves on.
      stopWithdraw(state, ctx);
      return "running";
    }
    return "running";
  }

  function workHerbs(ctx, state, Herblore, recipe) {
    const { player } = ctx;
    const amount = recipe.needsId
      ? Math.min(invAmount(player, recipe.inputId), invAmount(player, recipe.needsId))
      : invAmount(player, recipe.inputId);
    if (amount <= 0) return "running"; // pack changed; next tick re-decides
    // Same shape as upstream Smelt.js: hand the session to the skill plugin
    // directly — no interface clicking.
    try {
      const started = Herblore.startBotHerblore?.(player, amount);
      if (started) {
        try {
          world?.log?.("citizen_herb", {
            citizen: player.getUsername?.(),
            kingdom: kingdomIdOf(player),
            kind: recipe.kind,
            input: recipe.inputId,
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
  createCitizenHerbAction,
  // exposed for tests
  _herbMaterialsFromInventory: herbMaterialsFromInventory,
  _bestInventoryRecipe: bestInventoryRecipe,
  _bestBankPlan: bestBankPlan,
  _herbMaterials: herbMaterials,
  _herbloreLevel: herbloreLevel,
};
