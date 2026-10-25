// From server/: node --test tests/balloon-transport.test.cjs (after yarn build).
//
// The balloon transport system against the OSRS Wiki (Balloon_transport_system, Enlightened
// Journey) and the assistants' transcripts: the map and its buttons, the quest gate, a trip's
// log, level, weight and pet checks, the Entrana search, opening routes from Entrana, the saved
// routes' varbits, and logging out or dying mid-flight.
const assert = require('node:assert/strict');
const path = require('node:path');
const { before, beforeEach, test } = require('node:test');
const { Server } = require('../dist/Server');
Server.installProductionPathResolver();
const { PluginManager } = require('../dist/plugins/PluginManager');
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const core = PluginManager.getCoreApi();

let Common, Travel, tasks, questDone, pets;

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, '..'));
  Common = require('../plugins/world/balloontransport/Common.BalloonTransport');
  Travel = require('../plugins/world/balloontransport/Travel.BalloonTransport');
  const api = new Proxy({
    core: {
      ...core,
      TaskManager: { submit: (task) => { task.setRunning(true); tasks.push(task); } },
      World: { getNpcs: () => pets },
    },
    emitCustomEvent(name, event) {
      if (name === 'quest:is-complete') event.complete = questDone;
    },
  }, { get: (target, key) => target[key] ?? (() => {}) });
  Common.init(api);
});

beforeEach(() => {
  tasks = [];
  questDone = true;
  pets = [];
});

const loc = (x, y) => new core.Location(x, y, 0);
const xy = (location) => [location.getX(), location.getY()];
const station = (key) => Common.data.stations.find((entry) => entry.key === key);

function fakePlayer({ at = [2808, 3354], firemaking = 99, items = {}, worn = {} } = {}) {
  let tile = loc(...at);
  const inventory = new Map(Object.entries(items).map(([k, v]) => [Common.ids.objs[k] ?? Number(k), v]));
  const equipment = Array.from({ length: 14 }, () => new core.Item(-1, 0));
  for (const [slot, id] of Object.entries(worn)) equipment[core.Equipment[slot]] = new core.Item(id, 1);
  const player = {
    attributes: {}, varbits: {}, messages: [], said: [], fades: [], interface: -1, blocked: false, registered: true, xp: 0,
    getLocation: () => tile,
    moveTo: (to) => { tile = to; },
    isRegistered: () => player.registered,
    isDyingReturn: () => player.dying === true,
    getHitpoints: () => 99,
    getAttribute: (k) => player.attributes[k],
    setAttribute: (k, v) => { player.attributes[k] = v; },
    sendMessage: (m) => player.messages.push(m),
    getSkillManager: () => ({
      getMaxLevel: () => firemaking,
      addExperience: (skill, amount) => { player.xp += amount; },
    }),
    getInventory: () => ({
      getAmount: (id) => inventory.get(id) ?? 0,
      delete: (id, n) => inventory.set(id, (inventory.get(id) ?? 0) - n),
      adds: (id, n) => inventory.set(id, (inventory.get(id) ?? 0) + n),
      getItems: () => [...inventory].filter(([, n]) => n > 0).map(([id, n]) => new core.Item(id, n)),
      refreshItems() {},
    }),
    inventory,
    getEquipment: () => ({ get: (slot) => equipment[slot], getItems: () => equipment }),
    getMovementQueue: () => ({ setBlockMovement(v) { player.blocked = v; return this; }, reset() { return this; } }),
    getDialogueManager: () => ({
      startDialogues: (chain) => {
        player.said.push(chain);
        player.lastChain = chain;
      },
    }),
    getPacketSender: () => ({
      sendInterfaceRemoval: () => { player.interface = -1; },
      sendInterface: (id) => { player.interface = id; },
      sendVarbit: (id, v) => { player.varbits[id] = v; },
      sendSubInterface: (uid, id, type, { postScripts } = {}) => player.fades.push(postScripts?.[0]?.args?.[1] === 255 ? 'out' : 'in'),
      closeSubInterface: () => player.fades.push('closed'),
    }),
  };
  return player;
}

