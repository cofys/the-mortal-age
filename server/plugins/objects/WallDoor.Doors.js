"use strict";

// A straight wall door separates its own tile from the neighbour across its face.
function crossingFor(object, from) {
  if (object?.getType?.() !== 0) return null;
  const at = object.getLocation();
  const [dx, dy] = [[-1, 0], [0, 1], [1, 0], [0, -1]][object.getFace() & 3];
  const tile = { x: at.x, y: at.y, z: at.z };
  const neighbour = { x: at.x + dx, y: at.y + dy, z: at.z };
  const outside = (from.x - at.x) * dx + (from.y - at.y) * dy > 0;
  return { approach: outside ? neighbour : tile, destination: outside ? tile : neighbour };
}

module.exports = { crossingFor };
