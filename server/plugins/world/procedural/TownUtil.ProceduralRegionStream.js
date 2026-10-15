const { generateHouseForRect } = require("./BuildingUtil.ProceduralRegionStream");

const REGION_SIZE = 64;
const DEFAULT_STREET_WIDTH = 4;
const MIN_HOUSE_WIDTH = 9;
const MAX_HOUSE_WIDTH = 16;
const MIN_HOUSE_DEPTH = 9;
const MAX_HOUSE_DEPTH = 14;
const STREET_PATH_OVERLAY = 10;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

class XorShift32 {
  constructor(seed) {
    this.state = (seed >>> 0) || 0x9e3779b9;
  }

  nextU32() {
    let x = this.state >>> 0;
    x ^= (x << 13) >>> 0;
    x ^= x >>> 17;
    x ^= (x << 5) >>> 0;
    this.state = x >>> 0;
    return this.state;
  }

  nextInt(min, maxInclusive) {
    if (maxInclusive <= min) {
      return min;
    }
    return min + (this.nextU32() % (maxInclusive - min + 1));
  }
}

function buildStreetPlan(size, rng, streetWidth = DEFAULT_STREET_WIDTH) {
  const clampedStreetWidth = clamp(streetWidth | 0, 3, 8);
  const streetStartY = ((size - clampedStreetWidth) / 2) | 0;
  const streetEndY = streetStartY + clampedStreetWidth - 1;

  const lotsNorth = [];
  const lotsSouth = [];
  let cursorX = 2;
  const maxX = size - 2;

  while (cursorX <= maxX - MIN_HOUSE_WIDTH) {
    const maxWidthAtCursor = maxX - cursorX;
    if (maxWidthAtCursor < MIN_HOUSE_WIDTH) {
      break;
    }
    const width = clamp(rng.nextInt(MIN_HOUSE_WIDTH, MAX_HOUSE_WIDTH), MIN_HOUSE_WIDTH, maxWidthAtCursor);

    const maxNorthDepth = streetStartY - 1;
    const maxSouthDepth = size - streetEndY - 2;
    if (maxNorthDepth < MIN_HOUSE_DEPTH || maxSouthDepth < MIN_HOUSE_DEPTH) {
      break;
    }

    const northDepth = clamp(rng.nextInt(MIN_HOUSE_DEPTH, MAX_HOUSE_DEPTH), MIN_HOUSE_DEPTH, maxNorthDepth);
    const southDepth = clamp(rng.nextInt(MIN_HOUSE_DEPTH, MAX_HOUSE_DEPTH), MIN_HOUSE_DEPTH, maxSouthDepth);

    const northMinY = streetStartY - northDepth + 1;
    const southMinY = streetEndY;
    if (northMinY < 2 || southMinY + southDepth - 1 > size - 3) {
      break;
    }

    lotsNorth.push({
      x: cursorX,
      y: northMinY,
      w: width,
      h: northDepth,
      side: "north",
      doorOrientation: 3, // Door faces south, into the street.
    });
    lotsSouth.push({
      x: cursorX,
      y: southMinY,
      w: width,
      h: southDepth,
      side: "south",
      doorOrientation: 1, // Door faces north, into the street.
    });

    let spacing = rng.nextInt(0, 1);
    if (rng.nextInt(0, 99) < 15) {
      spacing += 1;
    }
    cursorX += width + spacing;
  }

  return {
    streetStartY,
    streetEndY,
    streetWidth: clampedStreetWidth,
    northLots: lotsNorth,
    southLots: lotsSouth,
  };
}

