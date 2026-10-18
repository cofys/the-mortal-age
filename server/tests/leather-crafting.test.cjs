const assert = require('node:assert/strict');
const { test, before } = require('node:test');
const { Server } = require('../dist/Server');
Server.installProductionPathResolver();
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { PluginManager } = require('../dist/plugins/PluginManager');
const WorldDefinition = require('../dist/game/definition/WorldDefinition');
const { ItemIds } = require('../dist/util/IdEnums');
const { Animation } = require('../dist/game/model/Animation');

const THREAD_USES_ATTRIBUTE = 'crafting:thread-uses';
const TASK_ATTRIBUTE = 'crafting:leather-task';
const LEATHER_CRAFTING_ANIMATION = 1249;

let handleNeedleOnLeather;
const tasks = [];

before(async () => {
  await CachePipeline.initialize(process.cwd());
  const api = PluginManager.createApi('LeatherCraftingTest');
  require('../plugins/skills/Crafting.plugin').register({
    ...api,
    onItemOnItem: handler => {
      if (handler.name === 'handleNeedleOnLeather') handleNeedleOnLeather = handler;
    },
    onItemOnObject: () => {},
    onInterfaceActionClick: () => {},
    onObjectInteraction: () => {},
    persistAttribute: () => {},
    getTaskManager: () => ({ submit: task => tasks.push(task) }),
  });
});

function membersWorld(t, members) {
  const saved = WorldDefinition.isMembersWorld;
  t.after(() => { WorldDefinition.isMembersWorld = saved; });
  WorldDefinition.isMembersWorld = () => members;
}

function playerWith(entries = [], { level = 99, threadUses } = {}) {
  const amounts = new Map(entries);
  const attributes = new Map(threadUses === undefined ? [] : [[THREAD_USES_ATTRIBUTE, threadUses]]);
  const log = [];
  let menu;
  const inventory = {
    contains: id => (amounts.get(id) ?? 0) > 0,
    getAmount: id => amounts.get(id) ?? 0,
    deleteNumber: (id, amount) => amounts.set(id, Math.max(0, (amounts.get(id) ?? 0) - amount)),
    addItem: item => amounts.set(item.id, (amounts.get(item.id) ?? 0) + item.getAmount()),
  };
  const packetSender = {
    sendCreationMenu(value) {
      menu = value;
      return packetSender;
    },
    closeInterface() {
      log.push(['close']);
      return packetSender;
    },
  };
  const player = {
    amounts,
    log,
    level,
    interfaceId: -1,
    moving: false,
    getInventory: () => inventory,
    getSkillManager: () => ({
      getCurrentLevel: () => player.level,
      addExperiences: (skill, xp) => log.push(['xp', xp]),
    }),
    getAttribute: key => attributes.get(key),
    setAttribute: (key, value) => attributes.set(key, value),
    getPacketSender: () => packetSender,
    getDialogueManager: () => ({
      startDialogues: chain => log.push(['statement', chain.getDialogues().get(0).text]),
    }),
    sendMessage: text => log.push(['message', text]),
    performAnimation: animation => log.push(['animation', animation.getId()]),
    getInterfaceId: () => player.interfaceId,
    setInterfaceId: id => { player.interfaceId = id; },
    isRegistered: () => true,
    getHitpoints: () => 99,
    getMovementQueue: () => ({ size: () => player.moving ? 1 : 0 }),
    getForceMovement: () => null,
  };
  return { player, getMenu: () => menu };
}

function useNeedle(player, materialId, needleId = ItemIds.NEEDLE) {
  const event = { player, usedItemId: needleId, usedWithItemId: materialId, handled: false };
  handleNeedleOnLeather(event);
  return event;
}

/** Chooses `itemId` from the menu and returns what each following tick logged. */
function craft(player, menu, itemId, amount, ticks) {
  player.log.length = 0;
  menu.execute(itemId, amount);
  const byTick = [player.log.splice(0)];
  const task = tasks.at(-1);
  for (let i = 1; i <= ticks; i++) {
    if (player.getAttribute(TASK_ATTRIBUTE) === task) task.execute();
    byTick.push(player.log.splice(0));
  }
  return byTick;
}

const messages = rows => rows.filter(row => row[0] === 'message').map(row => row[1]);

