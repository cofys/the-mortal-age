"use strict";

/**
 * DiegeticObjects — PHYSICAL ANCHORS for the no-commands migration.
 *
 * Jon's directive: no ::commands for players. The migration built interfaces
 * hooked to object names ("Market board", "War table", etc.) — but those
 * names don't exist in the game cache, so the hooks could never fire.
 *
 * This module fixes that by SPAWNING the objects programmatically. On
 * startup, it places real cache objects at capital locations:
 *   Market board  -> Bank notice board (961)
 *   War table     -> Table (593)
 *   Donation chest -> Closed chest (103)
 *   Steward's desk -> Desk (2910)
 *   Discarded papers -> Paper (7108)
 *
 * The feature modules use the GLOBAL api.onObjectInteraction(handler) and
 * check (objectId, location) against the spawned positions. This helper
 * provides the registry: isDiegeticObject(objectId, location, type).
 *
 * Why this way: the cache has no "Donation chest". Spawning a real Chest
 * and location-gating the interaction is the seed-simple path. The option
 * text comes from the handler, not the cache — any click on our spawned
 * object triggers the feature.
 */

const CAPITALS = [
  { id: "asgarnia", x: 2964, y: 3378, z: 0 },
  { id: "misthalin", x: 3165, y: 3485, z: 0 },
  { id: "kandarin", x: 2660, y: 3290, z: 0 },
  { id: "morytania", x: 3495, y: 3235, z: 0 },
  { id: "keldagrim", x: 2855, y: 10200, z: 0 },
];

// Object IDs from the cache (ObjectIdentifiers).
const OBJECT_IDS = {
  board: 961, // Bank notice board
  table: 593, // Table
  chest: 103, // Closed chest
  desk: 2910, // Desk
  papers: 7108, // Paper
};

// Offset each object from the capital center so they're not on the spawn tile.
const OFFSETS = {
  board: { dx: 3, dy: 0 },
  table: { dx: -3, dy: 2 },
  chest: { dx: 0, dy: 3 },
  desk: { dx: 2, dy: -2 },
  papers: { dx: -2, dy: -1 },
};

let pluginApi = null;
let core = null;

// Spawned positions: [{ type, objectId, x, y, z, capitalId }]
const spawned = [];

function spawnAll() {
  const { ObjectManager, GameObject, Location } = core;
  if (!ObjectManager || !GameObject || !Location) {
    console.warn("[diegetic] missing core classes, objects not spawned");
    return;
  }
  for (const capital of CAPITALS) {
    for (const [type, objectId] of Object.entries(OBJECT_IDS)) {
      const off = OFFSETS[type];
      const x = capital.x + off.dx;
      const y = capital.y + off.dy;
      const z = capital.z;
      try {
        const loc = new Location(x, y, z);
        const obj = new GameObject(objectId, loc, 10, 0, null);
        ObjectManager.register(obj, true);
        spawned.push({ type, objectId, x, y, z, capitalId: capital.id });
      } catch (error) {
        console.warn("[diegetic] spawn failed", { type, capital: capital.id, error: error?.message });
      }
    }
  }
  console.info("[diegetic] objects spawned", { count: spawned.length });
}

/**
 * Is this (objectId, location) one of our spawned diegetic objects?
 * Returns the spawn record { type, capitalId, ... } or null.
 */
function matchDiegetic(objectId, location, type) {
  const x = location?.x ?? location?.getX?.() ?? 0;
  const y = location?.y ?? location?.getY?.() ?? 0;
  const z = location?.z ?? location?.getZ?.() ?? 0;
  for (const s of spawned) {
    if (type && s.type !== type) continue;
    if (s.objectId !== objectId) continue;
    if (Math.abs(s.x - x) <= 2 && Math.abs(s.y - y) <= 2 && s.z === z) {
      return s;
    }
  }
  return null;
}

function initDiegeticObjects(api) {
  pluginApi = api;
  core = api.core;
  // Spawn after the world is ready — delay one tick.
  try {
    const { Task } = require("../../src/main/typescript/elvarg/game/task/Task");
    class SpawnTask extends Task {
      execute() {
        spawnAll();
        this.stop?.();
      }
    }
    api.getTaskManager()?.submit(new SpawnTask(2));
  } catch {
    // Fallback: try immediately.
    spawnAll();
  }
}

module.exports = { initDiegeticObjects, matchDiegetic, OBJECT_IDS, CAPITALS };
