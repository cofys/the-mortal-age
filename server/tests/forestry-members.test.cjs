// Run after `yarn build`: node --test tests/forestry-members.test.cjs
//
// Forestry's members events against the rsprox recordings (and the Wiki for rewards): Pheasant
// Control, Poachers and the Enchantment Ritual.
const assert = require('node:assert/strict');
const { test, before, beforeEach } = require('node:test');

const { Server } = require('../dist/Server');
Server.installProductionPathResolver();

const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { RegionManager } = require('../dist/game/collision/RegionManager');
const { PluginManager } = require('../dist/plugins/PluginManager');
const { TaskManager } = require('../dist/game/task/TaskManager');
const { Location } = require('../dist/game/model/Location');

let Spawns, Pheasant, Poachers, Ritual, hooks, core;

before(() => {
  CachePipeline.initialize();
  RegionManager.init();
  core = PluginManager.getCoreApi();
  hooks = { objects: new Map(), npcs: new Map(), prompts: [] };
  const api = {
    core,
    persistAttribute() {},
    onObjectInteraction: (name, actions) => { if (typeof name !== 'function') for (const [op, fn] of Object.entries(actions)) hooks.objects.set(`${name}:${op}`, fn); },
    onNpcInteraction: (name, actions) => { if (typeof name !== 'function') for (const [op, fn] of Object.entries(actions)) hooks.npcs.set(`${name}:${op}`, fn); },
    onCustomEvent() {},
    onPlayerLogout() {},
    onPlayerLogin() {},
    emitCustomEvent() {},
    sendMultiChatboxPrompt: (player, title, ...args) => hooks.prompts.push(args),
  };
  const Woodcutting = require('../plugins/skills/Woodcutting.plugin');
  Woodcutting.isWoodcuttingActive = () => false;
  Woodcutting.stopWoodcutting = () => {};
  require('../plugins/minigames/Forestry.plugin').register(api);
  require('../plugins/minigames/ForestryMembers.plugin').register(api);
  Spawns = require('../plugins/minigames/forestry/Spawns.Forestry');
  Pheasant = require('../plugins/minigames/forestry/Pheasant.Forestry');
  Poachers = require('../plugins/minigames/forestry/Poachers.Forestry');
  Ritual = require('../plugins/minigames/forestry/Ritual.Forestry');
});

