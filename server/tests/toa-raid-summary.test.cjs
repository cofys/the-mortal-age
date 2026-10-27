// Run after `npx tsc --build`: node --test tests/toa-raid-summary.test.cjs
//
// The burial chamber's scoreboard (toa_vault_scoreboard) opening this raid's summary,
// toa_raid_summary, as rsprox 227/01852, 00581, 01753 and 01845 show it: the texts, the member
// rows (script 6590) and the scripts' order, from a real Raid with real Players (network stubbed).
const assert = require('node:assert/strict');
const { test, before } = require('node:test');

const { Server } = require('../dist/Server');
Server.installProductionPathResolver();

const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { PluginManager } = require('../dist/plugins/PluginManager');

const Raid = require('../plugins/minigames/toa/RaidState.TombsOfAmascut');
const { InvocationSettings } = require('../plugins/minigames/toa/Invocations.TombsOfAmascut');
const Summary = require('../plugins/minigames/toa/Summary.TombsOfAmascut');

const hooks = { objects: {} };
let INTERFACE, BOARD;
let index = 1;

before(() => {
  CachePipeline.initialize();
  const api = new Proxy({
    core: PluginManager.getCoreApi(),
    onObjectInteraction: (name, actions) => { if (typeof name === 'string') (hooks.objects[name] ??= []).push(actions); },
  }, { get: (target, key) => target[key] ?? (() => {}) });
  Summary(api);
  INTERFACE = api.core.CacheDefinitions.getInterfaceId('toa_raid_summary');
  BOARD = api.core.CacheDefinitions.getLocId('toa_vault_scoreboard');
});

function realPlayer(t, name) {
  const { Player } = require('../dist/game/entity/impl/player/Player');
  const p = new Player(null);
  p.setIndex(index++);
  p.setRegistered(true);
  p.setUsername(name);
  t.mock.method(p, 'getSession', () => ({ sendClientPacket: () => true, write: () => true }));
  const sender = p.getPacketSender();
  p.sent = [];
  const original = { sendInterface: sender.sendInterface, sendInterfaceScript: sender.sendInterfaceScript, sendString: sender.sendString };
  t.mock.method(sender, 'sendInterface', function (id) { p.sent.push(['interface', id]); return original.sendInterface.apply(this, arguments); });
  t.mock.method(sender, 'sendInterfaceScript', function (id, args) { p.sent.push(['script', id, args]); return original.sendInterfaceScript.apply(this, arguments); });
  t.mock.method(sender, 'sendString', function (text, uid) { p.sent.push(['text', uid & 0xffff, text]); return original.sendString.apply(this, arguments); });
  return p;
}

/** A real Raid for `players`, with `active` invocations on. */
function raidOf(players) {
  const settings = new InvocationSettings();
  const lobby = { settings, players, unlist() {}, raid: null };
  const raid = new Raid.Raid(lobby, players[0]);
  return raid;
}

function click(player, objectId) {
  for (const actions of hooks.objects.Scoreboard ?? []) {
    if (actions.Read?.({ player, objectId, option: 'read', clickType: 1, handled: false }) === true) return true;
  }
  return false;
}

const texts = (p) => new Map(p.sent.filter(([kind]) => kind === 'text').map(([, component, text]) => [component, text]));
const component = (name) => require('../dist/game/cache/CacheDefinitions').CacheDefinitions.getComponentId(`toa_raid_summary:${name}`) & 0xffff;

/** rsprox 227/01852's room times, in ticks: 2:14.40, 1:33.60, 2:58.20, 1:17.40, 5:09.00 (two phases), 0:57.00, 1:41.40, 0:39.00, 1:07.80. */
const RECORDED = [
  ['SCABARAS_PUZZLE', 95], ['SCABARAS_BOSS', 224], ['APMEKEN_PUZZLE', 169], ['APMEKEN_BOSS', 156],
  ['CRONDIS_PUZZLE', 65], ['CRONDIS_BOSS', 129], ['HET_PUZZLE', 113], ['HET_BOSS', 297],
  ['WARDENS_P1', 215], ['WARDENS_P3', 300],
];

