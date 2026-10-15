const ARENA = Object.freeze({ minX: 2495, maxX: 2514, minY: 7823, maxY: 7853, z: 3 });

/**
 * OSRS's final Lowerniel lunge uses a special roll that ignores normal
 * collision/pathing. Claim only a valid click during the lunge's one-tick
 * warning; all ordinary movement remains on the normal route.
 */
function handleDrakanDodgeRoll(event, fight, core) {
  const player = event?.player;
  const destination = event?.destination;
  const current = player?.getLocation?.();
  if (!player || !fight || fight.player !== player || player.getArea?.() !== fight.area ||
      fight.phase !== 3 || fight.special !== "lunges" ||
      !["lunge-appearances", "lunge"].includes(fight.warning) || fight.lungeRolled ||
      !Number.isFinite(fight.impactAt) || fight.impactAt <= 0 || !destination || !current) return false;

  const x = Number(destination.x ?? destination.getX?.());
  const y = Number(destination.y ?? destination.getY?.());
  const z = Number(destination.z ?? destination.getZ?.());
  const fromX = current.getX();
  const fromY = current.getY();
  const fromZ = current.getZ();
  if (![x, y, z, fromX, fromY, fromZ].every(Number.isInteger) || z !== ARENA.z || fromZ !== ARENA.z ||
      x < ARENA.minX || x > ARENA.maxX || y < ARENA.minY || y > ARENA.maxY) return false;
  const landing = new core.Location(x, y, z);
  if (core.RegionManager.blocked(landing, fight.area)) return false;

  const directions = ["north", "east", "south", "west"];
  const finalDirection = fight.warning === "lunge"
    ? fight.lungeDirection
    : directions[(fight.lungeIndex + fight.lungeCycles + 2) % directions.length];
  const verticalAttack = finalDirection === "north" || finalDirection === "south";
  const horizontalAttack = finalDirection === "east" || finalDirection === "west";
  if (!verticalAttack && !horizontalAttack) return false;
  const parallel = verticalAttack ? Math.abs(y - fromY) : Math.abs(x - fromX);
  const perpendicular = verticalAttack ? Math.abs(x - fromX) : Math.abs(y - fromY);
  if (parallel !== 0 || perpendicular < 2 || perpendicular > 5) return false;

  fight.lungeRolled = true;
  event.handled = true;
  player.moveTo(landing);
  return true;
}

module.exports = { ARENA, handleDrakanDodgeRoll };
