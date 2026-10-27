// Run after `npx tsc --build`: node --test tests/tzhaar-ket-rak-scoreboard.test.cjs
//
// The scoreboard by TzHaar-Ket-Rak (jad_challenge_scoreboard, interface 35) against rsprox
// 227/00216: the clientscripts Read runs and the text it lays out, fed by the real completion and
// failure paths in Rewards.TzHaarKetRak.js, on a real Player with only the network stubbed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, before, beforeEach, after } = require('node:test');

const { Server } = require('../dist/Server');
Server.installProductionPathResolver();

const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { PluginManager } = require('../dist/plugins/PluginManager');

const Common = require('../plugins/minigames/tzhaarketrak/Common.TzHaarKetRak');
const Rewards = require('../plugins/minigames/tzhaarketrak/Rewards.TzHaarKetRak');
const Scoreboard = require('../plugins/minigames/tzhaarketrak/Scoreboard.TzHaarKetRak');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ket-rak-scoreboard-'));
const hooks = { objects: {}, persisted: new Map() };
let INTERFACE, BOARD;
let index = 1;

before(() => {
  CachePipeline.initialize();
  const api = new Proxy({
    core: PluginManager.getCoreApi(),
    persistAttribute: (key, value) => hooks.persisted.set(key, value),
    onObjectInteraction: (name, actions) => { (hooks.objects[name] ??= []).push(actions); },
    emitCustomEvent() {},
  }, { get: (target, key) => target[key] ?? (() => {}) });
  Common.init(api);
  Rewards.attach(api);
  Scoreboard.attach(api);
  INTERFACE = api.core.CacheDefinitions.getInterfaceId('jad_challenge_scoreboard');
  BOARD = api.core.CacheDefinitions.getLocId('jad_challenge_scoreboard');
});

after(() => fs.rmSync(scratch, { recursive: true, force: true }));

beforeEach(() => Scoreboard._useFile(path.join(scratch, `${Math.random()}.json`)));

/** A real Player with only the network stubbed; the interfaces and scripts it is sent are recorded. */
function realPlayer(t) {
  const { Player } = require('../dist/game/entity/impl/player/Player');
  const p = new Player(null);
  p.setIndex(index++);
  p.setRegistered(true);
  t.mock.method(p, 'getSession', () => ({ sendClientPacket: () => true, write: () => true }));
  const sender = p.getPacketSender();
  p.sent = [];
  const original = { sendInterface: sender.sendInterface, sendInterfaceScript: sender.sendInterfaceScript };
  t.mock.method(sender, 'sendInterface', function (id) { p.sent.push(['interface', id]); return original.sendInterface.apply(this, arguments); });
  t.mock.method(sender, 'sendInterfaceScript', function (id, args) { p.sent.push(['script', id, args]); return original.sendInterfaceScript.apply(this, arguments); });
  t.mock.method(p, 'sendMessage', () => {});
  return p;
}

function click(player, objectId) {
  for (const actions of hooks.objects.Scoreboard ?? []) {
    if (actions.Read?.({ player, objectId, option: 'read', clickType: 1, handled: false }) === true) return true;
  }
  return false;
}

/** The text jad_challenge_setup was given on the last Read. */
const boardText = (p) => p.sent.filter(([kind, id]) => kind === 'script' && id === Scoreboard.SCRIPT.SETUP).at(-1)?.[2]?.[0];
const block = (p, ordinal) => boardText(p).split('<br><br><br>').find((part) => part.startsWith(`TzHaar-Ket-Rak's ${ordinal} Challenge`));

/** A challenge as Challenge.TzHaarKetRak.js hands it to Rewards. */
function challenge(number, ticks, extra = {}) {
  return { number, kills: 0, startTick: 0, styles: new Map(), nonMelee: true, emptyInventory: false, elapsedTicks: () => ticks, ...extra };
}

test('Read runs toplevel_mainmodal_open, opens 35 and lays out the text, as rsprox 227/00216', (t) => {
  const p = realPlayer(t);
  assert.equal(click(p, BOARD), true);
  assert.deepEqual(p.sent.slice(0, 2), [['script', 2524, [-1, -1]], ['interface', INTERFACE]]);
  assert.equal(p.sent[2][1], 4023);
  assert.equal(block(p, 'First'),
    "TzHaar-Ket-Rak's First Challenge<br><br>Personal Completions: 0<br>Global Completions: 0<br><br>"
    + 'Personal Best Time: -<br>Global Best Time: -<br><br>Personal Deaths: 0<br>Global Deaths: 0');
  const parts = boardText(p).split('<br><br><br>');
  assert.equal(parts.length, 7, 'six challenges and the Infinite, no League-Only block');
  assert.equal(parts[6], "TzHaar-Ket-Rak's Infinite Challenge<br><br>Personal Best Kills: 0<br>Global Best Kills: 0<br><br>Personal Deaths: 0<br>Global Deaths: 0");
});