test('Read opens the summary with the recorded times, totals, level and invocations', (t) => {
  const a = realPlayer(t, 'Alpha');
  const raid = raidOf([a]);
  raid.results = RECORDED.map(([key, ticks]) => ({ key, ticks }));
  raid.totalTicks = 2001; // 20:00.60
  raid.completedRaidLevel = 530;
  t.mock.getter(raid.settings, 'activeCount', () => 23);
  assert.equal(click(a, BOARD), true);
  assert.deepEqual(a.sent[0], ['script', 2524, [-1, -1]]);
  assert.deepEqual(a.sent[1], ['interface', INTERFACE]);
  const shown = texts(a);
  const expected = {
    overall_total: '20:00.60', challenge_total: '17:37.80', kephri_time: '2:14.40', baba_time: '1:33.60',
    akkha_time: '2:58.20', zebak_time: '1:17.40', wardens_time: '5:09.00', scabaras_time: '0:57.00',
    apmeken_time: '1:41.40', crondis_time: '0:39.00', het_time: '1:07.80', active: '23', raid_level: '530',
  };
  for (const [name, text] of Object.entries(expected)) assert.equal(shown.get(component(name)), text, name);
  // The texts in the recording's order, all before the member rows.
  const order = a.sent.filter(([kind]) => kind === 'text').map(([, id]) => id);
  assert.deepEqual(order, Object.keys(expected).map(component));
  const lastText = a.sent.findLastIndex(([kind]) => kind === 'text');
  const firstRow = a.sent.findIndex(([kind, id]) => kind === 'script' && id === 6590);
  assert.ok(firstRow > lastText, 'the 6590 rows follow the texts');
  raid.destroy?.();
  Raid.raids.delete(raid);
});

test('one 6590 row per member, most damage dealt first: dealt, taken, deaths, no title, rank, size, the reader', (t) => {
  const a = realPlayer(t, 'Alpha');
  const b = realPlayer(t, 'Bravo');
  const c = realPlayer(t, 'Charlie');
  const raid = raidOf([a, b, c]);
  // Party order is Alpha, Bravo, Charlie; the most damage is the second member's.
  Object.assign(raid.member(a), { damageDone: 11215.6, damageTaken: 648, deaths: 2 });
  Object.assign(raid.member(b), { damageDone: 19827, damageTaken: 648, deaths: 0 });
  Object.assign(raid.member(c), { damageDone: 2241, damageTaken: 879, deaths: 1 });
  click(a, BOARD);
  const rows = a.sent.filter(([kind, id]) => kind === 'script' && id === 6590).map(([, , args]) => args);
  assert.deepEqual(rows, [
    ['Bravo', 19827, 648, 0, -1, -1, 0, 3, 0],
    ['Alpha', 11215, 648, 2, -1, -1, 1, 3, 1],
    ['Charlie', 2241, 879, 1, -1, -1, 2, 3, 0],
  ]);
  Raid.raids.delete(raid);
});

test('rooms not done read "-", and a reader outside any raid is left alone', (t) => {
  const a = realPlayer(t, 'Alpha');
  const raid = raidOf([a]);
  click(a, BOARD);
  const shown = texts(a);
  assert.equal(shown.get(component('kephri_time')), '-');
  assert.equal(shown.get(component('overall_total')), '-');
  assert.equal(shown.get(component('challenge_total')), '-');
  Raid.raids.delete(raid);
  const outsider = realPlayer(t, 'Charlie');
  assert.equal(click(outsider, BOARD), false);
  assert.deepEqual(outsider.sent, []);
});

test('a raid over an hour reads h:mm:ss.cc', () => {
  assert.equal(Summary.formatTicks(6000), '1:00:00.00');
  assert.equal(Summary.formatTicks(6205), '1:02:03.00');
  assert.equal(Summary.formatTicks(2001), '20:00.60');
});

test('reading twice resends the same summary', (t) => {
  const a = realPlayer(t, 'Alpha');
  const raid = raidOf([a]);
  raid.results = [{ key: 'HET_BOSS', ticks: 100 }];
  click(a, BOARD);
  const first = a.sent.length;
  click(a, BOARD);
  assert.deepEqual(a.sent.slice(first), a.sent.slice(0, first));
  Raid.raids.delete(raid);
});

test("another board named Scoreboard is not claimed", (t) => {
  const a = realPlayer(t, 'Alpha');
  const raid = raidOf([a]);
  assert.equal(click(a, require('../dist/game/cache/CacheDefinitions').CacheDefinitions.getLocId('toa_scoreboard')), false);
  assert.deepEqual(a.sent, []);
  Raid.raids.delete(raid);
});

test('the board is in the burial chamber, as the cache places it', () => {
  const { RegionManager } = require('../dist/game/collision/RegionManager');
  const { MapObjects } = require('../dist/game/entity/impl/object/MapObjects');
  const { Location } = require('../dist/game/model/Location');
  RegionManager.init();
  const board = MapObjects.get(BOARD, new Location(3692, 5153, 0), null);
  assert.ok(board);
  assert.equal(board.getType(), 10);
  assert.equal(Summary.formatTicks(0), '-');
});