function generateStreetTownForRegion(styleTag, houseType, seed, size = REGION_SIZE) {
  const normalizedSeed = seed >>> 0;
  const rng = new XorShift32((normalizedSeed ^ 0x7f4a7c15) >>> 0);
  const plan = buildStreetPlan(size, rng, DEFAULT_STREET_WIDTH);

  const buildings = [];
  const floorPatches = [];
  const placements = [];
  const sideBounds = {
    north: null,
    south: null,
  };
  const overlayMap = new Map();
  const mainPathLowerY = plan.streetStartY + Math.max(0, ((plan.streetWidth - 2) >> 1));
  const mainPathUpperY = mainPathLowerY + 1;

  const overlayKey = (x, y, z) => `${x},${y},${z}`;
  const addOverlay = (x, y, z = 0, overlay = STREET_PATH_OVERLAY) => {
    const localX = x | 0;
    const localY = y | 0;
    const plane = z | 0;
    if (localX < 0 || localX >= size || localY < 0 || localY >= size || plane < 0 || plane >= 4) {
      return;
    }
    overlayMap.set(overlayKey(localX, localY, plane), overlay & 0xff);
  };

  const connectDoorwayToStreet = (doorway) => {
    if (!doorway || (doorway.z | 0) !== 0) {
      return;
    }
    const x = doorway.x | 0;
    const y = doorway.y | 0;
    const orientation = (doorway.orientation | 0) & 0x3;
    if (orientation === 3) {
      const start = y + 1;
      for (let tileY = start; tileY <= mainPathLowerY; tileY++) {
        addOverlay(x, tileY, 0, STREET_PATH_OVERLAY);
      }
      return;
    }
    if (orientation === 1) {
      const start = y - 1;
      for (let tileY = start; tileY >= mainPathUpperY; tileY--) {
        addOverlay(x, tileY, 0, STREET_PATH_OVERLAY);
      }
      return;
    }
    if (orientation === 0) {
      for (let tileX = x - 1; tileX >= (size >> 1); tileX--) {
        addOverlay(tileX, y, 0, STREET_PATH_OVERLAY);
      }
      return;
    }
    if (orientation === 2) {
      for (let tileX = x + 1; tileX <= (size >> 1); tileX++) {
        addOverlay(tileX, y, 0, STREET_PATH_OVERLAY);
      }
    }
  };

  const extendSideBounds = (side, rect) => {
    if (!rect) {
      return;
    }
    const minX = rect.x | 0;
    const minY = rect.y | 0;
    const maxX = minX + ((rect.w | 0) - 1);
    const maxY = minY + ((rect.h | 0) - 1);
    const existing = sideBounds[side];
    if (!existing) {
      sideBounds[side] = { minX, minY, maxX, maxY };
      return;
    }
    existing.minX = Math.min(existing.minX, minX);
    existing.minY = Math.min(existing.minY, minY);
    existing.maxX = Math.max(existing.maxX, maxX);
    existing.maxY = Math.max(existing.maxY, maxY);
  };

  let houseIndex = 0;
  const generateLotHouse = (lot) => {
    const houseSeed = (normalizedSeed + Math.imul(houseIndex + 1, 0x9e3779b1)) >>> 0;
    houseIndex++;
    const floors = rng.nextInt(0, 99) < 68 ? 1 : 2;
    const generated = generateHouseForRect(
      styleTag,
      houseSeed,
      lot,
      floors,
      0,
      houseType,
      lot.doorOrientation
    );
    buildings.push({
      style: generated.styleKey,
      side: lot.side,
      x: generated.x,
      y: generated.y,
      width: generated.width,
      height: generated.height,
      floors: generated.floors,
    });
    floorPatches.push(...generated.floorPatches);
    placements.push(...generated.placements);
    extendSideBounds(lot.side, { x: generated.x, y: generated.y, w: generated.width, h: generated.height });
    for (const doorway of generated.doorways ?? []) {
      connectDoorwayToStreet(doorway);
    }
  };

  for (let x = 2; x <= size - 3; x++) {
    addOverlay(x, mainPathLowerY, 0, STREET_PATH_OVERLAY);
    addOverlay(x, mainPathUpperY, 0, STREET_PATH_OVERLAY);
  }

  const pairCount = Math.min(plan.northLots.length, plan.southLots.length);
  for (let i = 0; i < pairCount; i++) {
    generateLotHouse(plan.northLots[i]);
    generateLotHouse(plan.southLots[i]);
  }

  const explicitOverlayTiles = [];
  for (const [key, overlay] of overlayMap.entries()) {
    const [xText, yText, zText] = key.split(",");
    explicitOverlayTiles.push({
      x: Number.parseInt(xText, 10),
      y: Number.parseInt(yText, 10),
      z: Number.parseInt(zText, 10),
      overlay: overlay & 0xff,
    });
  }

  const flattenRects = [];
  for (const side of ["north", "south"]) {
    const bounds = sideBounds[side];
    if (!bounds) {
      continue;
    }
    flattenRects.push({
      x: bounds.minX,
      y: bounds.minY,
      w: bounds.maxX - bounds.minX + 1,
      h: bounds.maxY - bounds.minY + 1,
    });
  }

  return {
    streetStartY: plan.streetStartY,
    streetEndY: plan.streetEndY,
    streetWidth: plan.streetWidth,
    buildings,
    floorPatches,
    placements,
    flattenRects,
    explicitOverlayTiles,
  };
}

module.exports = {
  generateStreetTownForRegion,
};
