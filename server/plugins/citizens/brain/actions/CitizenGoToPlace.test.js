// CitizenGoToPlace local-resource prospecting — work what's near you.
// Jon 2026-10-13: citizens must gather at real nearby resources at their
// tier instead of walking 120 tiles to a fixed anchor every time.
const assert = require("node:assert/strict");
const path = require("node:path");

const MODULE = "./CitizenGoToPlace.js";

// --- stubs ---------------------------------------------------------------

// Fake Woodcutting/Mining tier tables (plugin-shaped names).
const fakeWC = {
  TREES: [
    { name: "Magic tree", requiredLevel: 75 },
    { name: "Yew", requiredLevel: 60 },
    { name: "Willow", requiredLevel: 30 },
    { name: "Oak", requiredLevel: 15 },
    { name: "normal tree", requiredLevel: 1 },
  ],
};
const fakeMining = {
  ROCKS: [
    { objectName: "Runite rocks", level: 85 },
    { objectName: "Coal rocks", level: 30 },
    { objectName: "Iron rocks", level: 15 },
    { objectName: "Copper rocks", level: 1 },
  ],
};
// Object ids per tier name (sites.json vocabulary).
const IDS_BY_TIER = {
  willow: [555, 556],
  yew: [557],
  normal: [558, 559],
  coal: [660],
  copper: [661],
};
const fakeCatalog = {
  resolveCatalogObjectIds: (spec) => IDS_BY_TIER[spec.tier] ?? [],
};
const fakeFishing = { FISHING_SPOT_NAMES: ["Fishing spot"] };
// skillLevel via CitizenGoalResolver — stub the whole module.
const fakeLevels = { woodcutting: 1, mining: 1, fishing: 1 };
const fakeGoalResolver = {
  skillLevel: (player, skill) => fakeLevels[skill] ?? 1,
};

const gotoDir = path.dirname(require.resolve(MODULE));
function stubRequire(request, exportsObj) {
  // Resolve exactly the way the module under test resolves it (with .js).
  const resolved = path.resolve(gotoDir, request) + ".js";
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsObj,
  };
}
stubRequire("../../../skills/Woodcutting.plugin", fakeWC);
stubRequire("../../../skills/Mining.plugin", fakeMining);
stubRequire("../../../bots/brain/BotObjectCatalog", fakeCatalog);
stubRequire("../../../skills/Fishing.plugin", fakeFishing);
stubRequire("../CitizenGoalResolver", fakeGoalResolver);
// Heavy engine requires (TS) — stub before loading the module under test.
stubRequire("../../../bots/brain/ActionState", {
  playerState: (action, player, init) => init(),
});
stubRequire("../../../bots/behaviours/navigation/BotNavigation", {
  requestMovement: () => {},
  clearMovementRequest: () => {},
});
stubRequire("../CitizenSlotCapacity", { claimSlot: () => null, releaseFor: () => {} });
stubRequire("../../lib/humanizer", {
  agentRng: () => () => 0,
  personalSpot: (name, x, y) => ({ x: x + 2, y: y + 2 }),
});
// CitizenTiles: water-aware not needed here; stub minimal.
stubRequire("../../lib/CitizenTiles", {
  isWaterTile: () => false,
  isBlockedTile: () => false,
  snapToWalkableTile: (x, y, z) => ({ x, y, z }),
});

const {
  _targetTierFor: targetTierFor,
  _tierTables: tierTables,
  _prospectLocalResource: prospect,
} = require(MODULE);

// --- player/world fakes ----------------------------------------------------

function fakePlayer(x, y, z = 0) {
  const attrs = {};
  return {
    getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => z ?? 0 }),
    getPrivateArea: () => null,
    getAttribute: (k) => attrs[k],
    setAttribute: (k, v) => { attrs[k] = v; },
    _attrs: attrs,
  };
}
function fakeObject(id, x, y, z = 0) {
  return { getId: () => id, getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => z }) };
}
function fakeWorld(objects, npcs = []) {
  return {
    objectSearch: {
      findCandidatesByIds: (player, ids) => objects.filter((o) => ids.includes(o.getId())),
    },
    core: {
      World: { getNpcsNear: () => npcs },
    },
  };
}
const rng = () => 0; // deterministic: first of the spread pool

