// Run after `yarn build`: node --test tests/recharge-dragonstone.test.cjs
// Recharge Dragonstone (Wiki): every glory, combat bracelet and skills necklace in the inventory
// to 4 charges, the latter two after Legends' Quest; not the ring of wealth; hard Fremennik Diary.
const assert = require('node:assert/strict');
const { test, before, after, mock } = require('node:test');
const { Server } = require('../dist/Server');
Server.installProductionPathResolver();
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { PluginManager } = require('../dist/plugins/PluginManager');
const { Player } = require('../dist/game/entity/impl/player/Player');
const { PlayerSession } = require('../dist/net/PlayerSession');
const { ClientConnection } = require('../dist/net/NetworkBuilder');
const { ItemIds } = require('../dist/util/IdEnums');

const completeQuests = new Set();
let fremennikHard = true;
let core;

before(async () => {
  await CachePipeline.initialize(process.cwd());
  core = PluginManager.getCoreApi();
  require('../plugins/quests/QuestRuntime').getRegisteredQuests = () =>
    ["Legends' Quest"].map((name) => ({ name, isComplete: () => completeQuests.has(name) }));
  const api = PluginManager.createApi('RechargeDragonstoneTest');
  require('../plugins/items/Jewellery.plugin').register(api);
  api.onCustomEvent('diary:is-complete', (request) => {
    if (request.diary === 'fremennik' && request.tier === 'hard') request.complete = fremennikHard;
  });
});
after(() => mock.restoreAll());

function channel() {
  return { kind: 'test', remoteAddress: '127.0.0.1', isOpen: () => true,
    send: () => true, close() {}, onData() {}, onError() {}, onClose() {} };
}

function caster(t, items) {
  const player = new Player(new PlayerSession(channel())), amounts = new Map(), xp = [], messages = [];
  player.setRegistered(true); player.setSpellbook(core.MagicSpellbook.LUNAR);
  player.setLocation(new core.Location(3200, 3200, 0));
  const slots = items.map((id) => new core.Item(id, 1));
  t.mock.method(player, 'getSkillManager', () => ({ getMaxLevel: () => 99, getCurrentLevel: () => 99,
    addExperiences: (skill, value) => xp.push(value) }));
  t.mock.method(player, 'getInventory', () => ({ getItems: () => slots, refreshItems() {},
    getAmount: (id) => amounts.get(id) ?? 0,
    deletes: (item) => amounts.set(item.id, (amounts.get(item.id) ?? 0) - item.getAmount()) }));
  t.mock.method(player, 'sendMessage', (message) => messages.push(message));
  for (const id of [core.ItemIdentifiers.WATER_RUNE, core.ItemIdentifiers.ASTRAL_RUNE, core.ItemIdentifiers.SOUL_RUNE]) {
    amounts.set(id, 10);
  }
  return { player, slots, amounts, xp, messages, ids: () => slots.map((item) => item.getId()) };
}

async function cast(f) {
  const widget = core.CacheDefinitions.getSpellByName('Recharge Dragonstone');
  assert.ok(widget, 'the cache has the spell');
  const connection = new ClientConnection(channel()); connection.player = f.player;
  // rsprox 4119: the spell is cast straight from the spellbook (op 1), with no target.
  await connection.dispatch([{ type: 'widget_action', widgetId: widget.widgetId, groupId: widget.widgetId >>> 16,
    childId: widget.widgetId & 65535, buttonNum: 1, itemId: widget.itemId }]);
  connection.processTurnPackets();
}

test('every glory in the inventory goes to 4 charges; fuller pieces and the ring of wealth are left', async (t) => {
  completeQuests.clear(); fremennikHard = true;
  const f = caster(t, [ItemIds.AMULET_OF_GLORY, ItemIds.AMULET_OF_GLORY_1_, ItemIds.AMULET_OF_GLORY_T2_,
    ItemIds.AMULET_OF_GLORY_6_, ItemIds.AMULET_OF_GLORY_4_, 2572, 11988]);
  await cast(f);
  assert.deepEqual(f.ids(), [ItemIds.AMULET_OF_GLORY_4_, ItemIds.AMULET_OF_GLORY_4_, ItemIds.AMULET_OF_GLORY_T4_,
    ItemIds.AMULET_OF_GLORY_6_, ItemIds.AMULET_OF_GLORY_4_, 2572, 11988]);
  assert.equal(f.amounts.get(core.ItemIdentifiers.WATER_RUNE), 6, 'Wiki runes: 4 water');
  assert.equal(f.amounts.get(core.ItemIdentifiers.ASTRAL_RUNE), 9, '1 astral');
  assert.equal(f.amounts.get(core.ItemIdentifiers.SOUL_RUNE), 9, '1 soul');
  assert.deepEqual(f.xp, [97.5]);
});

test("skills necklaces and combat bracelets need Legends' Quest", async (t) => {
  fremennikHard = true; completeQuests.clear();
  const f = caster(t, [ItemIds.SKILLS_NECKLACE, ItemIds.COMBAT_BRACELET_2_]);
  await cast(f);
  assert.deepEqual(f.ids(), [ItemIds.SKILLS_NECKLACE, ItemIds.COMBAT_BRACELET_2_]);
  assert.equal(f.amounts.get(core.ItemIdentifiers.SOUL_RUNE), 10, 'nothing to recharge costs no runes');

  completeQuests.add("Legends' Quest");
  await cast(f);
  assert.deepEqual(f.ids(), [ItemIds.SKILLS_NECKLACE_4_, ItemIds.COMBAT_BRACELET_4_]);
});

test('the spell needs the hard Fremennik Diary and its soul rune', async (t) => {
  completeQuests.clear(); fremennikHard = false;
  const f = caster(t, [ItemIds.AMULET_OF_GLORY]);
  await cast(f);
  assert.deepEqual(f.ids(), [ItemIds.AMULET_OF_GLORY]);
  assert.match(f.messages.at(-1), /hard Fremennik Diary/);

  fremennikHard = true;
  f.amounts.set(core.ItemIdentifiers.SOUL_RUNE, 0);
  await cast(f);
  assert.deepEqual(f.ids(), [ItemIds.AMULET_OF_GLORY]);
  assert.deepEqual(f.xp, []);
});
