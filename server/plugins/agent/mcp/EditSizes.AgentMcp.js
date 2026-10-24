const fs = require("fs");
const path = require("path");

// Loc model sizes for the map-editing tools: how wide, deep and tall each loc's model is, per
// shape, in model units (128 to a tile). Read from plugins/agent/data/loc-sizes.json, generated
// from the cache by client/scripts/cache/dump-loc-sizes.ts.
//
//   find_similar_locs - locs of the same shape and about the same size as a given one, for
//                       swapping a piece without changing a building's proportions
//
// Size narrows the candidates; it says nothing about colour or material, so the look still
// needs a screenshot.

const FIELDS = ["width", "depth", "height", "top"];

let cached = null;
/** Sizes by loc id: Map<id, Map<shape, {width, depth, height, top}>>, loaded once. */
function loadSizes() {
  const file = process.env.AGENT_MCP_LOC_SIZES_FILE ?? path.resolve(__dirname, "..", "data", "loc-sizes.json");
  if (cached?.file === file) return cached.sizes;
  const sizes = new Map();
  if (fs.existsSync(file)) {
    const { locs } = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const [id, shapes] of Object.entries(locs)) {
      const byShape = new Map();
      for (const [shape, width, depth, height, top] of shapes) byShape.set(shape, { width, depth, height, top });
      sizes.set(Number(id), byShape);
    }
  }
  cached = { file, sizes };
  return sizes;
}

// Shapes a loc without per-shape models draws with its one model: scenery and ground decoration.
const SCENERY_SHAPES = new Set([10, 11, 22]);

/** A loc's size in one shape; a loc with a single scenery model answers for the scenery shapes. */
function sizeOf(id, shape) {
  const byShape = loadSizes().get(id);
  if (!byShape) return null;
  if (byShape.has(shape)) return byShape.get(shape);
  return SCENERY_SHAPES.has(shape) && byShape.size === 1 && byShape.has(10) ? byShape.get(10) : null;
}

/** Every shape's size for a loc, keyed by shape. */
function sizesOf(id) {
  const byShape = loadSizes().get(id);
  return byShape ? Object.fromEntries(byShape) : null;
}

/** Largest difference in any dimension, in model units. */
function difference(a, b) {
  return Math.max(...FIELDS.map((field) => Math.abs(a[field] - b[field])));
}

function registerEditSizeTools(ctx) {
  const { core, tool, z } = ctx;
  const { CacheDefinitions, ObjectDefinition } = core;

  const nameOf = (id) => {
    try {
      const name = CacheDefinitions.getObject(id)?.name;
      return name && name !== "null" ? name : null;
    } catch {
      return null;
    }
  };
  const interactive = (id) => {
    try {
      return ObjectDefinition.forId(id)?.hasActions?.() === true;
    } catch {
      return false;
    }
  };

  tool(
    "find_similar_locs",
    "Locs with a model of the same shape and about the same size as a given loc: width, depth, height and how high it reaches, each within tolerance (model units, 128 to a tile). Use it to swap a piece for another style's without changing a building's proportions, or to find a stand-in. Ranked closest first. Size only: colour and material still need a screenshot.",
    {
      id: z.number().int().min(0).describe("The loc to match"),
      shape: z.number().int().min(0).max(22).default(10).describe("Shape to compare: 0 wall, 2 corner, 9 diagonal, 10 scenery, 12-21 roof, 22 ground decoration"),
      tolerance: z.number().int().min(0).max(512).default(32).describe("Largest difference allowed in any dimension"),
      name: z.string().optional().describe("Only locs whose name contains this (unnamed locs have none)"),
      includeInteractive: z.boolean().default(false),
      limit: z.number().int().min(1).max(50).default(20),
    },
    ({ id, shape = 10, tolerance = 32, name, includeInteractive = false, limit = 20 }) => {
      const target = sizeOf(id, shape);
      if (!target) {
        const shapes = sizesOf(id);
        throw new Error(`No size for loc ${id} in shape ${shape}; ${shapes ? `it has shapes ${Object.keys(shapes).join(", ")}` : "it has no measured model"}`);
      }
      const needle = name?.toLowerCase();
      const matches = [];
      for (const [candidate, byShape] of loadSizes()) {
        if (candidate === id) continue;
        const size = byShape.get(shape);
        if (!size) continue;
        const diff = difference(size, target);
        if (diff > tolerance) continue;
        const label = nameOf(candidate);
        if (needle && !(label ?? "").toLowerCase().includes(needle)) continue;
        if (!includeInteractive && interactive(candidate)) continue;
        matches.push({ id: candidate, name: label, ...size, difference: diff });
      }
      matches.sort((a, b) => a.difference - b.difference || a.id - b.id);
      return { id, shape, size: target, count: matches.length, matches: matches.slice(0, limit) };
    }
  );
}

module.exports = registerEditSizeTools;
module.exports.sizeOf = sizeOf;
module.exports.sizesOf = sizesOf;
module.exports.difference = difference;
