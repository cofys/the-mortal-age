// From server/: node --test tests/eagles-peak-eagle.test.cjs (after yarn build).
//
// The giant eagle's Walk-past without the disguise, against rsprox 2821 (rev 230): the stumble back
// two tiles, the eagle's attack, a 0 hit and the recorded message box a tick later.
const assert = require('node:assert/strict');
const path = require('node:path');
const { before, test } = require('node:test');
const { Server } = require('../dist/Server');
Server.installProductionPathResolver();
const { PluginManager } = require('../dist/plugins/PluginManager');
const { CachePipeline } = require('../dist/game/cache/CachePipeline');

const SWIPE = "As you approach the eagle it takes a swipe at you with its beak. It seems to object to you trying to get past.";
let core, walkPast, tasks;

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, '..'));
  core = PluginManager.getCoreApi();
  const api = PluginManager.createApi('EaglesPeakEagleTest');
  const proxy = new Proxy(api, {
    get(target, property) {
      if (property === 'core') return { ...core, TaskManager: { submit: (task) => tasks.push(task) } };
      if (property === 'onNpcInteraction') {
        return (name, handlers) => { if (name === 'Eagle') walkPast = handlers['Walk-past']; };
      }
      if (typeof property === 'string' && /^on[A-Z]/.test(property)) return () => {};
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  require('../plugins/quests/quests/EaglesPeak.Quest')(proxy);
});

function fakePlayer() {
  const tile = new core.Location(2007, 4952, 3);
  const player = {
    anims: [], sounds: [], hits: [], dialogues: [], forced: null,
    getLocation: () => tile,
    getEquipment: () => ({ get: () => null, getItems: () => [], contains: () => false, containsAny: () => false, getById: () => null }),
    performAnimation: (a) => player.anims.push(a),
    getPacketSender: () => ({ sendSound: (id, volume, delay) => player.sounds.push([id, delay]) }),
    getCombat: () => ({ reset: () => {}, getHitQueue: () => ({ addPendingDamage: (hits) => player.hits.push(...hits.map((h) => h.getDamage())) }) }),
    getMovementQueue: () => ({ reset: () => {} }),
    setForceMovement: (f) => { player.forced = f; },
    getForceMovement: () => player.forced,
    getDialogueManager: () => ({ startDialogues: (chain) => player.dialogues.push(chain) }),
    getAttribute: () => undefined,
    sendMessage: () => {},
  };
  return player;
}

test('walking past the eagle without the disguise plays the recorded swipe', () => {
  tasks = [];
  const player = fakePlayer();
  const eagleAnims = [];
  const npc = { getId: () => 1490, performAnimation: (a) => eagleAnims.push(a.getId()) };
  const event = { player, npc, npcId: 1490 };
  assert.equal(walkPast(event), true);

  const { CacheDefinitions } = core;
  assert.deepEqual(eagleAnims, [CacheDefinitions.getSeqId('giant_eagle_attack')]);
  assert.equal(player.anims[0].getId(), CacheDefinitions.getSeqId('human_priority_stumble_back'));
  assert.equal(player.anims[0].getDelay(), 24);
  assert.equal(player.forced.getSpeed(), 0);
  const forced = player.forced;
  assert.equal(forced.getEnd().getX(), 0);
  assert.equal(forced.getEnd().getY(), -2, 'two tiles back, away from the eagle');
  assert.equal(forced.getReverseSpeed(), 46);
  assert.equal(forced.getDirection(), 0, 'facing north, at the eagle');
  assert.deepEqual(player.sounds, [[421, 0], [2455, 5]]);
  assert.equal(player.hits.length, 0, 'nothing lands on the first tick');
  assert.equal(player.dialogues.length, 0);

  const later = tasks.filter((t) => !(t instanceof core.ForceMovementTask));
  for (const task of later) task.execute();
  assert.deepEqual(player.hits, [0], 'the recorded hit is a 0');
  assert.deepEqual(player.sounds.at(-1), [511, 20]);
  assert.equal(player.dialogues.length, 1);
  const text = [...player.dialogues[0].dialogues.values()][0].text;
  assert.equal(text, SWIPE, "the recorded message box");
});

test('the swipe still plays when the eagle npc is missing from the event', () => {
  tasks = [];
  const player = fakePlayer();
  assert.equal(walkPast({ player, npc: undefined, npcId: 1490 }), true);
  for (const task of tasks.filter((t) => !(t instanceof core.ForceMovementTask))) task.execute();
  assert.deepEqual(player.hits, [0]);
  assert.equal(player.dialogues.length, 1);
});
