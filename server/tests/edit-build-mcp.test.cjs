// Batch building tools (plugins/agent/mcp/EditBuild.AgentMcp.js) and the geometry
// engine behind them (EditGeometry.AgentMcp.js). Run: node --test tests/edit-build-mcp.test.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { z } = require("zod");

const geometry = require("../plugins/agent/mcp/EditGeometry.AgentMcp");
const registerEditBuildTools = require("../plugins/agent/mcp/EditBuild.AgentMcp");

// --- geometry ---------------------------------------------------------------

test("line covers both ends", () => {
  assert.deepEqual(geometry.line(0, 0, 3, 0), [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }]);
  assert.deepEqual(geometry.line(5, 5, 5, 5), [{ x: 5, y: 5 }]);
});

test("ring is hollow, closed, and can open a gap", () => {
  const full = geometry.ring(0, 0, 5);
  assert.ok(full.length > 20);
  assert.ok(!full.some((tile) => tile.x === 0 && tile.y === 0), "centre must stay empty");
  const gapped = geometry.ring(0, 0, 5, { gapDegrees: 60, gapAngle: 0 });
  assert.ok(gapped.length < full.length);
  // The opening faces east: no tiles at the far east point.
  assert.ok(!gapped.some((tile) => tile.x === 5 && tile.y === 0));
  // Far west is still walled.
  assert.ok(gapped.some((tile) => tile.x === -5 && tile.y === 0));
});

test("box is hollow with an optional doorway", () => {
  const closed = geometry.box(0, 0, 4, 4);
  assert.equal(closed.length, 16);
  assert.ok(!closed.some((tile) => tile.x === 2 && tile.y === 2), "interior stays empty");
  const doored = geometry.box(0, 0, 4, 4, { doorSide: "south" });
  assert.equal(doored.length, 15);
  assert.ok(!doored.some((tile) => tile.x === 2 && tile.y === 0), "doorway is open");
});

test("tower fills its footprint; avenue mirrors around a line; rotate turns 90 degrees", () => {
  assert.equal(geometry.tower(10, 10, 3).length, 9);
  const av = geometry.avenue(0, 0, 8, 0, { offset: 2, spacing: 2 });
  assert.ok(av.some((tile) => tile.y === 2) && av.some((tile) => tile.y === -2));
  const rotated = geometry.rotate([{ x: 1, y: 0 }], 90, 0, 0);
  assert.deepEqual(rotated, [{ x: 0, y: -1 }]);
});

// --- tools ------------------------------------------------------------------

const MATERIAL_IDS = { 16519: "Castle wall", 2832: "Battlement", 37: "Gate", 2106: "Archway", 54: "Stairs", 11017: "Brazier", 29115: "Marble bench", 563: "Statue of a king", 8462: "Oak tree" };

function setup() {
  const tools = new Map();
  const live = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "edit-build-"));
  process.env.AGENT_MCP_SPAWNS_FILE = path.join(dir, "object-spawns.json");
  fs.writeFileSync(process.env.AGENT_MCP_SPAWNS_FILE, "[]");
  class Location {
    constructor(x, y, z) { this.x = x; this.y = y; this.z = z; }
    getX() { return this.x; }
    getY() { return this.y; }
    getZ() { return this.z; }
  }
  class GameObject {
    constructor(id, position, type, face) {
      this.id = id; this.position = position; this.type = type; this.face = face;
    }
    getId() { return this.id; }
    getType() { return this.type; }
    getFace() { return this.face; }
    getLocation() { return this.position; }
  }
  const core = {
    Location,
    GameObject,
    CacheDefinitions: { getCounts: () => ({ objects: 65535 }) },
    ObjectDefinition: { forId: (id) => (MATERIAL_IDS[id] ? { getName: () => "x" } : undefined) },
    ObjectManager: {
      register: (object) => {
        const at = object.position;
        for (let i = live.length - 1; i >= 0; i--) {
          const other = live[i].position;
          if (other.x === at.x && other.y === at.y && other.z === at.z && live[i].type === object.type) live.splice(i, 1);
        }
        live.push(object);
      },
      objectsAt: () => [],
    },
  };
  const tool = (name, _description, _schema, handler) => tools.set(name, async (args) => {
    try {
      return { content: [{ type: "text", text: JSON.stringify(await handler(args)) }] };
    } catch (error) {
      return { content: [{ type: "text", text: String(error?.message ?? error) }], isError: true };
    }
  });
  registerEditBuildTools({ core, tool, z });
  const call = async (name, args) => {
    const result = await tools.get(name)(args);
    if (result.isError) throw new Error(result.content[0].text);
    return JSON.parse(result.content[0].text);
  };
  const callRaw = (name, args) => tools.get(name)(args);
  return { tools, call, callRaw, live, file: process.env.AGENT_MCP_SPAWNS_FILE };
}

