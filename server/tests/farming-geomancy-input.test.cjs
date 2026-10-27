// Native Geomancy widget input with all plugins and real game objects; only transport/message output is captured.
const assert = require('node:assert/strict');
const path = require('node:path');
const { before, test } = require('node:test');
require('../dist/Server').Server.installProductionPathResolver();
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { PluginManager } = require('../dist/plugins/PluginManager');
const { Player } = require('../dist/game/entity/impl/player/Player');
const { PlayerSession } = require('../dist/net/PlayerSession');
const { ClientConnection } = require('../dist/net/NetworkBuilder');
const { SkillManager } = require('../dist/game/content/skill/SkillManager');
const { PlayerStatus } = require('../dist/game/model/PlayerStatus');
const ROOT = path.resolve(__dirname, '..');
let core, spell, Data, Patches;
let actorIndex = 100;

before(async () => {
  await CachePipeline.initialize(ROOT);
  PluginManager.loadFromDirectory(path.join(ROOT, 'plugins'));
  core = PluginManager.getCoreApi();
  core.RegionManager.init();
  core.RegionManager.loadMapFiles(3200, 3200);
  Data = require('../plugins/skills/farming/Data.Farming');
  Patches = require('../plugins/skills/farming/Patches.Farming');
  Data.initializeFarmingData();
  spell = core.CacheDefinitions.getSpellByName('Geomancy');
  assert.ok(spell);
});

function channel() {
  return { kind: 'test', remoteAddress: '127.0.0.1', isOpen: () => true,
    send: () => true, close() {}, onData() {}, onError() {}, onClose() {} };
}

function caster(t, { level = 99, casts = 1, book, full = false } = {}) {
  const transport = channel();
  const p = new Player(new PlayerSession(transport));
  p.setUsername(`geoin${actorIndex}`);
  p.setIndex(actorIndex++);
  p.setRegistered(true);
  p.setLocation(new core.Location(3200, 3200, 0));
  p.setSpellbook(book === 'normal' ? core.MagicSpellbook.NORMAL : core.MagicSpellbook.LUNAR);
  p.getSkillManager().setMaxLevels(core.Skill.MAGIC, level, false)
    .setCurrentLevels(core.Skill.MAGIC, level, false)
    .setExperiences(core.Skill.MAGIC, SkillManager.getExperienceForLevel(level), false);
  const messages = [];
  t.mock.method(p.getPacketSender(), 'sendMessage', text => { messages.push(text); return p.getPacketSender(); });
  for (const [name, amount] of [['Astral rune', 3], ['Nature rune', 3], ['Earth rune', 8]]) {
    if (casts) p.getInventory().add(new core.Item(Data.itemId(name), amount * casts), false);
  }
  if (full) while (p.getInventory().getFreeSlots()) p.getInventory().add(new core.Item(Data.itemId('Rake'), 1), false);
  const connection = new ClientConnection(transport);
  connection.player = p;
  const xp = () => p.getSkillManager().getExperience(core.Skill.MAGIC);
  const runes = () => ['Astral rune', 'Nature rune', 'Earth rune'].map(n => p.getInventory().getAmount(Data.itemId(n)));
  return { p, connection, messages, xp, runes, startXp: xp() };
}

async function click(f, { action = 1, widget = spell, copies = 1 } = {}) {
  await f.connection.dispatch(Array.from({ length: copies }, () => ({
    type: 'widget_action', widgetId: widget.widgetId, groupId: widget.widgetId >>> 16,
    childId: widget.widgetId & 65535, itemId: widget.itemId, buttonNum: action,
  })));
  f.connection.processTurnPackets();
}

test('native Cast reaches Farming once, consumes exactly the Wiki runes and awards 60 XP', async t => {
  const f = caster(t);
  await click(f);
  assert.deepEqual(f.runes(), [0, 0, 0]);
  assert.equal(f.xp() - f.startXp, 60);
  assert.equal(f.p.getInterfaceId(), core.CacheDefinitions.getInterfaceId('farming_view'));
});

test('native combat refusal keeps real runes, XP, Farming state and attacker intact', async t => {
  const f = caster(t);
  const attacker = new Player(null);
  f.p.getCombat().setUnderAttack(attacker);
  const farm = Patches.farmFor(f.p), before = structuredClone(farm);
  await click(f);
  assert.deepEqual(f.runes(), [3, 3, 8]);
  assert.equal(f.xp(), f.startXp);
  assert.deepEqual(farm, before);
  assert.equal(f.p.getCombat().getAttacker(), attacker);
  assert.ok(f.messages.includes("You can't commune with the land while fighting."));
  f.p.getCombat().setUnderAttack(null);
  await click(f);
  assert.equal(f.xp() - f.startXp, 60);
});

for (const [name, options] of [['low Magic', { level: 64 }], ['missing runes', { casts: 0 }], ['wrong book', { book: 'normal' }]]) {
  test(`native ${name} failure does not pay or award XP`, async t => {
    const f = caster(t, options), before = f.runes();
    await click(f);
    assert.deepEqual(f.runes(), before);
    assert.equal(f.xp(), f.startXp);
  });
}

test('only the native Cast action is accepted', async t => {
  const f = caster(t);
  for (const action of [0, 2, 10]) await click(f, { action });
  assert.deepEqual(f.runes(), [3, 3, 8]);
  assert.equal(f.xp(), f.startXp);
});

test('two queued clicks with one cast of runes charge and award once', async t => {
  const f = caster(t);
  await click(f, { copies: 2 });
  assert.deepEqual(f.runes(), [0, 0, 0]);
  assert.equal(f.xp() - f.startXp, 60);
});

test('a full inventory can cast without deleting unrelated items', async t => {
  const f = caster(t, { full: true });
  await click(f);
  assert.equal(f.p.getInventory().getAmount(Data.itemId('Rake')), 25);
  assert.equal(f.xp() - f.startXp, 60);
});

test('a mid-trade or dead player cannot spend runes through a native widget', async t => {
  for (const dead of [false, true]) {
    const f = caster(t);
    if (dead) f.p.setHitpoints(0);
    else f.p.setStatus(PlayerStatus.TRADING);
    await click(f);
    assert.deepEqual(f.runes(), [3, 3, 8]);
    assert.equal(f.xp(), f.startXp);
  }
});
