"use strict";

const HOUSE_SCENE_CHUNKS = 13;
const HOUSE_PLANES = 4;

/** Packs the canonical 26-bit REBUILD_REGION template chunk. */
function packTemplateChunk(chunk) {
  return (((chunk.sourcePlane & 3) << 24)
    | ((chunk.sourceChunkX & 0x3ff) << 14)
    | ((chunk.sourceChunkY & 0x7ff) << 3)
    | ((chunk.rotation & 3) << 1)) >>> 0;
}

function rotateChunkX(localX, localY, rotation) {
  switch (rotation & 3) {
    case 0: return localX;
    case 1: return localY;
    case 2: return 7 - localX;
    default: return 7 - localY;
  }
}

function rotateChunkY(localX, localY, rotation) {
  switch (rotation & 3) {
    case 0: return localY;
    case 1: return 7 - localX;
    case 2: return 7 - localY;
    default: return localX;
  }
}

function rotateHotspot(localX, localY, rotation) {
  return { x: rotateChunkX(localX, localY, rotation), y: rotateChunkY(localX, localY, rotation) };
}

function emptyHousePalette() {
  return Array.from({ length: HOUSE_PLANES }, () =>
    Array.from({ length: HOUSE_SCENE_CHUNKS }, () => Array(HOUSE_SCENE_CHUNKS).fill(-1)),
  );
}

Object.assign(module.exports, { HOUSE_SCENE_CHUNKS, HOUSE_PLANES, packTemplateChunk, rotateChunkX, rotateChunkY, rotateHotspot, emptyHousePalette });