test("registers the build toolset", () => {
  const { tools } = setup();
  assert.deepEqual(
    [...tools.keys()],
    ["place_objects", "build_shape", "build_preset", "plan_build", "list_presets"],
  );
});

test("place_objects writes the file once for a whole batch", async () => {
  const t = setup();
  const res = await t.call("place_objects", {
    objects: [
      { id: 16519, x: 100, y: 100 },
      { id: 16519, x: 101, y: 100 },
      { id: 2832, x: 102, y: 100, face: 2 },
    ],
  });
  assert.equal(res.placed, 3);
  assert.equal(res.persisted, 3);
  assert.equal(t.live.length, 3);
  const entries = JSON.parse(fs.readFileSync(t.file, "utf8"));
  assert.equal(entries.length, 3);
  assert.deepEqual(entries[0], {
    id: 16519, position: { x: 100, y: 100, z: 0 }, type: 10, face: 0, source: "agent-mcp",
  });
  // Re-placing the same tiles does not duplicate file entries.
  const again = await t.call("place_objects", { objects: [{ id: 16519, x: 100, y: 100 }] });
  assert.equal(again.persisted, 0);
  assert.equal(JSON.parse(fs.readFileSync(t.file, "utf8")).length, 3);
});

test("place_objects validates and caps batch size", async () => {
  const t = setup();
  assert.equal((await t.callRaw("place_objects", { objects: [{ id: 9999, x: 0, y: 0 }] })).isError, true);
  assert.equal((await t.callRaw("place_objects", { objects: [{ id: 16519, x: -5, y: 0 }] })).isError, true);
  const tooMany = Array.from({ length: 4001 }, (_, i) => ({ id: 16519, x: i % 100, y: 0 }));
  assert.equal((await t.callRaw("place_objects", { objects: tooMany })).isError, true);
});

test("build_shape makes a wall line and a ring with a gate gap", async () => {
  const t = setup();
  const wall = await t.call("build_shape", { shape: "line", id: 16519, x: 10, y: 10, x2: 19, y2: 10 });
  assert.equal(wall.count, 10);
  assert.equal(wall.placed, 10);
  const ring = await t.call("build_shape", {
    shape: "ring", material: "castle_wall", x: 50, y: 50, radius: 6, gapDegrees: 40, gapAngle: 0,
  });
  assert.ok(ring.count > 20);
  assert.equal(ring.placed, ring.count);
  assert.ok(!ring.sample.some((item) => item.x === 56 && item.y === 50));
});

test("build_preset builds a house, and plan_build reports without placing", async () => {
  const t = setup();
  // The preset's default doorSide is "south", so a 5x5 shell is 16 minus its doorway.
  const plan = await t.call("plan_build", { preset: "house", x: 200, y: 200, params: { width: 5, height: 5 } });
  assert.equal(plan.count, 15);
  assert.deepEqual(plan.bounds, { x1: 200, y1: 200, x2: 204, y2: 204 });
  assert.equal(t.live.length, 0, "plan_build must not place anything");
  assert.deepEqual(JSON.parse(fs.readFileSync(t.file, "utf8")), []);

  const built = await t.call("build_preset", { preset: "house", x: 200, y: 200, params: { doorSide: "south" } });
  assert.equal(built.placed, 15);
  const entries = JSON.parse(fs.readFileSync(t.file, "utf8"));
  assert.equal(entries.length, 15);
});

test("tiered_city repeats its parts once per radius", async () => {
  const t = setup();
  const plan = await t.call("plan_build", { preset: "tiered_city", x: 500, y: 500 });
  assert.ok(plan.count > 150, `expected a large city, got ${plan.count}`);
  // Four walls + their gate furniture: castle wall dominates the object mix.
  assert.ok(plan.byObjectId[16519] > 100);
  assert.ok(plan.byObjectId[37] === 4, "one gate per ring");
  assert.deepEqual(plan.bounds, { x1: 477, y1: 477, x2: 523, y2: 523 });
});

test("rotation turns a preset's footprint", async () => {
  const t = setup();
  const flat = await t.call("plan_build", { preset: "house", x: 0, y: 0, params: { width: 7, height: 3 } });
  const turned = await t.call("plan_build", { preset: "house", x: 0, y: 0, params: { width: 7, height: 3 }, rotation: 90 });
  assert.equal(flat.count, turned.count);
  assert.equal(flat.bounds.x2 - flat.bounds.x1, 6);
  assert.equal(turned.bounds.y2 - turned.bounds.y1, 6);
});

test("unknown preset and material are reported clearly", async () => {
  const t = setup();
  const bad = await t.callRaw("build_preset", { preset: "atlantis", x: 0, y: 0 });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /Unknown preset/);
  const badMaterial = await t.callRaw("build_shape", { shape: "line", material: "mithril_wall", x: 0, y: 0, x2: 3, y2: 0 });
  assert.equal(badMaterial.isError, true);
  assert.match(badMaterial.content[0].text, /Unknown material/);
});

