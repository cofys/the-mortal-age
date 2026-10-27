// Run after `npx tsc --build`: node --test tests/vardorvis-scoreboard.test.cjs
//
// Vardorvis' Ancient Tablet (vardorvis_scoreboard and its visible forms, interface
// vardorvis_scoreboard): the kill path in Fight.Vardorvis.js feeding it for the normal and the
// awakened fight, deaths, the Desert Treasure II gate, the world's records across players and
// restarts, on a real Player with only the network stubbed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, before, beforeEach, after } = require('node:test');

const { Server } = require('../dist/Server');
Server.installProductionPathResolver();

const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { PluginManager } = require('../dist/plugins/PluginManager');

const Common = require('../plugins/bosses/vardorvis/Common.Vardorvis');
const { Fight } = require('../plugins/bosses/vardorvis/Fight.Vardorvis');
const Site = require('../plugins/bosses/vardorvis/Site.Vardorvis');
const Scoreboard = require('../plugins/bosses/vardorvis/Scoreboard.Vardorvis');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'vardorvis-scoreboard-'));
const hooks = { objects: {}, before: [], persisted: new Map() };
const questDone = new Set();
let INTERFACE, PARENT, NORMAL, AWAKENED;
let index = 1;

before(() => {
  CachePipeline.initialize();
  const api = {
    core: PluginManager.getCoreApi(),
    persistAttribute: (key, value) => hooks.persisted.set(key, value),
    onObjectInteraction: (name, actions) => { (hooks.objects[name] ??= []).push(actions); },
    onBeforeObjectInteraction: (handler) => hooks.before.push(handler),
    emitCustomEvent(name, payload) {
      if (name === 'quest:is-complete' && questDone.has(payload.player)) payload.complete = true;
    },
  };
  Common.init(api);
  Scoreboard.attachScoreboard(api);
  const cache = api.core.CacheDefinitions;
  INTERFACE = cache.getInterfaceId('vardorvis_scoreboard');
  PARENT = cache.getLocId('vardorvis_scoreboard');
  NORMAL = cache.getLocId('vardorvis_scoreboard_vis');
  AWAKENED = cache.getLocId('vardorvis_scoreboard_vis_awakened');
});

after(() => fs.rmSync(scratch, { recursive: true, force: true }));

beforeEach(() => Scoreboard._useFile(path.join(scratch, `${Math.random()}.json`)));

/** A real Player past Desert Treasure II, with only the network stubbed; its packets are recorded. */
function realPlayer(t, { quest = true } = {}) {
  const { Player } = require('../dist/game/entity/impl/player/Player');
  const p = new Player(null);
  p.setIndex(index++);
  p.setRegistered(true);
  if (quest) questDone.add(p);
  t.mock.method(p, 'getSession', () => ({ sendClientPacket: () => true, write: () => true }));
  const sender = p.getPacketSender();
  p.sent = { interfaces: [], texts: new Map() };
  const original = { sendInterface: sender.sendInterface, sendString: sender.sendString };
  t.mock.method(sender, 'sendInterface', function (id) { p.sent.interfaces.push(id); return original.sendInterface.apply(this, arguments); });
  t.mock.method(sender, 'sendString', function (text, uid) { p.sent.texts.set(uid, text); return original.sendString.apply(this, arguments); });
  t.mock.method(p, 'sendMessage', () => {});
  return p;
}

/** Fires an option the way PluginManager does: before-hooks, then every handler for the name. */
function click(player, option, objectId, clickType = option === 'Read' ? 1 : 2) {
  const event = { player, objectId, option: option.toLowerCase(), clickType, handled: false };
  for (const hook of hooks.before) {
    hook(event);
    if (event.handled) return true;
  }
  for (const actions of hooks.objects['Ancient Tablet'] ?? []) {
    if (actions[option]?.(event) === true) return true;
  }
  return false;
}

/** Vardorvis falling to `player` after `ticks`, through Fight.Vardorvis.js's own won(). */
function kill(player, ticks, awakened = false) {
  const { World } = Common.core;
  const session = { awakened, ended: false, fight: null, setExit() {} };
  const fight = Object.assign(Object.create(Fight.prototype), {
    player, session, awakened, boss: null, startCycle: World.getProcessCycle() - ticks,
  });
  session.fight = fight;
  fight.won();
}

const text = (p, component) => p.sent.texts.get((INTERFACE << 16) | component);

test('a new reader sees the cache title, "(recorded)" counts and "No recorded best", as the other DT2 boards', (t) => {
  const p = realPlayer(t);
  assert.equal(click(p, 'Read', NORMAL), true);
  assert.deepEqual(p.sent.interfaces, [INTERFACE]);
  assert.equal(text(p, 6), 'Vardorvis Statistics');
  assert.equal(text(p, 9), '0');
  for (const component of [11, 15, 17]) assert.equal(text(p, component), '0 (recorded)');
  assert.equal(text(p, 13), 'No recorded best');
  assert.equal(text(p, 19), 'No recorded best');
});

