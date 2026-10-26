// Run after `yarn build`: node --test tests/forestry-leprechaun.test.cjs
//
// Forestry's Woodcutting Leprechaun against the rsprox recordings (and the Wiki for the rest).
const assert = require('node:assert/strict');
const { test, before, beforeEach } = require('node:test');

const { Server } = require('../dist/Server');
Server.installProductionPathResolver();

const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { RegionManager } = require('../dist/game/collision/RegionManager');
const { PluginManager } = require('../dist/plugins/PluginManager');
const { TaskManager } = require('../dist/game/task/TaskManager');
const { Location } = require('../dist/game/model/Location');

let Spawns, Leprechaun, hooks, core;

before(() => {
  CachePipeline.initialize();
  RegionManager.init();
  core = PluginManager.getCoreApi();
  hooks = { npcs: new Map(), prompts: [], events: {}, emitted: [] };
  const api = {
    core,
    persistAttribute() {},
    onObjectInteraction() {},
    onNpcInteraction: (name, actions) => {
      if (typeof name === 'function') (hooks.anyNpc ??= []).push(name);
      else for (const [op, fn] of Object.entries(actions)) hooks.npcs.set(`${name}:${op}`, fn);
    },
    onCustomEvent: (name, fn) => { (hooks.events[name] ??= []).push(fn); },
    onPlayerLogout: (fn) => { (hooks.logout ??= []).push(fn); },
    onPlayerLogin() {},
    emitCustomEvent: (name, payload) => hooks.emitted.push([name, payload]),
    emitCanBank: () => true,
    sendMultiChatboxPrompt: (player, title, ...args) => hooks.prompts.push({ title, args }),
  };
  const Woodcutting = require('../plugins/skills/Woodcutting.plugin');
  Woodcutting.isWoodcuttingActive = () => false;
  Woodcutting.stopWoodcutting = () => {};
  require('../plugins/minigames/Forestry.plugin').register(api);
  require('../plugins/minigames/ForestryMembers.plugin').register(api);
  Spawns = require('../plugins/minigames/forestry/Spawns.Forestry');
  Leprechaun = require('../plugins/minigames/forestry/Leprechaun.Forestry');
});

beforeEach(() => {
  ticks(320);
  for (const event of [...Spawns.active]) Spawns.active.delete(event);
  Spawns.quiet.length = 0;
  hooks.prompts.length = 0;
});

function container() {
  const slots = [];
  return {
    slots,
    add(item) { const slot = slots.find((s) => s.id === item.getId()); if (slot) slot.amount += item.getAmount(); else slots.push({ id: item.getId(), amount: item.getAmount() }); },
    delete(id, amount = 1) { const slot = slots.find((s) => s.id === id && s.amount > 0); if (slot) slot.amount -= amount; },
    contains: (id) => slots.some((s) => s.id === id && s.amount > 0),
    getAmount: (id) => slots.filter((s) => s.id === id).reduce((sum, s) => sum + s.amount, 0),
    getFreeSlots: () => 20,
    getAddableAmount: (item) => item.getAmount(),
    full() {},
  };
}

