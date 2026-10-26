// Run after `yarn build`: node --test tests/herbert-sarim-spawn.test.cjs
// Cabin Boy Herbert at Port Sarim, who takes over Veos' ferry during and after A Kingdom Divided.
// The spawn is from rsprox captures (cabin_boy_herbert_sarim 11126 at 3053,3245, facing north);
// the Wiki lists only his visible ids, on a labelled map line the sync used to skip.
const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");

const spawns = require("../data/definitions/npc-spawns.json");
const { parseInfoboxMaps } = require("../scripts/npc-spawn-matching.cjs");

const atSarimDocks = spawns.filter(({ x, y, level }) => x >= 3050 && x <= 3058 && y >= 3242 && y <= 3248 && level === 0);
const key = ({ id, name, x, y, direction, wanderRadius }) => `${id} ${name}@${x},${y} d${direction ?? "-"} r${wanderRadius ?? "-"}`;

test("Port Sarim's docks have Herbert as captured, and Veos stays", () => {
  assert.deepEqual(atSarimDocks.map(key).sort(), [
    "1063 Veos@3054,3245 d- r-",
    "11126 Cabin Boy Herbert@3053,3245 d6 r0",
  ]);
});

test("Herbert is spawned by his base id and shows from the Fuggy stage of A Kingdom Divided", async () => {
  await require("../dist/game/cache/CachePipeline").CachePipeline.initialize(path.resolve(__dirname, ".."));
  const { CacheDefinitions } = require("../dist/game/cache/CacheDefinitions");
  const base = CacheDefinitions.getNpc(11126);
  assert.equal(base.transformVarbit, 12296, "keyed on varbit akd");
  const at = (stage) => CacheDefinitions.resolveNpc(11126, { getVarbit: (id) => (id === 12296 ? stage : 0), getVarp: () => 0 });
  for (const stage of [0, 1, 11]) assert.ok(!at(stage), `hidden at stage ${stage}`);
  for (const stage of [12, 24, 150]) {
    const herbert = at(stage);
    assert.equal(herbert?.id, 10933, `stage ${stage}`);
    assert.equal(herbert.name, "Cabin Boy Herbert");
    assert.deepEqual(herbert.actions.filter(Boolean), ["Talk-to", "Port Piscarilius", "Land's End"]);
  }
});

test("the Wiki's labelled map line for Herbert is read, Port Sarim within a tile of the capture", () => {
  const maps = parseInfoboxMaps("|map = Port Sarim Docks {{Map|name=Cabin Boy Herbert|x=3054|y=3245|r=3|mtype=square}} "
    + "Port Piscarilius {{Map|name=Cabin Boy Herbert|x=1824|y=3690|r=3|mtype=square}}");
  assert.deepEqual(maps.map(({ points: [point] }) => point), [{ x: 3054, y: 3245 }, { x: 1824, y: 3690 }]);
});