test('the map loc with its null name reads through the before-hook, as the other DT2 boards do', (t) => {
  const p = realPlayer(t);
  assert.equal(click(p, 'Read', PARENT), true);
  assert.deepEqual(p.sent.interfaces, [INTERFACE]);
});

test('before Desert Treasure II the tablet reads nothing', (t) => {
  const p = realPlayer(t, { quest: false });
  assert.equal(click(p, 'Read', NORMAL), false);
  assert.equal(click(p, 'Read', PARENT), false);
  assert.deepEqual(p.sent.interfaces, []);
});

test('normal kills through Fight.won fill Read, awakened kills fill Read (Awakened)', (t) => {
  const p = realPlayer(t);
  kill(p, 43); // 0:25.80, the Wiki's world best
  kill(p, 60);
  kill(p, 165, true); // 1:39.00
  click(p, 'Read', NORMAL);
  assert.equal(text(p, 9), '2');
  assert.equal(text(p, 13), '0:25.80');
  assert.equal(text(p, 15), '2 (recorded)');
  assert.equal(text(p, 19), '0:25.80');
  assert.equal(click(p, 'Read (Awakened)', AWAKENED), true);
  assert.equal(text(p, 6), 'Vardorvis (Awakened) Statistics');
  assert.equal(text(p, 9), '1');
  assert.equal(text(p, 13), '1:39.00');
  assert.equal(text(p, 15), '1 (recorded)');
  assert.equal(text(p, 19), '1:39.00');
});

test("the world's records are every player's, and a reader's own rows stay theirs", (t) => {
  const a = realPlayer(t);
  const b = realPlayer(t);
  kill(a, 200);
  kill(b, 90);
  Scoreboard.died(b, false);
  Scoreboard.died(b, true);
  click(a, 'Read', NORMAL);
  assert.equal(text(a, 9), '1');
  assert.equal(text(a, 11), '0 (recorded)');
  assert.equal(text(a, 13), '2:00.00');
  assert.equal(text(a, 15), '2 (recorded)');
  assert.equal(text(a, 17), '1 (recorded)');
  assert.equal(text(a, 19), '0:54.00');
  click(a, 'Read (Awakened)', AWAKENED);
  assert.equal(text(a, 17), '1 (recorded)', "the awakened death is the awakened board's");
});

test('a death away from the ritual site counts for nothing', (t) => {
  const p = realPlayer(t);
  Site.diedAtSite({ killer: null, victim: p });
  click(p, 'Read', NORMAL);
  assert.equal(text(p, 11), '0 (recorded)');
  assert.equal(text(p, 17), '0 (recorded)');
});

test('deaths are saved attributes starting at 0, and the world records survive a restart', (t) => {
  assert.equal(hooks.persisted.get(Scoreboard.DEATHS_ATTRIBUTE), 0);
  assert.equal(hooks.persisted.get(Scoreboard.AWAKENED_DEATHS_ATTRIBUTE), 0);
  const file = path.join(scratch, 'restart.json');
  Scoreboard._useFile(file);
  const p = realPlayer(t);
  kill(p, 120);
  kill(p, 300, true);
  Scoreboard.died(p, false);
  Scoreboard._useFile(file); // as a restart reads it again
  const q = realPlayer(t);
  click(q, 'Read', NORMAL);
  assert.equal(text(q, 15), '1 (recorded)');
  assert.equal(text(q, 17), '1 (recorded)');
  assert.equal(text(q, 19), '1:12.00');
  assert.equal(text(q, 11), '0 (recorded)');
  click(q, 'Read (Awakened)', AWAKENED);
  assert.equal(text(q, 15), '1 (recorded)');
  assert.equal(text(q, 19), '3:00.00');
  click(p, 'Read', NORMAL);
  assert.equal(text(p, 11), '1 (recorded)');
});

test('reading twice sends the board twice and counts nothing', (t) => {
  const p = realPlayer(t);
  click(p, 'Read', NORMAL);
  click(p, 'Read', NORMAL);
  assert.deepEqual(p.sent.interfaces, [INTERFACE, INTERFACE]);
  assert.equal(text(p, 15), '0 (recorded)');
});

test('the tablet stands by the ritual site as a solid loc', () => {
  const { RegionManager } = require('../dist/game/collision/RegionManager');
  const { MapObjects } = require('../dist/game/entity/impl/object/MapObjects');
  const { Location } = require('../dist/game/model/Location');
  RegionManager.init();
  const board = MapObjects.get(PARENT, new Location(1116, 3426, 0), null);
  assert.ok(board, 'the cache places it at 1116,3426');
  assert.equal(board.getType(), 10);
});