function tick(n = 1) {
  for (let i = 0; i < n; i++) {
    const due = tasks;
    tasks = [];
    for (const task of due) if (task.tick()) tasks.push(task);
  }
}

/** The text of the last dialogue started for the player. */
function lastLine(player) {
  return player.lastChain?.getDialogues().get(0)?.getText() ?? null;
}

/** Runs the chain's follow-up action (the Entrana search's outcome). */
function continueChain(player) {
  player.lastChain.getDialogues().get(1)?.action?.execute();
}

const pick = (player, key) => {
  const childId = [...Common.ids.buttons].find(([, s]) => s.key === key)[0];
  const event = { player, groupId: Common.ids.map, childId, handled: false };
  Travel.chooseDestination(event);
  return event;
};

test('the map and its six buttons resolve from the cache; the logs too', () => {
  assert.equal(Common.ids.map, 469);
  const buttons = Object.fromEntries([...Common.ids.buttons].map(([child, s]) => [s.key, child]));
  assert.deepEqual(buttons, { castle: 13, gnome: 14, craft: 15, entrana: 16, taverley: 17, varrock: 18 });
  assert.deepEqual(Common.ids.objs, { logs: 1511, oak: 1521, willow: 1519, yew: 1515, magic: 1513 });
});

test('the map opens after Enlightened Journey only: Fly, Use on a basket, and the assistants\' "Yes."', () => {
  questDone = false;
  const before = fakePlayer();
  assert.equal(Travel.flyNpc({ player: before, npc: { getLocation: () => loc(2808, 3355), getId: () => 4715 } }), false);
  assert.equal(before.interface, -1, 'the quest keeps Auguste until then');
  questDone = true;
  const player = fakePlayer();
  Travel.flyNpc({ player, npc: { getLocation: () => loc(2808, 3355), getId: () => 4715 } });
  assert.equal(player.interface, 469);
  const basket = fakePlayer({ at: [2938, 3421] });
  assert.equal(Travel.useBasket({ player: basket, location: { x: 2939, y: 3421, z: 0 } }), true);
  assert.equal(basket.interface, 469);
  assert.equal(Travel.useBasket({ player: fakePlayer({ at: [3200, 3200] }), location: { x: 3200, y: 3200, z: 0 } }), false, 'not a station basket');
  const talk = fakePlayer({ at: [2938, 3421] });
  const action = { player: talk, npcId: 4723, action: 'open_interface', target: 'Balloon transport system', handled: false };
  Travel.onAction(action);
  assert.deepEqual([action.handled, action.end], [true, true]);
  tick();
  assert.equal(talk.interface, 469, 'the map opens as the talk closes');
  const other = { player: talk, action: 'open_interface', target: 'balloon construction diagram', handled: false };
  Travel.onAction(other);
  assert.equal(other.handled, false, "the quest's own interfaces are the quest's");
});

test('Entrana to Taverley: one log, the fade, Taverley 3 ticks later', () => {
  const player = fakePlayer({ items: { logs: 2 } });
  Travel.openMap(player, station('entrana'));
  pick(player, 'taverley');
  assert.equal(player.interface, -1);
  assert.equal(player.inventory.get(1511), 1, 'one log');
  assert.deepEqual(player.fades, ['out']);
  assert.equal(player.blocked, true);
  tick(3);
  assert.deepEqual(xy(player.getLocation()), [2938, 3421]);
  assert.deepEqual(player.fades, ['out', 'in']);
  assert.equal(player.blocked, false);
  tick(2);
  assert.deepEqual(player.fades, ['out', 'in', 'closed']);
});

test('a trip needs its log and its Firemaking level; the same station does nothing', () => {
  const player = fakePlayer({ at: [2938, 3421], items: { logs: 5 } });
  Common.openRoute(player, station('craft'));
  Travel.travel(player, station('taverley'), station('craft'));
  assert.equal(lastLine(player), 'You need 1 Oak logs to make this trip.');
  assert.equal(Travel.flying(player), false);
  const low = fakePlayer({ at: [2938, 3421], firemaking: 29, items: { oak: 1 } });
  Common.openRoute(low, station('craft'));
  Travel.travel(low, station('taverley'), station('craft'));
  assert.equal(lastLine(low), 'You need a Firemaking level of 30 to fly there.');
  assert.equal(Travel.travel(player, station('taverley'), station('taverley')), false);
});

