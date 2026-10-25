"use strict";

/**
 * Bounty Hunter's shared state, handed to every unit as `bh`. Membership follows the Lobby and
 * Arena areas (Area.BountyHunter.js), so it is exact and costs nothing outside the crater.
 * Saved state (skip history, penalty) lives on player attributes in Targets.BountyHunter.js.
 */

const CRATER = require("./data/crater.json");

function inside(box, location) {
  if (!location) return false;
  const x = location.getX?.() ?? location.x;
  const y = location.getY?.() ?? location.y;
  const z = location.getZ?.() ?? location.z ?? 0;
  return z === 0 && x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY;
}

const bh = {
  CRATER,
  /** Players in Fort Daimon, the safe lobby. */
  lobby: new Set(),
  /** Players in the arena, in entry order: matching serves the longest waiting first. */
  arena: new Set(),
  /** player -> target, kept in both directions. */
  targets: new Map(),
  /** player -> the target they skipped last; they are not paired again until a new target. */
  skipped: new WeakMap(),
  /** player -> Date.now() before which they get no new target (1 minute after dying). */
  noTargetUntil: new WeakMap(),
  /** player -> game cycle until which rogues can't attack them (entering the arena). */
  immuneUntil: new WeakMap(),
  /** player -> game cycle of their last special attack on a player in the arena. */
  lastSpecialAt: new WeakMap(),
  /** player -> ticks spent in the lobby with their current target (bh_lobby_timer). */
  lobbyTicks: new WeakMap(),

  targetOf(player) {
    return this.targets.get(player) ?? null;
  },
  inArena(player) {
    return this.arena.has(player);
  },
  inLobby(player) {
    return this.lobby.has(player);
  },
  inCrater(player) {
    return this.lobby.has(player) || this.arena.has(player);
  },
  /** Tile tests, for a location the player is about to reach or has just left. */
  isArenaTile(location) {
    return inside(CRATER.arena, location) && !inside(CRATER.lobby, location);
  },
  isLobbyTile(location) {
    return inside(CRATER.lobby, location);
  },
};

module.exports = bh;
