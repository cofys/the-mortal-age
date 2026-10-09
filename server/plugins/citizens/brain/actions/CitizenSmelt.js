"use strict";

/**
 * CitizenSmelt — smelt ore into bars for real Smithing XP, the RuneScape way.
 *
 * Citizens accumulate ore (mining, bought from players, banked from earlier
 * trips). When the decision layer picks citizen_smelt, the citizen works a
 * full smelt run: withdraw ore from the bank when the pack is empty, walk to
 * the nearest furnace, and smelt via the real Smithing plugin's bot entry
 * point (startBotSmelting) — the same path upstream's Smelt.js uses. Real
 * bars land in the inventory and real Smithing XP flows through SkillManager,
 * so the level-up celebration fires for citizens exactly as it does for
 * players.
 *
 * Flow per tick:
 *   - Smelting already active (isSmeltingActive) -> "running", wait it out.
 *   - Best smeltable recipe from inventory -> walk to furnace / smelt it.
 *   - No ore in the pack but the bank holds some -> walk to the bank, widen
 *     via the shared bank action's withdraw, then smelt next ticks.
 *   - No ore anywhere -> "success" (done, brain re-decides — likely mining).
 *   - No furnace in the area -> "failed" (cooldown, don't spin).
 *   - Give up after GIVE_UP_MS so a bad spot never stalls the day.
 *
 * Non-repeat: works one full smelt run, then the brain re-decides (usually
 * the bank hinge, since the pack is full of fresh bars).
 *
 * Zero LLM. Tick-safe: every engine read guarded, per-action try/catch in
 * the brain.
 */

const { playerState } = require("../../../bots/brain/ActionState");
const {
  requestMovement,
  clearMovementRequest,
  approachObject,
} = require("../../../bots/behaviours/navigation/BotNavigation");
const { createBankAction } = require("../../../bots/brain/actions/Bank");
const {
  resolveCatalogObjectIds,
} = require("../../../bots/brain/BotObjectCatalog");
const { siteTile, kingdomIdOf } = require("../CitizenSites");
const { ATTR_CITIZEN_PERSONALITY } = require("../../constants");
const {
  agentRng,
  personalSpot,
  humanizerProfile,
} = require("../../lib/humanizer");

// If no bar gets smelted in this long, the furnace/bank is cursed — move on.
const GIVE_UP_MS = 6 * 60 * 1000;
// Mirror upstream Smelt.js: the pathfinder only routes inside a small window.
const MAX_DIRECT_ROUTE_TILES = 20;
const INTERACT_COOLDOWN_MS = 1500;
const BANK_ARRIVE_RADIUS = 8;

function smithingPlugin() {
  try {
    return require("../../../skills/Smithing.plugin");
  } catch {
    return null;
  }
}

