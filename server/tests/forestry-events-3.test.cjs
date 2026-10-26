// Run after `yarn build`: node --test tests/forestry-events-3.test.cjs
//
// Forestry's Flowering Bush, Entlings and Beehive against the rsprox recordings (and the Wiki
// for rewards).
const assert = require('node:assert/strict');
const { test, before, beforeEach } = require('node:test');

const { Server } = require('../dist/Server');
Server.installProductionPathResolver();

const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { RegionManager } = require('../dist/game/collision/RegionManager');
const { PluginManager } = require('../dist/plugins/PluginManager');
const { TaskManager } = require('../dist/game/task/TaskManager');
const { Location } = require('../dist/game/model/Location');

let Spawns, Flowering, Entlings, Beehive, hooks, core;

before(() => {
  CachePipeline.initialize();
  RegionManager.init();
  core = PluginManager.getCoreApi();
  hooks = { npcs: new Map(), prompts: [] };
  const api = {
    core,
    persistAttribute() {},
    onObjectInteraction() {},
    onNpcInteraction: (name, actions) => {
      if (typeof name === 'function') (hooks.anyNpc ??= []).push(name);
      else for (const [op, fn] of Object.entries(actions)) hooks.npcs.set(`${name}:${op}`, fn);
    },
    onCustomEvent() {},
    onPlayerLogout: (fn) => { (hooks.logout ??= []).push(fn); },
    onPlayerLogin() {},
    emitCustomEvent() {},
    sendMultiChatboxPrompt: (player, title, ...args) => hooks.prompts.push({ title, args }),
  };
  const Woodcutting = require('../plugins/skills/Woodcutting.plugin');
  Woodcutting.isWoodcuttingActive = () => false;
  Woodcutting.stopWoodcutting = () => {};
  require('../plugins/minigames/Forestry.plugin').register(api);
  require('../plugins/minigames/ForestryMembers.plugin').register(api);
  Spawns = require('../plugins/minigames/forestry/Spawns.Forestry');
  Flowering = require('../plugins/minigames/forestry/Flowering.Forestry');
  Entlings = require('../plugins/minigames/forestry/Entlings.Forestry');
  Beehive = require('../plugins/minigames/forestry/Beehive.Forestry');
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

// ------------------------------------------------------------------ flowering bush

const NAMES = ['Lilac', 'Pink', 'Red', 'Orange', 'Yellow', 'White', 'Green', 'Blue'];
function tend(player, bush) {
  return hooks.npcs.get(`<col=00ffff>Flowering bush (${NAMES[bush.colour]})</col>:Tend-to`)({ player, npc: bush.npc });
}

test('flowering: eight bushes; none open until the first pair, then pollen back and forth for bark', () => {
  const p = fakePlayer({ level: 80 });
  const event = startEvent('flowering', [p]);
  assert.equal(event.bushes.length, 8);
  assert.deepEqual(event.bushes.map((b) => b.npc.getId()), [12120, 12134, 12141, 12143, 12145, 12147, 12149, 12151]);
  tend(p, event.bushes[0]);
  assert.deepEqual(lines(p.chats.at(-1)), ['The flowers on this bush have not yet opened enough to harvest<br>pollen.']);
  ticks(18);
  const [a, b] = event.pair.bushes;
  tend(p, a);
  assert.equal(p.messages.at(-1), '<col=3366ff>Bees are very active on this bush and there are pollen-rich flowers.</col> You carefully collect some Strange pollen.');
  assert.equal(p.inventory.getAmount(28192), 1);
  ticks(3);
  tend(p, a);
  assert.equal(p.messages.at(-1), 'You took the pollen from this bush and should apply it to a bush with unpollinated flowers.');
  const other = event.bushes.find((x) => x !== a && x !== b);
  ticks(3);
  tend(p, other);
  assert.equal(p.messages.at(-1), 'There are no open, unpollinated flowers on this bush yet.');
  ticks(3);
  tend(p, b);
  assert.equal(p.messages.at(-1), '<col=3366ff>Bees are very active on this bush and there are unpollinated flowers.</col> You carefully apply your pollen with the help of your bee then extract some from the bush.');
  const after = bark(p);
  assert.ok(after >= 1 && after <= 2);
  tend(p, a);
  assert.equal(bark(p), after, 'too soon: still busy');
  ticks(3);
  tend(p, a);
  assert.ok(bark(p) > after, 'and back again');
  assert.equal(p.messages.filter((m) => m.includes('unpollinated flowers.</col>')).length, 1, 'the long line once');
  assert.equal(Math.round(xp(p, 'Woodcutting') * 10), Math.round(2 * (0.2 * 80 + 2.8) * 10));
});

test('a pollinated pair fruits when it closes; the end at 300 with the lump, fruit and pollen discarded', () => {
  const p = fakePlayer();
  const event = startEvent('flowering', [p]);
  ticks(18);
  const [a, b] = event.pair.bushes;
  tend(p, a);
  ticks(3);
  tend(p, b);
  ticks(66);
  assert.equal(b.fruited, true);
  assert.equal(a.finished, true);
  assert.equal(p.messages.at(-1), '<col=229628>A bush has started producing fruit, well done!</col>');
  ticks(3);
  hooks.npcs.get(`<col=00ffff>Strange bush (${NAMES[b.colour]})</col>:Tend-to`)({ player: p, npc: b.npc });
  assert.equal(p.messages.at(-1), "<col=229628>The bush is already fruiting and won't benefit from any more pollen.</col>");
  ticks(3);
  tend(p, a);
  assert.equal(p.messages.at(-1), 'This bush has finished flowering and has no pollen to harvest.');
  const before = bark(p);
  ticks(300 - 93);
  assert.equal(Flowering.events.has(event), false);
  assert.ok(p.messages.includes("<col=229628>The bushes become dormant and the bees move on. You've helped make the forest a more diverse and beautiful place!</col>"));
  assert.ok(p.messages.includes('You discard your left over pollen.'));
  assert.equal(p.inventory.getAmount(28192), 0);
  ticks(1);
  assert.ok(bark(p) > before, 'the lump');
  assert.ok(p.inventory.getAmount(464) >= 1 && p.inventory.getAmount(464) <= 8, 'strange fruit');
});

// ------------------------------------------------------------------ entlings

function prune(player, entling, op) {
  player.location = entling.npc.getLocation().clone();
  return hooks.npcs.get(`Entling:${op}`)({ player, npc: entling.npc });
}

test('entlings: five with requests; the right cut prunes for bark, the wrong one stuns', () => {
  const p = fakePlayer({ level: 60 });
  const event = startEvent('entlings', [p]);
  assert.equal(event.entlings.length, 5);
  const entling = event.entlings[0];
  entling.say = 'Short on top!';
  entling.needs = { top: 2 };
  prune(p, entling, 'Prune-back');
  assert.deepEqual(lines(p.chats.at(-1)), ["Woah, that's not the cut I asked for!"]);
  assert.deepEqual(p.anims.slice(-1), [848]);
  assert.deepEqual(p.graphics, [254]);
  p.unstun();
  ticks(2);
  prune(p, entling, 'Prune-top');
  assert.equal(p.spam.at(-2), 'You prune the entling.');
  assert.ok(bark(p) >= 4 && bark(p) <= 5);
  assert.equal(xp(p, 'Woodcutting'), 30);
  assert.equal(Math.round(xp(p, 'Fletching')), 12);
  prune(p, entling, 'Prune-top');
  assert.equal(entling.pruned, false, 'busy: the second click too soon');
  ticks(2);
  prune(p, entling, 'Prune-top');
  assert.equal(entling.pruned, true);
  assert.equal(entling.npc.getId(), 12544, 'the pruned form');
  p.unstun();
  ticks(2);
  hooks.npcs.get('Pruned Entling:Prune-top')({ player: p, npc: entling.npc });
  assert.deepEqual(lines(p.chats.at(-1)), ['Hey, my cut is perfect, leave it alone!']);
});

test("Prune's menu, then the end: haircuts, bark, leaves and XP for each pruned entling", () => {
  const p = fakePlayer({ level: 50 });
  const event = startEvent('entlings', [p]);
  for (const entling of event.entlings.slice(0, 2)) entling.needs = { back: 1, sides: 1 };
  const [first, second] = event.entlings;
  p.location = first.npc.getLocation().clone();
  hooks.npcs.get('Entling:Prune')({ player: p, npc: first.npc });
  const menu = hooks.prompts.at(-1);
  assert.equal(menu.title, 'Which area of the entling would you like to prune?');
  assert.deepEqual(menu.args.filter((x) => typeof x === 'string'), ['Top', 'Back', 'Sides', 'Cancel']);
  menu.args[3]();
  for (const [entling, op] of [[first, 'Prune-sides'], [second, 'Prune-back'], [second, 'Prune-sides']]) {
    ticks(2);
    prune(p, entling, op);
  }
  assert.equal(first.pruned && second.pruned, true);
  ticks(194);
  assert.equal(Entlings.events.has(event), false);
  assert.ok(p.messages.includes("<col=3366ff>Well done, you've given 2 entlings haircuts! The entlings have left you a gift...</col>"));
  assert.ok(p.messages.includes("You've been awarded <col=3366ff>50 Anima-infused bark</col>."));
  assert.equal(p.inventory.getAmount(6024), 8, '4 willow leaves an entling');
});

// ------------------------------------------------------------------ beehive

const buildOn = (player, event) => hooks.npcs.get('<col=00ffff>Unfinished Beehive</col>:Build')({ player, npc: event.box.npc });

test('the beehive: Build adds a log every two ticks; five logs make a hive, its lump and a new box', () => {
  const p = fakePlayer({ level: 70 });
  p.inventory.add(new core.Item(1513, 6));
  const event = startEvent('beehive', [p]);
  assert.equal(event.keeper.getId(), 12514);
  assert.equal(event.needed, 5);
  const first = event.box;
  buildOn(p, event);
  ticks(1);
  assert.equal(first.logs, 1);
  assert.equal(p.anims.at(-1), 827);
  assert.ok(bark(p) >= 5 && bark(p) <= 6, 'magic logs: the better tier');
  assert.equal(xp(p, 'Construction'), 28);
  ticks(8);
  assert.equal(first.done, true);
  assert.equal(p.inventory.getAmount(1513), 1);
  assert.ok(p.messages.includes("<col=3366ff>Well done, you've completed a beehive. The bees can now be safely rehomed.</col>"));
  assert.notEqual(event.box, first, 'a new box');
  const before = bark(p);
  ticks(1);
  assert.ok(bark(p) - before >= 25 && bark(p) - before <= 30, 'the hive lump');
});

test('clicking Build every tick adds no faster than one log every two ticks', () => {
  const p = fakePlayer();
  p.inventory.add(new core.Item(1513, 6));
  const event = startEvent('beehive', [p]);
  const box = event.box;
  for (let i = 0; i < 5; i++) {
    buildOn(p, event);
    ticks(1);
  }
  assert.equal(box.logs, 3, 'ticks 1, 3 and 5');
  assert.equal(box.done, false);
});

test('no logs: refused; at 250 the keeper leaves', () => {
  const p = fakePlayer();
  const event = startEvent('beehive', [p]);
  buildOn(p, event);
  assert.equal(p.messages.at(-1), "You don't have any logs to add to the beehive.");
  ticks(250);
  assert.equal(Beehive.events.has(event), false);
  assert.equal(Spawns.active.has(event), false);
});

// ------------------------------------------------------------------ review fixes

test("flowering: the last pair closes before the end, so its exchanges count", () => {
  const p = fakePlayer();
  const event = startEvent('flowering', [p]);
  ticks(18 + 66 * 3);
  const [a, b] = event.pair.bushes;
  tend(p, a);
  ticks(3);
  tend(p, b);
  ticks(300 - 18 - 66 * 3 - 3);
  assert.equal(Flowering.events.has(event), false);
  assert.equal(b.fruited, true);
  ticks(1);
  assert.ok(p.inventory.getAmount(464) >= 1, 'the lump came');
});

test("logging out with pollen drops it", () => {
  const p = fakePlayer();
  const event = startEvent('flowering', [p]);
  ticks(18);
  tend(p, event.pair.bushes[0]);
  for (const fn of hooks.logout) fn({ player: p });
  assert.equal(p.inventory.getAmount(28192), 0);
});

test("a new beehive goes where the last stood when there's no room; clicking elsewhere stops building", () => {
  const p = fakePlayer();
  p.inventory.add(new core.Item(1513, 12));
  const event = startEvent('beehive', [p]);
  const Common = require('../plugins/minigames/forestry/Common.Forestry');
  const freeTiles = Common.freeTiles;
  const first = event.box;
  buildOn(p, event);
  Common.freeTiles = () => [];
  ticks(9);
  Common.freeTiles = freeTiles;
  assert.equal(first.done, true);
  assert.notEqual(event.box, first);
  assert.ok(event.box.npc.getLocation().equals(first.npc.getLocation()));
  buildOn(p, event);
  ticks(2);
  assert.equal(event.box.logs, 1);
  for (const fn of hooks.anyNpc) fn({ player: p, npc: event.keeper });
  ticks(4);
  assert.equal(event.box.logs, 1, 'stopped');
});
