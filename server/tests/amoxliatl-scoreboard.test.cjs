// Run after `npx tsc --build`: node --test tests/amoxliatl-scoreboard.test.cjs
//
// Amoxliatl's Ancient tablet (amoxliatl_scoreboard / amoxliatl_scoreboard_op, interface
// amoxliatl_scoreboard): the kill path in Kills.Amoxliatl.js feeding it, deaths, the world's
// records across players and restarts, on a real Player with only the network stubbed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, before, beforeEach, after } = require('node:test');

const { Server } = require('../dist/Server');
Server.installProductionPathResolver();

const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { PluginManager } = require('../dist/plugins/PluginManager');

const Common = require('../plugins/bosses/amoxliatl/Common.Amoxliatl');
const attachKills = require('../plugins/bosses/amoxliatl/Kills.Amoxliatl');
const Scoreboard = require('../plugins/bosses/amoxliatl/Scoreboard.Amoxliatl');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'amoxliatl-scoreboard-'));
const hooks = { objects: {}, npcDeaths: [], playerDeaths: [], persisted: new Map() };
let INTERFACE, BOARD_MULTI, BOARD;
let index = 1;

before(() => {
  CachePipeline.initialize();
  const api = {
    core: PluginManager.getCoreApi(),
    persistAttribute: (key, value) => hooks.persisted.set(key, value),
    onObjectInteraction: (name, actions) => { (hooks.objects[name] ??= []).push(actions); },
    onNpcDeath: (handler) => hooks.npcDeaths.push(handler),
    onNpcBeforeDeath() {},
    onPlayerDefeated: (handler) => hooks.playerDeaths.push(handler),
    onCustomEvent() {},
    onPlayerLogin() {},
    onItemAction() {},
    emitCustomEvent() {},
  };
  Common.init(api);
  attachKills(api);
  Scoreboard.attachScoreboard(api);
  const cache = api.core.CacheDefinitions;
  INTERFACE = cache.getInterfaceId('amoxliatl_scoreboard');
  BOARD_MULTI = cache.getLocId('amoxliatl_scoreboard');
  BOARD = cache.getLocId('amoxliatl_scoreboard_op');
});

after(() => fs.rmSync(scratch, { recursive: true, force: true }));

beforeEach(() => Scoreboard._useFile(path.join(scratch, `${Math.random()}.json`)));

/** A real Player with only the network stubbed; the packets it would send are recorded. */
function realPlayer(t) {
  const { Player } = require('../dist/game/entity/impl/player/Player');
  const p = new Player(null);
  p.setIndex(index++);
  p.setRegistered(true);
  t.mock.method(p, 'getSession', () => ({ sendClientPacket: () => true, write: () => true }));
  const sender = p.getPacketSender();
  p.sent = { interfaces: [], texts: new Map(), messages: [] };
  const original = { sendInterface: sender.sendInterface, sendString: sender.sendString };
  t.mock.method(sender, 'sendInterface', function (id) { p.sent.interfaces.push(id); return original.sendInterface.apply(this, arguments); });
  t.mock.method(sender, 'sendString', function (text, uid) { p.sent.texts.set(uid, text); return original.sendString.apply(this, arguments); });
  t.mock.method(p, 'sendMessage', (text) => p.sent.messages.push(text));
  return p;
}

/** Fires an option the way ObjectActionPacketListener does: every handler for the name until one claims it. */
function click(player, option, objectId) {
  for (const actions of hooks.objects['Ancient tablet'] ?? []) {
    if (actions[option]?.({ player, objectId, option: option.toLowerCase(), clickType: 1, handled: false }) === true) return true;
  }
  return false;
}

/** A fight as Fight.Amoxliatl.js keeps it, `ticks` long. */
function fightOf(player, ticks, quest = false) {
  return {
    player, stopped: false, stats: {}, duration: () => ticks, hideHud() {}, stop() {},
    session: { quest, kills: 0, end() {}, spawnBoss() {} },
  };
}

/** Amoxliatl dying in `player`'s chamber after `ticks`, through Kills.Amoxliatl.js's own death hook. */
function kill(player, ticks, quest = false) {
  for (const handler of hooks.npcDeaths) handler({ npc: { __amoxliatlFight: fightOf(player, ticks, quest) } });
}

