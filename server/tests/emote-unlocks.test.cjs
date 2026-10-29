const assert = require('node:assert/strict'), path = require('node:path');
const {before, after, test} = require('node:test');
require('../dist/Server').Server.installProductionPathResolver();
const {CachePipeline} = require('../dist/game/cache/CachePipeline');
const {PluginManager: PM} = require('../dist/plugins/PluginManager');
const {Player} = require('../dist/game/entity/impl/player/Player');
const {PlayerSession} = require('../dist/net/PlayerSession');

// Emote tab locks (cache script 702) and the emotes:unlock store the random events use.
let core, PlayerSave, next = 1700;
const EMOTE_CONTENTS = (216 << 16) | 2;
before(async () => { await CachePipeline.initialize(path.resolve(__dirname, '..')); PM.loadFromDirectory(path.resolve(__dirname, '../plugins')); core = PM.getCoreApi(); ({PlayerSave} = require('../dist/game/entity/impl/player/persistence/PlayerSave')); PM.emitServerStartup({}); });
after(() => PM.emitServerShutdown({}));

function actor(t) {
  const channel = {kind: 'test', remoteAddress: '127.0.0.1', isOpen: () => true, send: () => true, close() {}, onData() {}, onError() {}, onClose() {}};
  const p = new Player(new PlayerSession(channel)); p.setIndex(next++); p.setUsername('emote' + next); p.setRegistered(true); p.setLocation(new core.Location(3222, 3218, 0));
  t.after(() => { PM.emitPlayerLogout({player: p, username: p.getUsername()}); p.setRegistered(false); });
  return p;
}
const varbit = (p, name) => p.getPacketSender().getVarbit(core.CacheDefinitions.getVarbitId(name));
function click(t, p, slot) {
  const said = [], played = [];
  t.mock.method(core.StatementDialogue, 'send', (_player, text) => said.push(text));
  t.mock.method(p, 'performAnimation', (animation) => played.push(animation.getId?.() ?? animation.id));
  PM.emitInterfaceActionClick({player: p, buttonId: EMOTE_CONTENTS, slot, action: 1, handled: false});
  t.mock.restoreAll();
  return {said, played};
}

test('an unlocked base emote plays; a locked one shows its message and plays nothing', (t) => {
  const p = actor(t);
  assert.equal(click(t, p, 0).played.length, 1, 'Yes has no lock');
  const glassBox = click(t, p, 24);
  assert.deepEqual(glassBox.played, []);
  assert.deepEqual(glassBox.said, ['This emote can be unlocked during the mime random event.']);
  assert.deepEqual(click(t, p, 22).said, ['This emote can be unlocked during the Lost Tribe quest.']);
});

test('emotes:unlock saves the varbit, sends it, and survives a save and login', (t) => {
  const p = actor(t);
  const request = {player: p, varbit: 'emote_glassbox', unlocked: false};
  PM.emitCustomEvent('emotes:unlock', request);
  assert.equal(request.unlocked, true);
  assert.equal(varbit(p, 'emote_glassbox'), 1);
  assert.deepEqual(click(t, p, 24).played, [1131]);

  const again = {player: p, varbit: 'emote_glassbox', unlocked: false};
  PM.emitCustomEvent('emotes:unlock', again);
  assert.equal(again.unlocked, false, 'already unlocked');
  const stranger = {player: p, varbit: 'slayer_points', unlocked: false};
  PM.emitCustomEvent('emotes:unlock', stranger);
  assert.equal(stranger.unlocked, false, 'only emote lock varbits are stored');
  assert.deepEqual(p.getAttribute('emotes:unlocked'), ['emote_glassbox']);

  const save = PlayerSave.fromPlayer(p);
  const q = actor(t);
  save.applyToPlayer(q);
  PM.emitPlayerLogin({player: q, username: q.getUsername(), isNewAccount: false});
  assert.equal(varbit(q, 'emote_glassbox'), 1);
  assert.deepEqual(click(t, q, 24).played, [1131]);
});

test('lock varbits that unlock several emotes, and the Lost Tribe stage threshold', (t) => {
  const p = actor(t);
  PM.emitCustomEvent('emotes:unlock', {player: p, varbit: 'emote_drilldemon'});
  for (const slot of [36, 37, 38, 39]) assert.equal(click(t, p, slot).played.length, 1, `Drill Demon slot ${slot}`);
  const stage = core.CacheDefinitions.getVarbitId('lost_tribe_quest');
  p.getPacketSender().sendVarbit(stage, 6);
  assert.equal(click(t, p, 22).played.length, 0);
  p.getPacketSender().sendVarbit(stage, 7);
  assert.equal(click(t, p, 22).played.length, 1);
});

test('Fortis Salute follows the best Glory the Colosseum sends on login', (t) => {
  const p = actor(t);
  p.setAttribute('colosseum:glory', 19999);
  PM.emitPlayerLogin({player: p, username: p.getUsername(), isNewAccount: false});
  assert.equal(click(t, p, 53).played.length, 0);
  const q = actor(t);
  q.setAttribute('colosseum:glory', 20000);
  PM.emitPlayerLogin({player: q, username: q.getUsername(), isNewAccount: false});
  assert.equal(q.getPacketSender().getVarp(core.CacheDefinitions.getVarpId('colosseum_glory')), 20000);
  assert.equal(click(t, q, 53).played.length, 1);
});

test('random events unlock their emotes one at a time, in the tab order', (t) => {
  const p = actor(t);
  const Rewards = require('../plugins/npcs/random-events/Rewards.RandomEvents');
  const zombie = ['emote_zombie_walk', 'emote_zombie_dance'];
  const api = {emitCustomEvent: (name, payload) => PM.emitCustomEvent(name, payload)};
  assert.equal(Rewards.unlockEmote(api, p, zombie), 'emote_zombie_walk');
  assert.equal(Rewards.unlockEmote(api, p, zombie), 'emote_zombie_dance');
  assert.equal(Rewards.unlockEmote(api, p, zombie), undefined, 'both unlocked: the lamp is next');
});
