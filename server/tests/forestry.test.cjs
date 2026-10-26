// Run after `yarn build`: node --test tests/forestry.test.cjs
//
// Forestry against the rsprox recordings (and the Wiki for spawns and rewards): when an event
// spawns and who it rewards, the Struggling Sapling and Rising Roots.
const assert = require('node:assert/strict');
const { test, before, beforeEach } = require('node:test');

const { Server } = require('../dist/Server');
Server.installProductionPathResolver();

const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { RegionManager } = require('../dist/game/collision/RegionManager');
const { PluginManager } = require('../dist/plugins/PluginManager');
const { TaskManager } = require('../dist/game/task/TaskManager');
const { Location } = require('../dist/game/model/Location');

let Common, Spawns, Sapling, Roots, Woodcutting, hooks, core;
const chopping = new Set();
const stopped = [];

before(() => {
  CachePipeline.initialize();
  RegionManager.init();
  core = PluginManager.getCoreApi();
  hooks = { objects: new Map(), events: new Map() };
  const api = {
    core,
    persistAttribute() {},
    onObjectInteraction: (name, actions) => { if (typeof name !== 'function') for (const [op, fn] of Object.entries(actions)) hooks.objects.set(`${name}:${op}`, fn); },
    onCustomEvent: (name, fn) => { (hooks.events.get(name) ?? hooks.events.set(name, []).get(name)).push(fn); },
    onPlayerLogout() {},
    onPlayerLogin: (fn) => { hooks.login = fn; },
    emitCustomEvent() {},
  };
  Woodcutting = require('../plugins/skills/Woodcutting.plugin');
  Woodcutting.isWoodcuttingActive = (player) => chopping.has(player);
  Woodcutting.stopWoodcutting = (player) => { chopping.delete(player); stopped.push(player); };
  Woodcutting.findBestUsableAxe = () => ({ id: 1359, tier: 5, animationId: 867 });
  require('../plugins/minigames/Forestry.plugin').register(api);
  Common = require('../plugins/minigames/forestry/Common.Forestry');
  Spawns = require('../plugins/minigames/forestry/Spawns.Forestry');
  Sapling = require('../plugins/minigames/forestry/Sapling.Forestry');
  Roots = require('../plugins/minigames/forestry/Roots.Forestry');
});

let random;
beforeEach(() => {
  random = Math.random;
  for (const event of [...Sapling.saplings]) Sapling.finish(event, false);
  for (const event of [...Spawns.active]) Spawns.active.delete(event);
  Spawns.choppers.clear();
  Spawns.heldTrees.clear();
  Spawns.readyAt.clear();
  Spawns.quiet.length = 0;
  chopping.clear();
  stopped.length = 0;
  ticks(20);
});

function container() {
  const slots = [];
  return {
    slots,
    add(item) { const slot = slots.find((s) => s.id === item.getId()); if (slot && item.getId() === 28134) slot.amount += item.getAmount(); else slots.push({ id: item.getId(), amount: item.getAmount() }); },
    adds(id, amount = 1) { this.add(new core.Item(id, amount)); },
    delete(id, amount = 1) { const slot = slots.find((s) => s.id === id && s.amount > 0); if (slot) slot.amount -= amount; },
    contains: (id) => slots.some((s) => s.id === id && s.amount > 0),
    getAmount: (id) => slots.filter((s) => s.id === id).reduce((sum, s) => sum + s.amount, 0),
    getFreeSlots: () => 20,
    getAddableAmount: (item) => item.getAmount(),
    full() {},
  };
}

let index = 0;
function fakePlayer({ at = new Location(3085, 3233, 0), level = 70, kit = true } = {}) {
  const attributes = new Map();
  const id = ++index;
  const p = {
    location: at, messages: [], spam: [], anims: [], xp: {}, boxes: [], inventory: container(),
    getIndex: () => id, getUsername: () => `Tester${id}`, isPlayer: () => true, isRegistered: () => true,
    getLocation: () => p.location,
    getAttribute: (k) => attributes.get(k), setAttribute: (k, v) => attributes.set(k, v),
    getInventory: () => p.inventory,
    sendMessage: (m) => p.messages.push(m),
    performAnimation: (a) => p.anims.push(a.getId()),
    setPositionToFace() {},
    getSkillManager: () => ({
      addExperience: (skill, amount) => { const n = String(skill.getName?.() ?? skill); p.xp[n] = (p.xp[n] ?? 0) + amount; },
      getCurrentLevel: () => level, getMaxLevel: () => level,
    }),
    getDialogueManager: () => ({ startDialogues: (chain) => p.boxes.push(chain), reset() {} }),
    getPacketSender() {
      const sender = {
        sendTypedMessage: (type, text) => { p.spam.push(text); return sender; },
        sendAreaSound: () => sender, sendGraphic: () => sender, sendObjectAnimation: () => sender,
      };
      return sender;
    },
  };
  if (kit) p.inventory.adds(28136, 1);
  return p;
}