test('needle on leather opens the captured skillmulti menu with all seven items, coif included', t => {
  membersWorld(t, true);
  const { player, getMenu } = playerWith([[ItemIds.NEEDLE, 1], [ItemIds.THREAD, 1], [ItemIds.LEATHER, 13]], { level: 1 });
  assert.equal(useNeedle(player, ItemIds.LEATHER).handled, true);
  const menu = getMenu();
  assert.equal(menu.getTitle(), 'How many do you wish to make?');
  assert.deepEqual(menu.getItems(), [
    ItemIds.LEATHER_GLOVES, ItemIds.LEATHER_BOOTS, ItemIds.LEATHER_COWL, ItemIds.LEATHER_VAMBRACES,
    ItemIds.LEATHER_BODY, ItemIds.LEATHER_CHAPS, ItemIds.COIF,
  ]);
  assert.deepEqual(menu.getOptions().labels, [
    'Leather gloves', 'Leather boots', 'Leather cowl', 'Leather vambraces', 'Leather body', 'Leather chaps', 'Coif',
  ]);
  // The menu offers up to the leather carried, not the thread.
  assert.equal(menu.getOptions().maxAmount, 13);
  assert.equal(menu.getOptions().mode, 0);
});

test('free-to-play worlds leave the members coif out of the leather menu', t => {
  membersWorld(t, false);
  const { player, getMenu } = playerWith([[ItemIds.NEEDLE, 1], [ItemIds.THREAD, 1], [ItemIds.LEATHER, 1]]);
  useNeedle(player, ItemIds.LEATHER);
  assert.equal(getMenu().getItems().includes(ItemIds.COIF), false);
  assert.equal(getMenu().getItems().length, 6);
});

test('crafting animates on the choice, makes the first item 2 ticks later and one every 3 ticks', t => {
  membersWorld(t, true);
  const { player, getMenu } = playerWith([[ItemIds.NEEDLE, 1], [ItemIds.THREAD, 1], [ItemIds.LEATHER, 3]]);
  useNeedle(player, ItemIds.LEATHER);
  const byTick = craft(player, getMenu(), ItemIds.LEATHER_CHAPS, 3, 9);

  assert.deepEqual(byTick[0].filter(row => row[0] === 'animation'), [['animation', LEATHER_CRAFTING_ANIMATION]]);
  const madeOn = byTick.flatMap((rows, tick) => messages(rows).includes('You make a pair of leather chaps.') ? [tick] : []);
  assert.deepEqual(madeOn, [2, 5, 8]);
  assert.equal(player.amounts.get(ItemIds.LEATHER_CHAPS), 3);
  assert.equal(player.amounts.get(ItemIds.LEATHER), 0);
  assert.ok(byTick[2].some(row => row[0] === 'xp' && row[1] === 27));
  // Replayed after each item but the last, which resets the animation.
  assert.ok(byTick[2].some(row => row[0] === 'animation' && row[1] === LEATHER_CRAFTING_ANIMATION));
  assert.ok(byTick[8].some(row => row[0] === 'animation' && row[1] === Animation.DEFAULT_RESET_ANIMATION.getId()));
  assert.equal(player.getAttribute(TASK_ATTRIBUTE), null);
});

test('a reel of thread lasts five items, and the count carries over between batches', t => {
  membersWorld(t, true);
  const { player, getMenu } = playerWith([[ItemIds.NEEDLE, 1], [ItemIds.THREAD, 2], [ItemIds.LEATHER, 7]]);
  useNeedle(player, ItemIds.LEATHER);
  const byTick = craft(player, getMenu(), ItemIds.LEATHER_GLOVES, 4, 12);
  assert.equal(player.amounts.get(ItemIds.THREAD), 2);
  assert.equal(player.getAttribute(THREAD_USES_ATTRIBUTE), 4);
  assert.equal(byTick.flatMap(messages).filter(text => text.includes('thread')).length, 0);

  useNeedle(player, ItemIds.LEATHER);
  const next = craft(player, getMenu(), ItemIds.LEATHER_GLOVES, 1, 3);
  assert.deepEqual(messages(next[2]), ['You make a pair of leather gloves.', 'You use up one of your reels of thread.']);
  assert.equal(player.amounts.get(ItemIds.THREAD), 1);
  assert.equal(player.getAttribute(THREAD_USES_ATTRIBUTE), 0);
});

test('a costume needle sews without thread', t => {
  membersWorld(t, true);
  const { player, getMenu } = playerWith([[ItemIds.COSTUME_NEEDLE, 1], [ItemIds.LEATHER, 5]], { threadUses: 4 });
  assert.equal(useNeedle(player, ItemIds.LEATHER, ItemIds.COSTUME_NEEDLE).handled, true);
  craft(player, getMenu(), ItemIds.LEATHER_BOOTS, 5, 15);
  assert.equal(player.amounts.get(ItemIds.LEATHER_BOOTS), 5);
  assert.equal(player.getAttribute(THREAD_USES_ATTRIBUTE), 4);
});

test('choosing an item above the Crafting level shows the captured message box and makes nothing', t => {
  membersWorld(t, true);
  const { player, getMenu } = playerWith([[ItemIds.NEEDLE, 1], [ItemIds.THREAD, 1], [ItemIds.LEATHER, 1]], { level: 37 });
  useNeedle(player, ItemIds.LEATHER);
  const tasksBefore = tasks.length;
  const byTick = craft(player, getMenu(), ItemIds.COIF, 1, 0);
  assert.equal(tasks.length, tasksBefore);
  assert.ok(byTick[0].some(row => row[0] === 'statement' && row[1] === 'You need a Crafting level of 38 to make a coif.'));
  assert.equal(player.amounts.get(ItemIds.LEATHER), 1);
  assert.equal(player.amounts.get(ItemIds.COIF), undefined);
});

