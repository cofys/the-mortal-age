// Style tools (plugins/agent/mcp/EditStyles.AgentMcp.js) and the wall path they draw,
// against a fake core and temp files. Run: node --test tests/edit-style-mcp.test.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { z } = require("zod");

const geometry = require("../plugins/agent/mcp/EditGeometry.AgentMcp");
const registerEditStyleTools = require("../plugins/agent/mcp/EditStyles.AgentMcp");

test("a closed rectangle walls its boundary, facing out or in whichever way the corners run", () => {
  const square = [[0, 0], [3, 0], [3, 2], [0, 2]];
  const out = geometry.wallPath(square, { closed: true, facing: "out" });
  const at = (pieces, x, y) => pieces.find((piece) => piece.x === x && piece.y === y);
  // Facing out, every piece sits on the tile outside its edge.
  assert.deepEqual(at(out.pieces, 1, -1), { x: 1, y: -1, type: 0, face: 1 }, "north edge of the tile below");
  assert.deepEqual(at(out.pieces, 3, 1), { x: 3, y: 1, type: 0, face: 0 }, "west edge of the tile to the east");
  assert.equal(at(out.pieces, 0, 0), undefined);
  // Its outside corners get the small corner piece, turned to the corner, as Varrock's houses.
  assert.deepEqual(out.pieces.filter((p) => p.type === 1).map((p) => [p.x, p.y, p.face]),
    [[-1, -1, 1], [3, -1, 0], [3, 2, 3], [-1, 2, 2]]);
  const reversed = geometry.wallPath([...square].reverse(), { closed: true, facing: "out" });
  const key = (pieces) => pieces.map((p) => `${p.x},${p.y},${p.type},${p.face}`).sort();
  assert.deepEqual(key(reversed.pieces), key(out.pieces), "clockwise or not, the same wall");
  // Facing in, the inside tiles carry it, with L corners where two edges meet.
  const inside = geometry.wallPath(square, { closed: true, facing: "in", gaps: [[1, 0]] });
  assert.deepEqual(at(inside.pieces, 0, 0), { x: 0, y: 0, type: 2, face: 3 }, "south and west edges of the corner tile");
  assert.equal(at(inside.pieces, 1, 0), undefined, "the gateway stays open");
  assert.deepEqual(inside.openings, [{ x: 1, y: 0, type: 0, face: 3 }]);
});

test("an open wall sits on the side asked for", () => {
  assert.deepEqual(geometry.wallPath([[0, 0], [2, 0]], { side: "left" }).pieces.map((p) => [p.x, p.y, p.face]), [[0, 0, 3], [1, 0, 3]]);
  assert.deepEqual(geometry.wallPath([[0, 0], [2, 0]], { side: "right" }).pieces.map((p) => [p.x, p.y, p.face]), [[0, -1, 1], [1, -1, 1]]);
});

test("45-degree runs become diagonals, south-west to north-east rotation 0, the other 1", () => {
  assert.deepEqual(geometry.wallPath([[0, 0], [2, 2]], { side: "right" }).pieces, [
    { x: 0, y: 0, face: 0, type: 9 }, { x: 1, y: 1, face: 0, type: 9 },
  ]);
  assert.deepEqual(geometry.wallPath([[0, 0], [2, 2]], { side: "left" }).pieces[0].face, 2, "the other side flips it");
  assert.deepEqual(geometry.wallPath([[0, 2], [1, 1]], { side: "right" }).pieces, [{ x: 0, y: 1, face: 1, type: 9 }]);
});

function setup(objects = [], overlays = {}) {
  process.env.AGENT_MCP_STYLES_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "edit-style-")), "styles.json");
  const tools = new Map();
  const placed = [];
  const names = { 10: "Wall", 11: "Wall", 12: "Door", 13: "Gate" };
  const core = {
    ObjectDefinition: { forId: (id) => ({ getName: () => names[id] ?? "null", hasActions: () => id === 12 || id === 13 }) },
  };
  const objectsIn = () => objects.map(([id, type]) => ({ getId: () => id, getType: () => type }));
  const terrain = { tileAt: (x, y) => ({ overlay: overlays[`${x},${y}`] ?? null }) };
  const build = { applyPlacements: (list) => { placed.push(...list); return { placed: list.length }; } };
  registerEditStyleTools({ core, z, tool: (name, _d, _s, handler) => tools.set(name, handler) }, { build, terrain, objectsIn });
  return { call: async (name, args) => tools.get(name)(args), placed };
}

test("capture_style assigns the most common piece to each role, and roles override it", async () => {
  const t = setup(
    [[10, 0], [10, 0], [11, 0], [10, 2], [10, 9], [12, 0], [13, 0], [10, 22], [14, 12], [14, 16], [15, 4], [15, 4]],
    { "0,0": { id: 5 }, "1,0": { id: 5 }, "2,0": { id: 6 } },
  );
  const style = await t.call("capture_style", { name: "town", x1: 0, y1: 0, x2: 5, y2: 5 });
  assert.equal(style.wall, 10);
  assert.equal(style.corner, 10);
  assert.equal(style.diagonal, 10);
  assert.equal(style.post, null);
  assert.equal(style.door, 12);
  assert.equal(style.gate, 13);
  assert.equal(style.floor, 5);
  assert.equal(style.roof, 14);
  assert.equal(style.window, 15);
  assert.deepEqual(style.variants, [{ id: 11, count: 1 }]);
  const overridden = await t.call("capture_style", { name: "town", x1: 0, y1: 0, x2: 5, y2: 5, roles: { wall: 11 } });
  assert.equal(overridden.wall, 11);
  assert.equal((await t.call("list_styles", {})).count, 1);
  await assert.rejects(t.call("capture_style", { name: "town", x1: 0, y1: 0, x2: 1, y2: 1, roles: { chimney: 1 } }), /Unknown role/);
});

test("build_wall places the style along the path, hangs gates, and raises towers", async () => {
  const t = setup([[10, 0], [10, 2], [13, 0]]);
  await t.call("capture_style", { name: "fort", x1: 0, y1: 0, x2: 1, y2: 1 });
  const plan = await t.call("build_wall", { style: "fort", points: [[0, 0], [6, 0]], gates: [[3, 0]], dryRun: true });
  assert.equal(plan.dryRun, true);
  assert.equal(plan.gateways, 1);
  assert.equal(t.placed.length, 0);
  await t.call("build_wall", { style: "fort", points: [[0, 0], [6, 0]], gates: [[3, 0]] });
  assert.equal(t.placed.filter((piece) => piece.id === 13).length, 1, "the gate hangs in the gateway");
  assert.equal(t.placed.filter((piece) => piece.id === 10).length, 5);

  t.placed.length = 0;
  await t.call("build_wall", { style: "fort", points: [[0, 0], [8, 0]], towerEvery: 4, towerSize: 2 });
  // Towers round corners 0, 4 and 8: 2x2 squares of wall, facing out like the run.
  assert.ok(t.placed.some((piece) => piece.x === 3 && piece.y === -2 && piece.type === 0 && piece.face === 1), "its south side, facing out");
  assert.ok(t.placed.some((piece) => piece.x === 5 && piece.y === -1 && piece.type === 0 && piece.face === 0), "its east side");
});
