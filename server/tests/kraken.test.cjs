// Run after `yarn build`: node --test tests/kraken.test.cjs
// Kraken Cove: the task gate on the area's attacks, including the tentacles that
// belong to the Kraken fight but carry no Slayer task of their own.
const assert = require("node:assert/strict");
const { test } = require("node:test");

const Shared = require("../plugins/bosses/kraken/Shared.Kraken");
const { areaClass } = require("../plugins/bosses/kraken/Area.Kraken");

class Area {}
class Boundary {}

const requests = [];
let onTaskAnswer = () => false;

Shared.bind({
  core: {
    Area,
    Boundary,
    NpcIdentifiers: {
      WHIRLPOOL: 493,
      CAVE_KRAKEN: 492,
      WHIRLPOOL_2: 496,
      KRAKEN: 494,
      WHIRLPOOL_3: 5534,
      ENORMOUS_TENTACLE: 5535,
    },
  },
  emitCustomEvent: (name, request) => {
    assert.equal(name, "slayer:on-task");
    requests.push(request);
    request.onTask = onTaskAnswer(request);
  },
});

const area = new (areaClass())();
const player = { isPlayer: () => true, getAsPlayer: () => player };
const npc = (id) => ({ isNpc: () => true, getId: () => id });

test("the cove refuses attacks off a Kraken or cave kraken task", () => {
  onTaskAnswer = () => false;
  for (const id of [Shared.ids().CAVE_KRAKEN, Shared.ids().BOSS, Shared.ids().TENTACLE]) {
    assert.equal(area.canAttack(player, npc(id)), false);
  }
  assert.equal(area.canAttack({ isPlayer: () => false }, npc(Shared.ids().BOSS)), null);
  assert.equal(area.canAttack(player, { isNpc: () => false }), null);
});

test("the cove allows attacks covered by the player's task", () => {
  onTaskAnswer = () => true;
  for (const id of [Shared.ids().CAVE_KRAKEN, Shared.ids().BOSS, Shared.ids().TENTACLE]) {
    assert.equal(area.canAttack(player, npc(id)), null);
  }
});

test("a tentacle is asked about as the Kraken, which carries the task", () => {
  const tentacle = npc(Shared.ids().TENTACLE);
  onTaskAnswer = (request) => request.npc === tentacle && request.npcId === Shared.ids().BOSS;
  assert.equal(Shared.onTask(player, tentacle), true);
  assert.equal(requests.at(-1).npcId, Shared.ids().BOSS);
});