test('no thread: needle on leather is handled but opens no menu', t => {
  membersWorld(t, true);
  const { player, getMenu } = playerWith([[ItemIds.NEEDLE, 1], [ItemIds.LEATHER, 1]]);
  assert.equal(useNeedle(player, ItemIds.LEATHER).handled, true);
  assert.equal(getMenu(), undefined);
  assert.ok(messages(player.log).some(text => text.includes('thread')));
});

test('hard leather makes a hardleather body for 35 XP', t => {
  membersWorld(t, true);
  const { player, getMenu } = playerWith([[ItemIds.NEEDLE, 1], [ItemIds.THREAD, 1], [ItemIds.HARD_LEATHER, 9]]);
  useNeedle(player, ItemIds.HARD_LEATHER);
  assert.deepEqual(getMenu().getItems(), [ItemIds.HARDLEATHER_BODY]);
  assert.deepEqual(getMenu().getOptions().labels, ['Hardleather body']);
  assert.equal(getMenu().getOptions().maxAmount, 9);
  const byTick = craft(player, getMenu(), ItemIds.HARDLEATHER_BODY, 1, 3);
  assert.deepEqual(messages(byTick[2]), ['You make a hard leather body.']);
  assert.ok(byTick[2].some(row => row[0] === 'xp' && row[1] === 35));
});

test('dragon leather: body, vambraces, chaps with the captured labels, leather per item and XP', t => {
  membersWorld(t, true);
  const { player, getMenu } = playerWith([[ItemIds.NEEDLE, 1], [ItemIds.THREAD, 1], [ItemIds.BLACK_DRAGON_LEATHER, 26]]);
  useNeedle(player, ItemIds.BLACK_DRAGON_LEATHER);
  assert.deepEqual(getMenu().getItems(), [ItemIds.BLACK_DHIDE_BODY, ItemIds.BLACK_DHIDE_VAMBRACES, ItemIds.BLACK_DHIDE_CHAPS]);
  assert.deepEqual(getMenu().getOptions().labels,
    ['Black dragonhide body', 'Black dragonhide vambraces', 'Black dragonhide chaps']);
  assert.equal(getMenu().getOptions().maxAmount, 26);

  const byTick = craft(player, getMenu(), ItemIds.BLACK_DHIDE_BODY, 1, 3);
  assert.deepEqual(messages(byTick[2]), ['You make a black dragonhide body.']);
  assert.ok(byTick[2].some(row => row[0] === 'xp' && row[1] === 258));
  assert.equal(player.amounts.get(ItemIds.BLACK_DRAGON_LEATHER), 23);

  useNeedle(player, ItemIds.BLACK_DRAGON_LEATHER);
  const chaps = craft(player, getMenu(), ItemIds.BLACK_DHIDE_CHAPS, 1, 3);
  assert.deepEqual(messages(chaps[2]), ['You make a pair of black dragonhide chaps.']);
  assert.equal(player.amounts.get(ItemIds.BLACK_DRAGON_LEATHER), 21);
});

test('a body needs three dragon leather: the batch stops when fewer are left', t => {
  membersWorld(t, true);
  const { player, getMenu } = playerWith([[ItemIds.NEEDLE, 1], [ItemIds.THREAD, 1], [ItemIds.GREEN_DRAGON_LEATHER, 5]]);
  useNeedle(player, ItemIds.GREEN_DRAGON_LEATHER);
  craft(player, getMenu(), ItemIds.GREEN_DHIDE_BODY, 5, 15);
  assert.equal(player.amounts.get(ItemIds.GREEN_DHIDE_BODY), 1);
  assert.equal(player.amounts.get(ItemIds.GREEN_DRAGON_LEATHER), 2);
  assert.equal(player.getAttribute(TASK_ATTRIBUTE), null);
});

test('free-to-play worlds offer no dragonhide recipes', t => {
  membersWorld(t, false);
  const { player, getMenu } = playerWith([[ItemIds.NEEDLE, 1], [ItemIds.THREAD, 1], [ItemIds.GREEN_DRAGON_LEATHER, 3]]);
  useNeedle(player, ItemIds.GREEN_DRAGON_LEATHER);
  assert.deepEqual(getMenu().getItems(), []);
});

test('other items used on a needle are left to other handlers', () => {
  const { player } = playerWith([[ItemIds.NEEDLE, 1], [ItemIds.THREAD, 1]]);
  assert.equal(useNeedle(player, ItemIds.COINS).handled, false);
});
