"use strict";

/**
 * CitizenTiles — walkability helpers for citizen placement.
 *
 * Root cause (2026-10-13, Jon in-game): citizens materialized ON ocean tiles
 * at Catherby fishing beach and couldn't move. The chain:
 *   - fishing gather places resolve to the dock tile, which sits at the
 *     water's edge;
 *   - SlotCapacity spiral slots and whereabouts personalSpot rings around the
 *     dock land 2-8 tiles out — in the sea;
 *   - neither the slot claim, the whereabouts settle, nor spawnCitizen
 *     validated walkability, so water tiles became recorded positions and
 *     then materialization positions. Engine pathing can't move off water,
 *     so citizens stood stuck.
 *
 * This module is the single choke point: every citizen placement path snaps
 * through here. The engine's RegionManager is injected by the director at
 * boot (it owns the plugin api); all functions degrade gracefully when the
 * region manager is unavailable (return the input tile — never strand).
 *
 * Zero LLM. Tick-safe: never throws.
 */

let regionManagerProvider = null;

/**
 * The director calls this once at boot with
 * () => this.api?.getRegionManager?.() ?? null.
 */
function setRegionManagerProvider(fn) {
  if (typeof fn === "function") {
    regionManagerProvider = fn;
  }
}

function getRegionManager() {
  try {
    const rm = regionManagerProvider ? regionManagerProvider() : null;
    return rm && typeof rm.blocked === "function" ? rm : null;
  } catch {
    return null;
  }
}

/** Minimal location shape — RegionManager.blocked only reads getX/getY/getZ. */
function asLocation(x, y, z) {
  const ix = Math.round(x);
  const iy = Math.round(y);
  const iz = Number.isFinite(z) ? Math.round(z) : 0;
  return {
    getX: () => ix,
    getY: () => iy,
    getZ: () => iz,
    x: ix,
    y: iy,
    z: iz,
  };
}

/**
 * True when the tile is blocked (water, wall, mountain), false when walkable,
 * null when walkability can't be determined (no region manager).
 */
function isBlockedTile(x, y, z) {
  const rm = getRegionManager();
  if (!rm) return null;
  try {
    return rm.blocked(asLocation(x, y, z), null) === true;
  } catch {
    return null;
  }
}

/**
 * Snap (x, y, z) to the nearest walkable tile. Checks the tile itself first,
 * then expands outward in Chebyshev rings up to maxRadius (default 12).
 * Returns { x, y, z } — the input (rounded) when the region manager is
 * unavailable or nothing walkable is found (never strand the citizen).
 */
function snapToWalkableTile(x, y, z, maxRadius) {
  const ix = Math.round(x);
  const iy = Math.round(y);
  const iz = Number.isFinite(z) ? Math.round(z) : 0;
  const rm = getRegionManager();
  if (!rm) return { x: ix, y: iy, z: iz };
  const radius = Math.max(0, Math.min(40, Math.floor(Number(maxRadius) || 12)));
  const blockedAt = (tx, ty) => {
    try {
      return rm.blocked(asLocation(tx, ty, iz), null) === true;
    } catch {
      return false; // check failed: treat as walkable, don't strand
    }
  };
  if (!blockedAt(ix, iy)) return { x: ix, y: iy, z: iz };
  for (let r = 1; r <= radius; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // ring only
        const tx = ix + dx;
        const ty = iy + dy;
        if (!blockedAt(tx, ty)) return { x: tx, y: ty, z: iz };
      }
    }
  }
  return { x: ix, y: iy, z: iz };
}

module.exports = {
  setRegionManagerProvider,
  getRegionManager,
  isBlockedTile,
  snapToWalkableTile,
};
