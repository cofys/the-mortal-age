const fs = require("fs");
const path = require("path");
const { ObjectDefinition } = require("../../../src/main/typescript/elvarg/game/definition/ObjectDefinition");
const { ObjectType } = require("./ObjectType.ProceduralRegionStream");
const { PRESET_OUTPUT_PATH, HOUSE_DUMP_DIRECTORY } = require("./ProceduralDataPaths.ProceduralRegionStream");
const {
  LADDER_SIDE,
  LADDER_SIDE_VALUES,
  isLadderName,
  isLadderIdentifierId,
  parseIdSequenceKey,
  resolveRelativeBoundarySide,
  normalizeLadderCatalogEntry,
  resolveLadderPlacement,
} = require("./LadderUtil.ProceduralRegionStream");

const LEARNED_PRESET_PATH = PRESET_OUTPUT_PATH;

const HOUSE_TYPES = Object.freeze([
  // Ported from RSPSi procedural HouseType/WallType presets.
  // {
  //   key: "NORMAL",
  //   floorUnderlay: 108,
  //   wallId: 1902,
  //   wallCornerId: 1631,
  //   wallCornerType: 3,
  //   doorId: 1535,
  //   roofEdgeId: 1793,
  //   roofTopId: 1640,
  // },
  {
    key: "VARROCK",
    floorUnderlay: 22,
    wallId: 23735,
    wallCornerId: 23735,
    wallCornerType: 1,
    doorId: 11775,
    windowIds: [23743],
    roofEdgeId: 15552,
    roofTopId: 15552,
  },
  // {
  //   key: "BARBARIAN",
  //   floorUnderlay: 108,
  //   wallId: 11558,
  //   wallCornerId: -1,
  //   wallCornerType: 3,
  //   doorId: 1535,
  //   roofEdgeId: 4242,
  //   roofTopId: 11586,
  // },
  // {
  //   key: "CANAFIS",
  //   floorUnderlay: 57,
  //   wallId: 24371,
  //   wallCornerId: 24379,
  //   wallCornerType: 3,
  //   doorId: 24369,
  //   roofEdgeId: 15552,
  //   roofTopId: 15552,
  // },
]);

const DEFAULT_INTERIOR_OBJECTS = Object.freeze([
  { id: 154, type: ObjectType.INTERACTIVE }, // chair-like
  { id: 155, type: ObjectType.INTERACTIVE }, // table-like
  { id: 673, type: ObjectType.INTERACTIVE }, // crate-like
]);

const ROOF_EDGE_SIDE_TYPE = ObjectType.ROOF_EDGE_SIDE;
const ROOF_EDGE_CORNER_TYPE = ObjectType.ROOF_RIDGE_CORNER;
const ROOF_TOP_CORNER_TYPE = ObjectType.ROOF_EDGE_CORNER;
const ROOF_TOP_FLAT_TYPE = ObjectType.ROOF_TOP_FLAT;
const ROOF_TOP_SIDE_TYPE = ObjectType.ROOF_SLOPE;
const SINGLE_HOUSE_MIN_DIM = 7;
const SINGLE_HOUSE_MAX_DIM = 24;

let learnedPresetCache = null;
let learnedPresetMtimeMs = -1;
const houseDumpProfileCache = new Map();

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function readLearnedPreset() {
  try {
    const stat = fs.statSync(LEARNED_PRESET_PATH);
    if (stat.mtimeMs === learnedPresetMtimeMs && learnedPresetCache) {
      return learnedPresetCache;
    }
    const raw = fs.readFileSync(LEARNED_PRESET_PATH, "utf8");
    const parsed = JSON.parse(raw);
    learnedPresetCache = parsed;
    learnedPresetMtimeMs = stat.mtimeMs;
    return parsed;
  } catch {
    learnedPresetCache = null;
    learnedPresetMtimeMs = -1;
    return null;
  }
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
    const span = maxInclusive - min + 1;
    return min + (this.nextU32() % span);
  }

  pick(items) {
    if (!Array.isArray(items) || items.length === 0) {
      return null;
    }
    return items[this.nextInt(0, items.length - 1)];
  }
}

function rectsOverlap(a, b, padding = 1) {
  return !(
    a.x + a.w + padding <= b.x ||
    b.x + b.w + padding <= a.x ||
    a.y + a.h + padding <= b.y ||
    b.y + b.h + padding <= a.y
  );
}

function normalizeInteriorObjects(contents) {
  const learned = Array.isArray(contents?.interiorObjects) ? contents.interiorObjects : [];
  const valid = learned
    .filter((entry) => Number.isInteger(entry?.id) && entry.id > 0 && !isLikelyLadderId(entry.id))
    .map((entry) => ({
      id: entry.id,
      type: ObjectType.INTERACTIVE,
    }))
    .slice(0, 24);
  return valid.length > 0 ? valid : DEFAULT_INTERIOR_OBJECTS;
}

function normalizeStyle(style, index, contentFallback) {
  if (!style || !Number.isInteger(style.wallId) || !Number.isInteger(style.doorId)) {
    return null;
  }
  if (!Number.isInteger(style.roofEdgeId) || !Number.isInteger(style.roofTopId)) {
    return null;
  }
  const windowFallback = Array.isArray(contentFallback?.windowIds) ? contentFallback.windowIds : [];
  const decorFallback = Array.isArray(contentFallback?.wallDecorIds) ? contentFallback.wallDecorIds : [];
  return {
    key: style.key || `LEARNED_${index + 1}`,
    floorUnderlay: Number.isInteger(style.floorUnderlay) ? style.floorUnderlay : 22,
    wallId: style.wallId,
    wallCornerId: Number.isInteger(style.wallCornerId) ? style.wallCornerId : style.wallId,
    wallCornerType: Number.isInteger(style.wallCornerType) ? style.wallCornerType : 3,
    doorId: style.doorId,
    roofEdgeId: style.roofEdgeId,
    roofTopId: style.roofTopId,
    windowIds: Array.isArray(style.windowIds) && style.windowIds.length > 0 ? style.windowIds : windowFallback,
    windowIdPool:
      Array.isArray(style.windowIdPool) && style.windowIdPool.length > 0
        ? style.windowIdPool.filter((id) => Number.isInteger(id) && id > 0)
        : Array.isArray(style.windowIds) && style.windowIds.length > 0
          ? style.windowIds.filter((id) => Number.isInteger(id) && id > 0)
          : windowFallback,
    wallDecorIds: Array.isArray(style.wallDecorIds) && style.wallDecorIds.length > 0 ? style.wallDecorIds : decorFallback,
  };
}

