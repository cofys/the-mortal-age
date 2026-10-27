// Run after `npx tsc --build`: node --test tests/pyramid-plunder-mural.test.cjs
//
// The Pyramid Plunder Mural (ntk_tomb_wall_scoreboard, interface ntk_scores): Grand Gold Chests
// counted by room from a real chest search, read back on a real Player with only the network
// stubbed, the Wiki's "no pillaging" line, a saved attribute, and the cache's placements.
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');

const { Server } = require('../dist/Server');
Server.installProductionPathResolver();

const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { PluginManager } = require('../dist/plugins/PluginManager');

const PyramidPlunder = require('../plugins/minigames/PyramidPlunder.plugin');
const T = PyramidPlunder._test;
const C = T.Common;
const M = T.Mural;

const hooks = { objects: {}, persisted: new Map() };
let INTERFACE, MURAL, LINE;
let index = 1;
const players = [];

before(() => {
  CachePipeline.initialize();
  const api = {
    core: PluginManager.getCoreApi(),
    persistAttribute: (key, value) => hooks.persisted.set(key, value),
    onObjectInteraction: (name, actions) => { (hooks.objects[name] ??= []).push(actions); },
    emitCustomEvent() {},
    spawnNpc: () => null,
    removeNpc() {},
  };
  // Only the units under test: the chest search and the mural.
  require('../plugins/minigames/pyramidplunder/Containers.PyramidPlunder')(api);
  require('../plugins/minigames/pyramidplunder/Mural.PyramidPlunder')(api);
  const cache = api.core.CacheDefinitions;
  INTERFACE = cache.getInterfaceId('ntk_scores');
  MURAL = cache.getLocId('ntk_tomb_wall_scoreboard');
  LINE = (n) => cache.getComponentId(`ntk_scores:messagescroll${n}_hw`);
});

// The runs started here are only dropped: their players' network stubs are gone by now.
after(() => { for (const p of players) C.sessions.delete(p); });

/** A real Player with only the network stubbed; the packets it would send are recorded. */
function realPlayer(t, thieving = 99) {
  const { Player } = require('../dist/game/entity/impl/player/Player');
  const p = new Player(null);
  p.setIndex(index++);
  p.setRegistered(true);
  t.mock.method(p, 'getSession', () => ({ sendClientPacket: () => true, write: () => true }));
  t.mock.method(p.getInventory(), 'refreshItems', () => {});
  const { Skill } = C.getCore();
  p.getSkillManager().setMaxLevel(Skill.THIEVING, thieving).setCurrentLevel(Skill.THIEVING, thieving);
  const sender = p.getPacketSender();
  p.sent = { interfaces: [], texts: new Map(), messages: [] };
  t.mock.method(p, 'sendMessage', (message) => p.sent.messages.push(message));
  const original = { sendInterface: sender.sendInterface, sendString: sender.sendString };
  t.mock.method(sender, 'sendInterface', function (id) { p.sent.interfaces.push(id); return original.sendInterface.apply(this, arguments); });
  t.mock.method(sender, 'sendString', function (text, uid) { p.sent.texts.set(uid, text); return original.sendString.apply(this, arguments); });
  players.push(p);
  return p;
}

function click(player, objectId = MURAL) {
  for (const actions of hooks.objects.Mural ?? []) {
    if (actions.Read?.({ player, objectId, option: 'read', clickType: 1, handled: false }) === true) return true;
  }
  return false;
}

/** The room's Grand Gold Chest searched, through Containers.PyramidPlunder.js. */
/** A fresh visit to `room` (its chest closed again), as moving on through the rooms gives. */
function visit(player, room) {
  const run = C.sessionOf(player) ?? (C.startRun(player, () => 0), C.sessionOf(player));
  run.room = room;
  run.cleared = new Set();
  player.getPacketSender().sendVarbit(C.ids().varbit.chest, 0);
  return run;
}

/**
 * The room's Grand Gold Chest searched, through Containers.PyramidPlunder.js. 0.5 rolls no swarm
 * at 99 Thieving and no sceptre; `idle` lets the last search's ticks pass first.
 */
function searchChest(player, room, { roll = 0.5, idle = true } = {}) {
  const run = C.sessionOf(player)?.room === room ? C.sessionOf(player) : visit(player, room);
  if (idle) run.busyUntil = 0;
  const b = C.roomData(room).bounds;
  T.Containers.searchChest({ player, objectId: C.ids().chest, location: { x: b.minX + 2, y: b.minY + 2, z: 0 } }, () => roll);
}

const text = (p, n) => p.sent.texts.get(LINE(n));

