"use strict";

const { CombatSpells } = require("../../../../../src/main/typescript/elvarg/game/content/combat/magic/CombatSpells");
const { MagicSpellbook } = require("../../../../../src/main/typescript/elvarg/game/model/MagicSpellbook");
const { PvpProfileId } = require("../../pvp/PvpProfileRegistry.PlayerBots");
const { isVisibleRealPlayer } = require("../../pvp/PvpTargetFilters.PlayerBots");

class PvpJumpKilledTargetNode {
  constructor(options = {}) {
    this.setPhase = options.setPhase;
    this.resolveTargetPlayer = options.resolveTargetPlayer;
    this.isValidTarget = options.isValidTarget;
    this.setModePvp = options.setModePvp;
    this.scheduleCombatAction = options.scheduleCombatAction;
    this.scheduleReviewTimers = options.scheduleReviewTimers;
    this.applyGeneratedPvpLoadout = options.applyGeneratedPvpLoadout;
    this.randomInRange = options.randomInRange;
    this.pvpPhase = options.pvpPhase;
    this.behaviorMode = options.behaviorMode;
  }

  tick(context) {
    const { player, state, nowMs, pvpMinMs, pvpMaxMs } = context ?? {};
    const pvp = state?.pvp;
    if (!player || !state || !pvp) {
      return { handled: false };
    }
    if (pvp.targetUsername) {
      const currentTarget = this.resolveTargetPlayer?.(state) ?? null;
      if (this.isValidTarget?.(player, currentTarget)) {
        return { handled: false };
      }
      pvp.targetUsername = null;
      pvp.targetPlayer = null;
    }
    if (
      (!pvp.pjTargetUsername || nowMs >= Number(pvp.pjExpiresAt ?? 0)) &&
      pvp.pjVictimUsername &&
      nowMs < Number(pvp.pjVictimExpiresAt ?? 0)
    ) {
      const jumped = this.tryResolveImmediatePjFromKilledVictim(player, state, nowMs);
      if (jumped) {
        return this.engageTarget(player, state, jumped, nowMs, pvpMinMs, pvpMaxMs);
      }
    }

    if (!pvp.pjTargetUsername || nowMs >= Number(pvp.pjExpiresAt ?? 0)) {
      pvp.pjTargetUsername = null;
      pvp.pjExpiresAt = 0;
      pvp.pjVictimUsername = null;
      pvp.pjVictimExpiresAt = 0;
      return { handled: false };
    }

    const target = this.resolveTargetPlayer?.({
      pvp: { targetUsername: pvp.pjTargetUsername, targetPlayer: null },
    }) ?? null;
    if (!this.isValidTarget?.(player, target)) {
      pvp.pjTargetUsername = null;
      pvp.pjExpiresAt = 0;
      pvp.pjVictimUsername = null;
      pvp.pjVictimExpiresAt = 0;
      return { handled: false };
    }

    return this.engageTarget(player, state, target, nowMs, pvpMinMs, pvpMaxMs);
  }

  tryResolveImmediatePjFromKilledVictim(player, state, nowMs) {
    const pvp = state?.pvp;
    const victimUsername = pvp?.pjVictimUsername;
    if (!player || !pvp || !victimUsername) {
      return null;
    }
    const victim = this.resolveTargetPlayer?.({
      pvp: { targetUsername: victimUsername, targetPlayer: null },
    }) ?? null;
    const localPlayers = player.getLocalPlayers?.() ?? [];
    const playerLoc = player.getLocation?.();
    let bestTarget = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const candidate of localPlayers) {
      if (!isVisibleRealPlayer(player, candidate)) {
        continue;
      }
      if (!this.isValidTarget?.(player, candidate)) {
        continue;
      }
      const candidateCombat = candidate.getCombat?.();
      const candidateWasActiveOnVictim =
        (victim &&
          (candidateCombat?.getTarget?.() === victim ||
            candidateCombat?.getAttacker?.() === victim ||
            candidate.getCombatFollowing?.() === victim ||
            candidateCombat?.damageMapContains?.(victim) === true ||
            victim?.getCombat?.()?.damageMapContains?.(candidate) === true)) ||
        false;
      if (!candidateWasActiveOnVictim) {
        continue;
      }
      const candidateLoc = candidate.getLocation?.();
      const distance = playerLoc && candidateLoc ? playerLoc.getDistance(candidateLoc) : 9999;
      if (distance < bestDistance) {
        bestTarget = candidate;
        bestDistance = distance;
      }
    }
    pvp.pjVictimUsername = null;
    pvp.pjVictimExpiresAt = 0;
    return bestTarget;
  }

  engageTarget(player, state, target, nowMs, pvpMinMs, pvpMaxMs) {
    const pvp = state?.pvp;
    const durationMs = this.randomInRange?.(pvpMinMs, pvpMaxMs) ?? pvpMaxMs ?? 30000;
    if (
      !this.setModePvp?.(
        player,
        state,
        target,
        nowMs,
        durationMs,
        this.behaviorMode
      )
    ) {
      return { handled: false };
    }

    pvp.pjTargetUsername = null;
    pvp.pjExpiresAt = 0;
    pvp.pjVictimUsername = null;
    pvp.pjVictimExpiresAt = 0;
    pvp.phase = this.pvpPhase?.COMBAT ?? "combat";
    this.scheduleCombatAction?.(state, nowMs);
    this.scheduleReviewTimers?.(state, nowMs);
    this.applyGeneratedPvpLoadout?.(player, state);
    player.getMovementQueue?.().reset?.();
    if (this.tryOpenWithTeleblock(player, state, target, nowMs)) {
      this.setPhase?.(state, this.pvpPhase?.COMBAT ?? "combat");
      return { handled: true, status: "running", target };
    }
    player.getCombat?.()?.attack?.(target);
    this.setPhase?.(state, this.pvpPhase?.COMBAT ?? "combat");
    return { handled: true, status: "running", target };
  }

  tryOpenWithTeleblock(player, state, target, nowMs) {
    if (!this.shouldOpenWithTeleblock(player, state, target)) {
      return false;
    }
    const combat = player.getCombat?.();
    if (!combat?.castSpellOn) {
      return false;
    }
    combat.castSpellOn(target, CombatSpells.TELEBLOCK);
    if (state?.pvp) {
      state.pvp.lastTeleblockAt = nowMs;
    }
    return true;
  }

  shouldOpenWithTeleblock(player, state, target) {
    const profileId = state?.pvp?.profileId;
    if (profileId !== PvpProfileId.VETERAN && profileId !== PvpProfileId.ELITE) {
      return false;
    }
    if (player.getSpellbook?.() !== MagicSpellbook.NORMAL) {
      return false;
    }
    return target?.getCombat?.().getTeleblockTimer?.().finished?.() === true;
  }
}

module.exports = {
  PvpJumpKilledTargetNode,
};
