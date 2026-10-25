const assert = require('node:assert/strict');
const { test, before } = require('node:test');
require('../dist/Server').Server.installProductionPathResolver();
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { PluginManager } = require('../dist/plugins/PluginManager');
const { Player } = require('../dist/game/entity/impl/player/Player');
let core, Data, Patches, handlers;
const MAX_STACK = 2147483647;
before(async () => {
    await CachePipeline.initialize(require('node:path').resolve(__dirname, '..'));
    core = PluginManager.getCoreApi();
    require('../plugins/skills/farming/Core.Farming').init({ core });
    Data = require('../plugins/skills/farming/Data.Farming');
    Patches = require('../plugins/skills/farming/Patches.Farming');
    Data.initializeFarmingData();
    handlers = new Map();
    Patches.attach(new Proxy({}, { get: (_, name) => (...args) => {
        if (name === 'onCustomEvent') handlers.set(args[0], args[1]);
    } }));
});
function prepare(t, name = 'Seed box', stored) {
    const player = new Player(null), seen = [];
    const sender = new Proxy({}, { get: () => () => sender });
    player.getPacketSender = () => sender; player.sendMessage = () => {};
    player.setStatus(core.PlayerStatus.BANKING).setInterfaceId(core.Bank.MAIN_INTERFACE_ID);
    player.setCurrentBankTab(0);
    const id = Data.itemId(name), contents = stored ?? { [Data.itemId('Potato seed')]: 8 };
    player.getInventory().add(new core.Item(id, 1, { 'farming:stored': contents }), false);
    const container = player.getInventory().forSlot(0);
    t.mock.method(core.PluginManager, 'emitCustomEvent', (name, event) => {
        handlers.get(name)?.(event);
        if (name === core.Bank.INVENTORY_OP_EVENT) seen.push(event);
    });
    const empty = (op = 9, itemId = id) => core.Bank.handleWidgetAction(player, {
        groupId: core.Bank.SIDE_INTERFACE_ID, childId: core.Bank.SIDE_ITEMS_CHILD,
        slot: 0, itemId, buttonNum: op, option: op === 9 ? 'Empty' : undefined });
    return { player, container, empty, seen,
        stored: () => container.getMetaValue('farming:stored'), bank: tab => player.getBank(tab ?? 0) };
}
test('native bank Empty transfers seeds from open and closed seed boxes without banking the box', t => {
    for (const name of ['Seed box', 'Open seed box']) {
        const f = prepare(t, name), seed = Data.itemId('Potato seed');
        f.empty();
        assert.equal(f.bank().getAmount(seed), 8, name);
        assert.deepEqual(f.stored(), {}, name);
        assert.equal(f.player.getInventory().forSlot(0), f.container);
        assert.equal(f.seen.at(-1).handled, true);
    }
});
test('native bank Empty transfers herbs from open and closed sacks', t => {
    const herb = Data.itemId('Grimy ranarr weed');
    for (const name of ['Herb sack', 'Open herb sack']) {
        const f = prepare(t, name, { [herb]: 30 });
        f.empty();
        assert.equal(f.bank().getAmount(herb), 30, name);
        assert.deepEqual(f.stored(), {}, name);
    }
});
test('bank stack headroom preserves the exact remainder across repeated Empty actions', t => {
    const seed = Data.itemId('Potato seed'), f = prepare(t, 'Seed box', { [seed]: 10 });
    f.bank().add(new core.Item(seed, MAX_STACK - 3), false);
    f.empty(); f.empty();
    assert.equal(f.bank().getAmount(seed), MAX_STACK);
    assert.deepEqual(f.stored(), { [seed]: 7 });
    f.bank().deleteNumber(seed, 7);
    f.empty();
    assert.equal(f.bank().getAmount(seed), MAX_STACK);
    assert.deepEqual(f.stored(), {});
});
test('existing item tabs are used and bank placeholders are filled', t => {
    const seed = Data.itemId('Potato seed'), f = prepare(t);
    // Keep earlier tabs populated: the real bank compacts gaps when it refreshes.
    f.bank(1).add(new core.Item(Data.itemId('Onion seed')), false);
    f.bank(2).add(new core.Item(Data.itemId('Barley seed')), false);
    f.bank(3).add(new core.Item(seed, 0), false);
    f.empty();
    assert.equal(f.bank(3).getAmount(seed), 8);
    assert.equal(f.bank().getAmount(seed), 0);
    assert.deepEqual(f.stored(), {});
});
test('a completely full bank keeps all unbanked container contents', t => {
    const f = prepare(t), spade = Data.itemId('Spade');
    for (let tab = 0; tab < core.Bank.BANK_SEARCH_TAB_INDEX; tab++) {
        const bank = f.bank(tab);
        bank.setItems(Array.from({ length: bank.capacity() }, (_, slot) => new core.Item(spade, 1, { slot })));
    }
    f.empty();
    assert.deepEqual(f.stored(), { [Data.itemId('Potato seed')]: 8 });
    assert.equal(f.player.getInventory().forSlot(0), f.container);
});
test('closed bank, stale item ID and unrelated bank ops cannot empty contents', t => {
    const closed = prepare(t);
    closed.player.setInterfaceId(-1);
    closed.empty();
    assert.deepEqual(closed.stored(), { [Data.itemId('Potato seed')]: 8 });
    const stale = prepare(t);
    stale.empty(9, Data.itemId('Spade'));
    assert.equal(stale.seen.length, 0);
    assert.deepEqual(stale.stored(), { [Data.itemId('Potato seed')]: 8 });
    const other = prepare(t);
    other.empty(10);
    assert.equal(other.seen.at(-1).handled, false);
    assert.deepEqual(other.stored(), { [Data.itemId('Potato seed')]: 8 });
});
