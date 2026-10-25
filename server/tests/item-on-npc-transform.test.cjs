'use strict';
// Revision 241 spawns many NPCs as a nameless parent that transforms per player: the second
// Lumbridge banker (6520) is "null" until varbit 4153 resolves it to Banker 2897. NPC options
// already pass the resolved definition; item use on an NPC has to as well, or a handler that
// matches on the name (using coins on a banker to exchange them) never fires.
const assert = require('node:assert/strict');
const { test, before } = require('node:test');
const { Server } = require('../dist/Server');
Server.installProductionPathResolver();

before(async () => {
  await require('../dist/game/cache/CachePipeline').CachePipeline.initialize(require('node:path').resolve(__dirname, '..'));
});

const { PluginManager } = require('../dist/plugins/PluginManager');
const { UseItemPacketListener } = require('../dist/net/packet/impl/UseItemPacketListener');
const { World } = require('../dist/game/World');
const { NpcDefinition } = require('../dist/game/definition/NpcDefinition');
const { Item } = require('../dist/game/model/Item');
const { Inventory } = require('../dist/game/model/container/impl/Inventory');
const { Location } = require('../dist/game/model/Location');

const PARENT_BANKER = 6520;
const BANKER = 2897;
const COINS = 995;

function transformedBanker() {
  return {
    getDefinition: () => NpcDefinition.forId(PARENT_BANKER),
    getCurrentDefinition: () => NpcDefinition.forId(BANKER),
    getContentId: () => BANKER,
    getId: () => PARENT_BANKER,
    getLocation: () => new Location(3209, 3222, 2),
  };
}

function playerWithCoins(amount) {
  const sender = new Proxy({}, { get: () => () => sender });
  const messages = [];
  const dialogues = [];
  const player = {
    messages,
    dialogues,
    getMovementQueue: () => ({ walkToEntity: (_target, arrive) => arrive() }),
    setPositionToFace() {},
    sendMessage: (message) => messages.push(message),
    getDialogueManager: () => ({ getCurrent: () => null, startDialogues: (chain) => dialogues.push(chain) }),
    getPacketSender: () => sender,
  };
  const inventory = new Inventory(player);
  inventory.getItems()[0] = new Item(COINS, amount);
  player.getInventory = () => inventory;
  return player;
}

test('cache: 6520 is a nameless parent that resolves to Banker 2897', () => {
  assert.equal(NpcDefinition.forId(PARENT_BANKER).getName(), 'null');
  assert.equal(NpcDefinition.forId(BANKER).getName(), 'Banker');
});

test('item use on an NPC passes the definition the player sees', () => {
  const target = transformedBanker();
  const player = playerWithCoins(5000);
  const npcs = World.getNpcs();
  const originalGet = npcs.get;
  const originalEmit = PluginManager.emitItemOnNpc;
  let event;
  npcs.get = () => target;
  PluginManager.emitItemOnNpc = (emitted) => { event = emitted; return false; };
  try {
    UseItemPacketListener.itemOnNpc(player, 149, 1, COINS, 0);
  } finally {
    npcs.get = originalGet;
    PluginManager.emitItemOnNpc = originalEmit;
  }
  assert.ok(event, 'the item-on-NPC event was emitted');
  assert.equal(event.definition?.getName?.(), 'Banker', 'event.definition is the resolved form');
  assert.equal(event.npcId, BANKER);
});

test('queued item use revalidates the exact inventory slot and NPC on arrival', () => {
  const npcs = World.getNpcs();
  const originalGet = npcs.get;
  const originalEmit = PluginManager.emitItemOnNpc;
  try {
    for (const change of ['none', 'swap', 'consume', 'replace-npc']) {
      const target = transformedBanker();
      const player = playerWithCoins(5);
      const inventory = player.getInventory();
      inventory.setItem(1, new Item(4151, 1));
      let arrive, emitted = 0, currentTarget = target;
      player.getMovementQueue = () => ({ walkToEntity: (_target, callback) => { arrive = callback; } });
      npcs.get = () => currentTarget;
      PluginManager.emitItemOnNpc = () => { emitted++; return true; };
      UseItemPacketListener.itemOnNpc(player, 149, 1, COINS, 0);
      assert.equal(typeof arrive, 'function');
      if (change === 'swap') inventory.swap(0, 1);
      if (change === 'consume') inventory.deleteAtSlot(0, 5, false);
      if (change === 'replace-npc') currentTarget = transformedBanker();
      arrive();
      assert.equal(emitted, change === 'none' ? 1 : 0, change);
      assert.equal(inventory.getAmount(4151), 1, 'a replacement item is never offered to the old handler');
    }
  } finally {
    npcs.get = originalGet;
    PluginManager.emitItemOnNpc = originalEmit;
  }
});

test('using coins on a transformed banker offers the platinum token exchange', () => {
  const hooks = {};
  const api = new Proxy(PluginManager.createApi('BankBooths'), {
    get(target, property) {
      if (typeof property === 'string' && /^on[A-Z]/.test(property)) {
        return (handler) => { (hooks[property] ??= []).push(handler); };
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  require('../plugins/objects/BankBooths.plugin').register(api);
  const target = transformedBanker();
  const player = playerWithCoins(5000);
  const event = {
    player, target, definition: target.getCurrentDefinition(player), npcId: BANKER,
    targetIndex: 1, interfaceId: 149, item: player.getInventory().forSlot(0), itemId: COINS, slot: 0, handled: false,
  };
  for (const handler of hooks.onItemOnNpc) handler(event);
  assert.equal(event.handled, true, 'the exchange handles coins used on the banker');
  assert.equal(player.dialogues.length, 1, 'the Yes/No exchange prompt opens');
});
