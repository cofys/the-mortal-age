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


for(const [attacking,attacked] of [[true,false],[false,true],[true,true]]) {
 test('Geomancy refuses real combat before payment: '+JSON.stringify({attacking,attacked}),async t=>{
  const f=caster(t),opponent=new Player(null),farm=Patches.farmFor(f.p),before=structuredClone(farm);
  if(attacking) f.p.getCombat().setTarget(opponent);
  if(attacked) f.p.getCombat().setUnderAttack(opponent);
  assert.equal(core.CombatFactory.inCombat(f.p),true);await click(f);
  assert.deepEqual(f.runes(),[3,3,8]);assert.equal(f.xp(),f.startXp);assert.deepEqual(farm,before);
  assert.ok(f.messages.includes("You can't commune with the land while fighting."));
 });
}
test('Geomancy can be cast after real combat ends',async t=>{
 const f=caster(t),opponent=new Player(null); f.p.getCombat().setUnderAttack(opponent);await click(f);
 f.p.getCombat().setUnderAttack(null);await click(f);
 assert.deepEqual(f.runes(),[0,0,0]);assert.equal(f.xp()-f.startXp,60);assert.equal(f.p.getInterfaceId(),core.CacheDefinitions.getInterfaceId('farming_view'));
});
test('ordinary Geomancy still checks Magic level and rune availability',async t=>{
 for(const options of [{level:64},{casts:0}]) {const f=caster(t,options),before=f.runes();await click(f);assert.deepEqual(f.runes(),before);assert.equal(f.xp(),f.startXp);}
});
