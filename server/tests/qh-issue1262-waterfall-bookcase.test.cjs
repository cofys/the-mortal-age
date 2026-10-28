// Regression for issue #1262: exercise the actual cache object and full production plugin order.
const assert = require('node:assert/strict');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { Server } = require('../dist/Server');
Server.installProductionPathResolver();
const ROOT = path.resolve(__dirname, '..');
let PluginManager, core, Player, MapObjects, QuestRuntime;
const BOOKCASE = 1989;
const BOOK = 292;
const TILE = [2520, 3426, 1];

before(async () => {
  await require('../dist/game/cache/CachePipeline').CachePipeline.initialize(ROOT);
  ({ PluginManager } = require('../dist/plugins/PluginManager'));
  process.env.DISABLE_PLAYER_BOTS = '1';
  require('../dist/game/definition/WorldDefinition').isMembersWorld = () => true;
  PluginManager.loadPluginSwitches = () => ({ switches: new Map() });
  const quiet = [console.log, console.info, console.debug, console.warn];
  console.log = console.info = console.debug = console.warn = () => {};
  try {
    PluginManager.loadFromDirectory(path.join(ROOT, 'plugins'));
    core = PluginManager.getCoreApi();
    core.RegionManager.init();
    core.RegionManager.loadMapFiles(TILE[0], TILE[1]);
  } finally { [console.log, console.info, console.debug, console.warn] = quiet; }
  ({ Player } = require('../dist/game/entity/impl/player/Player'));
  ({ MapObjects } = require('../dist/game/entity/impl/object/MapObjects'));
  QuestRuntime = require('../plugins/quests/QuestRuntime');
});
after(() => setImmediate(() => process.exit()));

function makePlayer(t) {
  const p = new Player(null);
  p.setUsername('issue1262');
  p.setLocation(new core.Location(2519, 3426, 1));
  t.mock.method(p, 'getSession', () => ({ sendClientPacket: () => true, write: () => true }));
  p.isRegistered = () => true;
  p.getInventory().refreshItems = () => {};
  const messages = [];
  const configs = [];
  t.mock.method(p.getPacketSender(), 'sendMessage', text => { messages.push(String(text)); return p.getPacketSender(); });
  t.mock.method(p.getPacketSender(), 'sendConfig', (id, value) => { configs.push([id, value]); return p.getPacketSender(); });
  return { p, messages, configs };
}

function search(p) {
  const location = new core.Location(...TILE);
  const object = MapObjects.getPrivateArea(p, BOOKCASE, location);
  assert.ok(object, 'cache bookcase exists at the pinned QH location');
  const definition = object.getDefinition();
  const event = { player: p, object, definition, objectId: object.getId(), clickType: 1,
    option: definition.getInteractions()?.[0]?.toLowerCase(), location: { x: TILE[0], y: TILE[1], z: TILE[2] }, handled: false };
  return { handled: PluginManager.emitObjectInteraction(event), event };
}

test('production dispatch yields unrelated Bookcase-name owners to Waterfall and preserves retry/read progression', t => {
  const def = require('../dist/game/definition/ObjectDefinition').ObjectDefinition.forId(BOOKCASE);
  assert.equal(def.getName(), 'Bookcase');
  assert.equal(def.getInteractions()[0], 'Search');
  const { p, messages, configs } = makePlayer(t);
  const quest = QuestRuntime.getRegisteredQuests().find(q => q.key === 'waterfall_quest');
  assert.ok(quest, 'Waterfall is registered by the members production Quests plugin');

  quest.setStage(p, 1);
  const trace = [];
  const originalExecute = PluginManager.executeHook;
  PluginManager.executeHook = function(hook, event, ...args) {
    const value = originalExecute.call(this, hook, event, ...args);
    if (event?.objectId === BOOKCASE) trace.push([hook.pluginName, hook.profileName, event.handled]);
    return value;
  };
  let result;
  try { result = search(p); } finally { PluginManager.executeHook = originalExecute; }
  assert.equal(result.handled, true);
  assert.ok(trace.some(row => row[1] === 'Quests/TouristTrap' && row[2] === false), 'Tourist Trap yields when its bookcase ID does not match');
  assert.ok(trace.some(row => row[1] === 'Quests/WaterfallQuest' && row[2] === true), 'Waterfall handles its own cache bookcase');
  assert.equal(p.getInventory().getAmount(BOOK), 0, 'the stage-1 search is too early');
  assert.equal(quest.getStage(p), 1);

  quest.setStage(p, 2);
  assert.equal(quest.getStage(p), 2);

  const fillers = Array.from({ length: 28 }, (_, i) => 10000 + i);
  for (const id of fillers) p.getInventory().adds(id, 1);
  assert.equal(p.getInventory().isFull(), true);
  assert.equal(search(p).handled, true);
  assert.equal(p.getInventory().getAmount(BOOK), 0, 'full inventory does not award or consume the book');
  assert.ok(messages.some(m => /free inventory space/.test(m)));

  p.getInventory().deleteNumber(fillers[0], 1);
  assert.equal(search(p).handled, true);
  assert.equal(p.getInventory().getAmount(BOOK), 1, 'free-slot retry awards the book');
  p.getDialogueManager().reset();
  assert.equal(p.getInventory().getAmount(BOOK), 1, 'cancelling the item message does not discard the acquired book');
  assert.equal(quest.getStage(p), 2, 'cancelling the message does not falsely mark the book read');
  p.getInventory().deleteNumber(BOOK, 1);
  assert.equal(search(p).handled, true);
  assert.equal(p.getInventory().getAmount(BOOK), 1, 'a lost book can be reclaimed');
  assert.equal(quest.getStage(p), 2, 'search alone does not advance varp 65');

  const slot = p.getInventory().getItems().findIndex(item => item.getId() === BOOK);
  const read = { player: p, item: p.getInventory().getItems()[slot], slot, itemId: BOOK, clickType: 1, handled: false };
  assert.equal(PluginManager.emitItemAction(read), true, 'the registered Book on Baxtorian Read action runs');
  assert.equal(quest.getStage(p), 3);
  assert.deepEqual(configs.filter(([id]) => id === 65).at(-1), [65, 3], 'varp 65 advances to the read-book stage');
});