test('to Entrana the player is searched: no weapons or armour worn', () => {
  const armed = fakePlayer({ at: [2938, 3421], items: { logs: 1 }, worn: { WEAPON_SLOT: core.ItemIdentifiers.ABYSSAL_WHIP } });
  Travel.travel(armed, station('taverley'), station('entrana'));
  assert.equal(lastLine(armed), 'Weapons are not allowed on Entrana. I must search you first.');
  continueChain(armed);
  assert.deepEqual(armed.messages, ['You are quickly searched.']);
  assert.equal(lastLine(armed), "I'm sorry, no weapons or armour may be worn to Entrana. Come back when you have laid them down.");
  assert.equal(Travel.flying(armed), false);
  assert.equal(armed.inventory.get(1511), 1, 'the log kept');

  const clean = fakePlayer({ at: [2938, 3421], items: { logs: 1 } });
  Travel.travel(clean, station('taverley'), station('entrana'));
  continueChain(clean);
  assert.equal(Travel.flying(clean), true);
  tick(3);
  assert.deepEqual(xy(clean.getLocation()), [2808, 3354]);
});

test('opening a route from Entrana: its 10 logs (3 magic), 2,000 Firemaking XP, saved and shown', () => {
  const player = fakePlayer({ items: { oak: 12 } });
  Travel.travel(player, station('entrana'), station('craft'));
  assert.equal(player.inventory.get(1521), 2, '10 oak logs');
  tick(3);
  assert.deepEqual(xy(player.getLocation()), [2923, 3301]);
  assert.equal(Common.opened(player, station('craft')), true);
  assert.equal(player.xp, 2000);
  assert.equal(player.varbits[2871], 1, "the Crafting Guild's basket and Brock shown");
  assert.deepEqual(player.messages, ['You open the balloon route to the Crafting Guild.']);
  // Opened: one log from then on, from anywhere opened.
  Travel.travel(player, station('craft'), station('entrana'));
  continueChain(player);
  tick(3);
  Travel.travel(player, station('entrana'), station('craft'));
  assert.equal(player.inventory.get(1521), 1);

  const gnome = fakePlayer({ items: { magic: 3 } });
  Travel.travel(gnome, station('entrana'), station('gnome'));
  assert.equal(gnome.inventory.get(1513), 0, '3 magic logs');
  tick(3);
  assert.deepEqual([gnome.varbits[2870], gnome.varbits[5032]], [1, 1], 'the Grand Tree basket and Le Smith');

  const short = fakePlayer({ items: { yew: 9 } });
  Travel.travel(short, station('entrana'), station('castle'));
  assert.equal(lastLine(short), 'You need 10 Yew logs to open this route.');
});

test('a route not yet opened is refused away from Entrana', () => {
  const player = fakePlayer({ at: [2938, 3421], items: { willow: 20 } });
  Travel.travel(player, station('taverley'), station('varrock'));
  assert.equal(lastLine(player), 'You need to fly from Entrana to open that route first.');
  assert.equal(player.inventory.get(1519), 20);
});

test('no more than 40kg, the log aside, and no pet out', () => {
  const heavy = fakePlayer({ items: { logs: 1, [core.ItemIdentifiers.IRON_ORE]: 20 } });
  heavy.getInventory = ((original) => () => ({ ...original(), getItems: () => [new core.Item(1511, 1), ...Array.from({ length: 20 }, () => new core.Item(core.ItemIdentifiers.RUNE_PLATEBODY, 1))] }))(heavy.getInventory);
  assert.ok(Travel.weightKg(heavy, station('taverley')) > 40);
  Travel.travel(heavy, station('entrana'), station('taverley'));
  assert.equal(lastLine(heavy), 'You have too much weight in your bag. You may only bring 40kg of weight.');

  const owner = fakePlayer({ items: { logs: 1 } });
  owner.attributes['pets:current'] = { isRegistered: () => true };
  Travel.travel(owner, station('entrana'), station('taverley'));
  assert.equal(lastLine(owner), 'You need to put your pet into your inventory before the flight.');
});