test('before any chest: the Wiki\'s line, and the rest of the scroll blank', (t) => {
  const p = realPlayer(t);
  assert.equal(click(p), true);
  assert.deepEqual(p.sent.interfaces, [INTERFACE]);
  assert.equal(text(p, 1), 'At the time of writing, no pillaging has taken place here.');
  for (let n = 2; n <= 10; n++) assert.equal(text(p, n), '');
});

test('chests searched in rooms 1, 1 and 5 show by room; a second search of one chest counts once', (t) => {
  const p = realPlayer(t);
  searchChest(p, 1);
  searchChest(p, 1); // the same chest again this visit: "already looted", not counted
  visit(p, 1);
  searchChest(p, 1); // a later visit to room 1
  searchChest(p, 5);
  click(p);
  assert.equal(text(p, 1), 'Grand Gold Chests pillaged:');
  assert.deepEqual([2, 3, 4, 5, 6, 7, 8, 9].map((n) => text(p, n)),
    ['Room 1: 2', 'Room 2: 0', 'Room 3: 0', 'Room 4: 0', 'Room 5: 1', 'Room 6: 0', 'Room 7: 0', 'Room 8: 0']);
  assert.equal(text(p, 10), '');
});

test('a swarm from the chest still counts its pillaging', (t) => {
  const p = realPlayer(t);
  searchChest(p, 2, { roll: 0.999 }); // past the no-swarm chance even at 99 Thieving
  assert.ok(p.sent.messages.includes(C.MESSAGES.swarm), 'the swarm came out');
  click(p);
  assert.equal(text(p, 3), 'Room 2: 1');
});

test('a click while the last search is still going is ignored, and not counted', (t) => {
  const p = realPlayer(t);
  searchChest(p, 3);
  visit(p, 3).busyUntil = C.getCore().World.getProcessCycle() + 3; // the search's 3 ticks still running
  searchChest(p, 3, { idle: false });
  click(p);
  assert.equal(text(p, 4), 'Room 3: 1');
});

// A JSON round trip of the attribute, as the save stores it; not the real PlayerSave.
test('the counts are a saved attribute starting empty, and come back from their JSON', (t) => {
  assert.deepEqual(hooks.persisted.get(M.CHESTS_ATTRIBUTE), []);
  const p = realPlayer(t);
  M.chestPillaged(p, 8);
  M.chestPillaged(p, 8);
  const saved = JSON.parse(JSON.stringify(p.getAttribute(M.CHESTS_ATTRIBUTE)));
  const q = realPlayer(t);
  q.setAttribute(M.CHESTS_ATTRIBUTE, saved); // as a login restores it
  click(q);
  assert.equal(text(q, 9), 'Room 8: 2');
  assert.equal(text(q, 2), 'Room 1: 0');
});

test('counts are each player\'s own, and odd saved values read as 0', (t) => {
  const p = realPlayer(t);
  const q = realPlayer(t);
  M.chestPillaged(p, 3);
  q.setAttribute(M.CHESTS_ATTRIBUTE, ['x', -2, null]);
  M.chestPillaged(q, 0); // not a room
  M.chestPillaged(q, 9);
  click(q);
  assert.equal(text(q, 1), 'At the time of writing, no pillaging has taken place here.');
  click(p);
  assert.equal(text(p, 4), 'Room 3: 1');
});

test('reading twice sends the scroll twice and counts nothing; another loc is not ours', (t) => {
  const p = realPlayer(t);
  click(p);
  click(p);
  assert.deepEqual(p.sent.interfaces, [INTERFACE, INTERFACE]);
  assert.deepEqual(M.chestsOf(p), [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(click(p, C.getCore().CacheDefinitions.getLocId('ntk_golden_chest_multi')), false);
});

test('the cache places the mural in the four starting areas, each with an open tile beside it', () => {
  const { RegionManager } = require('../dist/game/collision/RegionManager');
  const { MapObjects } = require('../dist/game/entity/impl/object/MapObjects');
  const { Location } = require('../dist/game/model/Location');
  const { PathFinder } = require('../dist/game/model/movement/path/PathFinder');
  RegionManager.init();
  for (const [x, y, z] of [[1938, 4465, 2], [1972, 4435, 2], [1938, 4435, 3], [1972, 4465, 3]]) {
    const mural = MapObjects.get(MURAL, new Location(x, y, z), null);
    assert.ok(mural, `${x},${y},${z}`);
    let reachable = 0;
    for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 3; dy++) {
      const tile = { getLocation: () => new Location(x + dx, y + dy, z), getSize: () => 1, getPrivateArea: () => null };
      if (RegionManager.getClipping(x + dx, y + dy, z, null) === 0
        && PathFinder.reachedObject(tile, x, y, 1, 2, mural.getFace(), mural.getType(), 0)) reachable++;
    }
    assert.ok(reachable > 0, `an open tile reaches the mural at ${x},${y},${z}`);
  }
});