// --- tier selection --------------------------------------------------------

const treeTiers = tierTables("tree");
assert.deepEqual(
  treeTiers.map((t) => t.tier),
  ["magic", "yew", "willow", "oak", "normal"]
);
assert.equal(targetTierFor(1, treeTiers), "normal");
assert.equal(targetTierFor(35, treeTiers), "willow");
assert.equal(targetTierFor(60, treeTiers), "yew");
assert.equal(targetTierFor(99, treeTiers), "magic");

const rockTiers = tierTables("rock");
assert.equal(targetTierFor(20, rockTiers), "iron");
assert.equal(targetTierFor(30, rockTiers), "coal");

// --- local prospect: tier-appropriate --------------------------------------

const trees = [
  fakeObject(558, 3210, 3502), // normal tree, 2 tiles away
  fakeObject(555, 3220, 3510), // willow, ~14 tiles away
  fakeObject(557, 3300, 3600), // yew, far away (>48)
];

// Level 35 citizen: target tier willow — finds the willow, not the normal.
fakeLevels.woodcutting = 35;
let hit = prospect(fakePlayer(3210, 3500), "tree", fakeWorld(trees), rng);
assert.ok(hit, "expected a local willow prospect");
assert.equal(hit.tier, "willow");
assert.equal(hit.x, 3220);
assert.equal(hit.y, 3510);

// Level 5 citizen: target tier normal — finds the nearby normal tree.
fakeLevels.woodcutting = 5;
hit = prospect(fakePlayer(3210, 3500), "tree", fakeWorld(trees), rng);
assert.ok(hit, "expected a local normal-tree prospect");
assert.equal(hit.tier, "normal");
assert.equal(hit.x, 3210);
assert.equal(hit.y, 3502);

// Level 60 citizen with only normals nearby: NO local prospect (must
// travel to yews — the human-correct behavior).
fakeLevels.woodcutting = 60;
hit = prospect(fakePlayer(3210, 3500), "tree", fakeWorld([trees[0]]), rng);
assert.equal(hit, null, "level 60 should not settle for normal trees");

// Nothing nearby at all: null -> anchor fallback.
hit = prospect(fakePlayer(3210, 3500), "tree", fakeWorld([]), rng);
assert.equal(hit, null);

// Unknown kind: null.
hit = prospect(fakePlayer(3210, 3500), "dance", fakeWorld(trees), rng);
assert.equal(hit, null);

// --- rocks -----------------------------------------------------------------

const rocks = [fakeObject(661, 3205, 3495), fakeObject(660, 3215, 3505)];
fakeLevels.mining = 20; // target iron — none nearby -> null
hit = prospect(fakePlayer(3210, 3500), "rock", fakeWorld(rocks), rng);
assert.equal(hit, null, "no iron nearby -> anchor fallback");
fakeLevels.mining = 35; // target coal -> finds coal
hit = prospect(fakePlayer(3210, 3500), "rock", fakeWorld(rocks), rng);
assert.ok(hit && hit.tier === "coal" && hit.x === 3215);

// --- fish ------------------------------------------------------------------

function fakeNpc(x, y) {
  return {
    isRegistered: () => true,
    getDefinition: () => ({ getName: () => "Fishing spot" }),
    getLocation: () => ({ getX: () => x, getY: () => y, getZ: () => 0 }),
  };
}
hit = prospect(fakePlayer(3210, 3500), "fish", fakeWorld([], [fakeNpc(3212, 3503)]), rng);
assert.ok(hit, "expected a local fishing spot");
assert.equal(hit.x, 3212);
hit = prospect(fakePlayer(3210, 3500), "fish", fakeWorld([], []), rng);
assert.equal(hit, null, "no spots -> anchor fallback");

console.log("CitizenGoToPlace prospect: all checks passed");