function ticks(count) {
  for (let i = 0; i < count; i++) TaskManager.process();
}

/** A willow in Draynor (the recorded sapling site, 227/00083). */
const WILLOW = { id: 10833, x: 3083, y: 3237 };

function tree({ id, x, y } = WILLOW) {
  return new core.GameObject(id, new Location(x, y, 0), 10, 0, null);
}

/** The player starts chopping `object` and chops for `count` ticks. */
function chop(player, object, count) {
  for (const fn of hooks.events.get('woodcutting:validate-tree')) fn({ player, object, allow: true });
  chopping.add(player);
  ticks(count);
}

function log(player) {
  for (const fn of hooks.events.get('woodcutting:success')) fn({ player, logId: 1519 });
}

const bark = (p) => p.inventory.getAmount(28134);
const xp = (p, skill) => p.xp[skill] ?? p.xp[skill.toUpperCase()] ?? 0;

/** Starts an event of `kind` at the willow, with `players` taking part. */
function startEvent(kind, players) {
  const record = { object: tree(), location: new Location(WILLOW.x, WILLOW.y, 0), name: 'Willow tree', size: 2 };
  return Spawns.spawn(record, players, kind);
}

// ------------------------------------------------------------------ spawns

test('an event needs an eligible tree, a kit, enough chopping, and none nearby; it comes the tick after a log', () => {
  const p = fakePlayer({ kit: false });
  Math.random = () => 0;
  chop(p, tree(), 25);
  log(p);
  ticks(1);
  assert.equal(Spawns.active.size, 0, 'no kit');

  p.inventory.adds(28136, 1);
  log(p);
  assert.equal(Spawns.active.size, 1, 'the spot is taken at once');
  assert.equal(Sapling.saplings.size + Roots.events.size, 0, 'the event itself waits a tick');
  ticks(1);
  Math.random = random;
  assert.equal(Sapling.saplings.size + Roots.events.size, 1);
  assert.deepEqual(stopped, [p], 'the chopping stopped');

  const q = fakePlayer();
  chop(q, tree({ id: 10833, x: 3100, y: 3240 }), 250);
  log(q);
  ticks(1);
  assert.equal(Spawns.active.size, 1, 'none within 30 tiles of another');
});

test('a regular tree or too little chopping brings nothing', () => {
  const p = fakePlayer();
  Math.random = () => 0.999;
  chop(p, tree(), 5);
  log(p);
  ticks(1);
  assert.equal(Spawns.active.size, 0, 'not chopped long enough yet');
  Math.random = random;
  assert.equal(Spawns.eligibleTree('Tree'), false);
  assert.equal(Spawns.eligibleTree('Burnt tree'), false);
  assert.equal(Spawns.eligibleTree('Hollow tree'), false);
  assert.equal(Spawns.eligibleTree('Willow tree'), true);
});

test('a falling tree brings an event at once; then the buffer holds the next one off', () => {
  const p = fakePlayer();
  Math.random = () => 0.999;
  chop(p, tree(), 5);
  const falling = { player: p, object: tree(), handled: false };
  Spawns.treeFalling(falling);
  assert.equal(Spawns.active.size, 1, 'the fall brings one before the chopping time is up');
  ticks(1);
  Math.random = random;
  const [event] = [...Spawns.active];
  assert.equal(falling.handled, event.kind === 'sapling', "a sapling takes the stump's place");
  Math.random = () => 0.999;
  if (event.kind === 'sapling') Sapling.finish(event, false);
  else ticks(200);
  assert.equal(Spawns.active.size, 0);
  chop(p, tree(), 190);
  Math.random = random;
  Spawns.treeFalling({ player: p, object: tree(), handled: false });
  assert.equal(Spawns.active.size, 0, 'too soon after the last');
  ticks(15);
  Spawns.treeFalling({ player: p, object: tree(), handled: false });
  assert.equal(Spawns.active.size, 1, 'past the buffer');
});