test("list_presets exposes materials and preset parameters", async () => {
  const t = setup();
  const catalog = await t.call("list_presets", {});
  assert.ok(catalog.materials.castle_wall.id === 16519);
  assert.ok(catalog.presets.tiered_city.repeat.radius === "$radii");
  assert.ok(catalog.presets.house.params.width === 5);
});

// --- review follow-ups -------------------------------------------------------

test("re-placing on a razed tile clears the removal marker", async () => {
  const t = setup();
  // A tile that was razed earlier: the file holds a removal marker for this object.
  fs.writeFileSync(t.file, JSON.stringify([
    { id: 16519, position: { x: 300, y: 300, z: 0 }, type: 10, face: 0, remove: true, source: "agent-mcp" },
  ]));
  const res = await t.call("place_objects", { objects: [{ id: 16519, x: 300, y: 300 }] });
  assert.equal(res.persisted, 1);
  const entries = JSON.parse(fs.readFileSync(t.file, "utf8"));
  assert.equal(entries.length, 1, "the marker is replaced by the placement, not kept beside it");
  assert.equal(entries[0].remove, undefined);
  assert.deepEqual(entries[0].position, { x: 300, y: 300, z: 0 });
  // A marker for the same id on another tile is left alone.
  fs.writeFileSync(t.file, JSON.stringify([
    { id: 16519, position: { x: 301, y: 301, z: 0 }, type: 10, face: 0, remove: true, source: "agent-mcp" },
  ]));
  await t.call("place_objects", { objects: [{ id: 16519, x: 300, y: 300 }] });
  const after = JSON.parse(fs.readFileSync(t.file, "utf8"));
  assert.equal(after.filter((entry) => entry.remove === true).length, 1);
});

test("re-placing the same tile with a new rotation is persisted", async () => {
  const t = setup();
  await t.call("place_objects", { objects: [{ id: 16519, x: 400, y: 400, face: 0 }] });
  const turned = await t.call("place_objects", { objects: [{ id: 16519, x: 400, y: 400, face: 2 }] });
  assert.equal(turned.persisted, 1, "a different face needs its own entry");
  assert.equal(turned.replaced, 1, "the turned object replaced the old one live");
  const entries = JSON.parse(fs.readFileSync(t.file, "utf8"));
  assert.deepEqual(entries.map((entry) => entry.face), [2], "only the object standing live stays persisted");
});

test("an invalid placement aborts the batch before anything is registered", async () => {
  const t = setup();
  // Second item is out of world: the first must NOT be left standing.
  const bad = await t.callRaw("place_objects", {
    objects: [{ id: 16519, x: 10, y: 10 }, { id: 16519, x: 999999, y: 10 }],
  });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /Nothing was placed/);
  assert.equal(t.live.length, 0, "no partial batch in the world");
  assert.deepEqual(JSON.parse(fs.readFileSync(t.file, "utf8")), [], "and nothing persisted");
});

test("build_shape accepts material without an id, and rejects neither", async () => {
  const t = setup();
  const ok = await t.call("build_shape", { shape: "line", material: "castle_wall", x: 0, y: 0, x2: 3, y2: 0 });
  assert.equal(ok.count, 4);
  const neither = await t.callRaw("build_shape", { shape: "line", x: 0, y: 0, x2: 3, y2: 0 });
  assert.equal(neither.isError, true);
  assert.match(neither.content[0].text, /either `id`|and material/);
});

// --- live-test follow-ups ----------------------------------------------------

test("tower keeps its whole body inside a parapet ring one tile out", async () => {
  const t = setup();
  const plan = await t.call("plan_build", { preset: "tower", x: 500, y: 500 });
  assert.equal(plan.overlapped, 0);
  assert.deepEqual(plan.byObjectId, { 2832: 9, 16519: 16 });
  assert.deepEqual(plan.bounds, { x1: 499, y1: 499, x2: 503, y2: 503 });
});

test("every shipped preset places each tile slot once, bar tiered_city's wall towers", async () => {
  const t = setup();
  const { presets } = await t.call("list_presets", {});
  for (const name of Object.keys(presets)) {
    const plan = await t.call("plan_build", { preset: name, x: 500, y: 500 });
    // tiered_city stands its towers in the wall line on purpose: they replace wall tiles.
    if (name === "tiered_city") {
      assert.ok(plan.byObjectId[37] === 4, "the gates are not hidden under another part");
      continue;
    }
    assert.equal(plan.overlapped, 0, `${name} has parts on the same tile`);
  }
});

test("overlapping placements collapse to the later one, and say so", async () => {
  const t = setup();
  const result = await t.call("place_objects", { objects: [
    { id: 2832, x: 700, y: 700 },
    { id: 16519, x: 700, y: 700 },
  ] });
  assert.equal(result.placed, 1);
  assert.equal(result.overlapped, 1);
  const entries = JSON.parse(fs.readFileSync(t.file, "utf8"));
  assert.deepEqual(entries.map((entry) => entry.id), [16519]);
});
