"use strict";

/**
 * NPC counterpart of the object index: spawns grouped (by name, combat level...)
 * into 32x32-tile cells, so a bot can find the nearest group of training
 * opponents or fishing spots
 * without hand-drawn areas or scanning every NPC. Built once per world from the
 * live NPC list (spawn tiles, so wandering does not move a cluster).
 */

const CELL_SHIFT = 5;
// Surface Wilderness: bots training or gathering here would be farmed by PvP bots.
const WILDERNESS = { minX: 2944, maxX: 3392, minY: 3520, maxY: 3967 };

function inWilderness(x, y, z) {
  return z === 0 && x >= WILDERNESS.minX && x <= WILDERNESS.maxX &&
    y >= WILDERNESS.minY && y <= WILDERNESS.maxY;
}

/** Group keys are case-insensitive strings: an NPC name, or a combat level. */
const groupKey = (key) => String(key).toLowerCase();

/**
 * @param entries [{ key, x, y, z }] - key groups spawns (NPC name, combat level...)
 * @param exclude (x, y, z) => true drops a spawn (members land on a F2P world)
 * @returns Map(group key -> Map(cell key -> { key, x, y, z, count }))
 */
function buildNpcClusters(entries, exclude = () => false) {
  const byName = new Map();
  for (const { key: group, x, y, z } of entries) {
    if (group === null || group === undefined || inWilderness(x, y, z) || exclude(x, y, z)) {
      continue;
    }
    const lower = groupKey(group);
    let cells = byName.get(lower);
    if (!cells) {
      byName.set(lower, (cells = new Map()));
    }
    const key = `${x >> CELL_SHIFT},${y >> CELL_SHIFT},${z}`;
    let cell = cells.get(key);
    if (!cell) {
      cells.set(key, (cell = { key, sumX: 0, sumY: 0, z, count: 0 }));
    }
    cell.count += 1;
    cell.sumX += x;
    cell.sumY += y;
  }
  for (const cells of byName.values()) {
    for (const cell of cells.values()) {
      cell.x = Math.round(cell.sumX / cell.count);
      cell.y = Math.round(cell.sumY / cell.count);
    }
  }
  return byName;
}

/**
 * Clusters of any of `keys` on the bot's plane, nearest first. Groups sharing a
 * cell merge into one cluster (cows and goblins in one field crowd each other).
 */
function nearestClusters(index, keys, from) {
  const merged = new Map();
  for (const key of keys) {
    for (const cell of index.get(groupKey(key))?.values() ?? []) {
      if (cell.z !== from.z) {
        continue;
      }
      const into = merged.get(cell.key);
      if (into) {
        into.x = Math.round((into.x * into.count + cell.x * cell.count) / (into.count + cell.count));
        into.y = Math.round((into.y * into.count + cell.y * cell.count) / (into.count + cell.count));
        into.count += cell.count;
      } else {
        merged.set(cell.key, { key: cell.key, x: cell.x, y: cell.y, z: cell.z, count: cell.count });
      }
    }
  }
  const clusters = [...merged.values()];
  for (const cluster of clusters) {
    cluster.distance = Math.max(Math.abs(cluster.x - from.x), Math.abs(cluster.y - from.y));
  }
  return clusters.sort((a, b) => a.distance - b.distance);
}

const INDEX_BY_WORLD = new WeakMap();

/**
 * The world's cluster index for one grouping, built from its live NPCs on first
 * use. `keyOf(definition)` returns the group key, or several (a fishing spot with both a
 * cage and a harpoon); null skips the NPC. `cacheKey`
 * names that grouping so each caller's index is built once.
 */
function npcClustersFor(world, cacheKey, keyOf) {
  let byKey = INDEX_BY_WORLD.get(world);
  if (!byKey) {
    INDEX_BY_WORLD.set(world, (byKey = new Map()));
  }
  const cached = byKey.get(cacheKey);
  if (cached) {
    return cached;
  }
  const { World, WorldDefinition } = world.core;
  const entries = [];
  for (const npc of World.getNpcs()) {
    if (!npc || npc.getPrivateArea?.()) {
      continue;
    }
    const spawn = npc.getSpawnPosition?.() ?? npc.getLocation();
    const keys = keyOf(npc.getDefinition?.());
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      entries.push({ key, x: spawn.getX(), y: spawn.getY(), z: spawn.getZ() });
    }
  }
  const index = buildNpcClusters(entries, (x, y) => WorldDefinition?.isMembersArea?.(x, y) === true);
  // ponytail: built once; NPCs spawned after the first query (events) are not indexed.
  // An empty world (queried before NPCs load) is not cached, so it retries.
  if (entries.length) {
    byKey.set(cacheKey, index);
  }
  return index;
}

module.exports = {
  buildNpcClusters,
  nearestClusters,
  npcClustersFor,
};