function sanitizeStyleTag(raw) {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeHouseExampleType(raw) {
  const text = String(raw ?? "").trim();
  if (!text) {
    return null;
  }
  const normalized = text
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized : null;
}

function incrementHistogram(histogram, key, amount = 1) {
  if (!Number.isInteger(key) || key <= 0) {
    return;
  }
  histogram.set(key, (histogram.get(key) ?? 0) + amount);
}

function topHistogramEntries(histogram, limit = 12) {
  return [...histogram.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

function weightedPoolFromHistogram(histogram, validateFn = null, limit = 8, maxWeight = 6) {
  const entries = topHistogramEntries(histogram, limit).filter(([value]) => (validateFn ? validateFn(value) : true));
  if (entries.length === 0) {
    return [];
  }
  const topCount = entries[0][1] || 1;
  const pool = [];
  for (const [value, count] of entries) {
    const weight = clamp(Math.round((count / topCount) * maxWeight), 1, maxWeight);
    for (let i = 0; i < weight; i++) {
      pool.push(value);
    }
  }
  return pool;
}

function chooseFromPoolOrFallback(pool, fallback, rng) {
  if (Array.isArray(pool) && pool.length > 0) {
    return rng.pick(pool);
  }
  return fallback;
}

function normalizeInteriorPlacementType(type) {
  if (type === ObjectType.GROUND_DECOR || type === ObjectType.INTERACTIVE) {
    return type;
  }
  return ObjectType.INTERACTIVE;
}

function encodeObjectPoolKey(id, type) {
  return `${id}:${normalizeInteriorPlacementType(type)}`;
}

function parseObjectPoolKey(key) {
  const [idText, typeText] = String(key).split(":");
  const id = Number.parseInt(idText, 10);
  const type = Number.parseInt(typeText, 10);
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(type)) {
    return null;
  }
  return {
    id,
    type: normalizeInteriorPlacementType(type),
  };
}

function weightedObjectPoolFromHistogram(histogram, limit = 12, maxWeight = 6) {
  const pool = weightedPoolFromCountMap(histogram, limit, maxWeight);
  return pool
    .map((value) => parseObjectPoolKey(value))
    .filter((entry) => entry && isValidObjectId(entry.id));
}

function incrementCount(histogram, key, amount = 1) {
  if (key === null || key === undefined || amount <= 0) {
    return;
  }
  histogram.set(key, (histogram.get(key) ?? 0) + amount);
}

function weightedPoolFromCountMap(histogram, limit = 8, maxWeight = 6) {
  if (!(histogram instanceof Map) || histogram.size === 0) {
    return [];
  }
  const entries = [...histogram.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);
  if (entries.length === 0) {
    return [];
  }
  const topCount = entries[0][1] || 1;
  const pool = [];
  for (const [value, count] of entries) {
    const weight = clamp(Math.round((count / topCount) * maxWeight), 1, maxWeight);
    for (let i = 0; i < weight; i++) {
      pool.push(value);
    }
  }
  return pool;
}

function getObjectMetadata(id) {
  if (!Number.isInteger(id) || id <= 0) {
    return null;
  }
  try {
    const definition = ObjectDefinition.forId(id);
    if (!definition) {
      return null;
    }
    const name = String(definition.getName?.() ?? "").toLowerCase();
    const actions = Array.isArray(definition.getInteractions?.())
      ? definition
          .getInteractions()
          .filter((value) => typeof value === "string" && value.trim().length > 0)
          .map((value) => String(value).toLowerCase())
      : [];
    return { name, actions };
  } catch {
    return null;
  }
}

function isLikelyDoorId(id) {
  const metadata = getObjectMetadata(id);
  if (!metadata) {
    return false;
  }
  if (/door|gate|arch|portcullis/.test(metadata.name)) {
    return true;
  }
  return metadata.actions.some((action) => /open|close|enter|go through|walk-through|pass/.test(action));
}

function isLikelyWindowId(id) {
  const metadata = getObjectMetadata(id);
  if (!metadata) {
    return false;
  }
  return /window/.test(metadata.name);
}

function isLikelyLadderId(id) {
  const metadata = getObjectMetadata(id);
  if (metadata && isLadderName(metadata.name)) {
    return true;
  }
  return isLadderIdentifierId(id);
}

const CORNER_TYPES = new Set([ObjectType.WALL_DIAGONAL_CORNER, ObjectType.WALL_L, ObjectType.WALL_SQUARE_CORNER]);
const ROOF_EDGE_TYPES = new Set([ObjectType.ROOF_EDGE_CORNER, ObjectType.ROOF_EDGE_SIDE]);
const ROOF_TOP_TYPES = new Set([
  ObjectType.ROOF_SLOPE,
  ObjectType.ROOF_FLAT,
  ObjectType.ROOF_SLOPE_WITH_BORDER,
  ObjectType.ROOF_FLAT_WITH_BORDER,
  ObjectType.ROOF_SLOPE_CORNER,
  ObjectType.ROOF_TOP_CORNER,
  ObjectType.ROOF_RIDGE_CORNER,
  ObjectType.ROOF_TOP_FLAT,
]);
const INTERIOR_SCORING_TYPES = new Set([
  ObjectType.INTERACTIVE,
  ObjectType.GROUND_DECOR,
  ObjectType.WALL_DECOR_STRAIGHT,
  ObjectType.WALL_DECOR_DIAGONAL,
  ObjectType.WALL_DECORATION,
]);

function resolveFallbackStyle(styleTag) {
  const normalizedTag = sanitizeStyleTag(styleTag);
  return (
    HOUSE_TYPES.find((style) => sanitizeStyleTag(style?.key ?? "") === normalizedTag) ??
    HOUSE_TYPES.find((style) => sanitizeStyleTag(style?.key ?? "") === "varrock") ??
    HOUSE_TYPES[0]
  );
}

function readHouseDumpProfile(styleTag, houseType = null) {
  const safeTag = sanitizeStyleTag(styleTag);
  if (!safeTag) {
    return null;
  }
  const normalizedType = normalizeHouseExampleType(houseType);
  const cacheKey = `${safeTag}::${normalizedType ?? "__UNTYPED__"}`;
  const filePath = path.join(HOUSE_DUMP_DIRECTORY, `${safeTag}.json`);
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }
  const cached = houseDumpProfileCache.get(cacheKey);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached.profile;
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
  const allExamples = Array.isArray(parsed?.examples) ? parsed.examples : [];
  const examples = allExamples.filter((example) => normalizeHouseExampleType(example?.type) === normalizedType);
  if (examples.length === 0) {
    return null;
  }

  const fallbackStyle = resolveFallbackStyle(styleTag);
  const wallHistogram = new Map();
  const wallPerimeterHistogram = new Map();
  const doorHistogram = new Map();
  const cornerIdHistogram = new Map();
  const cornerTypeHistogram = new Map();
  const roofEdgeHistogram = new Map();
  const roofTopHistogram = new Map();
  const windowHistogram = new Map();
  const decorHistogram = new Map();
  const widthHistogram = new Map();
  const heightHistogram = new Map();
  const floorHistogram = new Map();
  const floorOverlayHistogram = new Map();
  const interiorHistogram = new Map();
  const interiorDensityByFloor = new Map();
  const interiorWallAffinity = new Map();
  const interiorRelations = new Map();
  const linearDividerAxisHistogram = new Map();
  const linearDividerOffsetHistogram = new Map();
  const linearServiceOffsetHistogram = new Map();
  const linearRowGapHistogram = new Map();
  const linearFloorHistogram = new Map();
  const linearServiceLineCountHistogram = new Map();
  const linearServiceSideCountHistogram = new Map();
  const linearDividerObjectHistogram = new Map();
  const linearServiceObjectHistogram = new Map();
  const linearMiscObjectHistogram = new Map();
  const linearOrientationSideHistograms = {
    neg: new Map(),
    pos: new Map(),
  };
  const ladderPairHistogram = new Map();
  const ladderTripleHistogram = new Map();
  const ladderOrientationHistogram = new Map();
  const ladderSideHistogram = new Map();
  const ladderSideOrientationHistograms = {
    [LADDER_SIDE.WEST]: new Map(),
    [LADDER_SIDE.EAST]: new Map(),
    [LADDER_SIDE.NORTH]: new Map(),
    [LADDER_SIDE.SOUTH]: new Map(),
  };
  const ladderIdsFromCatalog = new Set();
  const parentLadders = Array.isArray(parsed?.ladders) ? parsed.ladders : [];
  for (const entry of parentLadders) {
    const normalized = normalizeLadderCatalogEntry(entry, isValidObjectId);
    if (!normalized) {
      continue;
    }
    const ladderIds =
      normalized.levels === 3
        ? [normalized.bottomId, normalized.middleId, normalized.topId]
        : [normalized.bottomId, normalized.topId];
    const ladderKey = ladderIds.join(":");
    if (normalized.levels === 3) {
      incrementCount(ladderTripleHistogram, ladderKey, normalized.count);
    } else {
      incrementCount(ladderPairHistogram, ladderKey, normalized.count);
    }
    for (const id of ladderIds) {
      ladderIdsFromCatalog.add(id);
    }
  }
  const hasParentLadderCatalog = ladderIdsFromCatalog.size > 0;

  for (const example of examples) {
    const bounds = example?.bounds ?? {};
    const width = Number.isInteger(bounds?.width) ? clamp(bounds.width, SINGLE_HOUSE_MIN_DIM, SINGLE_HOUSE_MAX_DIM) : null;
    const height = Number.isInteger(bounds?.height) ? clamp(bounds.height, SINGLE_HOUSE_MIN_DIM, SINGLE_HOUSE_MAX_DIM) : null;
    if (width !== null) {
      incrementHistogram(widthHistogram, width);
    }
    if (height !== null) {
      incrementHistogram(heightHistogram, height);
    }

    const minZ = Number.isInteger(bounds?.minZ) ? bounds.minZ : 0;
    const maxZ = Number.isInteger(bounds?.maxZ) ? bounds.maxZ : minZ;
    const floorCount = clamp(Math.max(1, maxZ - minZ), 1, 3);
    incrementHistogram(floorHistogram, floorCount);

    let consumedInteriorProfile = false;
    const profile = example?.interiorProfile;
    if (profile && typeof profile === "object") {
      if (profile.densityByFloor && typeof profile.densityByFloor === "object") {
        for (const [zText, densityValue] of Object.entries(profile.densityByFloor)) {
          const z = Number.parseInt(zText, 10);
          const density = Number(densityValue);
          if (!Number.isInteger(z) || !Number.isFinite(density)) {
            continue;
          }
          const bucket = interiorDensityByFloor.get(z) ?? { sum: 0, count: 0 };
          bucket.sum += clamp(density, 0.01, 0.95);
          bucket.count += 1;
          interiorDensityByFloor.set(z, bucket);
        }
      }

      if (Array.isArray(profile.objectStats) && profile.objectStats.length > 0) {
        consumedInteriorProfile = true;
        for (const stat of profile.objectStats) {
          const id = Number.parseInt(stat?.id, 10);
          if (!isValidObjectId(id) || isLikelyLadderId(id)) {
            continue;
          }
          const rawType = Number.parseInt(stat?.type, 10);
          const type = normalizeInteriorPlacementType(rawType);
          const count = clamp(Number.parseInt(stat?.count, 10) || 0, 0, 500);
          if (count <= 0) {
            continue;
          }
          const wallAdjacent = clamp(Number.parseInt(stat?.wallAdjacent, 10) || 0, 0, count);
          const key = `${id}:${type}`;
          interiorHistogram.set(key, (interiorHistogram.get(key) ?? 0) + count);
          const affinity = interiorWallAffinity.get(key) ?? { wall: 0, total: 0 };
          affinity.wall += wallAdjacent;
          affinity.total += count;
          interiorWallAffinity.set(key, affinity);
        }
      }

      if (Array.isArray(profile.pairStats) && profile.pairStats.length > 0) {
        for (const entry of profile.pairStats) {
          const pairText = String(entry?.pair ?? "");
          const count = clamp(Number.parseInt(entry?.count, 10) || 0, 0, 500);
          if (!pairText || count <= 0) {
            continue;
          }
          const [a, b] = pairText.split("|");
          if (!a || !b) {
            continue;
          }
          const [aIdText, aTypeText] = a.split(":");
          const [bIdText, bTypeText] = b.split(":");
          const aId = Number.parseInt(aIdText, 10);
          const bId = Number.parseInt(bIdText, 10);
          if (!isValidObjectId(aId) || !isValidObjectId(bId) || isLikelyLadderId(aId) || isLikelyLadderId(bId)) {
            continue;
          }
          const aType = normalizeInteriorPlacementType(Number.parseInt(aTypeText, 10));
          const bType = normalizeInteriorPlacementType(Number.parseInt(bTypeText, 10));
          const aKey = `${aId}:${aType}`;
          const bKey = `${bId}:${bType}`;

          const aMap = interiorRelations.get(aKey) ?? new Map();
          aMap.set(bKey, (aMap.get(bKey) ?? 0) + count);
          interiorRelations.set(aKey, aMap);

          const bMap = interiorRelations.get(bKey) ?? new Map();
          bMap.set(aKey, (bMap.get(aKey) ?? 0) + count);
          interiorRelations.set(bKey, bMap);
        }
      }
    }

    const linearMotif = example?.layoutMotifs?.linear;
    if (linearMotif && typeof linearMotif === "object") {
      const axis = String(linearMotif.dividerAxis ?? "").toLowerCase();
      if (axis === "x" || axis === "y") {
        incrementCount(linearDividerAxisHistogram, axis, 1);
      }
      if (Number.isFinite(Number(linearMotif.dividerOffset))) {
        const bucket = Number((Math.round(Number(linearMotif.dividerOffset) * 2) / 2).toFixed(1));
        incrementCount(linearDividerOffsetHistogram, bucket, 1);
      }

      const ingestObjectPool = (pool, histogram) => {
        if (!Array.isArray(pool)) {
          return;
        }
        for (const entry of pool) {
          const id = Number.parseInt(entry?.id, 10);
          const type = Number.parseInt(entry?.type, 10);
          const count = clamp(Number.parseInt(entry?.count, 10) || 0, 0, 500);
          if (!isValidObjectId(id) || count <= 0) {
            continue;
          }
          const key = encodeObjectPoolKey(id, type);
          incrementCount(histogram, key, count);
        }
      };
      ingestObjectPool(linearMotif.dividerPool, linearDividerObjectHistogram);
      ingestObjectPool(linearMotif.servicePool, linearServiceObjectHistogram);
      ingestObjectPool(linearMotif.miscPool, linearMiscObjectHistogram);

      const ingestNumberPool = (pool, histogram) => {
        if (!Array.isArray(pool)) {
          return;
        }
        for (const entry of pool) {
          const value = Number.parseInt(entry?.value, 10);
          const count = clamp(Number.parseInt(entry?.count, 10) || 0, 0, 500);
          if (!Number.isInteger(value) || count <= 0) {
            continue;
          }
          incrementCount(histogram, value, count);
        }
      };
      ingestNumberPool(linearMotif.serviceOffsetPool, linearServiceOffsetHistogram);
      ingestNumberPool(linearMotif.rowGapPool, linearRowGapHistogram);
      ingestNumberPool(linearMotif.floorPool, linearFloorHistogram);

      const serviceOffsetValues = Array.isArray(linearMotif.serviceOffsetPool)
        ? [
            ...new Set(
              linearMotif.serviceOffsetPool
                .map((entry) => Number.parseInt(entry?.value, 10))
                .filter((value) => Number.isInteger(value) && value > 0)
            ),
          ]
        : [];
      if (serviceOffsetValues.length > 0) {
        incrementCount(linearServiceLineCountHistogram, clamp(serviceOffsetValues.length, 1, 4), 1);
      }
      const sideCount =
        (Array.isArray(linearMotif?.orientationBySide?.neg) && linearMotif.orientationBySide.neg.length > 0 ? 1 : 0) +
        (Array.isArray(linearMotif?.orientationBySide?.pos) && linearMotif.orientationBySide.pos.length > 0 ? 1 : 0);
      if (sideCount > 0) {
        incrementCount(linearServiceSideCountHistogram, clamp(sideCount, 1, 2), 1);
      }

      const ingestOrientationPool = (pool, histogram) => {
        if (!Array.isArray(pool)) {
          return;
        }
        for (const entry of pool) {
          const value = Number.parseInt(entry?.value, 10);
          const count = clamp(Number.parseInt(entry?.count, 10) || 0, 0, 500);
          if (!Number.isInteger(value) || value < 0 || value > 3 || count <= 0) {
            continue;
          }
          incrementCount(histogram, value, count);
        }
      };
      ingestOrientationPool(linearMotif?.orientationBySide?.neg, linearOrientationSideHistograms.neg);
      ingestOrientationPool(linearMotif?.orientationBySide?.pos, linearOrientationSideHistograms.pos);
    }

    const overlayGrid =
      example?.terrainProfile?.overlayGridsByZ?.["0"] ??
      example?.terrainProfile?.overlayGrid ??
      null;
    if (Array.isArray(overlayGrid)) {
      for (const row of overlayGrid) {
        if (!Array.isArray(row)) {
          continue;
        }
        for (const value of row) {
          if (!Number.isInteger(value) || value <= 0) {
            continue;
          }
          incrementHistogram(floorOverlayHistogram, value);
        }
      }
    }

    for (const entry of example?.categories?.doors ?? []) {
      if (Number.isInteger(entry?.id) && Number.isInteger(entry?.count) && entry.count > 0) {
        incrementHistogram(doorHistogram, entry.id, entry.count);
      }
    }

    const objects = Array.isArray(example?.layoutObjects) ? example.layoutObjects : [];
    const laddersByTile = new Map();
    for (const obj of objects) {
      const id = obj?.id | 0;
      const type = obj?.type | 0;
      const x = obj?.x | 0;
      const y = obj?.y | 0;
      const name = String(obj?.name ?? "").toLowerCase();
      const orientation = (obj?.orientation | 0) & 0x3;
      const z = obj?.z | 0;
      if (id <= 0) {
        continue;
      }
      const onPerimeter = width !== null && height !== null && (x === 0 || x === width - 1 || y === 0 || y === height - 1);

      if (type === ObjectType.WALL_STRAIGHT) {
        incrementHistogram(wallHistogram, id);
        if (onPerimeter) {
          incrementHistogram(wallPerimeterHistogram, id);
          if (/door|gate|archway/.test(name)) {
            incrementHistogram(doorHistogram, id, 4);
          }
          if (/window/.test(name)) {
            incrementHistogram(windowHistogram, id, 4);
          }
        }
      }
      if (CORNER_TYPES.has(type)) {
        incrementHistogram(cornerIdHistogram, id);
        incrementHistogram(cornerTypeHistogram, type);
      }
      if (ROOF_EDGE_TYPES.has(type)) {
        incrementHistogram(roofEdgeHistogram, id);
      }
      if (ROOF_TOP_TYPES.has(type)) {
        incrementHistogram(roofTopHistogram, id);
      }
      if ((type === ObjectType.WALL_DECOR_STRAIGHT || type === ObjectType.WALL_DECOR_DIAGONAL) && onPerimeter) {
        if (/window/.test(name)) {
          incrementHistogram(windowHistogram, id, 4);
        } else {
          incrementHistogram(windowHistogram, id);
        }
      }
      if (type === ObjectType.WALL_DECORATION) {
        incrementHistogram(decorHistogram, id);
      }

      const isLadderLikeId = type === ObjectType.INTERACTIVE && (ladderIdsFromCatalog.has(id) || isLikelyLadderId(id));
      if (!consumedInteriorProfile && (type === ObjectType.INTERACTIVE || type === ObjectType.GROUND_DECOR) && !isLadderLikeId) {
        const typeKey = normalizeInteriorPlacementType(type);
        const key = `${id}:${typeKey}`;
        interiorHistogram.set(key, (interiorHistogram.get(key) ?? 0) + 1);
      }

      if (type === ObjectType.INTERACTIVE) {
        const ladderKey = `${x}:${y}:${orientation}`;
        const list = laddersByTile.get(ladderKey) ?? [];
        list.push({
          id,
          x,
          y,
          z,
          orientation,
          looksLadder: isLadderLikeId || isLadderName(name),
          inCatalog: ladderIdsFromCatalog.has(id),
        });
        laddersByTile.set(ladderKey, list);
      }
    }

    const ladderIdsInExample = new Set();
    for (const ladderList of laddersByTile.values()) {
      ladderList.sort((a, b) => a.z - b.z);
      const byZ = new Map(ladderList.map((entry) => [entry.z, entry]));
      const hasLadderHint = ladderList.some((entry) => entry.looksLadder === true);
      const pairs = [];
      for (const bottom of ladderList) {
        const top = byZ.get(bottom.z + 1);
        if (!top) {
          continue;
        }
        pairs.push({ bottom, top, top2: byZ.get(bottom.z + 2) ?? null });
      }
      if (pairs.length === 0) {
        continue;
      }
      for (const pair of pairs) {
        const bottom = pair.bottom;
        const top = pair.top;
        const pairMatchesCatalog =
          !hasParentLadderCatalog ||
          bottom.inCatalog === true ||
          top.inCatalog === true ||
          (pair.top2?.inCatalog === true);
        if (!pairMatchesCatalog && !hasLadderHint) {
          continue;
        }
        const pairKey = `${bottom.id}:${top.id}`;
        incrementCount(ladderPairHistogram, pairKey);
        incrementHistogram(ladderOrientationHistogram, bottom.orientation, 1);
        ladderIdsInExample.add(bottom.id);
        ladderIdsInExample.add(top.id);
        const side = resolveRelativeBoundarySide(bottom.x, bottom.y, width, height);
        if (side) {
          incrementCount(ladderSideHistogram, side);
          incrementHistogram(ladderSideOrientationHistograms[side], bottom.orientation, 1);
        }
        const top2 = pair.top2;
        if (top2) {
          const tripleKey = `${bottom.id}:${top.id}:${top2.id}`;
          incrementCount(ladderTripleHistogram, tripleKey);
          ladderIdsInExample.add(top2.id);
        }
      }
    }
    for (const ladderId of ladderIdsInExample) {
      interiorHistogram.delete(`${ladderId}:${ObjectType.INTERACTIVE}`);
    }
  }

  const perimeterWallSource = wallPerimeterHistogram.size > 0 ? wallPerimeterHistogram : wallHistogram;
  const perimeterWallEntries = topHistogramEntries(perimeterWallSource, 16).filter(([id]) => isValidObjectId(id));
  const wallIdPool = weightedPoolFromHistogram(perimeterWallSource, isValidObjectId);
  const wallId = wallIdPool[0] ?? fallbackStyle.wallId;
  const modalWallCount = perimeterWallEntries[0]?.[1] ?? 1;

  const inferredDoorHistogram = new Map(doorHistogram);
  for (const [id, count] of perimeterWallEntries) {
    if (id === wallId) {
      continue;
    }
    if (isLikelyDoorId(id)) {
      incrementHistogram(inferredDoorHistogram, id, Math.max(1, count * 3));
    }
  }
  if (inferredDoorHistogram.size === 0) {
    const maxDoorLikeCount = Math.max(2, Math.round(modalWallCount * 0.35));
    for (const [id, count] of perimeterWallEntries) {
      if (id === wallId) {
        continue;
      }
      if (count <= maxDoorLikeCount) {
        const weighted = Math.max(1, maxDoorLikeCount - count + 1);
        incrementHistogram(inferredDoorHistogram, id, weighted);
      }
    }
  }
  if (inferredDoorHistogram.size === 0 && isValidObjectId(fallbackStyle.doorId)) {
    incrementHistogram(inferredDoorHistogram, fallbackStyle.doorId, 1);
  }
  let doorIdPool = weightedPoolFromHistogram(
    inferredDoorHistogram,
    (id) => isValidObjectId(id) && id !== wallId
  );
  let doorId = doorIdPool[0] ?? fallbackStyle.doorId;
  if (!isValidObjectId(doorId) || doorId === wallId) {
    doorId = fallbackStyle.doorId;
    doorIdPool = [];
  }
  if (!isLikelyDoorId(doorId)) {
    const preferredFallbackDoor = Number.isInteger(fallbackStyle?.doorId) ? fallbackStyle.doorId : null;
    if (isValidObjectId(preferredFallbackDoor) && preferredFallbackDoor !== wallId) {
      doorId = preferredFallbackDoor;
      doorIdPool = [preferredFallbackDoor];
    }
  }
  if (!Array.isArray(doorIdPool) || doorIdPool.length === 0) {
    doorIdPool = [doorId];
  }

  const cornerIdPool = weightedPoolFromHistogram(cornerIdHistogram, isValidObjectId);
  const wallCornerId = cornerIdPool[0] ?? fallbackStyle.wallCornerId ?? wallId;

  const cornerTypePool = weightedPoolFromHistogram(cornerTypeHistogram, (value) => CORNER_TYPES.has(value), 3, 4);
  const wallCornerType = cornerTypePool[0] ?? fallbackStyle.wallCornerType ?? ObjectType.WALL_SQUARE_CORNER;

  const roofEdgeIdPool = weightedPoolFromHistogram(roofEdgeHistogram, isValidObjectId);
  const roofEdgeId = roofEdgeIdPool[0] ?? fallbackStyle.roofEdgeId;
  const roofTopIdPool = weightedPoolFromHistogram(roofTopHistogram, isValidObjectId);
  const roofTopId = roofTopIdPool[0] ?? fallbackStyle.roofTopId;

  const inferredWindowHistogram = new Map(windowHistogram);
  for (const [id, count] of perimeterWallEntries) {
    if (id === wallId || id === doorId) {
      continue;
    }
    const frequencyRatio = count / Math.max(1, modalWallCount);
    const likelyWindow = isLikelyWindowId(id);
    if (likelyWindow || count >= 2 || (frequencyRatio >= 0.08 && frequencyRatio <= 0.5)) {
      incrementHistogram(inferredWindowHistogram, id, likelyWindow ? Math.max(1, count * 3) : count);
    }
  }
  if (inferredWindowHistogram.size === 0 && Array.isArray(fallbackStyle.windowIds)) {
    for (const id of fallbackStyle.windowIds) {
      incrementHistogram(inferredWindowHistogram, id, 1);
    }
  }
  const windowIdPool = weightedPoolFromHistogram(
    inferredWindowHistogram,
    (id) => isValidObjectId(id) && id !== wallId && id !== doorId,
    8,
    5
  );
  const windowIds = [
    ...new Set(
      [
        ...windowIdPool,
        ...topHistogramEntries(inferredWindowHistogram, 8).map(([id]) => id),
      ].filter((id) => isValidObjectId(id) && id !== wallId && id !== doorId)
    ),
  ];
  const wallDecorIds = topHistogramEntries(decorHistogram, 8)
    .map(([id]) => id)
    .filter(isValidObjectId);
  const widthChoices = topHistogramEntries(widthHistogram, 6).map(([value]) => value);
  const heightChoices = topHistogramEntries(heightHistogram, 6).map(([value]) => value);
  const floorPool = weightedPoolFromHistogram(floorHistogram, (value) => Number.isInteger(value) && value >= 1 && value <= 3, 3, 5);

  const floorUnderlayPool = weightedPoolFromHistogram(
    floorOverlayHistogram,
    (value) => Number.isInteger(value) && value > 0 && value < 256,
    6,
    5
  );
  const floorUnderlay = floorUnderlayPool[0] ?? fallbackStyle.floorUnderlay ?? 22;

  const ladderPairKey = [...ladderPairHistogram.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const ladderTripleKey = [...ladderTripleHistogram.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const ladderPairIds = ladderPairKey ? parseIdSequenceKey(ladderPairKey).slice(0, 2) : [];
  const ladderTripleIds = ladderTripleKey ? parseIdSequenceKey(ladderTripleKey).slice(0, 3) : [];
  const ladderOrientationPool = weightedPoolFromHistogram(
    ladderOrientationHistogram,
    (value) => Number.isInteger(value) && value >= 0 && value <= 3,
    4,
    5
  );
  const ladderSidePool = weightedPoolFromCountMap(ladderSideHistogram, 4, 5)
    .map((value) => String(value).toLowerCase())
    .filter((value) => LADDER_SIDE_VALUES.includes(value));
  const ladderSideOrientationPools = {};
  for (const side of LADDER_SIDE_VALUES) {
    ladderSideOrientationPools[side] = weightedPoolFromHistogram(
      ladderSideOrientationHistograms[side],
      (value) => Number.isInteger(value) && value >= 0 && value <= 3,
      4,
      5
    );
  }
  const ladderSpec = {
    pairIds:
      ladderPairIds.length === 2 && ladderPairIds.every((id) => isValidObjectId(id))
        ? ladderPairIds
        : null,
    tripleIds:
      ladderTripleIds.length === 3 && ladderTripleIds.every((id) => isValidObjectId(id))
        ? ladderTripleIds
        : null,
    orientationPool: ladderOrientationPool,
    sidePool: ladderSidePool,
    sideOrientationPools: ladderSideOrientationPools,
  };
  ladderSpec.maxChainLength = ladderSpec.tripleIds
    ? 3
    : ladderSpec.pairIds
      ? 2
      : 1;

  const interiorObjects = [...interiorHistogram.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 24)
    .map(([key, count]) => {
      const [idText, typeText] = String(key).split(":");
      const id = Number.parseInt(idText, 10);
      const type = Number.parseInt(typeText, 10);
      const affinity = interiorWallAffinity.get(key) ?? { wall: 0, total: 0 };
      return {
        id,
        type: normalizeInteriorPlacementType(type),
        count,
        wallAffinity: affinity.total > 0 ? Number((affinity.wall / affinity.total).toFixed(4)) : null,
      };
    })
    .filter((entry) => isValidObjectId(entry.id) && !isLikelyLadderId(entry.id));

  const interiorDensityByFloorObj = {};
  for (const [floor, summary] of interiorDensityByFloor.entries()) {
    if (!summary || summary.count <= 0) {
      continue;
    }
    interiorDensityByFloorObj[String(floor)] = Number((summary.sum / summary.count).toFixed(4));
  }
  const densitySamples = Object.values(interiorDensityByFloorObj);
  const interiorDensityDefault = Number(
    (densitySamples.length > 0 ? densitySamples.reduce((sum, value) => sum + value, 0) / densitySamples.length : 0.24).toFixed(4)
  );
  const interiorRelationPools = {};
  for (const entry of interiorObjects) {
    const key = `${entry.id}:${entry.type}`;
    const relationMap = interiorRelations.get(key);
    if (!(relationMap instanceof Map) || relationMap.size === 0) {
      continue;
    }
    const pool = weightedPoolFromCountMap(relationMap, 8, 5).filter((value) => typeof value === "string" && value.includes(":"));
    if (pool.length > 0) {
      interiorRelationPools[key] = pool;
    }
  }

  const linearLayout = (() => {
    const dividerPool = weightedObjectPoolFromHistogram(linearDividerObjectHistogram, 10, 6);
    const servicePool = weightedObjectPoolFromHistogram(linearServiceObjectHistogram, 14, 6);
    const miscPool = weightedObjectPoolFromHistogram(linearMiscObjectHistogram, 18, 5);
    const dividerAxisPool = weightedPoolFromCountMap(linearDividerAxisHistogram, 3, 6)
      .map((value) => String(value).toLowerCase())
      .filter((value) => value === "x" || value === "y");
    const dividerOffsetPool = weightedPoolFromCountMap(linearDividerOffsetHistogram, 6, 5)
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value));
    const serviceOffsetPool = weightedPoolFromCountMap(linearServiceOffsetHistogram, 8, 5)
      .map((value) => Number.parseInt(String(value), 10))
      .filter((value) => Number.isInteger(value) && value > 0);
    const rowGapPool = weightedPoolFromCountMap(linearRowGapHistogram, 8, 5)
      .map((value) => Number.parseInt(String(value), 10))
      .filter((value) => Number.isInteger(value) && value > 0);
    const serviceLineCountPool = weightedPoolFromCountMap(linearServiceLineCountHistogram, 4, 5)
      .map((value) => Number.parseInt(String(value), 10))
      .filter((value) => Number.isInteger(value) && value >= 1 && value <= 4);
    const serviceSideCountPool = weightedPoolFromCountMap(linearServiceSideCountHistogram, 2, 5)
      .map((value) => Number.parseInt(String(value), 10))
      .filter((value) => Number.isInteger(value) && value >= 1 && value <= 2);
    const floorPoolRaw = weightedPoolFromCountMap(linearFloorHistogram, 4, 5)
      .map((value) => Number.parseInt(String(value), 10))
      .filter((value) => Number.isInteger(value) && value >= 0 && value <= 3);
    const floorPool = [...new Set(floorPoolRaw)];
    const orientationNegPool = weightedPoolFromCountMap(linearOrientationSideHistograms.neg, 4, 5)
      .map((value) => Number.parseInt(String(value), 10))
      .filter((value) => Number.isInteger(value) && value >= 0 && value <= 3);
    const orientationPosPool = weightedPoolFromCountMap(linearOrientationSideHistograms.pos, 4, 5)
      .map((value) => Number.parseInt(String(value), 10))
      .filter((value) => Number.isInteger(value) && value >= 0 && value <= 3);

    if (dividerPool.length === 0 && servicePool.length === 0) {
      return null;
    }
    return {
      dividerAxisPool,
      dividerOffsetPool,
      serviceOffsetPool,
      serviceLineCountPool,
      serviceSideCountPool,
      rowGapPool,
      floorPool,
      dividerPool,
      servicePool,
      miscPool,
      minServiceRows: normalizedType === "BANK" ? 1 : 0,
      maxServiceRows: normalizedType === "BANK" ? 2 : 3,
      doorPathDepth: normalizedType === "BANK" ? 4 : 2,
      doorPathHalfWidth: normalizedType === "BANK" ? 1 : 0,
      orientationBySide: {
        neg: orientationNegPool,
        pos: orientationPosPool,
      },
    };
  })();

  const profileStyle = {
    key: (styleTag || fallbackStyle.key || "LEARNED").toUpperCase(),
    floorUnderlay,
    wallId,
    wallCornerId,
    wallCornerType,
    doorId,
    roofEdgeId,
    roofTopId,
    windowIds: windowIds.length > 0 ? windowIds : fallbackStyle.windowIds ?? [],
    windowIdPool:
      windowIds.length > 0
        ? [...new Set(windowIds)]
        : windowIdPool.length > 0
          ? [...new Set(windowIdPool)]
          : fallbackStyle.windowIds?.length > 0
            ? [...new Set(fallbackStyle.windowIds)]
            : [],
    wallDecorIds: wallDecorIds.length > 0 ? wallDecorIds : fallbackStyle.wallDecorIds ?? [],
    wallIdPool: [wallId],
    doorIdPool: [doorId],
    wallCornerIdPool: cornerIdPool.length > 0 ? cornerIdPool : [wallCornerId],
    roofEdgeIdPool: roofEdgeIdPool.length > 0 ? roofEdgeIdPool : [roofEdgeId],
    roofTopIdPool: roofTopIdPool.length > 0 ? roofTopIdPool : [roofTopId],
    floorUnderlayPool: floorUnderlayPool.length > 0 ? floorUnderlayPool : [floorUnderlay],
  };

  if (!isStyleUsable(profileStyle)) {
    return null;
  }

  const profile = {
    houseType: normalizedType,
    style: profileStyle,
    widthChoices: widthChoices.length > 0 ? widthChoices : null,
    heightChoices: heightChoices.length > 0 ? heightChoices : null,
    floorPool: floorPool.length > 0 ? floorPool : null,
    interiorObjects: interiorObjects.length > 0 ? interiorObjects : null,
    interiorDensityByFloor: Object.keys(interiorDensityByFloorObj).length > 0 ? interiorDensityByFloorObj : null,
    interiorDensityDefault,
    interiorRelationPools: Object.keys(interiorRelationPools).length > 0 ? interiorRelationPools : null,
    layoutConstraints: linearLayout ? { linear: linearLayout } : null,
    ladderSpec,
  };
  houseDumpProfileCache.set(cacheKey, {
    mtimeMs: stat.mtimeMs,
    profile,
  });
  return profile;
}

function normalizeLayoutTemplates(templates) {
  if (!Array.isArray(templates)) {
    return [];
  }
  return templates
    .map((template) => ({
      width: clamp(Number.parseInt(template?.width, 10) || 0, 7, 14),
      height: clamp(Number.parseInt(template?.height, 10) || 0, 7, 14),
      floors: clamp(Number.parseInt(template?.floors, 10) || 1, 1, 3),
    }))
    .filter((template) => Number.isInteger(template.width) && Number.isInteger(template.height))
    .slice(0, 24);
}

function isValidObjectId(id) {
  if (!Number.isInteger(id) || id <= 0) {
    return false;
  }
  try {
    return !!ObjectDefinition.forId(id);
  } catch {
    return false;
  }
}

function isStyleUsable(style) {
  return (
    isValidObjectId(style.wallId) &&
    isValidObjectId(style.doorId) &&
    isValidObjectId(style.roofEdgeId) &&
    isValidObjectId(style.roofTopId)
  );
}

function getGenerationConfig() {
  const learned = readLearnedPreset();
  const params = learned?.params ?? {};
  const styles = Array.isArray(learned?.styles)
    ? learned.styles
        .map((style, index) => normalizeStyle(style, index, learned?.contents))
        .filter((style) => style !== null)
    : [];
  const layoutTemplates = normalizeLayoutTemplates(learned?.layoutTemplates);
  const townMode = Boolean(params.townMode) || layoutTemplates.length >= 4;
  const useLearnedStyles = Boolean(params.useLearnedStyles) === true;
  const minFloors = Number.isInteger(params.minFloors) ? clamp(params.minFloors, 1, 3) : 1;
  const maxFloors = Number.isInteger(params.maxFloors) ? clamp(params.maxFloors, minFloors, 2) : 2;
  const buildingCountMinDefault = townMode ? 28 : 10;
  const buildingCountMaxDefault = townMode ? 42 : 18;

  const validatedStyles = styles.filter(isStyleUsable);
  const spacingRaw = Number.isInteger(params.minSpacing) ? params.minSpacing : townMode ? 1 : 2;
  const userMin = Number.isInteger(params.buildingCountMin) ? clamp(params.buildingCountMin, 4, 42) : buildingCountMinDefault;
  const userMax = Number.isInteger(params.buildingCountMax) ? clamp(params.buildingCountMax, 8, 48) : buildingCountMaxDefault;
  const finalMinCount = townMode ? Math.max(24, userMin) : userMin;
  const finalMaxCount = townMode ? Math.max(finalMinCount + 8, userMax) : Math.max(finalMinCount + 2, userMax);
  return {
    styles: useLearnedStyles && validatedStyles.length > 0 ? validatedStyles : HOUSE_TYPES,
    layoutTemplates,
    interiorObjects: normalizeInteriorObjects(learned?.contents),
    buildingCountMin: finalMinCount,
    buildingCountMax: clamp(finalMaxCount, finalMinCount + 1, 48),
    widthChoices:
      Array.isArray(params.widthChoices) && params.widthChoices.length > 0
        ? params.widthChoices.map((value) => clamp(Number.parseInt(value, 10) || 8, 7, 14))
        : [8, 9, 10, 11, 12, 13, 14],
    heightChoices:
      Array.isArray(params.heightChoices) && params.heightChoices.length > 0
        ? params.heightChoices.map((value) => clamp(Number.parseInt(value, 10) || 8, 7, 14))
        : [8, 9, 10, 11, 12, 13, 14],
    minSpacing: clamp(spacingRaw, 0, townMode ? 1 : 4),
    minFloors,
    maxFloors,
    townMode,
    roadSpacing: Number.isInteger(params.roadSpacing) ? clamp(params.roadSpacing, 9, 14) : 10,
    roadWidth: Number.isInteger(params.roadWidth) ? clamp(params.roadWidth, 1, 2) : 1,
    roadClearance: Number.isInteger(params.roadClearance) ? clamp(params.roadClearance, 0, 2) : 0,
  };
}

function chooseDoorPlacement(minX, minY, maxX, maxY, rng, preferredOrientation = null) {
  // Orientation parity from RSPSi BuildingGenerator.
  let doorOrientation = preferredOrientation;
  if (!Number.isInteger(doorOrientation) || doorOrientation < 0 || doorOrientation > 3) {
    doorOrientation = rng.nextInt(0, 3);
  }
  if (doorOrientation === 0 || doorOrientation === 2) {
    const y = rng.nextInt(minY + 3, maxY - 3);
    return { orientation: doorOrientation, coord: y };
  }
  const x = rng.nextInt(minX + 3, maxX - 3);
  return { orientation: doorOrientation, coord: x };
}

function resolveDoorTile(minX, minY, maxX, maxY, door) {
  if (!door || !Number.isInteger(door.orientation) || !Number.isInteger(door.coord)) {
    return null;
  }
  if (door.orientation === 2) {
    return { x: minX + 1, y: door.coord };
  }
  if (door.orientation === 0) {
    return { x: maxX - 1, y: door.coord };
  }
  if (door.orientation === 1) {
    return { x: door.coord, y: minY + 1 };
  }
  if (door.orientation === 3) {
    return { x: door.coord, y: maxY - 1 };
  }
  return null;
}

function getObjectFootprint(id, orientation) {
  let sizeX = 1;
  let sizeY = 1;
  try {
    const definition = ObjectDefinition.forId(id);
    sizeX = clamp(Number.isInteger(definition?.getSizeX?.()) ? definition.getSizeX() : 1, 1, 8);
    sizeY = clamp(Number.isInteger(definition?.getSizeY?.()) ? definition.getSizeY() : 1, 1, 8);
  } catch {
    sizeX = 1;
    sizeY = 1;
  }
  if ((orientation & 0x1) === 1) {
    return { sizeX: sizeY, sizeY: sizeX };
  }
  return { sizeX, sizeY };
}

function isWithinDoorBuffer(doorTile, x, y, sizeX, sizeY, buffer = 1) {
  if (!doorTile) {
    return false;
  }
  const minX = x;
  const minY = y;
  const maxX = x + sizeX - 1;
  const maxY = y + sizeY - 1;
  const dx = doorTile.x < minX ? minX - doorTile.x : doorTile.x > maxX ? doorTile.x - maxX : 0;
  const dy = doorTile.y < minY ? minY - doorTile.y : doorTile.y > maxY ? doorTile.y - maxY : 0;
  return Math.max(dx, dy) <= buffer;
}

function canPlaceObjectAt(x, y, sizeX, sizeY, occupiedTiles, minX, minY, maxX, maxY, doorTile) {
  const interiorMinX = minX + 2;
  const interiorMinY = minY + 2;
  const interiorMaxX = maxX - 2;
  const interiorMaxY = maxY - 2;
  if (x < interiorMinX || y < interiorMinY) {
    return false;
  }
  if (x + sizeX - 1 > interiorMaxX || y + sizeY - 1 > interiorMaxY) {
    return false;
  }
  if (isWithinDoorBuffer(doorTile, x, y, sizeX, sizeY, 1)) {
    return false;
  }
  for (let tileX = x; tileX < x + sizeX; tileX++) {
    for (let tileY = y; tileY < y + sizeY; tileY++) {
      if (occupiedTiles.has(`${tileX}:${tileY}`)) {
        return false;
      }
    }
  }
  return true;
}

function markDoorApproachTiles(
  blockedTiles,
  doorTile,
  door,
  minX,
  minY,
  maxX,
  maxY,
  depth = 3,
  halfWidth = 0
) {
  if (!(blockedTiles instanceof Set) || !doorTile || !door || !Number.isInteger(door.orientation)) {
    return;
  }
  const clampedDepth = clamp(depth | 0, 1, 8);
  const clampedHalfWidth = clamp(halfWidth | 0, 0, 2);
  const interiorMinX = minX + 2;
  const interiorMaxX = maxX - 2;
  const interiorMinY = minY + 2;
  const interiorMaxY = maxY - 2;
  if (interiorMinX > interiorMaxX || interiorMinY > interiorMaxY) {
    return;
  }

  let dirX = 0;
  let dirY = 0;
  if (door.orientation === 2) {
    dirX = 1;
  } else if (door.orientation === 0) {
    dirX = -1;
  } else if (door.orientation === 1) {
    dirY = 1;
  } else if (door.orientation === 3) {
    dirY = -1;
  } else {
    return;
  }
  const perpX = dirY;
  const perpY = dirX;
  for (let step = 1; step <= clampedDepth; step++) {
    const centerX = doorTile.x + dirX * step;
    const centerY = doorTile.y + dirY * step;
    for (let offset = -clampedHalfWidth; offset <= clampedHalfWidth; offset++) {
      const x = centerX + perpX * offset;
      const y = centerY + perpY * offset;
      if (x < interiorMinX || x > interiorMaxX || y < interiorMinY || y > interiorMaxY) {
        continue;
      }
      blockedTiles.add(`${x}:${y}`);
    }
  }
}

function selectWindowWallSlots(minX, minY, maxX, maxY, door, rng, minWindows = 2) {
  const candidatesByKey = new Map();
  const addCandidate = (x, y, orientation) => {
    if (x <= minX || x >= maxX || y <= minY || y >= maxY) {
      return;
    }
    const key = `${x}:${y}`;
    if (candidatesByKey.has(key)) {
      return;
    }
    candidatesByKey.set(key, { x, y, orientation, key });
  };
  const addBand = (inset) => {
    for (let y = minY + inset; y <= maxY - inset; y++) {
      if (!(door.orientation === 2 && y === door.coord)) {
        addCandidate(minX + 1, y, 2);
      }
      if (!(door.orientation === 0 && y === door.coord)) {
        addCandidate(maxX - 1, y, 0);
      }
    }
    for (let x = minX + inset; x <= maxX - inset; x++) {
      if (!(door.orientation === 1 && x === door.coord)) {
        addCandidate(x, minY + 1, 1);
      }
      if (!(door.orientation === 3 && x === door.coord)) {
        addCandidate(x, maxY - 1, 3);
      }
    }
  };

  addBand(3);
  if (candidatesByKey.size < minWindows) {
    addBand(2);
  }
  if (candidatesByKey.size < minWindows) {
    addBand(1);
  }

  const candidates = [...candidatesByKey.values()];
  if (candidates.length === 0) {
    return new Map();
  }

  shuffleInPlace(candidates, rng);
  const selected = [];
  const used = new Set();
  const pickFirstBy = (predicate) => {
    for (const candidate of candidates) {
      if (!predicate(candidate) || used.has(candidate.key)) {
        continue;
      }
      used.add(candidate.key);
      selected.push(candidate);
      return true;
    }
    return false;
  };

  pickFirstBy((candidate) => candidate.orientation === 0 || candidate.orientation === 2);
  pickFirstBy((candidate) => candidate.orientation === 1 || candidate.orientation === 3);

  const targetCount = clamp(Math.max(minWindows, Math.round(candidates.length * 0.25)), minWindows, 10);
  for (const candidate of candidates) {
    if (selected.length >= targetCount) {
      break;
    }
    if (used.has(candidate.key)) {
      continue;
    }
    used.add(candidate.key);
    selected.push(candidate);
  }

  if (selected.length < minWindows) {
    for (const candidate of candidates) {
      if (selected.length >= minWindows) {
        break;
      }
      if (used.has(candidate.key)) {
        continue;
      }
      used.add(candidate.key);
      selected.push(candidate);
    }
  }

  const map = new Map();
  for (const slot of selected) {
    map.set(slot.key, slot);
  }
  return map;
}

function addInteriorObjects(
  placements,
  interiorPool,
  interiorProfile,
  minX,
  minY,
  maxX,
  maxY,
  floor,
  rng,
  door,
  blockedTiles = null
) {
  if (!Array.isArray(interiorPool) || interiorPool.length === 0) {
    return;
  }
  const innerMinX = minX + 2;
  const innerMaxX = maxX - 2;
  const innerMinY = minY + 2;
  const innerMaxY = maxY - 2;
  if (innerMinX > innerMaxX || innerMinY > innerMaxY) {
    return;
  }

  const area = (innerMaxX - innerMinX + 1) * (innerMaxY - innerMinY + 1);
  const densityByFloor = interiorProfile?.densityByFloor && typeof interiorProfile.densityByFloor === "object"
    ? interiorProfile.densityByFloor
    : null;
  const learnedDensity = densityByFloor ? Number(densityByFloor[String(floor)]) : Number.NaN;
  const defaultDensity = Number(interiorProfile?.defaultDensity);
  const fallbackDensity = floor === 0 ? 0.18 : 0.14;
  const baseDensity = clamp(
    Number.isFinite(learnedDensity)
      ? learnedDensity
      : Number.isFinite(defaultDensity)
        ? defaultDensity
        : fallbackDensity,
    0.1,
    0.5
  );
  const targetDensity = clamp(baseDensity * 0.72, 0.08, 0.36);
  const minRequired = area >= 16 ? 2 : 1;
  const propCount = clamp(Math.round(area * targetDensity), minRequired, Math.max(minRequired, Math.min(18, area)));
  const occupiedTiles = new Set(blockedTiles instanceof Set ? blockedTiles : []);
  const doorTile = resolveDoorTile(minX, minY, maxX, maxY, door);
  let placedCount = 0;
  let previousPickKey = null;

  const normalizedPool = interiorPool
    .filter((pick) => Number.isInteger(pick?.id) && pick.id > 0)
    .map((pick) => ({
      id: pick.id,
      type: normalizeInteriorPlacementType(pick.type),
      key: `${pick.id}:${normalizeInteriorPlacementType(pick.type)}`,
      wallAffinity: Number.isFinite(Number(pick?.wallAffinity)) ? clamp(Number(pick.wallAffinity), 0, 1) : null,
    }));
  if (normalizedPool.length === 0) {
    return;
  }
  const poolByKey = new Map(normalizedPool.map((pick) => [pick.key, pick]));
  const wallFavoredPool = normalizedPool.filter((pick) => (pick.wallAffinity ?? 0) >= 0.45);
  const relationPools = interiorProfile?.relationPools && typeof interiorProfile.relationPools === "object"
    ? interiorProfile.relationPools
    : null;

  const isNearInnerWall = (x, y) => x === innerMinX || x === innerMaxX || y === innerMinY || y === innerMaxY;
  const isWallAdjacentFootprint = (x, y, sizeX, sizeY) =>
    x <= innerMinX ||
    y <= innerMinY ||
    x + sizeX - 1 >= innerMaxX ||
    y + sizeY - 1 >= innerMaxY;

  const resolvePick = (nearWall) => {
    let relationCandidate = null;
    if (previousPickKey && relationPools && Array.isArray(relationPools[previousPickKey]) && relationPools[previousPickKey].length > 0) {
      relationCandidate = rng.pick(relationPools[previousPickKey]);
    }
    if (relationCandidate && poolByKey.has(relationCandidate) && rng.nextInt(0, 99) < 70) {
      return poolByKey.get(relationCandidate);
    }
    if (nearWall && wallFavoredPool.length > 0 && rng.nextInt(0, 99) < 65) {
      return rng.pick(wallFavoredPool);
    }
    return rng.pick(normalizedPool);
  };

  const tryPlaceRandom = () => {
    for (let attempt = 0; attempt < 120; attempt++) {
      const x = rng.nextInt(innerMinX, innerMaxX);
      const y = rng.nextInt(innerMinY, innerMaxY);
      const nearWall = isNearInnerWall(x, y);
      const pick = resolvePick(nearWall);
      if (!pick || !Number.isInteger(pick.id) || pick.id <= 0) {
        continue;
      }
      const orientation = rng.nextInt(0, 3);
      const { sizeX, sizeY } = getObjectFootprint(pick.id, orientation);
      if (!isWallAdjacentFootprint(x, y, sizeX, sizeY)) {
        continue;
      }
      if (!canPlaceObjectAt(x, y, sizeX, sizeY, occupiedTiles, minX, minY, maxX, maxY, doorTile)) {
        continue;
      }
      placements.push({
        id: pick.id,
        x,
        y,
        z: floor,
        type: pick.type,
        orientation,
      });
      for (let tileX = x; tileX < x + sizeX; tileX++) {
        for (let tileY = y; tileY < y + sizeY; tileY++) {
          occupiedTiles.add(`${tileX}:${tileY}`);
        }
      }
      placedCount++;
      previousPickKey = pick.key;
      return true;
    }
    return false;
  };

  for (let i = 0; i < propCount; i++) {
    if (!tryPlaceRandom()) {
      break;
    }
  }

  if (placedCount >= minRequired) {
    return;
  }

  // Deterministic fallback: sweep interior positions to guarantee at least some props.
  for (let x = innerMinX; x <= innerMaxX && placedCount < minRequired; x++) {
    for (let y = innerMinY; y <= innerMaxY && placedCount < minRequired; y++) {
      for (const pick of normalizedPool) {
        if (!pick || !Number.isInteger(pick.id) || pick.id <= 0) {
          continue;
        }
        const orientation = rng.nextInt(0, 3);
        const { sizeX, sizeY } = getObjectFootprint(pick.id, orientation);
        if (!isWallAdjacentFootprint(x, y, sizeX, sizeY)) {
          continue;
        }
        if (!canPlaceObjectAt(x, y, sizeX, sizeY, occupiedTiles, minX, minY, maxX, maxY, doorTile)) {
          continue;
        }
        placements.push({
          id: pick.id,
          x,
          y,
          z: floor,
          type: pick.type,
          orientation,
        });
        for (let tileX = x; tileX < x + sizeX; tileX++) {
          for (let tileY = y; tileY < y + sizeY; tileY++) {
            occupiedTiles.add(`${tileX}:${tileY}`);
          }
        }
        placedCount++;
        previousPickKey = pick.key;
        break;
      }
    }
  }
}

function chooseNumericPoolValue(pool, fallback, rng) {
  if (!Array.isArray(pool) || pool.length === 0) {
    return fallback;
  }
  const value = Number(rng.pick(pool));
  return Number.isFinite(value) ? value : fallback;
}

function chooseObjectPoolEntry(pool, rng) {
  if (!Array.isArray(pool) || pool.length === 0) {
    return null;
  }
  const pick = rng.pick(pool);
  if (!pick || !Number.isInteger(pick.id) || !isValidObjectId(pick.id)) {
    return null;
  }
  return {
    id: pick.id,
    type: normalizeInteriorPlacementType(pick.type),
  };
}

function tryPlaceConstrainedObject(placements, occupiedTiles, pick, x, y, orientation, minX, minY, maxX, maxY, doorTile, floor) {
  if (!pick || !Number.isInteger(pick.id) || pick.id <= 0) {
    return false;
  }
  const normalizedOrientation = orientation & 0x3;
  const { sizeX, sizeY } = getObjectFootprint(pick.id, normalizedOrientation);
  if (!canPlaceObjectAt(x, y, sizeX, sizeY, occupiedTiles, minX, minY, maxX, maxY, doorTile)) {
    return false;
  }
  placements.push({
    id: pick.id,
    x,
    y,
    z: floor,
    type: pick.type,
    orientation: normalizedOrientation,
  });
  for (let tileX = x; tileX < x + sizeX; tileX++) {
    for (let tileY = y; tileY < y + sizeY; tileY++) {
      occupiedTiles.add(`${tileX}:${tileY}`);
    }
  }
  return true;
}

function addLinearMotifObjects(
  placements,
  linearConstraints,
  minX,
  minY,
  maxX,
  maxY,
  floor,
  rng,
  door,
  occupiedTiles
) {
  if (!linearConstraints || typeof linearConstraints !== "object") {
    return false;
  }
  const innerMinX = minX + 2;
  const innerMaxX = maxX - 2;
  const innerMinY = minY + 2;
  const innerMaxY = maxY - 2;
  if (innerMinX > innerMaxX || innerMinY > innerMaxY) {
    return false;
  }

  const floorPool = Array.isArray(linearConstraints.floorPool) ? linearConstraints.floorPool : [];
  if (floorPool.length > 0 && !floorPool.includes(floor)) {
    return false;
  }

  const dividerPick = chooseObjectPoolEntry(linearConstraints.dividerPool, rng);
  const servicePick = chooseObjectPoolEntry(linearConstraints.servicePool, rng);
  if (!dividerPick && !servicePick) {
    return false;
  }

  const axisPool = Array.isArray(linearConstraints?.dividerAxisPool)
    ? linearConstraints.dividerAxisPool.map((value) => String(value).toLowerCase()).filter((value) => value === "x" || value === "y")
    : [];
  const axis =
    axisPool.length > 0
      ? rng.pick(axisPool)
      : innerMaxX - innerMinX <= innerMaxY - innerMinY
        ? "x"
        : "y";
  const centerLine = axis === "x" ? (innerMinX + innerMaxX) / 2 : (innerMinY + innerMaxY) / 2;
  const dividerOffset = chooseNumericPoolValue(linearConstraints.dividerOffsetPool, 0, rng);
  const dividerLine = clamp(Math.round(centerLine + dividerOffset), axis === "x" ? innerMinX : innerMinY, axis === "x" ? innerMaxX : innerMaxY);
  const serviceOffsets = Array.isArray(linearConstraints.serviceOffsetPool)
    ? [...new Set(linearConstraints.serviceOffsetPool.filter((value) => Number.isInteger(value) && value > 0))]
    : [];
  const resolvedOffsets = serviceOffsets.length > 0 ? serviceOffsets.sort((a, b) => a - b) : [1];
  const minServiceRows = clamp(Number.parseInt(linearConstraints.minServiceRows, 10) || 0, 0, 4);
  const maxServiceRows = clamp(
    Number.parseInt(linearConstraints.maxServiceRows, 10) || Math.max(minServiceRows, resolvedOffsets.length),
    Math.max(minServiceRows, 1),
    4
  );
  const desiredServiceRows = clamp(
    Math.round(
      chooseNumericPoolValue(
        linearConstraints.serviceLineCountPool,
        Math.min(2, resolvedOffsets.length),
        rng
      )
    ),
    Math.max(1, minServiceRows),
    Math.min(maxServiceRows, Math.max(1, resolvedOffsets.length))
  );
  const selectedOffsets = resolvedOffsets.slice(0, Math.max(1, desiredServiceRows));

  const doorTile = resolveDoorTile(minX, minY, maxX, maxY, door);
  const orientationNegPool = Array.isArray(linearConstraints?.orientationBySide?.neg)
    ? linearConstraints.orientationBySide.neg.filter((value) => Number.isInteger(value) && value >= 0 && value <= 3)
    : [];
  const orientationPosPool = Array.isArray(linearConstraints?.orientationBySide?.pos)
    ? linearConstraints.orientationBySide.pos.filter((value) => Number.isInteger(value) && value >= 0 && value <= 3)
    : [];
  const fallbackOrientation = axis === "x" ? 1 : 0;
  const fallbackNegOrientation = axis === "x" ? 0 : 3;
  const fallbackPosOrientation = axis === "x" ? 2 : 1;
  const sideCountTarget = clamp(
    Math.round(chooseNumericPoolValue(linearConstraints.serviceSideCountPool, 2, rng)),
    1,
    2
  );
  const serviceSides = (() => {
    if (sideCountTarget >= 2) {
      return [-1, 1];
    }
    if (orientationNegPool.length > 0 && orientationPosPool.length === 0) {
      return [-1];
    }
    if (orientationPosPool.length > 0 && orientationNegPool.length === 0) {
      return [1];
    }
    return [rng.nextInt(0, 1) === 0 ? -1 : 1];
  })();

  const placeAt = (pick, x, y, orientation) => {
    return tryPlaceConstrainedObject(
      placements,
      occupiedTiles,
      pick,
      x,
      y,
      orientation,
      minX,
      minY,
      maxX,
      maxY,
      doorTile,
      floor
    );
  };

  let placed = 0;
  const runStart = axis === "x" ? innerMinY : innerMinX;
  const runEnd = axis === "x" ? innerMaxY : innerMaxX;
  if (dividerPick) {
    for (let run = runStart; run <= runEnd; run++) {
      const x = axis === "x" ? dividerLine : run;
      const y = axis === "x" ? run : dividerLine;
      if (placeAt(dividerPick, x, y, fallbackOrientation)) {
        placed++;
      }
    }
  }

  const placedServiceRows = new Set();
  const tryPlaceServiceRow = (offset, side) => {
    const line = dividerLine + side * offset;
    const minLine = axis === "x" ? innerMinX : innerMinY;
    const maxLine = axis === "x" ? innerMaxX : innerMaxY;
    if (line < minLine || line > maxLine) {
      return false;
    }
    const rowKey = `${side}:${line}`;
    if (placedServiceRows.has(rowKey)) {
      return true;
    }
    let rowPlaced = false;
    for (let run = runStart; run <= runEnd; run++) {
      const x = axis === "x" ? line : run;
      const y = axis === "x" ? run : line;
      const orientation =
        side < 0
          ? orientationNegPool.length > 0
            ? rng.pick(orientationNegPool)
            : fallbackNegOrientation
          : orientationPosPool.length > 0
            ? rng.pick(orientationPosPool)
            : fallbackPosOrientation;
      if (placeAt(servicePick, x, y, orientation)) {
        placed++;
        rowPlaced = true;
      }
    }
    if (rowPlaced) {
      placedServiceRows.add(rowKey);
    }
    return rowPlaced;
  };

  if (servicePick) {
    for (const offset of selectedOffsets) {
      for (const side of serviceSides) {
        tryPlaceServiceRow(offset, side);
      }
    }
    if (placedServiceRows.size < minServiceRows) {
      for (const offset of resolvedOffsets) {
        for (const side of [-1, 1]) {
          tryPlaceServiceRow(offset, side);
          if (placedServiceRows.size >= minServiceRows) {
            break;
          }
        }
        if (placedServiceRows.size >= minServiceRows) {
          break;
        }
      }
    }
  }

  return placed > 0;
}

function addRspiStyleBuilding(
  placements,
  style,
  minX,
  minY,
  maxX,
  maxY,
  floors,
  rng,
  interiorPool,
  interiorProfile = null,
  layoutConstraints = null,
  preferredDoorOrientation = null,
  ladderSpec = null,
  outDoorways = null
) {
  const door = chooseDoorPlacement(minX, minY, maxX, maxY, rng, preferredDoorOrientation);
  const doorTile = resolveDoorTile(minX, minY, maxX, maxY, door);
  const totalFloors = clamp(floors | 0, 1, 3);
  const ladderPlacement = resolveLadderPlacement({
    minX,
    minY,
    maxX,
    maxY,
    doorTile,
    rng,
    ladderSpec,
    totalFloors,
    isBlockedTileFn: (x, y) => isWithinDoorBuffer(doorTile, x, y, 1, 1, 1),
  });
  const interiorBlockedTiles = new Set();
  if (ladderPlacement) {
    interiorBlockedTiles.add(`${ladderPlacement.x}:${ladderPlacement.y}`);
  }
  const recordedDoorKeys = new Set();
  const recordDoorTile = (x, y, orientation) => {
    if (!Array.isArray(outDoorways)) {
      return;
    }
    const key = `${x}:${y}`;
    if (recordedDoorKeys.has(key)) {
      return;
    }
    recordedDoorKeys.add(key);
    outDoorways.push({
      x: x | 0,
      y: y | 0,
      z: 0,
      orientation: (orientation | 0) & 0x3,
    });
  };
  let doorPlaced = false;

  const wallId = chooseFromPoolOrFallback(style.wallIdPool, style.wallId, rng);
  const doorId = chooseFromPoolOrFallback(style.doorIdPool, style.doorId, rng);
  const roofEdgeId = Number.isInteger(style.roofEdgeId) ? style.roofEdgeId : chooseFromPoolOrFallback(style.roofEdgeIdPool, style.roofEdgeId, rng);
  const roofTopId = Number.isInteger(style.roofTopId) ? style.roofTopId : chooseFromPoolOrFallback(style.roofTopIdPool, style.roofTopId, rng);
  const cornerIdDefault = style.wallCornerId > 0 ? style.wallCornerId : wallId;
  const cornerId = chooseFromPoolOrFallback(style.wallCornerIdPool, cornerIdDefault, rng);
  const cornerType = style.wallCornerType >= 0 ? style.wallCornerType : ObjectType.WALL_SQUARE_CORNER;
  const windowFallback =
    Array.isArray(style.windowIds) && style.windowIds.length > 0 ? rng.pick(style.windowIds) : null;
  const windowId = chooseFromPoolOrFallback(style.windowIdPool, windowFallback, rng);
  const windowSlotsByFloor = new Map();
  if (windowId) {
    for (let fl = 0; fl < totalFloors; fl++) {
      const minWindows = fl === 0 ? 2 : 1;
      windowSlotsByFloor.set(fl, selectWindowWallSlots(minX, minY, maxX, maxY, door, rng, minWindows));
    }
  }

  for (let fl = 0; fl < totalFloors; fl++) {
    const floor = fl;
    const isTopFloor = fl === totalFloors - 1;
    const roofZ = fl + 1;
    const floorWindowSlots = windowSlotsByFloor.get(fl) ?? null;

    for (let y = minY + 2; y < maxY - 1; y++) {
      const westDoor = fl === 0 && door.orientation === 2 && y === door.coord;
      const eastDoor = fl === 0 && door.orientation === 0 && y === door.coord;
      const westWindow = !!(windowId && floorWindowSlots && floorWindowSlots.has(`${minX + 1}:${y}`));
      const eastWindow = !!(windowId && floorWindowSlots && floorWindowSlots.has(`${maxX - 1}:${y}`));

      if (westDoor) {
        placements.push({ id: doorId, x: minX + 1, y, z: floor, type: ObjectType.WALL_STRAIGHT, orientation: 2 });
        recordDoorTile(minX + 1, y, 2);
        doorPlaced = true;
      } else if (westWindow) {
        placements.push({ id: windowId, x: minX + 1, y, z: floor, type: ObjectType.WALL_STRAIGHT, orientation: 2 });
      } else {
        placements.push({ id: wallId, x: minX + 1, y, z: floor, type: ObjectType.WALL_STRAIGHT, orientation: 2 });
      }

      if (eastDoor) {
        placements.push({ id: doorId, x: maxX - 1, y, z: floor, type: ObjectType.WALL_STRAIGHT, orientation: 0 });
        recordDoorTile(maxX - 1, y, 0);
        doorPlaced = true;
      } else if (eastWindow) {
        placements.push({ id: windowId, x: maxX - 1, y, z: floor, type: ObjectType.WALL_STRAIGHT, orientation: 0 });
      } else {
        placements.push({ id: wallId, x: maxX - 1, y, z: floor, type: ObjectType.WALL_STRAIGHT, orientation: 0 });
      }

      if (isTopFloor) {
        placements.push({ id: roofEdgeId, x: minX + 1, y, z: roofZ, type: ROOF_EDGE_SIDE_TYPE, orientation: 2 });
        placements.push({ id: roofEdgeId, x: maxX - 1, y, z: roofZ, type: ROOF_EDGE_SIDE_TYPE, orientation: 0 });

        if (y >= minY + 3 && y <= maxY - 3) {
          placements.push({ id: roofTopId, x: minX + 2, y, z: roofZ, type: ROOF_TOP_SIDE_TYPE, orientation: 2 });
          placements.push({ id: roofTopId, x: maxX - 2, y, z: roofZ, type: ROOF_TOP_SIDE_TYPE, orientation: 0 });
        }
      }

    }

    for (let x = minX + 2; x < maxX - 1; x++) {
      const northDoor = fl === 0 && door.orientation === 1 && x === door.coord;
      const southDoor = fl === 0 && door.orientation === 3 && x === door.coord;
      const northWindow = !!(windowId && floorWindowSlots && floorWindowSlots.has(`${x}:${minY + 1}`));
      const southWindow = !!(windowId && floorWindowSlots && floorWindowSlots.has(`${x}:${maxY - 1}`));

      if (northDoor) {
        placements.push({ id: doorId, x, y: minY + 1, z: floor, type: ObjectType.WALL_STRAIGHT, orientation: 1 });
        recordDoorTile(x, minY + 1, 1);
        doorPlaced = true;
      } else if (northWindow) {
        placements.push({ id: windowId, x, y: minY + 1, z: floor, type: ObjectType.WALL_STRAIGHT, orientation: 1 });
      } else {
        placements.push({ id: wallId, x, y: minY + 1, z: floor, type: ObjectType.WALL_STRAIGHT, orientation: 1 });
      }

      if (southDoor) {
        placements.push({ id: doorId, x, y: maxY - 1, z: floor, type: ObjectType.WALL_STRAIGHT, orientation: 3 });
        recordDoorTile(x, maxY - 1, 3);
        doorPlaced = true;
      } else if (southWindow) {
        placements.push({ id: windowId, x, y: maxY - 1, z: floor, type: ObjectType.WALL_STRAIGHT, orientation: 3 });
      } else {
        placements.push({ id: wallId, x, y: maxY - 1, z: floor, type: ObjectType.WALL_STRAIGHT, orientation: 3 });
      }

      if (isTopFloor) {
        placements.push({ id: roofEdgeId, x, y: maxY - 1, z: roofZ, type: ROOF_EDGE_SIDE_TYPE, orientation: 3 });
        placements.push({ id: roofEdgeId, x, y: minY + 1, z: roofZ, type: ROOF_EDGE_SIDE_TYPE, orientation: 1 });

        if (x >= minX + 3 && x <= maxX - 3) {
          placements.push({ id: roofTopId, x, y: maxY - 2, z: roofZ, type: ROOF_TOP_SIDE_TYPE, orientation: 3 });
          placements.push({ id: roofTopId, x, y: minY + 2, z: roofZ, type: ROOF_TOP_SIDE_TYPE, orientation: 1 });
        }
      }

    }

    if (isTopFloor) {
      placements.push({ id: roofEdgeId, x: minX + 1, y: minY + 1, z: roofZ, type: ROOF_EDGE_CORNER_TYPE, orientation: 1 });
      placements.push({ id: roofTopId, x: minX + 2, y: minY + 2, z: roofZ, type: ROOF_TOP_CORNER_TYPE, orientation: 1 });
      placements.push({ id: roofEdgeId, x: minX + 1, y: maxY - 1, z: roofZ, type: ROOF_EDGE_CORNER_TYPE, orientation: 2 });
      placements.push({ id: roofTopId, x: minX + 2, y: maxY - 2, z: roofZ, type: ROOF_TOP_CORNER_TYPE, orientation: 2 });
      placements.push({ id: roofEdgeId, x: maxX - 1, y: maxY - 1, z: roofZ, type: ROOF_EDGE_CORNER_TYPE, orientation: 3 });
      placements.push({ id: roofTopId, x: maxX - 2, y: maxY - 2, z: roofZ, type: ROOF_TOP_CORNER_TYPE, orientation: 3 });
      placements.push({ id: roofEdgeId, x: maxX - 1, y: minY + 1, z: roofZ, type: ROOF_EDGE_CORNER_TYPE, orientation: 0 });
      placements.push({ id: roofTopId, x: maxX - 2, y: minY + 2, z: roofZ, type: ROOF_TOP_CORNER_TYPE, orientation: 0 });

      for (let x = minX + 3; x <= maxX - 3; x++) {
        for (let y = minY + 3; y <= maxY - 3; y++) {
          placements.push({ id: roofTopId, x, y, z: roofZ, type: ROOF_TOP_FLAT_TYPE, orientation: 0 });
        }
      }
    }

    placements.push({ id: cornerId, x: minX + 1, y: minY + 1, z: floor, type: cornerType, orientation: 1 });
    placements.push({ id: cornerId, x: minX + 1, y: maxY - 1, z: floor, type: cornerType, orientation: 2 });
    placements.push({ id: cornerId, x: maxX - 1, y: maxY - 1, z: floor, type: cornerType, orientation: 3 });
    placements.push({ id: cornerId, x: maxX - 1, y: minY + 1, z: floor, type: cornerType, orientation: 0 });

    // Ensure wall segments directly adjacent to corners are always present.
    // Never overwrite the chosen doorway tile on ground floor.
    const pushReinforcedWall = (x, y, orientation) => {
      if (floor === 0 && doorTile && x === doorTile.x && y === doorTile.y) {
        return;
      }
      placements.push({ id: wallId, x, y, z: floor, type: ObjectType.WALL_STRAIGHT, orientation });
    };
    pushReinforcedWall(minX + 2, minY + 1, 1);
    pushReinforcedWall(minX + 1, minY + 2, 2);
    pushReinforcedWall(maxX - 2, minY + 1, 1);
    pushReinforcedWall(maxX - 1, minY + 2, 0);
    pushReinforcedWall(minX + 2, maxY - 1, 3);
    pushReinforcedWall(minX + 1, maxY - 2, 2);
    pushReinforcedWall(maxX - 2, maxY - 1, 3);
    pushReinforcedWall(maxX - 1, maxY - 2, 0);

    const linearConstraints = layoutConstraints?.linear ?? null;
    const floorBlockedTiles = new Set(interiorBlockedTiles);
    if (floor === 0 && doorTile) {
      const doorPathDepth = clamp(Number.parseInt(linearConstraints?.doorPathDepth, 10) || 2, 1, 8);
      const doorPathHalfWidth = clamp(Number.parseInt(linearConstraints?.doorPathHalfWidth, 10) || 0, 0, 2);
      markDoorApproachTiles(
        floorBlockedTiles,
        doorTile,
        door,
        minX,
        minY,
        maxX,
        maxY,
        doorPathDepth,
        doorPathHalfWidth
      );
    }
    const hasLinearMotif = addLinearMotifObjects(
      placements,
      linearConstraints,
      minX,
      minY,
      maxX,
      maxY,
      floor,
      rng,
      door,
      floorBlockedTiles
    );
    const motifMiscPool =
      hasLinearMotif && Array.isArray(linearConstraints?.miscPool) && linearConstraints.miscPool.length > 0
        ? linearConstraints.miscPool
        : interiorPool;
    const motifInteriorProfile =
      hasLinearMotif
        ? {
            densityByFloor: null,
            defaultDensity: 0.08,
            relationPools: null,
          }
        : interiorProfile;
    addInteriorObjects(
      placements,
      motifMiscPool,
      motifInteriorProfile,
      minX,
      minY,
      maxX,
      maxY,
      floor,
      rng,
      door,
      floorBlockedTiles
    );
  }

  if (ladderPlacement) {
    for (let level = 0; level < Math.min(totalFloors, ladderPlacement.ids.length); level++) {
      const ladderId = ladderPlacement.ids[level];
      if (!isValidObjectId(ladderId)) {
        continue;
      }
      placements.push({
        id: ladderId,
        x: ladderPlacement.x,
        y: ladderPlacement.y,
        z: level,
        type: ObjectType.INTERACTIVE,
        orientation: ladderPlacement.orientation,
      });
    }
  }

  if (!doorPlaced && doorTile) {
    placements.push({
      id: doorId,
      x: doorTile.x,
      y: doorTile.y,
      z: 0,
      type: ObjectType.WALL_STRAIGHT,
      orientation: door.orientation & 0x3,
    });
    recordDoorTile(doorTile.x, doorTile.y, door.orientation & 0x3);
  }
}

function flattenHeightsAroundRect(heights, rect, size) {
  const outerMinX = Math.max(0, rect.x - 2);
  const outerMinY = Math.max(0, rect.y - 2);
  const outerMaxX = Math.min(size - 1, rect.x + rect.w + 1);
  const outerMaxY = Math.min(size - 1, rect.y + rect.h + 1);
  const innerMinX = Math.max(0, rect.x + 1);
  const innerMinY = Math.max(0, rect.y + 1);
  const innerMaxX = Math.min(size - 1, rect.x + rect.w - 2);
  const innerMaxY = Math.min(size - 1, rect.y + rect.h - 2);

  const samples = [];
  for (let x = outerMinX; x <= outerMaxX; x++) {
    for (let y = outerMinY; y <= outerMaxY; y++) {
      const insideInner = x >= innerMinX && x <= innerMaxX && y >= innerMinY && y <= innerMaxY;
      if (!insideInner) {
        samples.push(heights[x][y]);
      }
    }
  }
  if (samples.length === 0) {
    return;
  }
  const average = Math.round(samples.reduce((a, b) => a + b, 0) / samples.length);
  for (let x = outerMinX; x <= outerMaxX; x++) {
    for (let y = outerMinY; y <= outerMaxY; y++) {
      heights[x][y] = average;
    }
  }
}

function createRoadPlan(size, config, rng) {
  if (!config.townMode) {
    return { vertical: [], horizontal: [], width: 0 };
  }
  const vertical = [];
  const horizontal = [];
  const spacing = clamp(config.roadSpacing, 8, 20);
  const width = clamp(config.roadWidth, 1, 3);

  let x = rng.nextInt(6, Math.min(spacing, size - 8));
  while (x < size - 5) {
    vertical.push(x);
    x += clamp(spacing + rng.nextInt(-2, 2), 7, 22);
  }
  let y = rng.nextInt(6, Math.min(spacing, size - 8));
  while (y < size - 5) {
    horizontal.push(y);
    y += clamp(spacing + rng.nextInt(-2, 2), 7, 22);
  }
  return { vertical, horizontal, width };
}

function rectIntersectsRoad(rect, roadPlan, padding = 1) {
  if (!roadPlan || (roadPlan.vertical.length === 0 && roadPlan.horizontal.length === 0)) {
    return false;
  }
  const minX = rect.x - padding;
  const maxX = rect.x + rect.w + padding - 1;
  const minY = rect.y - padding;
  const maxY = rect.y + rect.h + padding - 1;
  for (const roadX of roadPlan.vertical) {
    if (roadX >= minX - roadPlan.width && roadX <= maxX + roadPlan.width) {
      return true;
    }
  }
  for (const roadY of roadPlan.horizontal) {
    if (roadY >= minY - roadPlan.width && roadY <= maxY + roadPlan.width) {
      return true;
    }
  }
  return false;
}

function nearestRoadDoorOrientation(rect, roadPlan) {
  if (!roadPlan || (roadPlan.vertical.length === 0 && roadPlan.horizontal.length === 0)) {
    return null;
  }
  const centerX = rect.x + (rect.w >> 1);
  const centerY = rect.y + (rect.h >> 1);
  let best = { dist: Number.MAX_SAFE_INTEGER, orientation: null };

  for (const roadX of roadPlan.vertical) {
    const dist = Math.abs(centerX - roadX);
    const orientation = roadX < centerX ? 2 : 0;
    if (dist < best.dist) {
      best = { dist, orientation };
    }
  }
  for (const roadY of roadPlan.horizontal) {
    const dist = Math.abs(centerY - roadY);
    const orientation = roadY < centerY ? 1 : 3;
    if (dist < best.dist) {
      best = { dist, orientation };
    }
  }
  return best.orientation;
}

function pickFootprint(config, rng) {
  const template = config.layoutTemplates.length > 0 && rng.nextInt(0, 99) < 70 ? rng.pick(config.layoutTemplates) : null;
  let w = template ? template.width : rng.pick(config.widthChoices);
  let h = template ? template.height : rng.pick(config.heightChoices);
  if (rng.nextInt(0, 1) === 1) {
    const swap = w;
    w = h;
    h = swap;
  }
  const floorsBase = template ? template.floors : rng.nextInt(config.minFloors, config.maxFloors);
  const floors = clamp(floorsBase + (rng.nextInt(0, 99) < 12 ? 1 : 0), config.minFloors, config.maxFloors);
  return { width: clamp(w, 7, 14), height: clamp(h, 7, 14), floors };
}

function shuffleInPlace(values, rng) {
  for (let i = values.length - 1; i > 0; i--) {
    const j = rng.nextInt(0, i);
    const tmp = values[i];
    values[i] = values[j];
    values[j] = tmp;
  }
}

function generateTownLots(size, rng) {
  const lots = [];
  let y = 2;
  let row = 0;

  while (y < size - 8) {
    const baseRowHeight = rng.nextInt(7, 10);
    const rowHeight = Math.min(baseRowHeight, Math.max(6, size - y - 2));
    let x = 2;
    while (x < size - 8) {
      const w = Math.min(rng.nextInt(6, 10), Math.max(6, size - x - 2));
      if (x + w > size - 2) {
        break;
      }
      const h = Math.min(rowHeight, Math.max(6, size - y - 2));
      if (x + w <= size - 2 && y + h <= size - 2) {
        lots.push({ x, y, w, h, row });
      }
      x += w + rng.nextInt(0, 1);
      if (rng.nextInt(0, 99) < 10) {
        x += 1;
      }
    }
    y += rowHeight + 1;
    if (row % 2 === 1) {
      y += 1;
    }
    row++;
  }

  shuffleInPlace(lots, rng);
  return lots;
}

function resolveStyleForTag(styleTag, config) {
  const normalizedTag = String(styleTag ?? "").trim().toLowerCase();
  if (!normalizedTag) {
    return null;
  }
  const styles = Array.isArray(config?.styles) ? config.styles : [];
  const fromConfig = styles.find((style) => String(style?.key ?? "").trim().toLowerCase() === normalizedTag);
  if (fromConfig) {
    return fromConfig;
  }
  const fromBuiltIns = HOUSE_TYPES.find((style) => String(style?.key ?? "").trim().toLowerCase() === normalizedTag);
  return fromBuiltIns ?? null;
}

function chooseSingleHouseFloors(rng, dumpProfile, footprint, maxFloors) {
  const cappedMax = clamp(maxFloors | 0, 1, 3);
  if (cappedMax <= 1) {
    return 1;
  }

  const pool = Array.isArray(dumpProfile?.floorPool)
    ? dumpProfile.floorPool.filter((value) => Number.isInteger(value) && value >= 1 && value <= cappedMax)
    : [];
  const sampled = pool.length > 0 ? rng.pick(pool) : footprint.floors;
  const preferred = clamp(sampled, 1, cappedMax);

  // Bias toward single-floor houses by default, but keep typed bank samples more faithful.
  const singleFloorBias = dumpProfile?.houseType === "BANK" ? 15 : 45;
  if (rng.nextInt(0, 99) < singleFloorBias) {
    return 1;
  }

  const multiCandidates = [];
  const pushCandidate = (value) => {
    if (!Number.isInteger(value) || value < 2 || value > cappedMax || multiCandidates.includes(value)) {
      return;
    }
    multiCandidates.push(value);
  };

  pushCandidate(preferred);
  pushCandidate(preferred - 1);
  pushCandidate(preferred + 1);
  pushCandidate(2);
  if (cappedMax >= 3 && rng.nextInt(0, 99) < 40) {
    pushCandidate(3);
  }

  if (multiCandidates.length === 0) {
    return 1;
  }
  return rng.pick(multiCandidates);
}

function nearestDistanceToPool(value, pool) {
  if (!Number.isFinite(value) || !Array.isArray(pool) || pool.length === 0) {
    return null;
  }
  let nearest = Number.POSITIVE_INFINITY;
  for (const entry of pool) {
    if (!Number.isFinite(Number(entry))) {
      continue;
    }
    const distance = Math.abs(value - Number(entry));
    if (distance < nearest) {
      nearest = distance;
    }
  }
  return Number.isFinite(nearest) ? nearest : null;
}

function modeFromPool(pool, fallback = null) {
  if (!Array.isArray(pool) || pool.length === 0) {
    return fallback;
  }
  const counts = new Map();
  for (const value of pool) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let bestValue = fallback;
  let bestCount = -1;
  for (const [value, count] of counts.entries()) {
    if (count > bestCount) {
      bestValue = value;
      bestCount = count;
    }
  }
  return bestValue;
}

function buildPoolKeySet(pool) {
  const set = new Set();
  if (!Array.isArray(pool)) {
    return set;
  }
  for (const entry of pool) {
    const id = Number.parseInt(entry?.id, 10);
    const type = Number.parseInt(entry?.type, 10);
    if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(type)) {
      continue;
    }
    set.add(`${id}:${normalizeInteriorPlacementType(type)}`);
  }
  return set;
}

