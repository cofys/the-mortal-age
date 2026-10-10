"use strict";

/**
 * Brain-owned agility shortcut use. A strict route that cannot be solved is
 * sometimes a climbable wall: the door pattern applies - walk to the near side,
 * click Climb-over through the normal object interaction hook (Agility.plugin),
 * and let the next dispatch re-route from the far side.
 *
 * A shortcut is only used when crossing it provably gets the route closer to the
 * target: its clipping is removed to test the route, then restored, so a wall the
 * bot could walk around (or one pointing the wrong way) is left alone.
 */

const { MapObjects } = require("../../../src/main/typescript/elvarg/game/entity/impl/object/MapObjects");
const { ObjectIds } = require("../../../src/main/typescript/elvarg/util/IdEnums");
const { routeDistance, sharedRouteFinder } = require("./DoorOpening");

/**
 * Agility shortcuts bots may detour through, with the walkable tile on each side
 * (matches plugins/skills/agility/shortcuts). The bot stands on the end nearer to
 * it; the click carries it to the other.
 */
const SHORTCUTS = Object.freeze([
  Object.freeze({
    objectId: ObjectIds.CRUMBLING_WALL_3,
    ends: Object.freeze([
      Object.freeze([2934, 3355, 0]),
      Object.freeze([2936, 3355, 0]),
    ]),
  }),
]);

// The object sits beside its ends; a small sweep around the near end finds it.
const OBJECT_SEARCH_RADIUS = 2;
const ATTEMPT_COOLDOWN_MS = 2500;
// A shortcut this bot just used is not retried: crossing back is never progress.
const REUSE_COOLDOWN_MS = 30000;
const MAX_TRACKED_SHORTCUTS = 32;
const MAX_APPROACH_ROUTES = 6;

function shortcutKey(objectId, x, y, z) {
  return `${objectId}:${x},${y},${z}`;
}

function chebyshev(loc, tile) {
  return Math.max(Math.abs(loc.getX() - tile[0]), Math.abs(loc.getY() - tile[1]));
}

/** The two end tiles, nearest to the player first. */
function orderedEnds(player, ends) {
  return chebyshev(player.getLocation(), ends[0]) <= chebyshev(player.getLocation(), ends[1])
    ? [ends[0], ends[1]]
    : [ends[1], ends[0]];
}

/** The object of `entry` beside `tile` on the player's plane, if any. */
function findShortcutObject(player, entry, tile) {
  const z = player.getLocation().getZ();
  for (let dx = -OBJECT_SEARCH_RADIUS; dx <= OBJECT_SEARCH_RADIUS; dx++) {
    for (let dy = -OBJECT_SEARCH_RADIUS; dy <= OBJECT_SEARCH_RADIUS; dy++) {
      const x = tile[0] + dx;
      const y = tile[1] + dy;
      for (const object of MapObjects.mapObjects.get(MapObjects.getHash(x, y, z)) ?? []) {
        if (object?.getId?.() !== entry.objectId) {
          continue;
        }
        const loc = object.getLocation?.();
        if (!loc || loc.getX() !== x || loc.getY() !== y || loc.getZ() !== z) {
          continue;
        }
        return object;
      }
    }
  }
  return null;
}

function clickShortcut(player, state, world, attempt) {
  const objectLoc = attempt.object.getLocation();
  state.shortcutAttempt = null;
  state.recentShortcutKeys[attempt.key] = Date.now() + REUSE_COOLDOWN_MS;
  if (process.env.BOT_SHORTCUT_DEBUG === "1") {
    world.log?.("bot_brain_shortcut", {
      username: player.getUsername?.(),
      object: attempt.key,
    });
  }
  world.emitObjectInteraction?.({
    player,
    object: attempt.object,
    objectId: attempt.object.getId(),
    // Agility.plugin registers shortcuts as first-click obstacles.
    clickType: 1,
    location: {
      x: objectLoc.getX(),
      y: objectLoc.getY(),
      z: objectLoc.getZ(),
    },
    sourceLocation: {
      x: player.getLocation().getX(),
      y: player.getLocation().getY(),
      z: player.getLocation().getZ(),
    },
    handled: false,
  });
}