function skillEnum() {
  try {
    return require("../../../src/main/typescript/elvarg/game/model/Skill")
      .Skill;
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

let FURNACE_IDS = null;
function furnaceIds(Smithing) {
  if (FURNACE_IDS) return FURNACE_IDS;
  try {
    if (Array.isArray(Smithing?.FURNACE_OBJECT_IDS)) {
      FURNACE_IDS = Object.freeze([...Smithing.FURNACE_OBJECT_IDS]);
      return FURNACE_IDS;
    }
  } catch {
    // fall through to the catalog
  }
  try {
    FURNACE_IDS = Object.freeze(
      resolveCatalogObjectIds({ catalog: "furnace" })
    );
  } catch {
    FURNACE_IDS = Object.freeze([]);
  }
  return FURNACE_IDS;
}

/** Smithing level, 1 when unreadable (bronze-only — safe fallback). */
function smithingLevel(player) {
  try {
    const mgr = player.getSkillManager?.();
    const Skill = skillEnum();
    if (!mgr || !Skill || typeof mgr.getCurrentLevel !== "function") return 1;
    const lvl = mgr.getCurrentLevel(Skill.SMITHING);
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

/** Total of itemId across all bank tabs (bounded, early-exits never needed). */
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

/** Bars of recipe the inventory can currently produce. */
function barsFromInventory(player, recipe) {
  if (!recipe?.ingredients?.length) return 0;
  let bars = Number.MAX_SAFE_INTEGER;
  for (const [itemId, perBar] of recipe.ingredients) {
    if (!Number.isInteger(itemId) || !Number.isInteger(perBar) || perBar <= 0) {
      return 0;
    }
    bars = Math.min(bars, Math.floor(invAmount(player, itemId) / perBar));
  }
  return bars === Number.MAX_SAFE_INTEGER ? 0 : bars;
}

/**
 * Best recipe the citizen can smelt right now: highest Smithing level at or
 * under their level with ingredients for at least one bar in the pack.
 * A human smelts the best ore they've got.
 */
function bestInventoryRecipe(Smithing, player) {
  const recipes = [...(Smithing?.SMELTING_RECIPES ?? [])].sort(
    (a, b) => (b.level ?? 0) - (a.level ?? 0)
  );
  const level = smithingLevel(player);
  for (const recipe of recipes) {
    if ((recipe.level ?? 99) > level) continue;
    const bars = barsFromInventory(player, recipe);
    if (bars > 0) return { recipe, bars };
  }
  return null;
}

/**
 * Withdraw plan from the bank: best level-gated recipe the bank can supply
 * for at least one bar. Amounts top the inventory up toward a full smelt run
 * (28 slots, like a player filling the pack before the furnace trip).
 */
function bestBankPlan(Smithing, player) {
  const recipes = [...(Smithing?.SMELTING_RECIPES ?? [])].sort(
    (a, b) => (b.level ?? 0) - (a.level ?? 0)
  );
  const level = smithingLevel(player);
  for (const recipe of recipes) {
    if ((recipe.level ?? 99) > level) continue;
    const slotsPerBar = recipe.ingredients.reduce(
      (n, [, perBar]) => n + (Number.isInteger(perBar) ? perBar : 0),
      0
    );
    if (slotsPerBar <= 0) continue;
    const targetBars = Math.max(1, Math.floor(28 / slotsPerBar));
    let bankBars = Number.MAX_SAFE_INTEGER;
    const withdraw = [];
    let viable = true;
    for (const [itemId, perBar] of recipe.ingredients) {
      if (!Number.isInteger(itemId) || !Number.isInteger(perBar) || perBar <= 0) {
        viable = false;
        break;
      }
      const want = perBar * targetBars;
      const have = invAmount(player, itemId);
      const inBank = bankAmount(player, itemId);
      const take = Math.min(Math.max(0, want - have), inBank);
      bankBars = Math.min(bankBars, Math.floor((have + take) / perBar));
      withdraw.push({ item: itemId, amount: have + take });
    }
    if (!viable) continue;
    if (bankBars >= 1) return { recipe, withdraw };
  }
  return null;
}

/** Cheapest honest answer to "does this citizen have ore to smelt?" */
function smeltableBars(Smithing, player) {
  const inv = bestInventoryRecipe(Smithing, player);
  if (inv) return inv.bars;
  const plan = bestBankPlan(Smithing, player);
  if (!plan) return 0;
  let bars = Number.MAX_SAFE_INTEGER;
  for (const [itemId, perBar] of plan.recipe.ingredients) {
    bars = Math.min(
      bars,
      Math.floor((invAmount(player, itemId) + bankAmount(player, itemId)) / perBar)
    );
  }
  return bars === Number.MAX_SAFE_INTEGER ? 0 : bars;
}

function findFurnace(world, player, Smithing) {
  try {
    const loc = player.getLocation?.();
    if (!loc) return null;
    const ids = furnaceIds(Smithing);
    if (!ids.length) return null;
    const candidates =
      world?.objectSearch?.findCandidatesByIds?.(player, ids, {
        regionRadius: 2,
        z: loc.getZ?.(),
        privateArea: player.getPrivateArea?.() ?? null,
      }) ?? [];
    let best = null;
    let bestDistSq = Number.MAX_SAFE_INTEGER;
    for (const object of candidates) {
      const objectLoc = object?.getLocation?.();
      if (!objectLoc || objectLoc.getZ?.() !== loc.getZ?.()) continue;
      const dx = objectLoc.getX() - loc.getX();
      const dy = objectLoc.getY() - loc.getY();
      const distSq = dx * dx + dy * dy;
      if (distSq < bestDistSq) {
        bestDistSq = distSq;
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
  // Personal spot near the bank — the smelt crew shouldn't stack on one tile.
  const spot = personalSpot(username, tile.x, tile.y, 4, 10);
  try {
    requestMovement(player, spot.x, spot.y, {
      reason: "citizen_smelt_bank",
      basicPather: true,
      z: tile.z ?? 0,
    });
    return true;
  } catch {
    return false;
  }
}

function createCitizenSmeltAction(spec, world) {
  function botState(player) {
    return playerState(action, player, () => {
      const personality = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
      return {
        rng: agentRng(`smelt:${player.getUsername?.() ?? "unknown"}`),
        human: humanizerProfile(personality),
        giveUpAt: 0,
        lastClickAt: 0,
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
    id: "citizenSmelt",
    update(ctx) {
      const { player, nowMs } = ctx;
      const Smithing = smithingPlugin();
      if (!Smithing?.startBotSmelting) {
        return "failed"; // Smithing plugin not loaded
      }
      const state = botState(player);
      if (!state.giveUpAt) {
        state.giveUpAt = nowMs + GIVE_UP_MS;
      }
      if (nowMs >= state.giveUpAt) {
        stopWithdraw(state, ctx);
        return "success"; // bad furnace/bank day — move on, don't stall
      }

      // A batch is already smelting — wait it out.
      let active = false;
      try {
        active = Smithing.isSmeltingActive?.(player) === true;
      } catch {
        active = false;
      }
      if (active) return "running";

      // Ore in the pack? Smelt the best of it.
      const pick = bestInventoryRecipe(Smithing, player);
      if (pick) {
        if (state.withdrawing) stopWithdraw(state, ctx);
        return smeltAtFurnace(ctx, state, Smithing, pick);
      }

      // No ore in the pack — check the bank before giving up.
      const plan = bestBankPlan(Smithing, player);
      if (!plan) return "success"; // nothing to smelt anywhere; re-decide
      return withdrawOre(ctx, state, plan);
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

  function withdrawOre(ctx, state, plan) {
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
      // ore and smelting resumes next tick, or the day moves on.
      stopWithdraw(state, ctx);
      return "running";
    }
    return "running";
  }

  function smeltAtFurnace(ctx, state, Smithing, pick) {
    const { player, nowMs } = ctx;
    const { recipe } = pick;
    const furnace = findFurnace(world, player, Smithing);
    if (!furnace) {
      return "failed"; // no furnace in the area — cooldown, don't spin
    }
    let furnaceLoc = null;
    let playerLoc = null;
    try {
      furnaceLoc = furnace.getLocation();
      playerLoc = player.getLocation();
    } catch {
      return "running";
    }
    if (!furnaceLoc || !playerLoc) return "running";
    const distance = Math.max(
      Math.abs(playerLoc.getX() - furnaceLoc.getX()),
      Math.abs(playerLoc.getY() - furnaceLoc.getY())
    );
    if (distance > MAX_DIRECT_ROUTE_TILES) {
      try {
        approachObject(player, furnace, {
          nowMs,
          reason: "citizen_furnace_approach",
        });
      } catch {
        // fall through; next tick retries
      }
      return "running";
    }
    // Let in-flight movement finish first.
    try {
      if (player.getForceMovement?.() != null) return "running";
      if (player.getMovementQueue?.()?.size?.() > 0) return "running";
    } catch {
      // fall through and try the smelt
    }
    if (nowMs - state.lastClickAt < INTERACT_COOLDOWN_MS) {
      return "running";
    }
    state.lastClickAt = nowMs;
    // Same shape as upstream Smelt.js: walk into range, then fire the real
    // object interaction and start the bot smelting session directly.
    try {
      const queue = player.getMovementQueue?.();
      if (!queue) return "running";
      queue.walkToObject(furnace, {
        execute: () => {
          try {
            world.emitObjectInteraction?.({
              player,
              object: furnace,
              objectId: furnace.getId(),
              clickType: 1,
              location: {
                x: furnaceLoc.getX(),
                y: furnaceLoc.getY(),
                z: furnaceLoc.getZ(),
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
            const available = barsFromInventory(player, recipe);
            if (available > 0) {
              const started = Smithing.startBotSmelting?.(
                player,
                recipe,
                available
              );
              if (started) {
                try {
                  world?.log?.("citizen_smelt", {
                    citizen: player.getUsername?.(),
                    kingdom: kingdomIdOf(player),
                    bar: recipe.name,
                    bars: available,
                  });
                } catch {
                  // non-fatal
                }
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
  createCitizenSmeltAction,
  // exposed for tests
  _barsFromInventory: barsFromInventory,
  _bestInventoryRecipe: bestInventoryRecipe,
  _bestBankPlan: bestBankPlan,
  _smeltableBars: smeltableBars,
  _smithingLevel: smithingLevel,
};