function isInteriorScoringPlacement(placement, minX, minY, maxX, maxY) {
  if (!placement || !INTERIOR_SCORING_TYPES.has(placement.type)) {
    return false;
  }
  return placement.x >= minX + 2 && placement.x <= maxX - 2 && placement.y >= minY + 2 && placement.y <= maxY - 2;
}

function scoreGeneratedSingleHouseCandidate(candidate, dumpProfile, style) {
  if (!dumpProfile || !candidate || !Array.isArray(candidate.placements)) {
    return 100;
  }
  let score = 0;
  let maxScore = 0;

  const widthChoices = Array.isArray(dumpProfile.widthChoices) ? dumpProfile.widthChoices : [];
  const heightChoices = Array.isArray(dumpProfile.heightChoices) ? dumpProfile.heightChoices : [];
  if (widthChoices.length > 0) {
    maxScore += 12;
    const distance = nearestDistanceToPool(candidate.width, widthChoices);
    score += clamp(12 - Math.round((distance ?? 6) * 2), 0, 12);
  }
  if (heightChoices.length > 0) {
    maxScore += 12;
    const distance = nearestDistanceToPool(candidate.height, heightChoices);
    score += clamp(12 - Math.round((distance ?? 6) * 2), 0, 12);
  }

  const floorPool = Array.isArray(dumpProfile.floorPool) ? dumpProfile.floorPool : [];
  if (floorPool.length > 0) {
    maxScore += 10;
    const distance = nearestDistanceToPool(candidate.floors, floorPool);
    score += clamp(10 - Math.round((distance ?? 3) * 4), 0, 10);
  }

  maxScore += 10;
  const doorCount = candidate.placements.filter(
    (placement) =>
      placement.z === 0 &&
      placement.type === ObjectType.WALL_STRAIGHT &&
      Number.isInteger(style?.doorId) &&
      placement.id === style.doorId
  ).length;
  if (doorCount === 1) {
    score += 10;
  } else if (doorCount > 1) {
    score += 6;
  }

  const linear = dumpProfile?.layoutConstraints?.linear ?? null;
  if (linear && typeof linear === "object") {
    const dividerKeys = buildPoolKeySet(linear.dividerPool);
    const serviceKeys = buildPoolKeySet(linear.servicePool);
    const floorSet = new Set(
      Array.isArray(linear.floorPool) && linear.floorPool.length > 0
        ? linear.floorPool.filter((value) => Number.isInteger(value) && value >= 0 && value <= 3)
        : [0]
    );
    const linearPlacements = candidate.placements.filter((placement) => {
      if (!floorSet.has(placement.z)) {
        return false;
      }
      const key = `${placement.id}:${normalizeInteriorPlacementType(placement.type)}`;
      return dividerKeys.has(key) || serviceKeys.has(key);
    });
    maxScore += 28;
    if (linearPlacements.length > 0) {
      const serviceCount = linearPlacements.filter((placement) => {
        const key = `${placement.id}:${normalizeInteriorPlacementType(placement.type)}`;
        return serviceKeys.has(key);
      }).length;
      const dividerCount = linearPlacements.length - serviceCount;
      score += clamp(Math.round(serviceCount / 2), 0, 10);
      score += clamp(Math.round(dividerCount / 2), 0, 8);

      const dominantAxis = modeFromPool(linear.dividerAxisPool, null);
      const lineHistogram = new Map();
      for (const placement of linearPlacements) {
        const line = dominantAxis === "y" ? placement.y : placement.x;
        lineHistogram.set(line, (lineHistogram.get(line) ?? 0) + 1);
      }
      const topLineCount = [...lineHistogram.values()].sort((a, b) => b - a)[0] ?? 0;
      const alignmentRatio = topLineCount / Math.max(1, linearPlacements.length);
      score += clamp(Math.round(alignmentRatio * 10), 0, 10);

      const desiredRows = Array.isArray(linear.serviceLineCountPool)
        ? linear.serviceLineCountPool.filter((value) => Number.isInteger(value) && value >= 1)
        : [];
      if (desiredRows.length > 0 && serviceCount > 0) {
        const serviceLines = new Set();
        for (const placement of linearPlacements) {
          const key = `${placement.id}:${normalizeInteriorPlacementType(placement.type)}`;
          if (!serviceKeys.has(key)) {
            continue;
          }
          serviceLines.add(dominantAxis === "y" ? placement.y : placement.x);
        }
        const rowDistance = nearestDistanceToPool(serviceLines.size, desiredRows);
        score += clamp(4 - Math.round((rowDistance ?? 2) * 2), 0, 4);
      }
    }
  }

  const targetDensity = Number.isFinite(Number(dumpProfile?.interiorDensityByFloor?.["0"]))
    ? Number(dumpProfile.interiorDensityByFloor["0"])
    : Number.isFinite(Number(dumpProfile?.interiorDensityDefault))
      ? Number(dumpProfile.interiorDensityDefault)
      : null;
  if (targetDensity !== null) {
    maxScore += 12;
    const interiorArea = Math.max(1, Math.max(1, candidate.width - 4) * Math.max(1, candidate.height - 4));
    const generatedInteriorCount = candidate.placements.filter((placement) =>
      placement.z === 0 &&
      isInteriorScoringPlacement(placement, candidate.minX, candidate.minY, candidate.maxX, candidate.maxY)
    ).length;
    const generatedDensity = generatedInteriorCount / interiorArea;
    const allowableDelta = Math.max(0.12, targetDensity * 0.8);
    const densityDelta = Math.abs(generatedDensity - targetDensity);
    const densityScore = 1 - clamp(densityDelta / allowableDelta, 0, 1);
    score += Math.round(densityScore * 12);
  }

  if (maxScore <= 0) {
    return 100;
  }
  return Number(((score / maxScore) * 100).toFixed(2));
}