const text = (p, component) => p.sent.texts.get((INTERFACE << 16) | component);

test('a new reader sees zeros and "-" under the cache title', (t) => {
  const p = realPlayer(t);
  assert.equal(click(p, 'Read', BOARD_MULTI), true);
  assert.deepEqual(p.sent.interfaces, [INTERFACE]);
  assert.equal(text(p, 6), 'Amoxliatl Statistics');
  for (const component of [9, 11, 15, 17]) assert.equal(text(p, component), '0');
  assert.equal(text(p, 13), '-');
  assert.equal(text(p, 19), '-');
});

test('kills through her death hook fill the personal and world rows, the faster time winning', (t) => {
  const p = realPlayer(t);
  kill(p, 108); // 1:04.80
  kill(p, 150);
  assert.equal(click(p, 'Read', BOARD), true, 'the transformed loc reads too');
  assert.equal(text(p, 9), '2');
  assert.equal(text(p, 13), '1:04.80');
  assert.equal(text(p, 15), '2');
  assert.equal(text(p, 19), '1:04.80');
});

test("the quest's fight is not a kill, and a death outside her chamber is not a death", (t) => {
  const p = realPlayer(t);
  kill(p, 100, true);
  for (const handler of hooks.playerDeaths) handler({ killer: null, victim: p });
  click(p, 'Read', BOARD_MULTI);
  assert.equal(text(p, 9), '0');
  assert.equal(text(p, 11), '0');
  assert.equal(text(p, 15), '0');
  assert.equal(text(p, 17), '0');
});

test("the world's records are every player's, and a reader's own rows stay theirs", (t) => {
  const a = realPlayer(t);
  const b = realPlayer(t);
  kill(a, 200);
  kill(b, 90);
  Scoreboard.died(b);
  click(a, 'Read', BOARD_MULTI);
  assert.equal(text(a, 9), '1');
  assert.equal(text(a, 11), '0');
  assert.equal(text(a, 13), '2:00.00');
  assert.equal(text(a, 15), '2');
  assert.equal(text(a, 17), '1');
  assert.equal(text(a, 19), '0:54.00', "b's kill is the world's best");
});

test('deaths are a saved attribute starting at 0, and the world records survive a restart', (t) => {
  assert.equal(hooks.persisted.get(Scoreboard.DEATHS_ATTRIBUTE), 0);
  const file = path.join(scratch, 'restart.json');
  Scoreboard._useFile(file);
  const p = realPlayer(t);
  kill(p, 120);
  Scoreboard.died(p);
  Scoreboard.died(p);
  Scoreboard._useFile(file); // as a restart reads it again
  const q = realPlayer(t);
  click(q, 'Read', BOARD_MULTI);
  assert.equal(text(q, 15), '1');
  assert.equal(text(q, 17), '2');
  assert.equal(text(q, 19), '1:12.00');
  assert.equal(text(q, 11), '0');
  // The player's own deaths are their attribute, which the save keeps (persistAttribute above).
  click(p, 'Read', BOARD_MULTI);
  assert.equal(text(p, 11), '2');
});

test('reading twice sends the board twice and counts nothing', (t) => {
  const p = realPlayer(t);
  click(p, 'Read', BOARD_MULTI);
  click(p, 'Read', BOARD_MULTI);
  assert.deepEqual(p.sent.interfaces, [INTERFACE, INTERFACE]);
  assert.equal(text(p, 15), '0');
});

test("the Tombs of Amascut's Scabaras Ancient tablet is left to its own handler", (t) => {
  const p = realPlayer(t);
  assert.equal(click(p, 'Read', Common.core.CacheDefinitions.getLocId('toa_scabaras_totaltiles_tablet')), false);
  assert.deepEqual(p.sent.interfaces, []);
});

test('the tablet is placed before her door as a shape-10 loc (the plain rectangle reach, no route needed)', () => {
  const { RegionManager } = require('../dist/game/collision/RegionManager');
  const { MapObjects } = require('../dist/game/entity/impl/object/MapObjects');
  const { Location } = require('../dist/game/model/Location');
  RegionManager.init();
  const board = MapObjects.get(BOARD_MULTI, new Location(1616, 9635, 0), null);
  assert.ok(board, 'the cache places it at 1616,9635');
  assert.equal(board.getType(), 10);
});
