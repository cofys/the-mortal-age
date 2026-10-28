const { getPvpProfile } = require("../../pvp/PvpAssignment.PlayerBots");
const { isFoodItem, isComboFoodItem } = require("../../../../items/Food.plugin");
const { computeEatThreshold } = require("../../state/State.PlayerBots");
const { resolveBotNodeContext } = require("../context/NodeContext.PlayerBots");

function findFoodSlots(inventory) {
  return (inventory?.getItems?.() ?? [])
    .map((item, slot) => (isFoodItem(item?.getId?.()) ? slot : -1))
    .filter((slot) => slot >= 0);
}

class EatFoodActionNode {
  constructor(botStatesByName, api, options = {}) {
    this.botStatesByName = botStatesByName;
    this.api = api;
    this.lowHpRatio = Math.max(0.05, Math.min(0.95, Number(options.lowHpRatio ?? 0.45)));
  }

  resolvePvpProfile(state) {
    if (state?.mode !== "pvp" || !state?.pvp) {
      return null;
    }
    return getPvpProfile(state.pvp.profileId);
  }

  getCachedPvpEatAtHpRatio(state) {
    const pvp = state?.pvp;
    if (!pvp) {
      return this.lowHpRatio;
    }
    const profileId = pvp.profileId ?? "standard";
    if (pvp.cachedEatAtHpRatioProfileId !== profileId) {
      pvp.cachedEatAtHpRatioProfileId = profileId;
      pvp.cachedEatAtHpRatio = Number(getPvpProfile(profileId)?.eatAtHpRatio ?? this.lowHpRatio);
    }
    return Number(pvp.cachedEatAtHpRatio ?? this.lowHpRatio);
  }

  tick(context) {
    const resolved = resolveBotNodeContext(context, this.botStatesByName, {
      requireNotBusy: false,
      requireNotInCombat: false,
      requireNoTraversalTransition: false,
    });
    if (!resolved) {
      return "failure";
    }

    const { player, state, nowMs } = resolved;
    const { Skill, TimerKey, ItemActionPacketListener, Inventory } = this.api.core;
    const skillManager = player.getSkillManager?.();
    if (!skillManager || !state) {
      return "failure";
    }

    const currentHp = Number(skillManager.getCurrentLevel?.(Skill.HITPOINTS) ?? 0);
    const maxHp = Number(skillManager.getMaxLevel?.(Skill.HITPOINTS) ?? 0);
    if (currentHp <= 0 || maxHp <= 0) {
      return "failure";
    }

    const pvpProfile = this.resolvePvpProfile(state);
    const isF2pPvp = state?.mode === "pvp" && state.pvp?.loadoutId?.startsWith("f2p_");
    const lowHpRatio = state?.mode === "pvp" ? this.getCachedPvpEatAtHpRatio(state) : this.lowHpRatio;
    const lowHpThreshold = computeEatThreshold(maxHp, lowHpRatio, isF2pPvp);
    // Veteran and elite bots can react to imminent lethal hits; weaker tiers watch current HP.
    const tickEat = !isF2pPvp && Number(pvpProfile?.confidenceTier ?? 0) >= 3 &&
      Number(player.getHitpointsAfterPendingDamage?.() ?? currentHp) <= 0 &&
      Math.random() < Number(pvpProfile.tickEatChance ?? 0);
    if (currentHp > lowHpThreshold && !tickEat) {
      if (isF2pPvp) {
        state.pvp.f2pFoodPending = false;
        state.pvp.f2pFoodPendingHp = null;
      }
      return "failure";
    }

    if (isF2pPvp) {
      const combat = player.getCombat?.();
      const engaged = Boolean(
        combat?.getTarget?.() || combat?.getAttacker?.() || player.getCombatFollowing?.()
      );
      if (!engaged) {
        state.pvp.f2pFoodPending = false;
        state.pvp.f2pFoodPendingHp = null;
      } else if (state.pvp.f2pFoodPending !== true) {
        state.pvp.f2pFoodPending = true;
        state.pvp.f2pFoodPendingHp = currentHp;
        return "failure";
      } else if (currentHp >= Number(state.pvp.f2pFoodPendingHp ?? currentHp)) {
        return "failure";
      } else {
        state.pvp.f2pFoodPending = false;
        state.pvp.f2pFoodPendingHp = null;
      }
    }

    const inventory = player.getInventory?.();
    const foodSlots = findFoodSlots(inventory);
    state.virtualFoodChargesRemaining = foodSlots.length;
    if (!Number.isFinite(state.nextNoFoodLogAt)) {
      state.nextNoFoodLogAt = 0;
    }
    if (state.virtualFoodChargesRemaining <= 0) {
      if ((nowMs ?? Date.now()) >= state.nextNoFoodLogAt) {
        this.api?.log?.("bot_food_empty", {
          username: player.getUsername?.(),
          currentHp,
          maxHp,
          threshold: lowHpThreshold,
        });
        state.nextNoFoodLogAt = (nowMs ?? Date.now()) + 10000;
      }
      return "failure";
    }

    const timers = player.getTimers?.();
    if (!timers || timers.has?.(TimerKey.STUN)) return "failure";

    const normalSlot = foodSlots.find((slot) => !isComboFoodItem(inventory.getItems()[slot].getId()));
    const comboSlot = foodSlots.find((slot) => isComboFoodItem(inventory.getItems()[slot].getId()));
    const firstSlot = !timers.has(TimerKey.FOOD) && normalSlot !== undefined ? normalSlot : comboSlot;
    if (firstSlot === undefined) return "failure";

    const consume = (slot) => {
      const item = inventory.getItems()[slot];
      const itemId = item.getId();
      const amount = item.getAmount?.() ?? 1;
      ItemActionPacketListener.handleAction(player, Inventory.INTERFACE_ID, itemId, slot, 1);
      const remaining = inventory.getItems()[slot];
      return remaining?.getId() !== itemId || (remaining.getAmount?.() ?? 1) < amount;
    };
    if (!consume(firstSlot)) return "failure";

    let comboEatTriggered = false;
    if (Number(pvpProfile?.confidenceTier ?? 0) >= 3 && firstSlot !== comboSlot && comboSlot !== undefined &&
        (tickEat || currentHp <= Math.max(1, Math.ceil(maxHp * Math.max(0.1, lowHpRatio * 0.72)))) &&
        Math.random() < Number(pvpProfile.comboEatChance ?? 0)) {
      comboEatTriggered = consume(comboSlot);
      if (comboEatTriggered) state.pvp.lastComboEatAt = nowMs ?? Date.now();
    }
    state.virtualFoodChargesRemaining = findFoodSlots(inventory).length;
    if (state?.pvp) state.pvp.lastFoodAt = nowMs ?? Date.now();
    this.api?.log?.("bot_food_eat", {
      username: player.getUsername?.(),
      currentHp,
      nextHp: skillManager.getCurrentLevel(Skill.HITPOINTS),
      comboEatTriggered,
      chargesRemaining: state.virtualFoodChargesRemaining,
      maxHp,
      threshold: lowHpThreshold,
    });
    return "success";
  }
}

module.exports = {
  EatFoodActionNode,
};
