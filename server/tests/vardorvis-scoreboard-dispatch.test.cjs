// Run after `npx tsc --build`: node --test tests/vardorvis-scoreboard-dispatch.test.cjs
//
// Vardorvis' Ancient Tablet through the real plugins: every plugin loaded, Desert Treasure II
// completed through the quest runtime (so DesertTreasureScoreboards sends dt2_scoreboards), the
// click dispatched by PluginManager with the loc's per-player definition, a real ritual-site
// Session for the normal and the awakened fight, and deaths through PlayerDeath's own every-death
// hook (onPlayerDefeated).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, before, after } = require('node:test');

const ROOT = path.join(__dirname, '..');
const { Server } = require('../dist/Server');
Server.installProductionPathResolver();

let PluginManager, core, ObjectDefinition, MapObjects, Player, Location, Site, Scoreboard, quest;
const BOARD_TILE = [1116, 3426, 0];
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vardorvis-dispatch-'));
let index = 2100;

before(async () => {
  await require('../dist/game/cache/CachePipeline').CachePipeline.initialize(ROOT);
  ({ PluginManager } = require('../dist/plugins/PluginManager'));
  ({ ObjectDefinition } = require('../dist/game/definition/ObjectDefinition'));
  ({ MapObjects } = require('../dist/game/entity/impl/object/MapObjects'));
  ({ Location } = require('../dist/game/model/Location'));
  PluginManager.loadPluginSwitches = () => ({ switches: new Map() });
  const quiet = [console.log, console.info, console.debug, console.warn];
  console.log = console.info = console.debug = console.warn = () => {};
  try {
    PluginManager.loadFromDirectory(path.join(ROOT, 'plugins'));
    core = PluginManager.getCoreApi();
    core.RegionManager.init();
  } finally {
    [console.log, console.info, console.debug, console.warn] = quiet;
  }
  ({ Player } = require('../dist/game/entity/impl/player/Player'));
  Site = require('../plugins/bosses/vardorvis/Site.Vardorvis');
  Scoreboard = require('../plugins/bosses/vardorvis/Scoreboard.Vardorvis');
  Scoreboard._useFile(path.join(scratch, 'world.json'));
  quest = require('../plugins/quests/QuestRuntime').getRegisteredQuests().find((q) => q.key === 'desert_treasure_ii');
  core.RegionManager.loadMapFiles(BOARD_TILE[0], BOARD_TILE[1]);
});

after(() => fs.rmSync(scratch, { recursive: true, force: true }));

/** A real player past Desert Treasure II by the tablet, with the network and messages stubbed. */
function reader(t) {
  const p = new Player(null);
  p.setIndex(index++);
  p.setRegistered(true);
  // Kept past the test (not t.mock), so tasks the site leaves queued still have a network to stub.
  p.getSession = () => ({ sendClientPacket: () => true, write: () => true });
  t.mock.method(p, 'sendMessage', () => {});
  p.setLocation(new Location(1116, 3427, 0));
  quest.complete(p);
  const sender = p.getPacketSender();
  p.sent = { interfaces: [], texts: new Map() };
  const original = { sendInterface: sender.sendInterface, sendString: sender.sendString };
  t.mock.method(sender, 'sendInterface', function (id) { p.sent.interfaces.push(id); return original.sendInterface.apply(this, arguments); });
  t.mock.method(sender, 'sendString', function (text, uid) { p.sent.texts.set(uid, text); return original.sendString.apply(this, arguments); });
  return p;
}

function click(p, clickType = 1) {
  const [x, y, z] = BOARD_TILE;
  const object = MapObjects.get(core.CacheDefinitions.getLocId('vardorvis_scoreboard'), new Location(x, y, z), null);
  assert.ok(object, 'the tablet is placed at 1116,3426');
  const definition = ObjectDefinition.forPlayer(object.getId(), p);
  const event = { player: p, object, objectId: object.getId(), definition, clickType, location: { x, y, z }, handled: false };
  PluginManager.emitObjectInteraction(event);
  return { event, definition };
}

const INTERFACE = () => core.CacheDefinitions.getInterfaceId('vardorvis_scoreboard');
const text = (p, component) => p.sent.texts.get((INTERFACE() << 16) | component);
const tick = (n) => { for (let i = 0; i < n; i++) core.TaskManager.process(); };

/** Into a real ritual site, until his fight has begun. */
function enterSite(p, awakened) {
  Site.enter(p, awakened);
  for (let i = 0; i < 20 && !Site.sessionOf(p)?.fight; i++) tick(1);
  const session = Site.sessionOf(p);
  assert.ok(session?.fight && p.getPrivateArea() === session.area, 'in the site with his fight on');
  assert.equal(session.fight.awakened, awakened);
  return session;
}

test('after the quest the tablet is "Ancient Tablet": Read, and reads through PluginManager', (t) => {
  const p = reader(t);
  const { event, definition } = click(p);
  assert.equal(definition.getName(), 'Ancient Tablet');
  assert.equal(definition.getInteractions()[0], 'Read');
  assert.equal(event.handled, true);
  assert.deepEqual(p.sent.interfaces, [INTERFACE()]);
  assert.equal(text(p, 6), 'Vardorvis Statistics');
});

test("the awakened form's second option is Read (Awakened), the name the handler is keyed on", () => {
  const awakened = ObjectDefinition.forId(core.CacheDefinitions.getLocId('vardorvis_scoreboard_vis_awakened'));
  assert.equal(awakened.getName(), 'Ancient Tablet');
  assert.deepEqual(awakened.getInteractions().slice(0, 2), ['Read', 'Read (Awakened)']);
});

test('a death in a real site during the normal fight counts as a normal death', (t) => {
  const p = reader(t);
  enterSite(p, false);
  PluginManager.emitPlayerDefeated(null, p);
  assert.equal(p.getAttribute(Scoreboard.DEATHS_ATTRIBUTE), 1);
  assert.equal(p.getAttribute(Scoreboard.AWAKENED_DEATHS_ATTRIBUTE) ?? 0, 0);
  Site.leave(p);
  tick(8);
});

test('a death in a real site during the awakened fight counts as an awakened death', (t) => {
  const p = reader(t);
  enterSite(p, true);
  PluginManager.emitPlayerDefeated(null, p);
  assert.equal(p.getAttribute(Scoreboard.AWAKENED_DEATHS_ATTRIBUTE), 1);
  assert.equal(p.getAttribute(Scoreboard.DEATHS_ATTRIBUTE) ?? 0, 0);
  Site.leave(p);
  tick(8);
});

test('a death after his fight is over, or away from the site, is not counted', (t) => {
  const p = reader(t);
  const session = enterSite(p, false);
  session.fight.over = true;
  PluginManager.emitPlayerDefeated(null, p);
  Site.leave(p);
  tick(8);
  PluginManager.emitPlayerDefeated(null, p);
  assert.equal(p.getAttribute(Scoreboard.DEATHS_ATTRIBUTE) ?? 0, 0);
});
