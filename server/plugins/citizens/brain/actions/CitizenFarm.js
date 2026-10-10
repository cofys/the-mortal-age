"use strict";

/**
 * CitizenFarm — run real farming routes for real Farming XP, the RuneScape way.
 *
 * Citizens with seeds do what a human player does on a farm run: walk the
 * patch circuit nearest their kingdom (herb first — that's the money — then
 * allotments, then flowers), and at each patch work the real engine state:
 * dig out dead crops, rake weeds, compost, plant the best seed their Farming
 * level allows, water what can be watered, check-health grown crops, and
 * harvest them. Every step calls the farming plugin's real patch functions
 * (the same ones the player click path calls), so seeds are really consumed,
 * growth follows the real growth clock, produce really lands in the pack, and
 * real Farming XP flows through SkillManager — the level-up celebration
 * fires for citizens exactly as it does for players.
 *
 * Farming is periodic, not continuous — a human plants, then goes and does
 * something else until things grow. So one run works the circuit once and
 * returns "success": the decision layer re-picks farming when there's fresh
 * work (weeds, grown crops, empty patches + seeds). The inventory clock
 * still rules: harvested produce fills the pack and the citizen_bank hinge
 * handles the banking.
 *
 * Supply loop (mirrors CitizenCook): the citizen carries a tool set (rake,
 * seed dibber, spade; watering can when the bank has one) and seeds. Empty
 * pack but the bank holds seeds/tools -> walk to the bank, withdraw the
 * loadout via the shared bank action, then farm next ticks. No seeds
 * anywhere -> "success" (re-decide — a human can't farm without seeds
 * either; no seeds are ever conjured). No patches in walking range (e.g.
 * Keldagrim, underground) -> "success".
 *
 * Diseased crops are skipped in v1: curing needs plant cure / secateurs
 * handling that the click path does through dialogue; they die and get dug
 * out on the next run. Compost is applied when the citizen already has some;
 * the compost-making loop is a follow-up.
 *
 * Flow per tick:
 *   - No farming engine (botFarm seam missing) -> "failed".
 *   - Advance the real growth clock (Model.advanceFarm — citizens aren't on
 *     the farming tick's tracked set, so the brain does the plugin's own
 *     advance call), then read real patch state. Never hash-derived.
 *   - Tools/seeds missing -> bank loadout leg (once per run).
 *   - Walk the site circuit; at each patch, do the next real work item on
 *     an interaction cooldown, one engine call per cooldown.
 *   - Circuit done, or nothing to do anywhere -> "success".
 *   - Give up after GIVE_UP_MS so a bad route never stalls the day.
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
const { ACT_FARM } = require("../CitizenDecisions");
const SlotCapacity = require("../CitizenSlotCapacity");

// A farm run involves real walking between patches; still, a cursed route
// must never stall the day.
const GIVE_UP_MS = 12 * 60 * 1000;
const BANK_ARRIVE_RADIUS = 8;
const PATCH_ARRIVE_RADIUS = 12;
const INTERACT_COOLDOWN_MS = 2500;
// A farm run is worth a walk, not a trek: patches beyond this are for
// teleporting players, not walking citizens.
const PATCH_SEARCH_RADIUS = 250;
// Patches within this of the nearest patch form one farm site (e.g. the
// Falador allotments + flower + herb).
const SITE_GROUP_RADIUS = 60;
// The v1 circuit: the patches a walking citizen can actually work.
const FARM_TYPES = ["HERB", "ALLOTMENT", "FLOWER"];
// Humans hit the money patch first.
const TYPE_PRIORITY = { HERB: 0, ALLOTMENT: 1, FLOWER: 2 };
const REQUIRED_TOOLS = ["Rake", "Seed dibber", "Spade"];
const COMPOST_NAMES = ["Ultracompost", "Supercompost", "Compost"];
const WATER_CAN_NAMES = [
  "Watering can(8)",
  "Watering can(7)",
  "Watering can(6)",
  "Watering can(5)",
  "Watering can(4)",
  "Watering can(3)",
  "Watering can(2)",
  "Watering can(1)",
  "Magic watering can",
  "Gricoller's can",
];
// Seeds withdrawn per patch type for one run (bounded — a human grabs a
// handful, not the whole seed vault).
const SEEDS_PER_TYPE = 6;

function farmingApi() {
  try {
    const mod = require("../../../skills/farming/Patches.Farming");
    return mod?.botFarm ?? null;
  } catch {
    return null;
  }
}

/** Farming level, 1 when unreadable (potato/marigold-only — safe fallback). */
function farmingLevel(player) {
  try {
    const Skill = require("../../../../src/main/typescript/elvarg/game/model/Skill")
      .Skill;
    const mgr = player.getSkillManager?.();
    if (!mgr || !Skill || typeof mgr.getCurrentLevel !== "function") return 1;
    const lvl = mgr.getCurrentLevel(Skill.FARMING);
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

function bankApi() {
  try {
    return require("../../../../src/main/typescript/elvarg/game/model/container/impl/Bank")
      .Bank;
  } catch {
    return null;
  }
}

/** Engine item id for a name, or -1 when the cache doesn't know it. */
function toolId(BF, name) {
  try {
    const id = BF.itemId(name);
    return Number.isInteger(id) && id >= 0 ? id : -1;
  } catch {
    return -1;
  }
}

/** Real engine tool check (inventory or worn). */
function hasTool(BF, player, name) {
  try {
    return BF.hasTool(player, name) === true;
  } catch {
    return false;
  }
}

/** A watering can that actually holds water, or -1. */
function waterCanId(BF, player) {
  for (const name of WATER_CAN_NAMES) {
    const id = toolId(BF, name);
    if (id >= 0 && invAmount(player, id) > 0) return id;
  }
  return -1;
}

/**
 * Best seed in the pack for a patch type: highest Farming level at or under
 * the citizen's level with enough seeds to plant. A human plants the best
 * crop they've got seeds for.
 */
function bestSeedFor(BF, player, patchType) {
  const level = farmingLevel(player);
  let best = null;
  try {
    for (const [seedId, crop] of BF.seeds ?? []) {
      if (!crop || crop.type !== patchType) continue;
      if ((crop.level ?? 99) > level) continue;
      if (invAmount(player, seedId) < (crop.seedCount ?? 1)) continue;
      if (!best || (crop.level ?? 0) > (best.crop.level ?? 0)) {
        best = { crop, seedId };
      }
    }
  } catch {
    // treat as no seeds
  }
  return best;
}

/** Plantable (level-gated, v1 patch types) seeds in pack and bank. */
function seedCounts(BF, player) {
  const level = farmingLevel(player);
  let inv = 0;
  let bank = 0;
  try {
    for (const [seedId, crop] of BF.seeds ?? []) {
      if (!crop || !FARM_TYPES.includes(crop.type)) continue;
      if ((crop.level ?? 99) > level) continue;
      inv += invAmount(player, seedId);
      bank += bankAmount(player, seedId);
    }
  } catch {
    // treat as empty
  }
  return { inv, bank };
}

/**
 * Withdraw plan for one farm run: missing tools, a watering can when the
 * bank has one, a handful of the best bank seeds per patch type, and some
 * compost when available. Null when the bank can't supply anything needed.
 */
function bestBankPlan(BF, player) {
  const level = farmingLevel(player);
  const withdraw = [];
  for (const name of REQUIRED_TOOLS) {
    if (hasTool(BF, player, name)) continue;
    const id = toolId(BF, name);
    if (id >= 0 && bankAmount(player, id) > 0) {
      withdraw.push({ item: id, amount: 1 });
    }
  }
  if (waterCanId(BF, player) < 0) {
    for (const name of WATER_CAN_NAMES) {
      const id = toolId(BF, name);
      if (id >= 0 && bankAmount(player, id) > 0) {
        withdraw.push({ item: id, amount: 1 });
        break;
      }
    }
  }
  // Best bank seed per patch type — a human grabs a run's worth.
  try {
    for (const type of FARM_TYPES) {
      let best = null;
      for (const [seedId, crop] of BF.seeds ?? []) {
        if (!crop || crop.type !== type) continue;
        if ((crop.level ?? 99) > level) continue;
        const inBank = bankAmount(player, seedId);
        if (inBank < (crop.seedCount ?? 1)) continue;
        if (!best || (crop.level ?? 0) > (best.crop.level ?? 0)) {
          best = { crop, seedId, inBank };
        }
      }
      if (best) {
        withdraw.push({
          item: best.seedId,
          amount: Math.min(best.inBank, SEEDS_PER_TYPE * (best.crop.seedCount ?? 1)),
        });
      }
    }
  } catch {
    // seeds stay in the bank
  }
  // Best compost tier available — disease protection a human wouldn't skip.
  for (const name of COMPOST_NAMES) {
    const id = toolId(BF, name);
    if (id >= 0 && bankAmount(player, id) > 0) {
      withdraw.push({ item: id, amount: Math.min(bankAmount(player, id), 6) });
      break;
    }
  }
  return withdraw.length > 0 ? { withdraw } : null;
}

function patchCenter(patch) {
  return {
    x: (patch.x + (patch.maxX ?? patch.x)) / 2,
    y: (patch.y + (patch.maxY ?? patch.y)) / 2,
    z: patch.z ?? 0,
  };
}

/**
 * The farm site: patches of the v1 types within walking range, grouped
 * around the nearest one (one site = one real-world farm, e.g. Falador's
 * allotments + flower + herb). Herb first, then allotments, then flowers —
 * then nearest within each type. Null when nothing is in range.
 */
function nearestPatchCluster(BF, player) {
  try {
    const loc = player.getLocation?.();
    if (!loc) return null;
    const px = loc.getX?.() ?? 0;
    const py = loc.getY?.() ?? 0;
    const pz = loc.getZ?.() ?? 0;
    const cands = [];
    for (const patch of BF.patches ?? []) {
      if (!patch || !FARM_TYPES.includes(patch.type)) continue;
      if ((patch.z ?? 0) !== pz) continue;
      const c = patchCenter(patch);
      const d = Math.max(Math.abs(c.x - px), Math.abs(c.y - py));
      if (d <= PATCH_SEARCH_RADIUS) cands.push({ patch, c, d });
    }
    if (!cands.length) return null;
    cands.sort((a, b) => a.d - b.d);
    const anchor = cands[0];
    const site = cands.filter(
      (e) => Math.max(Math.abs(e.c.x - anchor.c.x), Math.abs(e.c.y - anchor.c.y)) <= SITE_GROUP_RADIUS
    );
    site.sort(
      (a, b) =>
        (TYPE_PRIORITY[a.patch.type] ?? 9) - (TYPE_PRIORITY[b.patch.type] ?? 9) ||
        a.d - b.d
    );
    return site.map((e) => e.patch);
  } catch {
    return null;
  }
}

/**
 * The next real work item at a patch, from live engine state. The caller
 * advances the growth clock first, so this is never stale.
 */
function patchWork(BF, player, patch) {
  try {
    const state = BF.stateFor(player, patch);
    if (!state) return null;
    const crop = state.crop ? BF.crops?.get(state.crop) ?? null : null;
    // Dead crop or bare stump: dig it out (spade).
    if (state.crop && (state.status === "dead" || state.stump)) {
      return { kind: "dig" };
    }
    // Weeds first — the engine won't let you plant through them.
    if (!state.crop && !state.scarecrow && (state.weeds ?? 0) > 0) {
      return { kind: "rake" };
    }
    // Empty, raked patch: compost it when we've got some (real players do).
    if (!state.crop && !state.scarecrow && !(state.weeds ?? 0) && !state.compost) {
      const compostId = compostInPack(BF, player);
      if (compostId >= 0) return { kind: "compost", compostId };
    }
    // Empty and ready: plant the best seed we've got.
    if (!state.crop && !state.scarecrow && !(state.weeds ?? 0)) {
      const seed = bestSeedFor(BF, player, patch.type);
      if (seed) return { kind: "plant", seed };
      return null; // nothing to plant here — next patch
    }
    // Grown: health-check first (big XP), then harvest the lives off.
    if (state.crop && state.status === "grown") {
      if (crop?.check && !state.checked) return { kind: "check" };
      return { kind: "harvest" };
    }
    // Diseased (v1): leave it — curing needs plant cure / secateurs dialogue
    // handling; it dies and gets dug on the next run.
    return null;
  } catch {
    return null;
  }
}

/** Best compost tier in the pack, or -1. */
function compostInPack(BF, player) {
  for (const name of COMPOST_NAMES) {
    const id = toolId(BF, name);
    if (id >= 0 && invAmount(player, id) > 0) return id;
  }
  return -1;
}

/** Compost tier number the engine's fertilize() expects. */
function compostTier(BF, player, compostId) {
  for (let i = 0; i < COMPOST_NAMES.length; i++) {
    if (toolId(BF, COMPOST_NAMES[i]) === compostId) return COMPOST_NAMES.length - i;
  }
  return 1;
}

function atTile(player, tile, radius) {
  try {
    const loc = player.getLocation?.();
    if (!loc) return false;
    return (
      (loc.getZ?.() ?? 0) === (tile.z ?? 0) &&
      Math.max(Math.abs(loc.getX() - tile.x), Math.abs(loc.getY() - tile.y)) <= radius
    );
  } catch {
    return false;
  }
}

function walkTo(player, tile, reason, spread) {
  const username = player.getUsername?.() ?? "unknown";
  // Personal spot — the farm crew shouldn't stack on one tile (destack rule).
  const spot = personalSpot(username, tile.x, tile.y, 3, spread ?? 8);
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

/** Walk to an exact slot tile (the slot IS the destack — no personalSpot). */
function walkToExact(player, tile, reason) {
  try {
    requestMovement(player, tile.x, tile.y, {
      reason,
      basicPather: true,
      z: tile.z ?? 0,
    });
    return true;
  } catch {
    return false;
  }
}

function logFarm(world, player, event, extra) {
  try {
    world?.log?.("citizen_farm", {
      citizen: player.getUsername?.(),
      kingdom: kingdomIdOf(player),
      event,
      ...(extra ?? {}),
    });
  } catch {
    // non-fatal
  }
}

function createCitizenFarmAction(spec, world) {
  function botState(player) {
    return playerState(action, player, () => {
      const personality = player.getAttribute?.(ATTR_CITIZEN_PERSONALITY) ?? {};
      return {
        rng: agentRng(`farm:${player.getUsername?.() ?? "unknown"}`),
        human: humanizerProfile(personality),
        giveUpAt: 0,
        withdrawing: false,
        withdrawDelegate: null,
        bankTried: false,
        site: null,
        patchIdx: 0,
        lastClickAt: 0,
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
    id: "citizenFarm",
    update(ctx) {
      const { player, nowMs } = ctx;
      const BF = farmingApi();
      if (!BF) {
        return "failed"; // farming engine not loaded
      }
      const state = botState(player);
      if (!state.giveUpAt) {
        state.giveUpAt = nowMs + GIVE_UP_MS;
      }
      if (nowMs >= state.giveUpAt) {
        stopWithdraw(state, ctx);
        return "success"; // bad farm day — move on, don't stall
      }

      // Citizens aren't on the farming tick's tracked set, so the brain
      // advances the real growth clock itself — the same advanceFarm call the
      // plugin's own objectInteraction makes. Everything below reads live
      // engine state, never fabricated.
      try {
        BF.advanceFarm(BF.farmFor(player), nowMs, state.rng);
      } catch {
        return "running";
      }

      if (state.withdrawing) {
        return continueWithdraw(ctx, state);
      }

      // Supply check: tools + seeds. One bank leg per run, then work with
      // what's actually there — a human can't farm without seeds either.
      const missingTools = REQUIRED_TOOLS.filter((t) => !hasTool(BF, player, t));
      const counts = seedCounts(BF, player);
      const needBank =
        missingTools.length > 0 || (counts.inv === 0 && counts.bank > 0);
      if (!state.bankTried && needBank) {
        state.bankTried = true;
        const plan = bestBankPlan(BF, player);
        if (plan) return withdrawLoadout(ctx, state, plan);
      }
      if (missingTools.length > 0 || counts.inv + counts.bank === 0) {
        return "success"; // nothing to farm with — re-decide
      }

      // The run: work the nearest site circuit once.
      if (!state.site) {
        state.site = nearestPatchCluster(BF, player);
        state.patchIdx = 0;
        if (!state.site) return "success"; // no patches in walking range
      }
      if (state.patchIdx >= state.site.length) {
        return "success"; // circuit done — farming is periodic, not continuous
      }
      return workPatch(ctx, state, BF, state.site[state.patchIdx]);
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
        // Slot-capacity lifecycle: ending the farm run frees the spot claim.
        try {
          SlotCapacity.releaseFor(ctx.player);
        } catch {
          // best effort
        }
      }
    },
  };

  function continueWithdraw(ctx, state) {
    let result = "running";
    try {
      result = state.withdrawDelegate.update(ctx);
    } catch {
      result = "failed";
    }
    if (result === "success" || result === "failed") {
      // Loadout leg over — either the pack now holds tools/seeds and the
      // run resumes next tick, or the day moves on.
      stopWithdraw(state, ctx);
      return "running";
    }
    return "running";
  }

  function withdrawLoadout(ctx, state, plan) {
    const { player } = ctx;
    const bank = siteTile(player, "bank");
    if (!bank) {
      return "failed"; // no bank anchor for this kingdom
    }
    if (!atTile(player, bank, BANK_ARRIVE_RADIUS)) {
      walkTo(player, bank, "citizen_farm_bank", 10);
      return "running";
    }
    state.withdrawing = true;
    state.withdrawDelegate = createBankAction({ withdraw: plan.withdraw }, world);
    return "running";
  }

  function workPatch(ctx, state, BF, patch) {
    const { player, nowMs } = ctx;
    const center = patchCenter(patch);
    // Slot claim on the REAL patch center: the farm crew spreads around the
    // patch on distinct slot tiles instead of stacking on its center. A full
    // patch -> next patch (another spot of the same activity), never a fixed
    // wait. Falls back to the old personalSpot walk if claiming fails.
    let stand = center;
    let useExact = false;
    try {
      const claim = SlotCapacity.claimSlot(
        player,
        ACT_FARM,
        Math.round(center.x),
        Math.round(center.y),
        Math.round(center.z ?? 0),
        state.rng
      );
      if (!claim) {
        state.patchIdx += 1;
        logFarm(world, player, "patch-full", { patch: patch.type });
        return "running";
      }
      stand = { x: claim.x, y: claim.y, z: claim.z };
      useExact = true;
    } catch {
      // Claim failure degrades to the old personalSpot walk, never a break.
    }
    if (!atTile(player, stand, PATCH_ARRIVE_RADIUS)) {
      if (useExact) {
        walkToExact(player, stand, "citizen_farm_patch");
      } else {
        walkTo(player, center, "citizen_farm_patch", 8);
      }
      return "running";
    }

    // Let in-flight movement finish first.
    try {
      if (player.getForceMovement?.() != null) return "running";
      if (player.getMovementQueue?.()?.size?.() > 0) return "running";
    } catch {
      // fall through and try the work
    }
    if (nowMs - state.lastClickAt < INTERACT_COOLDOWN_MS) {
      return "running";
    }

    const work = patchWork(BF, player, patch);
    if (!work) {
      state.patchIdx += 1; // nothing to do here — next patch
      return "running";
    }
    // Tool pre-checks keep the engine's "you need a ..." messages out of the
    // citizen's chat; the bank leg already tried to supply them.
    if (work.kind === "rake" && !hasTool(BF, player, "Rake")) {
      state.patchIdx += 1;
      return "running";
    }
    if (
      (work.kind === "dig" || work.kind === "harvest") &&
      !hasTool(BF, player, "Spade")
    ) {
      state.patchIdx += 1;
      return "running";
    }
    if (work.kind === "plant" && !hasTool(BF, player, "Seed dibber")) {
      state.patchIdx += 1;
      return "running";
    }

    state.lastClickAt = nowMs;
    try {
      switch (work.kind) {
        case "rake": {
          const more = BF.rake(player, patch) === true;
          logFarm(world, player, "rake", { patch: patch.type });
          if (!more) state.patchIdx += 1; // weeds done — recheck next tick
          break;
        }
        case "compost": {
          const tier = compostTier(BF, player, work.compostId);
          if (BF.fertilize(player, patch, tier) === true) {
            logFarm(world, player, "compost", { patch: patch.type, tier });
          }
          break; // recheck: plant next tick
        }
        case "plant": {
          BF.plant(player, patch, work.seed.seedId);
          logFarm(world, player, "plant", {
            patch: patch.type,
            crop: work.seed.crop.key,
          });
          // Water what can be watered — a human waters the allotments.
          try {
            if (
              BF.waterable?.has(patch.type) &&
              waterCanId(BF, player) >= 0
            ) {
              BF.waterPatch(player, patch);
            }
          } catch {
            // watering is best-effort; the crop still grows
          }
          state.patchIdx += 1;
          break;
        }
        case "check": {
          BF.healthCheck(player, patch);
          logFarm(world, player, "check-health", { patch: patch.type });
          break; // recheck: harvest next tick
        }
        case "harvest": {
          const more = BF.harvest(player, patch) === true;
          logFarm(world, player, "harvest", { patch: patch.type });
          if (!more) state.patchIdx += 1; // lives exhausted — patch cleared
          break;
        }
        case "dig": {
          BF.dig(player, patch);
          logFarm(world, player, "dig", { patch: patch.type });
          break; // recheck: rake/plant next tick
        }
        default: {
          state.patchIdx += 1;
          break;
        }
      }
    } catch {
      // a failed engine call never stalls the run — next tick retries
    }
    return "running";
  }

  return action;
}

module.exports = {
  createCitizenFarmAction,
  // exposed for tests
  _farmingLevel: farmingLevel,
  _bestSeedFor: bestSeedFor,
  _seedCounts: seedCounts,
  _bestBankPlan: bestBankPlan,
  _nearestPatchCluster: nearestPatchCluster,
  _patchWork: patchWork,
  _waterCanId: waterCanId,
  _compostTier: compostTier,
};
