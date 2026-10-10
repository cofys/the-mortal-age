"use strict";

/**
 * Wall-aware object reach from the core route finder: true when the bot can
 * route to an interaction tile of the object from where it stands (object shape
 * and facing included).
 *
 * Actions that hand a nearby target to the core `walkToObject`/`walkToEntity`
 * must check this first. Core routing fails silently when a wall, fence or
 * closed gate is between - the arrival callback never fires - while the brain's
 * movement path runs the traversal hooks (`DoorOpening`, `ShortcutCrossing`,
 * `Climbing`) that open, climb or cross the way.
 *
 * `createEntityReachChecker` is the NPC counterpart: it routes into clicking
 * reach of the entity (`reachedAbsolute` from the route's end), so a spot behind
 * a level-locked door (the Fishing Guild below 68) reads as unreachable even
 * though a `moveNear` route to just outside the door exists.
 *
 * No core route finder (unit tests) means "assume reachable": the core walk is
 * then the old behaviour.
 */
/** A route finder, or null when the core has none (unit tests: assume reachable). */
function routeFinderFor(core) {
  const RouteFinder = core?.RsmodRouteFinding ?? null;
  return RouteFinder ? new RouteFinder() : null;
}

/** The source-side route fields both checks share, read from where the player stands. */
function sourceRoute(player) {
  const from = player.getLocation();
  return {
    level: from.getZ(),
    srcX: from.getX(),
    srcY: from.getY(),
    srcSize: Math.max(1, Math.floor(player.getSize?.() ?? 1)),
    privateArea: player.getPrivateArea?.() ?? null,
  };
}

function createObjectReachChecker(core) {
  const routeFinder = routeFinderFor(core);
  if (!routeFinder) {
    return () => true;
  }
  return function canReach(player, object) {
    const objectLoc = object.getLocation();
    const definition = object.getDefinition?.();
    return routeFinder.findRoute({
      ...sourceRoute(player),
      destX: objectLoc.getX(), destY: objectLoc.getY(),
      destWidth: Math.max(1, definition?.getSizeX?.() ?? 1),
      destLength: Math.max(1, definition?.getSizeY?.() ?? 1),
      locAngle: object.getFace?.() ?? 0, locShape: object.getType?.() ?? 10,
      moveNear: false, blockAccessFlags: 0, maxWaypoints: 25,
    }).success === true;
  };
}

function createEntityReachChecker(core) {
  const routeFinder = routeFinderFor(core);
  if (!routeFinder) {
    return () => true;
  }
  return function canReach(player, entity) {
    const at = entity.getLocation();
    const source = sourceRoute(player);
    const size = Math.max(1, Math.floor(entity.getSize?.() ?? 1));
    const route = routeFinder.findRoute({
      ...source,
      destX: at.getX(), destY: at.getY(), destWidth: size, destLength: size,
      locAngle: 0, locShape: -2, moveNear: true, blockAccessFlags: 0,
      maxWaypoints: 25,
    });
    if (!route.success) {
      return false;
    }
    return routeFinder.reachedAbsolute({
      level: source.level, srcX: route.endX, srcY: route.endY, srcSize: source.srcSize,
      destX: at.getX(), destY: at.getY(), destWidth: size, destLength: size,
      locShape: -2, privateArea: source.privateArea,
    }) === true;
  };
}

module.exports = {
  createObjectReachChecker,
  createEntityReachChecker,
};