let random;
beforeEach(() => {
  random = Math.random;
  ticks(260);
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

// ------------------------------------------------------------------ pheasant control

function retrieve(player, nest) {
  return hooks.objects.get('Pheasant Nest:Retrieve-egg')({ player, object: nest.object });
}

test('pheasants: the forester, three birds on four nests; an egg from the empty nest, one at a time', () => {
  const p = fakePlayer();
  const event = startEvent('pheasant', [p]);
  assert.equal(event.forester.getId(), 12536);
  assert.equal(event.nests.length, 4);
  assert.equal(event.pheasants.length, 3);
  assert.equal(event.nests.filter((n) => n.occupied).length, 3);
  const empty = event.nests.find((n) => !n.occupied);
  assert.equal(empty.object.getId(), 49937);
  Math.random = () => 0.9;
  retrieve(p, empty);
  Math.random = random;
  assert.equal(p.inventory.getAmount(28661), 1);
  assert.equal(p.spam.at(-1), 'You collect a pheasant egg.');
  retrieve(p, empty);
  assert.equal(p.messages.at(-1), 'You should hand in the egg you have before collecting another.');
});

test('the occupied nest attacks: eggs dropped, a 5-tick stun, then "stunned"', () => {
  const p = fakePlayer();
  const event = startEvent('pheasant', [p]);
  const occupied = event.nests.find((n) => n.occupied);
  retrieve(p, occupied);
  assert.equal(p.messages.at(-1), "The nest's inhabitant attacks you.");
  assert.deepEqual(p.anims.slice(-1), [397]);
  assert.deepEqual(p.graphics, [245]);
  ticks(1);
  assert.equal(p.messages.at(-1), "You've been stunned!");
  retrieve(p, event.nests.find((n) => !n.occupied));
  assert.equal(p.inventory.getAmount(28661), 0, 'nothing while stunned');
});

test('a pheasant flies to the empty nest every 8 or 12 ticks; reaching into it mid-flight is an attack', () => {
  const p = fakePlayer();
  const event = startEvent('pheasant', [p]);
  const empty = event.nests.find((n) => !n.occupied);
  ticks(8);
  assert.equal(empty.incoming, true, 'a pheasant is on its way');
  retrieve(p, empty);
  assert.equal(p.messages.at(-1), "The nest's inhabitant attacks you.");
  ticks(2);
  assert.equal(empty.occupied, true);
  assert.equal(event.nests.filter((n) => n.occupied).length, 3);
});

test('the hand-in pays bark and XP; ineligible pays 1 XP; the end at 200 ticks', () => {
  const p = fakePlayer({ level: 80 });
  const late = fakePlayer();
  const event = startEvent('pheasant', [p]);
  for (const player of [p, late]) {
    player.inventory.add(new core.Item(28661, 1));
    event.eggTakers.add(player);
    hooks.npcs.get('Freaky Forester:Talk-to')({ player, npc: event.forester });
    assert.deepEqual(lines(player.chats.at(-1)), ['I have an egg for you.']);
    assert.equal(player.inventory.getAmount(28661), 0);
  }
  assert.ok(bark(p) === 8 || bark(p) === 9);
  assert.ok(xp(p, 'Woodcutting') >= 80 && xp(p, 'Woodcutting') <= 96);
  assert.equal(xp(p, 'Thieving'), 40);
  assert.equal(bark(late), 0);
  assert.equal(xp(late, 'Woodcutting'), 1);

  hooks.npcs.get('Freaky Forester:Talk-to')({ player: p, npc: event.forester });
  assert.deepEqual(lines(p.chats.at(-1)), ["Hello, what's going on?", `Hey, ${p.getUsername()}, can you help me with some pheasants?`]);
  ticks(199);
  assert.equal(Pheasant.events.has(event), true);
  ticks(1);
  assert.equal(Pheasant.events.has(event), false);
  assert.equal(Spawns.active.has(event), false);
});

// ------------------------------------------------------------------ poachers

const disarm = (player, trap) => hooks.npcs.get('<col=00ffff>Fox trap</col>:Disarm')({ player, npc: trap.npc });

test('poachers set traps by the fox; Disarm takes 9 ticks and pays', () => {
  const p = fakePlayer({ level: 70 });
  const event = startEvent('poachers', [p]);
  assert.equal(event.fox.getId(), 12559);
  assert.deepEqual(event.poachers.map((n) => n.getId()), [12553, 12554, 12555]);
  ticks(14);
  assert.equal(event.traps.size, 1);
  const [trap] = event.traps;
  const fox = event.fox.getLocation();
  assert.ok(Math.max(Math.abs(trap.npc.getLocation().getX() - fox.getX()), Math.abs(trap.npc.getLocation().getY() - fox.getY())) <= 2);
  disarm(p, trap);
  assert.equal(p.spam.at(-1), 'You start disarming the trap...');
  assert.equal(p.anims.at(-1), 10551);
  ticks(8);
  assert.equal(event.traps.has(trap), true, "it doesn't spring while being disarmed");
  ticks(1);
  assert.equal(event.traps.has(trap), false);
  assert.equal(p.messages.at(-1), 'You successfully disarm the trap.');
  ticks(1);
  assert.equal(bark(p), 11);
  assert.equal(xp(p, 'Woodcutting'), 105);
  assert.equal(xp(p, 'Hunter'), 35);
});

test('left alone, three sprung traps lose the fox', () => {
  const p = fakePlayer();
  const event = startEvent('poachers', [p]);
  for (let i = 0; i < 200 && Poachers.events.has(event); i++) ticks(1);
  assert.equal(Poachers.events.has(event), false);
  assert.ok(event.foxHp <= 0, 'lost before the end');
  assert.equal(p.messages.at(-1), "<col=ff3045>Unfortunately you weren't able to save the fox from the poachers...</col>");
});

test('saving the fox: the gift and bonus for a disarmer who was there; none for a late one', () => {
  const p = fakePlayer({ level: 99 });
  const late = fakePlayer();
  const event = startEvent('poachers', [p]);
  let turn = 0;
  for (let i = 0; i < 200 && Poachers.events.has(event); i++) {
    for (const trap of event.traps) {
      if (!trap.disarming && ![...Poachers.sessions.keys()].some((pl) => Poachers.sessions.get(pl).event === event && pl === (turn % 2 ? late : p))) {
        disarm(turn++ % 2 ? late : p, trap);
      }
    }
    ticks(1);
  }
  assert.ok(event.foxHp > 0);
  assert.ok(p.messages.includes("<col=3366ff>Well done, you've saved the fox from the poachers! The fox has left you a gift...</col>"));
  assert.ok(p.messages.includes("You've been awarded <col=3366ff>160 Anima-infused bark</col>."));
  assert.ok(late.messages.includes("Well done, you've saved the fox from the poachers!"));
  assert.equal(bark(late), 0);
});

// ------------------------------------------------------------------ enchantment ritual

test('the circles: exactly one whose colour and shape are both unique', () => {
  for (let i = 0; i < 50; i++) {
    const { odd, others } = Ritual.pickCircles();
    const all = [odd, ...others];
    const unique = all.filter(([c, s]) => all.filter(([c2]) => c2 === c).length === 1 && all.filter(([, s2]) => s2 === s).length === 1);
    assert.deepEqual(unique, [odd]);
  }
});

test('the ritual: stand on the odd circle as the step closes; eight steps, then the gift', () => {
  const p = fakePlayer({ level: 80 });
  const event = startEvent('ritual', [p]);
  assert.equal(event.dryad.getId(), 12519);
  assert.equal(event.circles.length, 5);
  for (let step = 0; step < 8; step++) {
    ticks(20);
    p.location = event.odd.at.clone();
    ticks(7);
    assert.equal(event.steps.get(p), step + 1);
    ticks(3);
  }
  assert.equal(Ritual.events.has(event), false);
  assert.ok(p.messages.includes('<col=3366ff>Well done, you completed 8 steps of the ritual! The Dryad has left you a gift...</col>'));
  assert.ok(p.messages.includes("You've been awarded <col=3366ff>143 Anima-infused bark</col>."));
  assert.ok(bark(p) >= 143 + 8 * 20);
  assert.equal(Math.round(xp(p, 'Woodcutting')), 8 * (2 * 80 + 60) + (2 * 8 * 80 + 55));
});

test('off the odd circle, a step is missed', () => {
  const p = fakePlayer();
  const event = startEvent('ritual', [p]);
  const wrong = event.circles.find((c) => c !== event.odd);
  p.location = wrong.at.clone();
  ticks(27);
  assert.equal(event.steps.get(p) ?? 0, 0);
  assert.equal(bark(p), 0);
});

// ------------------------------------------------------------------ review fixes

test("switching traps mid-disarm frees the first to spring", () => {
  const p = fakePlayer();
  // Pinned rolls: a trap every 12 ticks, each living 13, so two stand at tick 24.
  Math.random = () => 0;
  const event = startEvent('poachers', [p]);
  ticks(24);
  Math.random = random;
  assert.equal(event.traps.size, 2);
  const [a, b] = event.traps;
  disarm(p, a);
  disarm(p, b);
  assert.equal(a.disarming, false);
  assert.equal(b.disarming, true);
  const other = fakePlayer();
  disarm(other, a);
  assert.equal(Poachers.sessions.get(other).trap, a, 'someone else can take it on');
});

test("an egg from another pheasant event isn't taken", () => {
  const p = fakePlayer();
  const event = startEvent('pheasant', [p]);
  p.inventory.add(new core.Item(28661, 1));
  hooks.npcs.get('Freaky Forester:Talk-to')({ player: p, npc: event.forester });
  assert.equal(p.inventory.getAmount(28661), 1, 'kept: not one of these nests');
  assert.equal(bark(p), 0);
});

test("a ritual that can't place its circles ends instead of wedging", () => {
  const p = fakePlayer();
  const event = startEvent('ritual', [p]);
  const Common = require('../plugins/minigames/forestry/Common.Forestry');
  const freeTiles = Common.freeTiles;
  Common.freeTiles = () => [];
  ticks(30);
  Common.freeTiles = freeTiles;
  assert.equal(Ritual.events.has(event), false);
  assert.equal(Spawns.active.has(event), false);
});
