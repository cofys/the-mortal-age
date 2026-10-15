function createSpawnOffsets(
  count,
  radius,
  minDistance,
  maxAttemptsPerBot
) {
  const offsets = [];
  const minDistanceSq = minDistance * minDistance;
  const radiusSq = radius * radius;
  const maxAttempts = Math.max(count * maxAttemptsPerBot, count * 10);

  let attempts = 0;
  while (offsets.length < count && attempts < maxAttempts) {
    attempts++;

    const dx = Math.floor(Math.random() * (radius * 2 + 1)) - radius;
    const dy = Math.floor(Math.random() * (radius * 2 + 1)) - radius;
    if (dx * dx + dy * dy > radiusSq) {
      continue;
    }

    let tooClose = false;
    for (const [ox, oy] of offsets) {
      const deltaX = ox - dx;
      const deltaY = oy - dy;
      if (deltaX * deltaX + deltaY * deltaY < minDistanceSq) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) {
      continue;
    }

    offsets.push([dx, dy]);
  }

  // Fallback fill guarantees all bots spawn even if density constraints are tight.
  while (offsets.length < count) {
    const dx = Math.floor(Math.random() * (radius * 2 + 1)) - radius;
    const dy = Math.floor(Math.random() * (radius * 2 + 1)) - radius;
    if (dx * dx + dy * dy > radiusSq) {
      continue;
    }
    offsets.push([dx, dy]);
  }

  return offsets;
}

function spawnLocationForIndex(baseLocation, offsets, index) {
  const [dx, dy] = offsets[index % offsets.length];
  return baseLocation.clone().translate(dx, dy, 0);
}

module.exports = {
  createSpawnOffsets,
  spawnLocationForIndex,
};
