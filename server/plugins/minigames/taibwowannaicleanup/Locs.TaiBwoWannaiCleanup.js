/**
 * Tai Bwo Wannai Cleanup: the jungle and fence locs everyone shares. A hacked jungle or repaired
 * fence is swapped for its next form in place (same shape and rotation, as loc_add_change shows),
 * and goes back once its time is up: a jungle to its first stage 149 ticks after its last change,
 * a fence straight to rotten 1000 ticks after its last repair (rsprox 227/01858, 231/03030).
 */
const Common = require("./Common.TaiBwoWannaiCleanup");

/** By tile: { original, current, due, restoreId }. */
const changed = new Map();

const key = (location) => `${location.getX()},${location.getY()},${location.getZ()}`;
const now = () => Common.core.World.getProcessCycle();

/** The loc at `location` with one of `ids`, or null. */
function find(ids, location) {
  const { MapObjects } = Common.core;
  for (const id of ids) {
    const object = MapObjects.get(id, location, null);
    if (object) return object;
  }
  return null;
}

/** Puts `newId` in place of `object` until `ticks` from now, then `restoreId` (default: the map's own loc). */
function swap(object, newId, ticks, restoreId = null) {
  const { GameObject, ObjectManager } = Common.core;
  const tile = key(object.getLocation());
  const entry = changed.get(tile) ?? { original: object };
  const next = new GameObject(newId, object.getLocation().clone(), object.getType(), object.getFace(), null);
  ObjectManager.deregister(object, true);
  ObjectManager.register(next, true);
  entry.current = next;
  entry.due = now() + ticks;
  entry.restoreId = restoreId ?? entry.original.getId();
  changed.set(tile, entry);
  return next;
}

function restore(tile, entry) {
  const { GameObject, ObjectManager, MapObjects } = Common.core;
  changed.delete(tile);
  const live = MapObjects.get(entry.current.getId(), entry.current.getLocation(), null);
  if (live) ObjectManager.deregister(live, true);
  const { original } = entry;
  ObjectManager.register(entry.restoreId === original.getId()
    ? original
    : new GameObject(entry.restoreId, original.getLocation().clone(), original.getType(), original.getFace(), null), true);
}

/** Restores every loc whose time is up (run each tick). */
function process() {
  const tick = now();
  for (const [tile, entry] of [...changed]) {
    if (entry.due <= tick) restore(tile, entry);
  }
}

function attachLocs() {
  const { Task, TaskManager } = Common.core;
  TaskManager.submit(new (class extends Task {
    constructor() {
      super(1, "tai-bwo-wannai-cleanup:locs", false);
    }
    execute() {
      process();
    }
  })());
}

module.exports = {
  attachLocs, find, swap, process,
  /** Tests: the pending restores, and forgetting them. */
  _changed: changed,
  _reset() { changed.clear(); },
};