test("a held tree doesn't fall while its sapling stands", () => {
  const p = fakePlayer();
  startEvent('sapling', [p]);
  const fell = { object: tree(), handled: false };
  Spawns.treeFalling(fell);
  assert.equal(fell.handled, true);
  const elsewhere = { object: tree({ id: 10833, x: 3200, y: 3200 }), handled: false };
  Spawns.treeFalling(elsewhere);
  assert.equal(elsewhere.handled, false);
});

// ------------------------------------------------------------------ the sapling

test("nutrition: 10, +30 a right slot, +10 a right ingredient in the wrong slot (every recorded value)", () => {
  assert.equal(Sapling.nutrition([0, 0, 4], [2, 3, 1]), 10);
  assert.equal(Sapling.nutrition([0, 0, 4], [4, 3, 1]), 20);
  assert.equal(Sapling.nutrition([0, 0, 4], [0, 3, 1]), 40);
  assert.equal(Sapling.nutrition([0, 0, 4], [0, 4, 1]), 50);
  assert.equal(Sapling.nutrition([0, 0, 4], [4, 0, 2]), 50);
  assert.equal(Sapling.nutrition([0, 0, 4], [4, 1, 0]), 30);
  assert.equal(Sapling.nutrition([0, 0, 4], [0, 4, 0]), 60);
  assert.equal(Sapling.nutrition([0, 0, 4], [0, 0, 1]), 70);
  assert.equal(Sapling.nutrition([0, 0, 4], [0, 0, 4]), 100);
});

function pileOf(event, ingredient) {
  return event.piles.find((pile) => pile.index === ingredient).object;
}

function collect(player, event, ingredient) {
  const object = pileOf(event, ingredient);
  const name = core.CacheDefinitions.getObject(object.getId()).name;
  return hooks.objects.get(`${name}:Collect`)({ player, object });
}

const addMulch = (player, event) => hooks.objects.get('Struggling sapling:Add-mulch')({ player, object: event.loc });

test('the sapling takes the tree, with its piles and meter; Collect builds the mulch as recorded', () => {
  const p = fakePlayer();
  const event = startEvent('sapling', [p]);
  assert.equal(event.loc.getId(), 47487, 'the 2x2 sapling');
  assert.equal(event.piles.length, 5);
  assert.equal(event.npc.getId(), 12165);
  for (const pile of event.piles) assert.ok(Common.distance(pile.object.getLocation(), event.loc.getLocation()) <= 5);

  addMulch(p, event);
  assert.equal(p.messages.at(-1), 'You need some mulch to add to the sapling.');
  collect(p, event, 2);
  assert.equal(p.spam.at(-1), 'You create some mulch using droppings as the first ingredient.');
  assert.equal(p.inventory.getAmount(28648), 1);
  addMulch(p, event);
  assert.equal(p.messages.at(-1), 'You think this mulch could do with some more ingredients first.');
  collect(p, event, 0);
  assert.equal(p.spam.at(-1), 'You add some rotting leaves to your mulch as the second ingredient.');
  collect(p, event, 4);
  assert.equal(p.spam.at(-1), 'You add some splintered bark to your mulch as the third ingredient.');
  assert.deepEqual([p.inventory.getAmount(28648), p.inventory.getAmount(28649), p.inventory.getAmount(28650)], [0, 0, 1]);
  collect(p, event, 1);
  assert.equal(p.messages.at(-1), "The mulch would be too sloppy to handle with any more ingredients. It's ready to add to the sapling.");
  assert.deepEqual(p.anims.slice(-3), [827, 827, 827]);
});

function feedWith(player, event, mulch) {
  for (const ingredient of mulch) collect(player, event, ingredient);
  addMulch(player, event);
}

