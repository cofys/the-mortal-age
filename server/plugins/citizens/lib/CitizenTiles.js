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

/**
 * True when the tile is open water, via the region's water layer.
 * Open water carries no block flags in this fork's collision (Jon
 * 2026-10-13: citizens standing in the ocean at Draynor reported
 * blocked:false), so blocked() alone cannot see it. The engine tracks
 * water separately from cache terrain overlays (Region.isWater).
 * Null when walkability can't be determined (no region manager).
 */
function isWaterTile(x, y, z) {
  const rm = getRegionManager();
  if (!rm || typeof rm.isWater !== "function") return null;
  try {
    return rm.isWater(asLocation(x, y, z)) === true;
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
 *
 * Water counts as blocked: open sea carries no block flags in this fork's
 * collision, so the region's water layer is consulted too (Jon 2026-10-13:
 * Draynor shoreline — citizens fished standing on water tiles that reported
 * blocked:false). Piers and bridges are safe: their tiles carry structure
 * overlays, not water, so isWater is false for them.
 */
function isBlockedTile(x, y, z) {
  const rm = getRegionManager();
  if (!rm) return null;
  try {
    if (rm.blocked(asLocation(x, y, z), null) === true) return true;
    if (typeof rm.isWater === "function" && rm.isWater(asLocation(x, y, z)) === true) {
      return true;
    }
    return false;
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
      if (rm.blocked(asLocation(tx, ty, iz), null) === true) return true;
      // Water counts as blocked (see isBlockedTile): the snap must never
      // leave a citizen standing in the sea.
      if (typeof rm.isWater === "function" && rm.isWater(asLocation(tx, ty, iz)) === true) {
        return true;
      }
      return false;
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
  isWaterTile,
  snapToWalkableTile,
};