test('a completion through lastJadDown fills the personal and world lines, the faster time winning', (t) => {
  const p = realPlayer(t);
  Rewards.lastJadDown(p, challenge(1, 57)); // 0:34.20, the recording's best
  Rewards.lastJadDown(p, challenge(1, 80));
  click(p, BOARD);
  assert.equal(block(p, 'First'),
    "TzHaar-Ket-Rak's First Challenge<br><br>Personal Completions: 2<br>Global Completions: 2<br><br>"
    + 'Personal Best Time: 0:34.20<br>Global Best Time: 0:34.20<br><br>Personal Deaths: 0<br>Global Deaths: 0');
  assert.match(block(p, 'Second'), /Personal Completions: 0<br>Global Completions: 0/);
});

test('a death in a challenge counts through failed(died); leaving, logging out and a death in the fade in do not', (t) => {
  const p = realPlayer(t);
  Rewards.failed(p, challenge(4, 30), { died: true });
  Rewards.failed(p, challenge(4, 30), { died: true });
  Rewards.failed(p, challenge(4, 30), {}); // the cave exit
  Rewards.failed(p, challenge(4, 30), { logout: true });
  Rewards.failed(p, challenge(4, 0, { startTick: -1 }), { died: true }); // before the Jads arrive
  click(p, BOARD);
  assert.match(block(p, 'Fourth'), /Personal Deaths: 2<br>Global Deaths: 2$/);
  assert.match(block(p, 'Fourth'), /Personal Completions: 0/);
});

test("the world's lines are every player's; a reader's own lines stay theirs", (t) => {
  const a = realPlayer(t);
  const b = realPlayer(t);
  Rewards.lastJadDown(a, challenge(2, 200));
  Rewards.lastJadDown(b, challenge(2, 129)); // 1:17.40
  Rewards.failed(b, challenge(2, 10), { died: true });
  click(a, BOARD);
  assert.equal(block(a, 'Second'),
    "TzHaar-Ket-Rak's Second Challenge<br><br>Personal Completions: 1<br>Global Completions: 2<br><br>"
    + 'Personal Best Time: 2:00.00<br>Global Best Time: 1:17.40<br><br>Personal Deaths: 0<br>Global Deaths: 1');
});

test('deaths are a saved attribute, and the world records survive a restart', (t) => {
  assert.deepEqual(hooks.persisted.get(Scoreboard.DEATHS_ATTRIBUTE), {});
  const file = path.join(scratch, 'restart.json');
  Scoreboard._useFile(file);
  const p = realPlayer(t);
  Rewards.lastJadDown(p, challenge(6, 115)); // 1:09.00
  Rewards.failed(p, challenge(6, 50), { died: true });
  Scoreboard._useFile(file); // as a restart reads it again
  const q = realPlayer(t);
  click(q, BOARD);
  assert.equal(block(q, 'Sixth'),
    "TzHaar-Ket-Rak's Sixth Challenge<br><br>Personal Completions: 0<br>Global Completions: 1<br><br>"
    + 'Personal Best Time: -<br>Global Best Time: 1:09.00<br><br>Personal Deaths: 0<br>Global Deaths: 1');
  // The player's deaths come back from the save as the object the attribute holds.
  const restored = realPlayer(t);
  restored.setAttribute(Scoreboard.DEATHS_ATTRIBUTE, JSON.parse(JSON.stringify(p.getAttribute(Scoreboard.DEATHS_ATTRIBUTE))));
  click(restored, BOARD);
  assert.match(block(restored, 'Sixth'), /Personal Deaths: 1<br>/);
});

test('large counts read as the Wiki prints them', (t) => {
  const p = realPlayer(t);
  p.setAttribute(Common.completionsAttribute(3), 219896);
  click(p, BOARD);
  assert.match(block(p, 'Third'), /Personal Completions: 219,896/);
});

test('reading twice sends the board twice and counts nothing', (t) => {
  const p = realPlayer(t);
  click(p, BOARD);
  click(p, BOARD);
  assert.equal(p.sent.filter(([kind]) => kind === 'interface').length, 2);
  assert.match(block(p, 'First'), /Global Completions: 0/);
});

test("another boss's Scoreboard is left to its own handler", (t) => {
  const p = realPlayer(t);
  assert.equal(click(p, Common.core.CacheDefinitions.getLocId('araxxor_scoreboard_multi')), false);
  assert.deepEqual(p.sent, []);
});

test('the board stands where the cache places it, as an ordinary shape-10 loc', () => {
  const { RegionManager } = require('../dist/game/collision/RegionManager');
  const { MapObjects } = require('../dist/game/entity/impl/object/MapObjects');
  const { Location } = require('../dist/game/model/Location');
  RegionManager.init();
  const board = MapObjects.get(BOARD, new Location(2541, 5108, 0), null);
  assert.ok(board);
  assert.equal(board.getType(), 10);
});
