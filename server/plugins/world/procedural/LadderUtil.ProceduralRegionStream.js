const { ObjectDefinition } = require("../../../src/main/typescript/elvarg/game/definition/ObjectDefinition");
const { ObjectIdentifiers } = require("../../../src/main/typescript/elvarg/util/ObjectIdentifiers");
const { ObjectType } = require("./ObjectType.ProceduralRegionStream");

const LADDER_NAME_PATTERN = /^Ladder$/;
const LADDER_IDENTIFIER_PATTERN = /^LADDER(?:_\d+)?$/;

const LADDER_SIDE = Object.freeze({
  WEST: "west",
  EAST: "east",
  NORTH: "north",
  SOUTH: "south",
});

const LADDER_SIDE_VALUES = Object.freeze([
  LADDER_SIDE.WEST,
  LADDER_SIDE.EAST,
  LADDER_SIDE.NORTH,
  LADDER_SIDE.SOUTH,
]);

let ladderObjectIdSet = null;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function isLadderName(name) {
  return String(name ?? "").trim().toLowerCase() === "ladder";
}

function getLadderObjectIdSet() {
  if (ladderObjectIdSet) {
    return ladderObjectIdSet;
  }
  const set = new Set();
  const entries = Object.entries(ObjectIdentifiers ?? {});
  for (const [key, value] of entries) {
    if (!Number.isInteger(value) || value <= 0) {
      continue;
    }
    if (LADDER_IDENTIFIER_PATTERN.test(String(key))) {
      set.add(value);
    }
  }
  ladderObjectIdSet = set;
  return set;
}

function isLadderIdentifierId(id) {
  if (!Number.isInteger(id) || id <= 0) {
    return false;
  }
  return getLadderObjectIdSet().has(id);
}

function isLadderLikeObject(id, fallbackName = null) {
  if (!Number.isInteger(id) || id <= 0) {
    return false;
  }
  if (LADDER_NAME_PATTERN.test(String(fallbackName ?? "").trim())) {
    return true;
  }
  try {
    const definition = ObjectDefinition.forId(id);
    const name = String(definition?.getName?.() ?? "").trim();
    if (LADDER_NAME_PATTERN.test(name)) {
      return true;
    }
  } catch {
    // fall through to identifier-set check
  }
  return isLadderIdentifierId(id);
}

function parseIdSequenceKey(text) {
  return String(text)
    .split(":")
    .map((part) => Number.parseInt(part, 10))
    .filter((value) => Number.isInteger(value) && value > 0);
}

function resolveRelativeBoundarySide(x, y, width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 3 || height < 3) {
    return null;
  }
  if (x === 1) {
    return LADDER_SIDE.WEST;
  }
  if (x === width - 2) {
    return LADDER_SIDE.EAST;
  }
  if (y === 1) {
    return LADDER_SIDE.NORTH;
  }
  if (y === height - 2) {
    return LADDER_SIDE.SOUTH;
  }
  return null;
}

function normalizeLadderCatalogEntry(entry, isValidObjectId) {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  if (typeof isValidObjectId !== "function") {
    return null;
  }
  const levels = Number.parseInt(entry?.levels, 10) === 3 ? 3 : 2;
  const bottomId = Number.parseInt(entry?.bottomId, 10);
  const topId = Number.parseInt(entry?.topId, 10);
  const middleId = Number.parseInt(entry?.middleId, 10);
  const ids = levels === 3 ? [bottomId, middleId, topId] : [bottomId, topId];
  if (ids.some((value) => !Number.isInteger(value) || value <= 0)) {
    return null;
  }
  if (!ids.every((value) => isValidObjectId(value))) {
    return null;
  }
  const countRaw = Number.parseInt(entry?.count, 10);
  const count = Number.isInteger(countRaw) && countRaw > 0 ? clamp(countRaw, 1, 64) : 1;
  return {
    levels,
    bottomId: ids[0],
    middleId: levels === 3 ? ids[1] : null,
    topId: levels === 3 ? ids[2] : ids[1],
    count,
  };
}