test('login sends the opened routes; logging out mid-flight lands the player; dying ends it', () => {
  const player = fakePlayer();
  player.attributes[Common.ROUTES_ATTRIBUTE] = station('varrock').bit | station('castle').bit;
  Travel.login({ player });
  assert.deepEqual([player.varbits[2869], player.varbits[2870], player.varbits[2871], player.varbits[2872], player.varbits[5032]], [1, 0, 0, 1, 0]);

  const leaving = fakePlayer({ items: { logs: 1 } });
  Travel.travel(leaving, station('entrana'), station('taverley'));
  Travel.logout({ player: leaving });
  assert.deepEqual(xy(leaving.getLocation()), [2938, 3421]);
  assert.equal(Travel.flying(leaving), false);
  assert.equal(leaving.blocked, false);

  const dying = fakePlayer({ items: { logs: 1 } });
  Travel.travel(dying, station('entrana'), station('taverley'));
  dying.dying = true;
  tick(3);
  assert.deepEqual(xy(dying.getLocation()), [2808, 3354], 'where they were');
  assert.equal(dying.inventory.get(1511), 1, 'the log back');
  assert.equal(dying.fades.at(-1), 'closed');
  assert.equal(Travel.flying(dying), false);
});

test('one flight at a time, and a map pick only from an open map', () => {
  const player = fakePlayer({ items: { logs: 3 } });
  Travel.travel(player, station('entrana'), station('taverley'));
  assert.equal(Travel.travel(player, station('entrana'), station('taverley')), false);
  assert.equal(player.inventory.get(1511), 2);
  const stray = pick(fakePlayer(), 'taverley');
  assert.equal(stray.handled, false, 'no map open');
});

test("the trip is checked again after the Entrana search; armour put on mid-flight, or a teleport, stops it", () => {
  const dropped = fakePlayer({ at: [2938, 3421], items: { logs: 1 } });
  Travel.travel(dropped, station('taverley'), station('entrana'));
  dropped.inventory.set(1511, 0);
  continueChain(dropped);
  assert.equal(Travel.flying(dropped), false);
  assert.equal(lastLine(dropped), 'You need 1 normal logs to make this trip.');

  const armed = fakePlayer({ at: [2938, 3421], items: { logs: 1 } });
  Travel.travel(armed, station('taverley'), station('entrana'));
  continueChain(armed);
  assert.equal(Travel.flying(armed), true);
  armed.getEquipment().getItems()[core.Equipment.WEAPON_SLOT] = new core.Item(core.ItemIdentifiers.ABYSSAL_WHIP, 1);
  tick(3);
  assert.deepEqual(xy(armed.getLocation()), [2938, 3421], 'not landed on Entrana armed');
  assert.equal(armed.inventory.get(1511), 1, 'the log back');

  const away = fakePlayer({ items: { logs: 1 } });
  Travel.travel(away, station('entrana'), station('taverley'));
  away.moveTo(loc(3222, 3218));
  tick(3);
  assert.deepEqual(xy(away.getLocation()), [3222, 3218], 'a teleport on the way is not undone');
});

test("the map opens only at a station the player has open, and with a speaker who has a name", () => {
  const lori = fakePlayer({ at: [2480, 3457] });
  assert.equal(Travel.flyNpc({ player: lori, npc: { getLocation: () => loc(2480, 3457), getId: () => 7179 }, npcId: 7154 }), false, 'the Grand Tree not yet open');
  assert.equal(lori.interface, -1);
  assert.equal(Travel.flyNpc({ player: fakePlayer({ at: [1800, 4893] }), npc: { getLocation: () => loc(1800, 4893), getId: () => 4717 }, npcId: 4717 }), false, 'no station there');
  const brock = fakePlayer({ at: [2925, 3303] });
  Common.openRoute(brock, station('craft'));
  Travel.flyNpc({ player: brock, npc: { getLocation: () => loc(2925, 3303), getId: () => 4731 }, npcId: 4720 });
  Travel.chooseDestination({ player: brock, groupId: Common.ids.map, childId: 17, handled: false });
  assert.equal(brock.lastChain.getDialogues().get(0).getNpcId(), 4720, 'Brock, not his blank multinpc');
});