function generateSingleHouseForRegion(styleTag, seed, size = 64, localAnchorX = 32, localAnchorY = 32, floorOffset = 0, houseType = null) {
  const normalizedSeed = seed >>> 0;
  const config = getGenerationConfig();
  const normalizedType = normalizeHouseExampleType(houseType);
  const dumpProfile = readHouseDumpProfile(styleTag, normalizedType);
  const safeTag = sanitizeStyleTag(styleTag);
  const dumpPath = safeTag ? path.join(HOUSE_DUMP_DIRECTORY, `${safeTag}.json`) : null;
  if (!dumpProfile && dumpPath && fs.existsSync(dumpPath)) {
    const typeSuffix = normalizedType ? ` type '${normalizedType}'` : " untyped examples";
    throw new Error(`No house examples found for style '${safeTag}'${typeSuffix}.`);
  }
  const style = dumpProfile?.style ?? resolveStyleForTag(styleTag, config);
  if (!style) {
    throw new Error(`Unknown house style '${styleTag}'.`);
  }
  if (!isStyleUsable(style)) {
    throw new Error(`House style '${styleTag}' has invalid object ids.`);
  }

  const profileWidthChoices =
    Array.isArray(dumpProfile?.widthChoices) && dumpProfile.widthChoices.length > 0 ? dumpProfile.widthChoices : null;
  const profileHeightChoices =
    Array.isArray(dumpProfile?.heightChoices) && dumpProfile.heightChoices.length > 0 ? dumpProfile.heightChoices : null;
  const widthChoiceDiversity = profileWidthChoices ? new Set(profileWidthChoices).size > 1 : false;
  const heightChoiceDiversity = profileHeightChoices ? new Set(profileHeightChoices).size > 1 : false;
  const interiorPool =
    Array.isArray(dumpProfile?.interiorObjects) && dumpProfile.interiorObjects.length > 0
      ? dumpProfile.interiorObjects
      : config.interiorObjects;
  const interiorProfile = {
    densityByFloor: dumpProfile?.interiorDensityByFloor ?? null,
    defaultDensity: Number.isFinite(Number(dumpProfile?.interiorDensityDefault)) ? Number(dumpProfile.interiorDensityDefault) : null,
    relationPools: dumpProfile?.interiorRelationPools ?? null,
  };
  const layoutConstraints = dumpProfile?.layoutConstraints ?? null;
  const ladderSpec = dumpProfile?.ladderSpec ?? null;
  const zShift = clamp(floorOffset | 0, 0, 3);
  const hasLinearMotif = !!layoutConstraints?.linear;

  const buildCandidate = (attemptSeed) => {
    const rng = new XorShift32(attemptSeed >>> 0);
    const footprint = pickFootprint(config, rng);

    let width = clamp(
      profileWidthChoices ? rng.pick(profileWidthChoices) : footprint.width,
      SINGLE_HOUSE_MIN_DIM,
      SINGLE_HOUSE_MAX_DIM
    );
    let height = clamp(
      profileHeightChoices ? rng.pick(profileHeightChoices) : footprint.height,
      SINGLE_HOUSE_MIN_DIM,
      SINGLE_HOUSE_MAX_DIM
    );

    if (!widthChoiceDiversity) {
      width = clamp(width + rng.nextInt(-2, 2), SINGLE_HOUSE_MIN_DIM, SINGLE_HOUSE_MAX_DIM);
    }
    if (!heightChoiceDiversity) {
      height = clamp(height + rng.nextInt(-2, 2), SINGLE_HOUSE_MIN_DIM, SINGLE_HOUSE_MAX_DIM);
    }
    if (!widthChoiceDiversity && !heightChoiceDiversity && rng.nextInt(0, 99) < 45) {
      if (rng.nextInt(0, 1) === 0) {
        width = clamp(
          width + (rng.nextInt(0, 1) === 0 ? -1 : 1),
          SINGLE_HOUSE_MIN_DIM,
          SINGLE_HOUSE_MAX_DIM
        );
      } else {
        height = clamp(
          height + (rng.nextInt(0, 1) === 0 ? -1 : 1),
          SINGLE_HOUSE_MIN_DIM,
          SINGLE_HOUSE_MAX_DIM
        );
      }
    }

    const squareChance = normalizedType === "BANK" ? 5 : hasLinearMotif ? 12 : 30;
    const forceSquare = rng.nextInt(0, 99) < squareChance;
    if (forceSquare) {
      const side = clamp(
        Math.round((width + height) / 2) + rng.nextInt(-1, 1),
        SINGLE_HOUSE_MIN_DIM,
        SINGLE_HOUSE_MAX_DIM
      );
      width = side;
      height = side;
    } else {
      if (rng.nextInt(0, 99) < 35) {
        const swap = width;
        width = height;
        height = swap;
      }
      if (width === height) {
        const delta = rng.nextInt(0, 1) === 0 ? -1 : 1;
        width = clamp(width + delta, SINGLE_HOUSE_MIN_DIM, SINGLE_HOUSE_MAX_DIM);
        if (width === height) {
          height = clamp(height + (delta === -1 ? 1 : -1), SINGLE_HOUSE_MIN_DIM, SINGLE_HOUSE_MAX_DIM);
        }
      }
    }

    // Keep generated footprints from becoming overly long/thin.
    // BANK layouts are constrained harder so they stay town-realistic.
    const maxAspectRatio = normalizedType === "BANK" ? 1.6 : 2.0;
    const minShortSide = normalizedType === "BANK" ? 8 : SINGLE_HOUSE_MIN_DIM;
    let longSide = Math.max(width, height);
    let shortSide = Math.max(1, Math.min(width, height));
    if (shortSide < minShortSide) {
      shortSide = minShortSide;
    }
    const maxAllowedLongSide = clamp(
      Math.round(shortSide * maxAspectRatio),
      shortSide,
      SINGLE_HOUSE_MAX_DIM
    );
    if (longSide > maxAllowedLongSide) {
      longSide = maxAllowedLongSide;
    }
    if (width >= height) {
      width = longSide;
      height = shortSide;
    } else {
      width = shortSide;
      height = longSide;
    }

    const x = clamp((localAnchorX | 0) - (width >> 1), 2, Math.max(2, size - width - 3));
    const y = clamp((localAnchorY | 0) - (height >> 1), 2, Math.max(2, size - height - 3));
    const maxFloorsAllowed = clamp(3 - (floorOffset | 0), 1, 3);
    const maxLadderFloors = clamp(Number.isInteger(ladderSpec?.maxChainLength) ? ladderSpec.maxChainLength : 1, 1, 3);
    const floors = chooseSingleHouseFloors(rng, dumpProfile, footprint, Math.min(maxFloorsAllowed, maxLadderFloors));
    const floorUnderlay = chooseFromPoolOrFallback(style.floorUnderlayPool, style.floorUnderlay, rng);

    const placements = [];
    const floorPatches = [];
    for (let floor = 0; floor < floors; floor++) {
      const patchPlane = floor + zShift;
      if (patchPlane < 0 || patchPlane >= 4) {
        continue;
      }
      floorPatches.push({
        // Walls are placed on min/max inset by 1 tile, so floor overlay must be inner interior.
        x: x + 2,
        y: y + 2,
        width: Math.max(1, width - 4),
        height: Math.max(1, height - 4),
        underlay: floorUnderlay,
        z: patchPlane,
      });
    }

    const minX = x;
    const minY = y;
    const maxX = x + width - 1;
    const maxY = y + height - 1;
    addRspiStyleBuilding(
      placements,
      style,
      minX,
      minY,
      maxX,
      maxY,
      floors,
      rng,
      interiorPool,
      interiorProfile,
      layoutConstraints,
      null,
      ladderSpec
    );

    return {
      styleKey: style.key,
      x,
      y,
      width,
      height,
      floors,
      minX,
      minY,
      maxX,
      maxY,
      floorPatches,
      placements,
    };
  };

  const maxAttempts = dumpProfile ? 6 : 1;
  const targetScore = normalizedType === "BANK" ? 66 : 60;
  let bestCandidate = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const attemptSeed = (normalizedSeed + Math.imul(attempt, 0x9e3779b1)) >>> 0;
    const candidate = buildCandidate(attemptSeed);
    const similarity = scoreGeneratedSingleHouseCandidate(candidate, dumpProfile, style);
    if (similarity > bestScore) {
      bestScore = similarity;
      bestCandidate = candidate;
    }
    if (similarity >= targetScore) {
      break;
    }
  }

  const chosen = bestCandidate ?? buildCandidate(normalizedSeed);
  const shiftedPlacements = chosen.placements
    .map((placement) => ({
      ...placement,
      z: (placement.z | 0) + zShift,
    }))
    .filter((placement) => placement.z >= 0 && placement.z < 4);

  return {
    styleKey: chosen.styleKey,
    buildings: [
      {
        style: chosen.styleKey,
        x: chosen.x,
        y: chosen.y,
        width: chosen.width,
        height: chosen.height,
        floors: chosen.floors,
      },
    ],
    floorPatches: chosen.floorPatches,
    placements: shiftedPlacements,
  };
}

