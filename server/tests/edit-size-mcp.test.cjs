// Loc sizes (plugins/agent/mcp/EditSizes.AgentMcp.js): find_similar_locs and the size checks
// capture_style makes, against a small sizes file. Run: node --test tests/edit-size-mcp.test.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { z } = require("zod");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "edit-size-"));
process.env.AGENT_MCP_LOC_SIZES_FILE = path.join(dir, "sizes.json");
fs.writeFileSync(process.env.AGENT_MCP_LOC_SIZES_FILE, JSON.stringify({ locs: {
  1: [[0, 28, 128, 293, 292], [2, 28, 128, 293, 292]],  // a house wall
  2: [[0, 31, 128, 300, 300]],                           // a castle wall, a little taller
  3: [[0, 36, 128, 96, 95], [2, 36, 126, 96, 95]],       // a low wall
  4: [[0, 30, 128, 290, 290]],                           // a door, interactive
  5: [[10, 96, 96, 142, 142]],                           // scenery
} }));

const registerEditSizeTools = require("../plugins/agent/mcp/EditSizes.AgentMcp");
const registerEditStyleTools = require("../plugins/agent/mcp/EditStyles.AgentMcp");

function setup(objects = []) {
  const tools = new Map();
  const names = { 1: "Wall", 2: "Wall", 3: "Wall", 4: "Door", 5: "Rock" };
  const core = {
    CacheDefinitions: { getObject: (id) => ({ name: names[id] ?? "null" }) },
    ObjectDefinition: { forId: (id) => ({ getName: () => names[id], hasActions: () => id === 4 }) },
  };
  const ctx = { core, z, tool: (name, _d, _s, handler) => tools.set(name, handler) };
  registerEditSizeTools(ctx);
  process.env.AGENT_MCP_STYLES_FILE = path.join(dir, `styles-${Math.random()}.json`);
  registerEditStyleTools(ctx, {
    build: {}, terrain: { tileAt: () => ({ overlay: null }) },
    objectsIn: () => objects.map(([id, type]) => ({ getId: () => id, getType: () => type })),
  });
  return { call: async (name, args) => tools.get(name)(args) };
}

test("find_similar_locs ranks same-shape locs by their largest size difference", async () => {
  const t = setup();
  const found = await t.call("find_similar_locs", { id: 1, shape: 0 });
  assert.deepEqual(found.matches.map((m) => [m.id, m.difference]), [[2, 8]], "the low wall is too short; the door is interactive");
  const withDoors = await t.call("find_similar_locs", { id: 1, shape: 0, includeInteractive: true });
  assert.deepEqual(withDoors.matches.map((m) => m.id), [4, 2]);
  const wide = await t.call("find_similar_locs", { id: 1, shape: 0, tolerance: 300 });
  assert.deepEqual(wide.matches.map((m) => m.id), [2, 3]);
  await assert.rejects(t.call("find_similar_locs", { id: 5, shape: 0 }), /shapes 10/);
});

test("capture_style warns when a role's piece is far taller or shorter than the wall", async () => {
  const t = setup([[1, 0], [1, 0], [3, 2]]);
  const style = await t.call("capture_style", { name: "mixed", x1: 0, y1: 0, x2: 4, y2: 4 });
  assert.deepEqual(style.wallSize, { width: 28, depth: 128, height: 293, top: 292 });
  assert.deepEqual(style.sizeWarnings, ["corner 3 is 96 tall, the wall 293"]);
});