function extractLadderChainsFromLayoutObjects(layoutObjects) {
  if (!Array.isArray(layoutObjects) || layoutObjects.length === 0) {
    return [];
  }
  const stacks = new Map();
  for (const obj of layoutObjects) {
    if ((obj?.type | 0) !== ObjectType.INTERACTIVE || !Number.isInteger(obj?.id) || obj.id <= 0) {
      continue;
    }
    const x = obj?.x | 0;
    const y = obj?.y | 0;
    const orientation = (obj?.orientation | 0) & 0x3;
    const z = obj?.z | 0;
    const key = `${x}:${y}:${orientation}`;
    const list = stacks.get(key) ?? [];
    list.push({
      id: obj.id,
      z,
      looksLadder: isLadderLikeObject(obj.id, obj?.name ?? null),
    });
    stacks.set(key, list);
  }

  const chains = [];
  for (const list of stacks.values()) {
    if (list.length < 2) {
      continue;
    }
    list.sort((a, b) => a.z - b.z);
    const byZ = new Map(list.map((entry) => [entry.z, entry]));
    const hasLadderHint = list.some((entry) => entry.looksLadder);
    if (!hasLadderHint) {
      continue;
    }
    for (const bottom of list) {
      const top = byZ.get(bottom.z + 1);
      if (!top || byZ.has(bottom.z - 1)) {
        continue;
      }
      const middle = top;
      const topMost = byZ.get(bottom.z + 2);
      if (topMost) {
        chains.push({
          levels: 3,
          bottomId: bottom.id,
          middleId: middle.id,
          topId: topMost.id,
        });
      } else {
        chains.push({
          levels: 2,
          bottomId: bottom.id,
          topId: middle.id,
        });
      }
    }
  }
  return chains;
}

function buildLadderCatalogFromExamples(examples) {
  const histogram = new Map();
  for (const example of Array.isArray(examples) ? examples : []) {
    const chains = extractLadderChainsFromLayoutObjects(example?.layoutObjects ?? []);
    for (const chain of chains) {
      if (!chain || typeof chain !== "object") {
        continue;
      }
      const levels = chain.levels === 3 ? 3 : 2;
      const bottomId = Number.parseInt(chain?.bottomId, 10);
      const topId = Number.parseInt(chain?.topId, 10);
      const middleId = levels === 3 ? Number.parseInt(chain?.middleId, 10) : null;
      const ids = levels === 3 ? [bottomId, middleId, topId] : [bottomId, topId];
      if (ids.some((id) => !Number.isInteger(id) || id <= 0)) {
        continue;
      }
      const key = `${levels}:${ids.join(":")}`;
      histogram.set(key, (histogram.get(key) ?? 0) + 1);
    }
  }

  return [...histogram.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => {
      const parts = String(key).split(":").map((part) => Number.parseInt(part, 10));
      const levels = parts[0] === 3 ? 3 : 2;
      const ids = parts.slice(1, 1 + levels);
      if (levels === 3) {
        return {
          levels,
          bottomId: ids[0],
          middleId: ids[1],
          topId: ids[2],
          count,
        };
      }
      return {
        levels,
        bottomId: ids[0],
        topId: ids[1],
        count,
      };
    });
}

function resolveLadderIdsForFloors(ladderSpec, totalFloors) {
  if (!ladderSpec || totalFloors <= 1) {
    return null;
  }
  if (totalFloors >= 3) {
    if (Array.isArray(ladderSpec.tripleIds) && ladderSpec.tripleIds.length === 3) {
      return ladderSpec.tripleIds.slice(0, 3);
    }
    return null;
  }
  if (Array.isArray(ladderSpec.pairIds) && ladderSpec.pairIds.length === 2) {
    return ladderSpec.pairIds.slice(0, 2);
  }
  if (Array.isArray(ladderSpec.tripleIds) && ladderSpec.tripleIds.length >= 2) {
    return ladderSpec.tripleIds.slice(0, 2);
  }
  return null;
}

