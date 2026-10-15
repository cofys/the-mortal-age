const { Location } = require("../../../src/main/typescript/elvarg/game/model/Location");

function readCoord(source, axis) {
  if (!source) {
    return null;
  }
  const getter = source?.[`get${axis}`];
  const value =
    typeof getter === "function" ? getter.call(source) : source[axis.toLowerCase()];
  return Number.isFinite(value) ? value : null;
}

function readPoint(source) {
  const tile = Location.readTile(source);
  if (tile) {
    return tile;
  }
  const x = readCoord(source, "X");
  const y = readCoord(source, "Y");
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }
  const z = readCoord(source, "Z");
  return Number.isFinite(z) ? { x, y, z } : { x, y };
}

function readTile(source) {
  return Location.readTile(source);
}

function formatTile(source, fallback = "n/a") {
  const tile = readTile(source);
  return tile ? `${tile.x},${tile.y},${tile.z}` : fallback;
}

function formatPoint(point, fallback = "n/a") {
  const value = readPoint(point);
  if (!value) {
    return fallback;
  }
  const z = Number.isFinite(value.z) ? value.z : 0;
  return `${value.x},${value.y},${z}`;
}

module.exports = {
  readPoint,
  readTile,
  formatTile,
  formatPoint,
};
