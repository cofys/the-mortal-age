"use strict";

/**
 * CitizenRc — craft runes for real Runecrafting XP, the RuneScape way.
 *
 * Citizens withdraw rune essence or pure essence from the bank, travel to
 * the best altar their Runecrafting level allows, and craft via the real
 * Runecrafting plugin's bot entry point (startBotRunecrafting) — the same
 * pattern upstream's Smelt.js uses. Real runes land in the inventory and
 * real Runecrafting XP flows through SkillManager, so the level-up
 * celebration fires for citizens exactly as it does for players.
 *
 * Runecrafting is station work — the citizen must be AT the altar. The
 * action picks the highest-level altar the citizen's level allows (air at
 * 1, mind at 2, water at 5, earth at 9, fire at 14, body at 20, cosmic at
 * 27, chaos at 35, nature at 44, law at 54, death at 65, blood at 75) and
 * walks there. The craft itself is synchronous — one altar visit crafts the
 * full inventory — so the brain re-decides after each run (usually the
 * bank hinge for more essence).
 *
 * Flow per tick:
 *   - Essence in the pack -> walk to the best altar, craft on arrival.
 *   - No essence in the pack but the bank holds some -> walk to the bank,
 *     withdraw a full run, then head for the altar next ticks.
 *   - No essence anywhere -> "success" (done, brain re-decides — likely
 *     trading for essence or another skill).
 *   - Give up after GIVE_UP_MS so a bad altar day never stalls the day.
 *
 * Non-repeat: works one full essence run, then the brain re-decides.
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

// If no rune gets crafted in this long, the altar is cursed — move on.
const GIVE_UP_MS = 6 * 60 * 1000;
const BANK_ARRIVE_RADIUS = 8;
const ALTAR_ARRIVE_RADIUS = 6;

// A full essence run fills the pack.
const ESSENCE_PACK_TARGET = 28;

function runecraftingPlugin() {
  try {
    return require("../../../skills/Runecrafting.plugin");
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

/** Runecrafting level, 1 when unreadable (air runes only — safe fallback). */
function runecraftingLevel(player) {
  try {
    const Skill = require("../../../src/main/typescript/elvarg/game/model/Skill")
      .Skill;
    const mgr = player.getSkillManager?.();
    if (!mgr || !Skill || typeof mgr.getCurrentLevel !== "function") return 1;
    const lvl = mgr.getCurrentLevel(Skill.RUNECRAFTING);
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
 * Essence item IDs from the Runecrafting plugin. We read them from the
 * plugin export so the brain never hardcodes IDs that could drift.
 */
function essenceIds(Runecrafting) {
  try {
    const ids = Runecrafting?.ESSENCE_IDS;
    if (Array.isArray(ids)) return ids.filter(Number.isInteger);
  } catch {
    // fall through
  }
  return [];
}

/** Total essence in the pack (rune + pure). */
function essenceInInventory(Runecrafting, player) {
  let total = 0;
  for (const id of essenceIds(Runecrafting)) {
    total += invAmount(player, id);
  }
  return total;
}

/** Total essence in the bank (rune + pure). */
function essenceInBank(Runecrafting, player) {
  let total = 0;
  for (const id of essenceIds(Runecrafting)) {
    total += bankAmount(player, id);
  }
  return total;
}

/**
 * Cheapest honest answer to "does this citizen have essence to craft?":
 * pack first, then bank.
 */
function essenceMaterials(Runecrafting, player) {
  const inv = essenceInInventory(Runecrafting, player);
  if (inv > 0) return inv;
  return essenceInBank(Runecrafting, player);
}

/**
 * Withdraw plan: top the pack toward a full essence run (28). Prefers
 * pure essence (works at every altar) but takes rune essence too.
 */
function bestBankPlan(Runecrafting, player) {
  const ids = essenceIds(Runecrafting);
  if (!ids.length) return null;
  const withdraw = [];
  let remaining = ESSENCE_PACK_TARGET - essenceInInventory(Runecrafting, player);
  if (remaining <= 0) return null;
  for (const id of ids) {
    if (remaining <= 0) break;
    const inBank = bankAmount(player, id);
    if (inBank <= 0) continue;
    const take = Math.min(remaining, inBank);
    withdraw.push({
      item: id,
      amount: invAmount(player, id) + take,
    });
    remaining -= take;
  }
  if (!withdraw.length) return null;
  return { withdraw };
}

/**
 * Altar destination for the citizen's best altar: { x, y } coordinates
 * from the plugin's ALTAR_DESTINATIONS, plus the altar object ID.
 */
function altarDestination(Runecrafting, player) {
  try {
    const best = Runecrafting?.findBestAltar?.(player);
    if (!best) return null;
    const destinations = Runecrafting?.ALTAR_DESTINATIONS;
    const dest = destinations?.get?.(best.runeData?.runeId);
    if (!dest) return null;
    return {
      x: dest.x,
      y: dest.y,
      z: 0,
      objectId: best.objectId,
      runeId: best.runeData?.runeId,
      level: best.runeData?.level ?? 1,
    };
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

function walkTo(player, tile, reason) {
  const username = player.getUsername?.() ?? "unknown";
  // Personal spot near the target — the RC crew shouldn't stack on one tile.
  const spot = personalSpot(username, tile.x, tile.y, 4, 10);
  try {
    requestMovement(player, spot.x, spot.y, {
      reason,
      basicPather: true,
      z: tile.z ?? 0,
    });
    return true;
  } catch {
    return false;
  }
}

function createCitizenRcAction(spec, world) {
  function botState(player) {
    return playerState(action, player, () => {
      const personality = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
      return {
        rng: agentRng(`rc:${player.getUsername?.() ?? "unknown"}`),
        human: humanizerProfile(personality),
        giveUpAt: 0,
        withdrawing: false,
        withdrawDelegate: null,
        traveling: false,
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
    id: "citizenRc",
    update(ctx) {
      const { player, nowMs } = ctx;
      const Runecrafting = runecraftingPlugin();
      if (!Runecrafting?.startBotRunecrafting) {
        return "failed"; // Runecrafting plugin not loaded
      }
      const state = botState(player);
      if (!state.giveUpAt) {
        state.giveUpAt = nowMs + GIVE_UP_MS;
      }
      if (nowMs >= state.giveUpAt) {
        stopWithdraw(state, ctx);
        return "success"; // bad altar day — move on, don't stall
      }

      // Essence in the pack? Head for the altar and craft.
      if (essenceInInventory(Runecrafting, player) > 0) {
        if (state.withdrawing) stopWithdraw(state, ctx);
        return craftAtAltar(ctx, state, Runecrafting);
      }

      // No essence in the pack — check the bank before giving up.
      const plan = bestBankPlan(Runecrafting, player);
      if (!plan) return "success"; // no essence anywhere; re-decide
      return withdrawEssence(ctx, state, plan);
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

  function withdrawEssence(ctx, state, plan) {
    const { player } = ctx;
    const bank = siteTile(player, "bank");
    if (!bank) {
      return "failed"; // no bank anchor for this kingdom
    }
    if (!state.withdrawing) {
      if (!atTile(player, bank, BANK_ARRIVE_RADIUS)) {
        walkTo(player, bank, "citizen_rc_bank");
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
      // essence and crafting resumes next tick, or the day moves on.
      stopWithdraw(state, ctx);
      return "running";
    }
    return "running";
  }

  function craftAtAltar(ctx, state, Runecrafting) {
    const { player } = ctx;
    const dest = altarDestination(Runecrafting, player);
    if (!dest) {
      return "failed"; // no altar for this level (shouldn't happen — air is 1)
    }
    if (!atTile(player, dest, ALTAR_ARRIVE_RADIUS)) {
      walkTo(player, dest, "citizen_rc_altar");
      return "running";
    }
    // At the altar — craft the full inventory.
    // Same shape as upstream Smelt.js: hand the work to the skill plugin
    // directly — no interface clicking.
    let crafted = 0;
    try {
      crafted = Runecrafting.startBotRunecrafting?.(player, dest.objectId) ?? 0;
    } catch {
      crafted = 0;
    }
    if (crafted > 0) {
      try {
        world?.log?.("citizen_rc", {
          citizen: player.getUsername?.(),
          kingdom: kingdomIdOf(player),
          rune: dest.runeId,
          essence: crafted,
        });
      } catch {
        // non-fatal
      }
    }
    // Craft is synchronous — the pack is now empty of essence. Return
    // success so the brain re-decides (usually the bank hinge for more).
    return "success";
  }

  return action;
}

module.exports = {
  createCitizenRcAction,
  // exposed for tests
  _essenceInInventory: essenceInInventory,
  _essenceInBank: essenceInBank,
  _essenceMaterials: essenceMaterials,
  _bestBankPlan: bestBankPlan,
  _altarDestination: altarDestination,
  _runecraftingLevel: runecraftingLevel,
};