function generateHouseForRect(
  styleTag,
  seed,
  rect,
  floorsArg = null,
  floorOffset = 0,
  houseType = null,
  preferredDoorOrientation = null
) {
  const normalizedSeed = seed >>> 0;
  const config = getGenerationConfig();
  const normalizedType = normalizeHouseExampleType(houseType);
  const dumpProfile = readHouseDumpProfile(styleTag, normalizedType);
  const style = dumpProfile?.style ?? resolveStyleForTag(styleTag, config);
  if (!style) {
    throw new Error(`Unknown house style '${styleTag}'.`);
  }
  if (!isStyleUsable(style)) {
    throw new Error(`House style '${styleTag}' has invalid object ids.`);
  }

  const x = rect?.x | 0;
  const y = rect?.y | 0;
  const width = Math.max(SINGLE_HOUSE_MIN_DIM, rect?.w | 0);
  const height = Math.max(SINGLE_HOUSE_MIN_DIM, rect?.h | 0);
  const minX = x;
  const minY = y;
  const maxX = x + width - 1;
  const maxY = y + height - 1;

  const interiorPool =
    Array.isArray(dumpProfile?.interiorObjects) && dumpProfile.interiorObjects.length > 0
      ? dumpProfile.interiorObjects
      : config.interiorObjects;
  const interiorProfile = {
    densityByFloor: dumpProfile?.interiorDensityByFloor ?? null,
    defaultDensity: Number.isFinite(Number(dumpProfile?.interiorDensityDefault))
      ? Number(dumpProfile.interiorDensityDefault)
      : null,
    relationPools: dumpProfile?.interiorRelationPools ?? null,
  };
  const layoutConstraints = dumpProfile?.layoutConstraints ?? null;
  const ladderSpec = dumpProfile?.ladderSpec ?? null;

  const rng = new XorShift32(normalizedSeed);
  const zShift = clamp(floorOffset | 0, 0, 3);
  const maxFloorsAllowed = clamp(3 - zShift, 1, 3);
  const maxLadderFloors = clamp(Number.isInteger(ladderSpec?.maxChainLength) ? ladderSpec.maxChainLength : 1, 1, 3);
  const floorCap = Math.min(maxFloorsAllowed, maxLadderFloors);
  const resolvedFloors = Number.isInteger(floorsArg)
    ? clamp(floorsArg, 1, floorCap)
    : dumpProfile
      ? chooseSingleHouseFloors(rng, dumpProfile, { floors: 1 }, floorCap)
      : rng.nextInt(1, Math.min(2, floorCap));

  const floorUnderlay = chooseFromPoolOrFallback(style.floorUnderlayPool, style.floorUnderlay, rng);
  const floorPatches = [];
  for (let floor = 0; floor < resolvedFloors; floor++) {
    const patchPlane = floor + zShift;
    if (patchPlane < 0 || patchPlane >= 4) {
      continue;
    }
    floorPatches.push({
      x: x + 2,
      y: y + 2,
      width: Math.max(1, width - 4),
      height: Math.max(1, height - 4),
      underlay: floorUnderlay,
      z: patchPlane,
    });
  }

  const placements = [];
  const doorwayTiles = [];
  addRspiStyleBuilding(
    placements,
    style,
    minX,
    minY,
    maxX,
    maxY,
    resolvedFloors,
    rng,
    interiorPool,
    interiorProfile,
    layoutConstraints,
    Number.isInteger(preferredDoorOrientation) ? preferredDoorOrientation : null,
    ladderSpec,
    doorwayTiles
  );

  const shiftedPlacements = placements
    .map((placement) => ({
      ...placement,
      z: (placement.z | 0) + zShift,
    }))
    .filter((placement) => placement.z >= 0 && placement.z < 4);
  const shiftedDoorways = doorwayTiles
    .map((doorway) => ({
      x: doorway.x | 0,
      y: doorway.y | 0,
      z: (doorway.z | 0) + zShift,
      orientation: (doorway.orientation | 0) & 0x3,
    }))
    .filter((doorway) => doorway.z >= 0 && doorway.z < 4);

  return {
    styleKey: style.key,
    x,
    y,
    width,
    height,
    floors: resolvedFloors,
    floorPatches,
    doorways: shiftedDoorways,
    placements: shiftedPlacements,
  };
}