/**
 * Walks the in-flight attempt to the near end and clicks from any tile beside it
 * that is strictly closer to that end than the other: the end tile itself is not
 * required, so a crowd stacking on it does not block the crossing.
 */
function continueShortcutAttempt(core, player, state, world) {
  const attempt = state.shortcutAttempt;
  const loc = player.getLocation();
  const [near, far] = orderedEnds(player, attempt.ends);
  const distance = chebyshev(loc, near);
  if (distance <= 1 && distance < chebyshev(loc, far)) {
    clickShortcut(player, state, world, attempt);
    return true;
  }
  if (player.getMovementQueue?.()?.size?.() > 0) {
    return true;
  }
  attempt.routes += 1;
  const steps = core.PathFinder.calculateWalkRoute(player, near[0], near[1]);
  if (!Number.isFinite(steps) || steps <= 0 || attempt.routes >= MAX_APPROACH_ROUTES) {
    if (process.env.BOT_SHORTCUT_DEBUG === "1") {
      world.log?.("bot_brain_shortcut_drop", {
        username: player.getUsername?.(),
        object: attempt.key,
        steps,
        routes: attempt.routes,
        x: loc.getX(),
        y: loc.getY(),
      });
    }
    state.shortcutAttempt = null;
  }
  return true;
}

/**
 * Movement hook. While an attempt is in flight it owns the walk and the click.
 * After a failed dispatch (`select`), picks a shortcut whose crossing makes the
 * route reachable and starts an approach.
 * @returns {boolean} true when the brain should skip normal dispatch this tick.
 */
function maybeUseShortcut({ player, state, world, request, select = false }) {
  if (!player || !state || !request) {
    return false;
  }
  const core = world?.core;
  if (!core?.RegionManager || !core?.RsmodRouteFinding || !core?.PathFinder) {
    return false;
  }
  if (state.shortcutAttempt) {
    return continueShortcutAttempt(core, player, state, world);
  }
  if (!select) {
    return false;
  }
  const nowMs = Date.now();
  if (nowMs < Number(state.nextShortcutAttemptAt ?? 0)) {
    return false;
  }
  const targetX = Number.isFinite(request.lastSegmentX) ? request.lastSegmentX : request.x;
  const targetY = Number.isFinite(request.lastSegmentY) ? request.lastSegmentY : request.y;
  if (!Number.isFinite(targetX) || !Number.isFinite(targetY)) {
    return false;
  }
  const routeFinder = sharedRouteFinder(core);
  const baseline = routeDistance(routeFinder, player, targetX, targetY);
  if (baseline === 0) {
    return false;
  }
  state.nextShortcutAttemptAt = nowMs + ATTEMPT_COOLDOWN_MS;
  const recent = state.recentShortcutKeys ?? (state.recentShortcutKeys = {});
  if (Object.keys(recent).length > MAX_TRACKED_SHORTCUTS) {
    for (const [key, until] of Object.entries(recent)) {
      if (Number(until) <= nowMs) {
        delete recent[key];
      }
    }
  }
  for (const entry of SHORTCUTS) {
    const [near] = orderedEnds(player, entry.ends);
    const object = findShortcutObject(player, entry, near);
    if (!object) {
      continue;
    }
    const objectLoc = object.getLocation();
    const key = shortcutKey(entry.objectId, objectLoc.getX(), objectLoc.getY(), objectLoc.getZ());
    if (Number(recent[key] ?? 0) > nowMs) {
      continue;
    }
    core.RegionManager.removeObjectClipping(object);
    let crossed;
    try {
      crossed = routeDistance(routeFinder, player, targetX, targetY);
    } finally {
      core.RegionManager.addObjectClipping(object);
    }
    if (crossed >= baseline) {
      continue;
    }
    if (process.env.BOT_SHORTCUT_DEBUG === "1") {
      world.log?.("bot_brain_shortcut_attempt", {
        username: player.getUsername?.(),
        object: key,
        baseline,
        crossed,
      });
    }
    state.shortcutAttempt = { object, key, ends: entry.ends, routes: 0 };
    return continueShortcutAttempt(core, player, state, world);
  }
  return false;
}

module.exports = {
  maybeUseShortcut,
};