function buildLadderCandidatesForSide(side, minX, minY, maxX, maxY) {
  const candidates = [];
  const push = (x, y) => {
    if (x < minX + 2 || x > maxX - 2 || y < minY + 2 || y > maxY - 2) {
      return;
    }
    candidates.push({ x, y, side });
  };
  if (side === LADDER_SIDE.WEST || side === LADDER_SIDE.EAST) {
    const x = side === LADDER_SIDE.WEST ? minX + 2 : maxX - 2;
    for (let y = minY + 3; y <= maxY - 3; y++) {
      push(x, y);
    }
    if (candidates.length === 0) {
      for (let y = minY + 2; y <= maxY - 2; y++) {
        push(x, y);
      }
    }
    return candidates;
  }
  const y = side === LADDER_SIDE.NORTH ? minY + 2 : maxY - 2;
  for (let x = minX + 3; x <= maxX - 3; x++) {
    push(x, y);
  }
  if (candidates.length === 0) {
    for (let x = minX + 2; x <= maxX - 2; x++) {
      push(x, y);
    }
  }
  return candidates;
}

function ladderOrientationForSide(side) {
  if (side === LADDER_SIDE.WEST) {
    return 2;
  }
  if (side === LADDER_SIDE.EAST) {
    return 0;
  }
  if (side === LADDER_SIDE.NORTH) {
    return 1;
  }
  return 3;
}

function resolveLadderPlacement({
  minX,
  minY,
  maxX,
  maxY,
  doorTile,
  rng,
  ladderSpec,
  totalFloors,
  isBlockedTileFn,
}) {
  const ids = resolveLadderIdsForFloors(ladderSpec, totalFloors);
  if (!Array.isArray(ids) || ids.length < 2) {
    return null;
  }

  const sidePriority =
    Array.isArray(ladderSpec?.sidePool) && ladderSpec.sidePool.length > 0
      ? [...new Set(ladderSpec.sidePool.filter((side) => LADDER_SIDE_VALUES.includes(side)))]
      : [...LADDER_SIDE_VALUES];
  for (const side of LADDER_SIDE_VALUES) {
    if (!sidePriority.includes(side)) {
      sidePriority.push(side);
    }
  }

  const blockFn = typeof isBlockedTileFn === "function" ? isBlockedTileFn : () => false;
  const candidates = [];
  for (const side of sidePriority) {
    const sideCandidates = buildLadderCandidatesForSide(side, minX, minY, maxX, maxY);
    for (const candidate of sideCandidates) {
      if (blockFn(candidate.x, candidate.y, doorTile)) {
        continue;
      }
      candidates.push(candidate);
    }
  }
  if (candidates.length === 0) {
    return null;
  }

  let chosen = null;
  for (const side of sidePriority) {
    const bySide = candidates.filter((candidate) => candidate.side === side);
    if (bySide.length > 0) {
      chosen = rng.pick(bySide);
      break;
    }
  }
  if (!chosen) {
    chosen = rng.pick(candidates);
  }
  if (!chosen) {
    return null;
  }

  const orientation = ladderOrientationForSide(chosen.side);
  return {
    x: chosen.x,
    y: chosen.y,
    orientation: (orientation | 0) & 0x3,
    ids,
  };
}

module.exports = {
  LADDER_SIDE,
  LADDER_SIDE_VALUES,
  isLadderName,
  isLadderIdentifierId,
  isLadderLikeObject,
  parseIdSequenceKey,
  resolveRelativeBoundarySide,
  normalizeLadderCatalogEntry,
  extractLadderChainsFromLayoutObjects,
  buildLadderCatalogFromExamples,
  resolveLadderPlacement,
};