function generateBuildingsForRegion(regionX, regionY, seed, size = 64, heightGrid = null) {
  const regionSeed = (seed ^ ((regionX & 0xffff) << 16) ^ (regionY & 0xffff)) >>> 0;
  const rng = new XorShift32(regionSeed);
  const config = getGenerationConfig();
  const minCount = Math.min(config.buildingCountMin, config.buildingCountMax);
  const maxCount = Math.max(config.buildingCountMin, config.buildingCountMax);
  const buildingCount = rng.nextInt(minCount, maxCount);

  const roadPlan = createRoadPlan(size, config, rng);
  const footprints = [];
  const buildings = [];
  const floorPatches = [];
  const placements = [];
  const maxAttempts = config.townMode ? 320 : 80;

  function placeOneBuilding(rect, floors, useRoadFilter = true, spacingOverride = null, doorOrientationOverride = null) {
    const { x, y, w, h } = rect;
    const spacing = Number.isInteger(spacingOverride) ? spacingOverride : config.minSpacing;
    if (useRoadFilter && rectIntersectsRoad(rect, roadPlan, config.roadClearance)) {
      return false;
    }
    if (footprints.some((existing) => rectsOverlap(existing, rect, spacing))) {
      return false;
    }
    const style = rng.pick(config.styles);
    footprints.push(rect);
    for (let floor = 0; floor < floors; floor++) {
      floorPatches.push({
        x: x + 2,
        y: y + 2,
        width: Math.max(1, w - 4),
        height: Math.max(1, h - 4),
        underlay: style.floorUnderlay,
        z: floor,
      });
    }

    const minX = x;
    const minY = y;
    const maxX = x + w - 1;
    const maxY = y + h - 1;
    const doorOrientation = Number.isInteger(doorOrientationOverride)
      ? doorOrientationOverride
      : nearestRoadDoorOrientation(rect, roadPlan);

    const generatedInteriorProfile = {
      densityByFloor: null,
      defaultDensity: floors >= 2 ? 0.22 : 0.24,
      relationPools: null,
    };
    addRspiStyleBuilding(
      placements,
      style,
      minX,
      minY,
      maxX,
      maxY,
      floors,
      rng,
      config.interiorObjects,
      generatedInteriorProfile,
      null,
      doorOrientation,
      null
    );
    if (heightGrid) {
      flattenHeightsAroundRect(heightGrid, rect, size);
    }
    buildings.push({
      style: style.key,
      x,
      y,
      width: w,
      height: h,
      floors,
    });
    return true;
  }

  if (config.townMode) {
    const lots = generateTownLots(size, rng);
    const target = Math.min(buildingCount, lots.length);
    for (let i = 0; i < lots.length && buildings.length < target; i++) {
      const lot = lots[i];
      const floors = rng.nextInt(config.minFloors, config.maxFloors);
      const doorOrientation = lot.row % 2 === 0 ? 3 : 1;
      placeOneBuilding({ x: lot.x, y: lot.y, w: lot.w, h: lot.h }, floors, false, 0, doorOrientation);
    }
  }

  for (let i = 0; i < buildingCount && buildings.length < buildingCount; i++) {
    let placed = false;
    for (let attempt = 0; attempt < maxAttempts && !placed; attempt++) {
      const footprint = pickFootprint(config, rng);
      const w = footprint.width;
      const h = footprint.height;
      const x = rng.nextInt(2, Math.max(2, size - w - 3));
      const y = rng.nextInt(2, Math.max(2, size - h - 3));
      const rect = { x, y, w, h };
      placed = placeOneBuilding(rect, footprint.floors, !config.townMode);
    }
  }

  // Fallback: guarantee at least a few buildings even with pathological learned params.
  const minimumExpected = Math.max(8, Math.floor(minCount * 0.75));
  if (buildings.length < minimumExpected) {
    const fallbackSizes = [6, 7, 8, 9, 10, 11, 12];
    const fallbackSpacing = 1;
    const fallbackAttempts = 500;
    for (let attempt = 0; attempt < fallbackAttempts && buildings.length < minimumExpected; attempt++) {
      const w = rng.pick(fallbackSizes);
      const h = rng.pick(fallbackSizes);
      const x = rng.nextInt(2, Math.max(2, size - w - 3));
      const y = rng.nextInt(2, Math.max(2, size - h - 3));
      const rect = { x, y, w, h };
      if (footprints.some((existing) => rectsOverlap(existing, rect, fallbackSpacing))) {
        continue;
      }
      placeOneBuilding(rect, rng.nextInt(1, Math.min(2, config.maxFloors)), false, fallbackSpacing);
    }
  }

  return { buildings, floorPatches, placements };
}

module.exports = {
  HOUSE_TYPES,
  generateHouseForRect,
  generateSingleHouseForRegion,
  generateBuildingsForRegion,
};