let index = 0;
function fakePlayer({ at = new Location(3085, 3233, 0), level = 70 } = {}) {
  const id = ++index;
  const timers = new Map();
  const p = {
    location: at, messages: [], spam: [], anims: [], xp: {}, chats: [], graphics: [], inventory: container(),
    getIndex: () => id, getUsername: () => `Tester${id}`, isPlayer: () => true, isRegistered: () => true,
    getLocation: () => p.location,
    getAttribute: () => null, setAttribute() {},
    getInventory: () => p.inventory,
    sendMessage: (m) => p.messages.push(m),
    performAnimation: (a) => p.anims.push(a.getId()),
    performGraphic: (g) => p.graphics.push(g.getId()),
    setPositionToFace() {},
    getMovementQueue: () => ({ reset() {} }),
    getTimers: () => ({ registers: (key, ticks) => timers.set(key, ticks), has: (key) => (timers.get(key) ?? 0) > 0 }),
    unstun: () => timers.clear(),
    getSkillManager: () => ({
      addExperience: (skill, amount) => { const n = String(skill.getName?.() ?? skill); p.xp[n] = (p.xp[n] ?? 0) + amount; },
      getCurrentLevel: () => level, getMaxLevel: () => level,
    }),
    getDialogueManager: () => ({ startDialogues: (chain) => p.chats.push(chain), reset() {} }),
    getPacketSender() {
      const sender = {
        sendTypedMessage: (type, text) => { p.spam.push(text); return sender; },
        sendAreaSound: () => sender, sendGraphic: () => sender, sendObjectAnimation: () => sender,
        sendVarbit: (id, value) => { (p.varbits ??= new Map()).set(id, value); return sender; },
      };
      return sender;
    },
  };
  return p;
}

function ticks(count) {
  for (let i = 0; i < count; i++) TaskManager.process();
}

const WILLOW = { id: 10833, x: 3083, y: 3237 };
function startEvent(kind, players) {
  const object = new core.GameObject(WILLOW.id, new Location(WILLOW.x, WILLOW.y, 0), 10, 0, null);
  return Spawns.spawn({ object, location: object.getLocation().clone(), name: 'Willow tree', size: 2 }, players, kind);
}

const bark = (p) => p.inventory.getAmount(28134);
const xp = (p, skill) => p.xp[skill] ?? p.xp[skill.toUpperCase()] ?? 0;
const lines = (chain) => [...chain.dialogues.values()].map((d) => d.text).filter(Boolean);

function stand(player, event) {
  const bow = event.rainbows.at(-1);
  player.location = bow.at.clone();
  ticks(1);
  return bow;
}

function log(player) {
  for (const fn of hooks.events['woodcutting:success']) fn({ player, logId: 1519 });
}

test('the leprechaun on his clover; a rainbow every 37 ticks, fading 17-20 later', () => {
  const p = fakePlayer();
  const event = startEvent('leprechaun', [p]);
  assert.equal(event.npc.getId(), 12163);
  assert.equal(event.clover.getId(), 49935);
  ticks(1);
  assert.equal(event.rainbows.length, 1);
  assert.equal(event.rainbows[0].object.getId(), 49934);
  const d = Common().distance(event.rainbows[0].at, event.npc.getLocation());
  assert.ok(d >= 1 && d <= 9);
  ticks(20);
  assert.equal(event.rainbows.length, 0, 'gone within 20 ticks');
  ticks(17);
  assert.equal(event.rainbows.length, 1, 'the next 37 ticks on');
  assert.equal(event.made, 2);
});

function Common() {
  return require('../plugins/minigames/forestry/Common.Forestry');
}

test('standing in a rainbow: the line and 12 luck, once; each log spends 5 on 22-23 bark', () => {
  const p = fakePlayer({ level: 80 });
  const event = startEvent('leprechaun', [p]);
  Spawns.choppers.set(p, { name: 'Willow tree', location: new Location(3083, 3237, 0) });
  ticks(1);
  stand(p, event);
  assert.equal(p.messages.at(-1), 'You feel more in touch with the trees after standing in the rainbow.');
  assert.equal(Leprechaun.luckOf(p), 13);
  assert.equal(p.varbits.get(15344), 13);
  ticks(1);
  assert.equal(p.messages.filter((m) => m.includes('rainbow')).length, 1, 'once a rainbow');
  log(p);
  assert.equal(p.spam.at(-2), "You use your leprechaun's luck to gather some Anima-infused bark.");
  assert.ok(bark(p) >= 22 && bark(p) <= 23);
  assert.equal(Math.round(xp(p, 'Woodcutting') * 100), Math.round((1.33 * 80 + 38.7) * 100));
  log(p);
  assert.equal(p.spam.at(-2), "You use the last of your leprechaun's luck to gather some Anima-infused bark.");
  assert.equal(Leprechaun.luckOf(p), 3);
  const before = bark(p);
  log(p);
  assert.equal(bark(p), before, 'not enough luck left');
});