test('feeding: the lines, the hint, the bark the next tick and the XP; a perfect mulch', () => {
  const p = fakePlayer({ level: 80 });
  const event = startEvent('sapling', [p]);
  event.recipe = [0, 0, 4];
  feedWith(p, event, [0, 3, 1]);
  assert.equal(p.spam.at(-1), 'You add the mulch to the sapling...');
  assert.deepEqual(p.messages.slice(-2), [
    'It seems to accept it. You estimate the nutritional value of the mulch to be <col=3366ff>40%</col>.',
    'The sapling seems to love <col=3366ff>rotting leaves</col> as the <col=3366ff>first ingredient</col>.',
  ]);
  assert.equal(event.progress, 24, 'the hitsplat is 0.6 x the nutrition');
  assert.equal(bark(p), 0, 'the bark comes the next tick');
  ticks(1);
  assert.ok(bark(p) >= 3 && bark(p) <= 4);
  assert.match(p.spam.at(-1), /^You've been awarded <col=3366ff>\d Anima-infused bark<\/col>\.$/);
  assert.ok(xp(p, 'Woodcutting') > 0 && xp(p, 'Farming') > 0);

  feedWith(p, event, [0, 4, 1]);
  assert.equal(p.messages.at(-2), 'It seems to like it. You estimate the nutritional value of the mulch to be <col=3366ff>50%</col>.');
  feedWith(p, event, [0, 0, 4]);
  assert.deepEqual(p.messages.slice(-2), ['It seems to love it!', 'The sapling seems to love this combination of ingredients!']);
  assert.equal(p.boxes.length, 1, 'the item box');
});

test('saved: the thriving sapling, then bark, leaves and bonus XP; the tree back 14 ticks on', () => {
  const p = fakePlayer({ level: 80 });
  const event = startEvent('sapling', [p]);
  event.recipe = [1, 2, 3];
  for (let i = 0; i < 15; i++) feedWith(p, event, [1, 2, 3]);
  assert.equal(Sapling.saplings.has(event), false);
  assert.equal(event.loc.getId(), 47489, 'the thriving sapling');
  assert.equal(p.messages.at(-1), "<col=3366ff>Well done, you've saved the sapling and allowed it to flourish! It appears to have a gift for you...</col>");
  assert.equal(Spawns.active.has(event), false);
  ticks(1);
  assert.ok(p.messages.some((m) => /^You've been awarded <col=3366ff>(1[89]\d|200) Anima-infused bark<\/col>\.$/.test(m)), 'the lump for 100%');
  assert.ok(p.messages.includes(`You've been awarded <col=3366ff>${p.inventory.getAmount(6024)}</col> piles of <col=3366ff>Willow leaves</col>.`));
  assert.ok(p.inventory.getAmount(6024) >= 15 && p.inventory.getAmount(6024) <= 20);
  const at = (id) => core.ObjectManager.objectsAt(new Location(WILLOW.x, WILLOW.y, 0)).some((o) => o.getId() === id);
  ticks(12);
  assert.equal(at(47489), true, 'still thriving 13 ticks on');
  const chopAttempt = { player: p, object: tree(), allow: true };
  Spawns.refuseHeldTree(chopAttempt);
  assert.equal(chopAttempt.allow, false, 'the tree under it is held until it is back');
  ticks(1);
  assert.equal(at(10833), true, 'the willow is back');
  assert.equal(at(47489), false);
  assert.equal(Spawns.heldTrees.size, 0, 'the tree is free again');
});

test('a sapling is harder with more players; a late joiner helps but gets nothing', () => {
  const [a, b, c] = [fakePlayer(), fakePlayer(), fakePlayer()];
  const event = startEvent('sapling', [a, b]);
  assert.equal(event.target, 1800);
  event.recipe = [1, 1, 1];
  feedWith(c, event, [1, 1, 1]);
  assert.equal(c.messages.filter((m) => /eligible/.test(m)).length, 1);
  assert.equal(c.messages.includes("<col=ff3045>As you weren't chopping near the event when it started, you aren't eligible for full rewards.</col>"), true);
  ticks(1);
  assert.equal(bark(c), 0);
  assert.equal(xp(c, 'Woodcutting'), 1);
  assert.equal(event.progress, 60, 'it still counts');
  feedWith(c, event, [1, 1, 1]);
  assert.equal(c.messages.filter((m) => /eligible/.test(m)).length, 1, 'told once');
});

test('not saved in 400 ticks: it withers', () => {
  const p = fakePlayer();
  const event = startEvent('sapling', [p]);
  ticks(399);
  assert.equal(Sapling.saplings.has(event), true);
  ticks(1);
  assert.equal(Sapling.saplings.has(event), false);
  assert.equal(p.messages.at(-1), '<col=ff3045>The sapling withers due to lack of nutrients.</col>');
});

// ------------------------------------------------------------------ rising roots

test('rising roots: six to start, a wave every 27 ticks with an anima root, over at 199', () => {
  const p = fakePlayer();
  const event = startEvent('roots', [p]);
  assert.equal(event.roots.size, 6);
  assert.ok([...event.roots].every((r) => r.kind === 'normal'));
  ticks(27);
  assert.ok(event.roots.size >= 2 && event.roots.size <= 4);
  assert.equal([...event.roots].filter((r) => r.kind === 'anima').length, 1);
  ticks(199 - 27);
  assert.equal(Roots.events.has(event), false);
  assert.equal(Spawns.active.has(event), false);
});

test('chopping a root: the swing line, a roll every 4 ticks, then the root goes with bark and XP', () => {
  const p = fakePlayer({ level: 70 });
  const event = startEvent('roots', [p]);
  const root = [...event.roots][0];
  Math.random = () => 0;
  hooks.objects.get('Tree roots:Chop down')({ player: p, object: root.object });
  assert.equal(p.spam.at(-1), 'You swing your axe at the roots.');
  ticks(3);
  assert.equal(event.roots.has(root), true);
  ticks(1);
  Math.random = random;
  assert.equal(event.roots.has(root), false);
  assert.ok(bark(p) >= 3 && bark(p) <= 4, 'normal root at 41+');
  assert.equal(Math.round(xp(p, 'Woodcutting')), Math.round(70 * 0.55));
});

test('a boosted Woodcutting level past 99 still pays the top band', () => {
  const p = fakePlayer({ level: 105 });
  const event = startEvent('roots', [p]);
  const root = [...event.roots][0];
  Math.random = () => 0;
  hooks.objects.get('Tree roots:Chop down')({ player: p, object: root.object });
  ticks(4);
  Math.random = random;
  assert.equal(event.roots.has(root), false);
  assert.equal(bark(p), 3, 'the 41+ band');
});

test('an anima root pays more; a late joiner gets 1 XP and no bark', () => {
  const p = fakePlayer({ level: 30 });
  const late = fakePlayer({ level: 30 });
  const event = startEvent('roots', [p]);
  ticks(27);
  const anima = [...event.roots].find((r) => r.kind === 'anima');
  const other = [...event.roots].find((r) => r.kind === 'normal');
  Math.random = () => 0;
  hooks.objects.get('Anima-infused Tree roots:Chop down')({ player: p, object: anima.object });
  hooks.objects.get('Tree roots:Chop down')({ player: late, object: other.object });
  ticks(4);
  Math.random = random;
  assert.ok(bark(p) >= 8 && bark(p) <= 10);
  assert.equal(bark(late), 0);
  assert.equal(xp(late, 'Woodcutting'), 1);
});

// ------------------------------------------------------------------ review fixes

test("the buffer after an event holds for everyone nearby, and survives a relog", () => {
  const p = fakePlayer();
  const other = fakePlayer();
  Math.random = () => 0.999;
  const event = startEvent('roots', [p]);
  for (let i = 0; i < 200; i++) ticks(1);
  assert.equal(Roots.events.has(event), false);
  chop(other, tree({ id: 10833, x: 3090, y: 3240 }), 5);
  Spawns.treeFalling({ player: other, object: tree({ id: 10833, x: 3090, y: 3240 }), handled: false });
  assert.equal(Spawns.active.size, 0, 'not a non-participant either');
  Spawns.choppers.delete(p);
  chop(p, tree({ id: 10833, x: 3200, y: 3300 }), 5);
  Spawns.treeFalling({ player: p, object: tree({ id: 10833, x: 3200, y: 3300 }), handled: false });
  Math.random = random;
  assert.equal(Spawns.active.size, 0, 'nor the participant, after a relog, far away');
});

test("chopping a root stops the woodcutting; starting on a tree stops the root", () => {
  const p = fakePlayer();
  const event = startEvent('roots', [p]);
  chopping.add(p);
  stopped.length = 0;
  const root = [...event.roots][0];
  hooks.objects.get('Tree roots:Chop down')({ player: p, object: root.object });
  assert.deepEqual(stopped, [p]);
  assert.equal(Roots.sessions.has(p), true);
  for (const fn of hooks.events.get('woodcutting:validate-tree')) fn({ player: p, object: tree({ id: 10833, x: 3200, y: 3300 }), allow: true });
  assert.equal(Roots.sessions.has(p), false);
});

test("mulch goes with the sapling even when its maker walked off, and at login if it's gone", () => {
  const p = fakePlayer();
  const event = startEvent('sapling', [p]);
  collect(p, event, 0);
  p.location = new Location(3200, 3300, 0);
  Sapling.finish(event, false);
  assert.equal(p.inventory.getAmount(28648), 0);
  assert.equal(p.getAttribute(Sapling.MULCH_ATTRIBUTE), null);

  p.inventory.adds(28650, 1);
  hooks.login({ player: p });
  assert.equal(p.inventory.getAmount(28650), 0, 'no sapling near: gone at login');
});