test('a late joiner gets no luck; he leaves at 224 and the luck goes with him', () => {
  const p = fakePlayer();
  const late = fakePlayer();
  const event = startEvent('leprechaun', [p]);
  ticks(1);
  stand(late, event);
  assert.equal(Leprechaun.luckOf(late), 0);
  stand(p, event);
  ticks(222);
  assert.equal(Leprechaun.events.has(event), false);
  assert.equal(Leprechaun.luckOf(p), 0);
  assert.equal(p.varbits.get(15344), 0);
});

test('Deposit: the recorded menu; banking all for a chopper, the deposit box, nothing', () => {
  const p = fakePlayer();
  p.inventory.getItems = () => [new core.Item(1519, 1), new core.Item(1359, 1)];
  const deposited = [];
  const realDeposit = core.Bank.deposit;
  core.Bank.deposit = (player, id) => { deposited.push(id); player.inventory.add(new core.Item(id, -1)); };
  p.inventory.add(new core.Item(1519, 1));
  p.inventory.add(new core.Item(1359, 1));
  p.inventory.refreshItems = () => {};
  const event = startEvent('leprechaun', [p]);
  p.location = event.npc.getLocation().clone();
  hooks.npcs.get('Woodcutting Leprechaun:Deposit')({ player: p, npc: event.npc });
  const menu = hooks.prompts.at(-1);
  assert.equal(menu.title, 'Bank all the items in your inventory?');
  assert.deepEqual(menu.args.filter((x) => typeof x === 'string'), ['Yes, bank it all', 'Only bank woodcutting resources', "No, don't bank anything", 'Open my bank deposit box']);
  menu.args[3]();
  assert.deepEqual(deposited, [1519], 'resources only: the logs');
  menu.args[1]();
  assert.deepEqual(deposited, [1519, 1519, 1359], 'all of it');
  menu.args[7]();
  assert.deepEqual(hooks.emitted.at(-1)[0], 'bank:open-deposit-box');
  core.Bank.deposit = realDeposit;
  hooks.npcs.get('Woodcutting Leprechaun:Talk-to')({ player: p, npc: event.npc });
  assert.deepEqual(lines(p.chats.at(-1)), ["Grand job, what an obnoxious tree, spreading rumours 'bout other trees and sucking up all the water.", "As a reward, I'll let ye use me full banking services!"]);
});

test("luck from one leprechaun ends with him, even with another still out; no banking once he's gone", () => {
  const p = fakePlayer();
  const first = startEvent('leprechaun', [p]);
  ticks(1);
  stand(p, first);
  assert.equal(Leprechaun.luckOf(p), 13);
  hooks.npcs.get('Woodcutting Leprechaun:Deposit')({ player: p, npc: first.npc });
  const menu = hooks.prompts.at(-1);
  const object = new core.GameObject(10833, new Location(3200, 3300, 0), 10, 0, null);
  Spawns.quiet.length = 0;
  const second = Spawns.spawn({ object, location: object.getLocation().clone(), name: 'Willow tree', size: 2 }, [p], 'leprechaun');
  assert.ok(second);
  for (let i = 0; i < 230 && Leprechaun.events.has(first); i++) ticks(1);
  assert.equal(Leprechaun.events.has(first), false);
  assert.equal(Leprechaun.luckOf(p), 0, "the first one's luck is gone");
  const deposited = [];
  const realDeposit = core.Bank.deposit;
  core.Bank.deposit = (player, id) => deposited.push(id);
  p.inventory.getItems = () => [new core.Item(1519, 1)];
  menu.args[1]();
  core.Bank.deposit = realDeposit;
  assert.deepEqual(deposited, [], 'he has gone');
});
