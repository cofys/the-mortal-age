const assert = require('node:assert/strict');
const { test, before } = require('node:test');
require('../dist/Server').Server.installProductionPathResolver();
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { PluginManager } = require('../dist/plugins/PluginManager');
const { Player } = require('../dist/game/entity/impl/player/Player');
let core, Data, Patches, Hespori;
const MAX_STACK = 2147483647;
before(async () => {
    await CachePipeline.initialize(require('node:path').resolve(__dirname, '..'));
    core = PluginManager.getCoreApi();
    require('../plugins/skills/farming/Core.Farming').init({ core });
    Data = require('../plugins/skills/farming/Data.Farming');
    Patches = require('../plugins/skills/farming/Patches.Farming');
    Hespori = require('../plugins/skills/farming/Hespori.Farming');
    Data.initializeFarmingData();
});
function prepare(t, stored, held = []) {
    const player = new Player(null);
    const sender = new Proxy({}, { get: () => () => sender });
    player.getPacketSender = () => sender; player.sendMessage = () => {};
    player.moveTo(new core.Location(1232, 3728, 0));
    for (const [id, amount, meta] of held) player.getInventory().add(new core.Item(id, amount, meta), false);
    const farm = { offset: 0, patches: {}, tools: {}, deathbank: structuredClone(stored), deathbankPaid: true };
    player.setAttribute(Patches.FARM_ATTRIBUTE, farm);
    let entries;
    t.mock.method(Patches, 'choose', (_player, options) => { entries = options; });
    Hespori.hesporiNpc({ player, npc: { getLocation: () => new core.Location(1232, 3728, 0) },
        definition: { getName: () => 'Arno', getActions: () => ['Talk-to', 'Collect'] }, clickType: 2 });
    return { player, inventory: player.getInventory(), farm, collect: () => entries[0][1]() };
}
test('near-cap stacks retain the exact uncollected remainder across repeated collection', t => {
    const coins = core.ItemIdentifiers.COINS;
    const f = prepare(t, [{ id: coins, amount: 100 }], [[coins, MAX_STACK - 7]]);
    f.collect();
    assert.equal(f.inventory.getAmount(coins), MAX_STACK);
    assert.deepEqual(f.farm.deathbank, [{ id: coins, amount: 93 }]);
    f.collect();
    assert.deepEqual(f.farm.deathbank, [{ id: coins, amount: 93 }]);
    f.inventory.deleteNumber(coins, 93);
    f.collect();
    assert.equal(f.inventory.getAmount(coins), MAX_STACK);
    assert.deepEqual(f.farm.deathbank, []);
});
test('a full inventory can collect into a matching stack behind a blocked item', t => {
    const coins = core.ItemIdentifiers.COINS, spade = Data.itemId('Spade');
    const f = prepare(t, [{ id: spade, amount: 1 }, { id: coins, amount: 50 }], [[coins, 100], [spade, 27]]);
    assert.equal(f.inventory.getFreeSlots(), 0);
    f.collect();
    assert.equal(f.inventory.getAmount(coins), 150);
    assert.deepEqual(f.farm.deathbank, [{ id: spade, amount: 1 }]);
});
test('partially fitting unstackable batches keep the remainder stored', t => {
    const spade = Data.itemId('Spade');
    const f = prepare(t, [{ id: spade, amount: 3 }], [[spade, 27]]);
    f.collect();
    assert.equal(f.inventory.getAmount(spade), 28);
    assert.deepEqual(f.farm.deathbank, [{ id: spade, amount: 2 }]);
});
test('metadata-incompatible stacks cannot consume a stored entry when inventory is full', t => {
    const coins = core.ItemIdentifiers.COINS, spade = Data.itemId('Spade');
    const stored = [{ id: coins, amount: 50, meta: { source: { value: 'stored' } } }];
    const f = prepare(t, stored, [[coins, 100, { source: { value: 'held' } }], [spade, 27]]);
    f.collect();
    assert.deepEqual(f.farm.deathbank, stored);
    assert.equal(f.inventory.getAmount(coins), 100);
});
test('a capped stack stays stored while later items that fit are returned', t => {
    const coins = core.ItemIdentifiers.COINS, spade = Data.itemId('Spade');
    const f = prepare(t, [{ id: coins, amount: 50 }, { id: spade, amount: 1 }], [[coins, MAX_STACK]]);
    f.collect();
    assert.equal(f.inventory.getAmount(coins), MAX_STACK);
    assert.equal(f.inventory.getAmount(spade), 1);
    assert.deepEqual(f.farm.deathbank, [{ id: coins, amount: 50 }]);
});
test('metadata survives partial collection and is not shared with the stored remainder', t => {
    const coins = core.ItemIdentifiers.COINS, meta = { charges: { remaining: 3 } };
    const f = prepare(t, [{ id: coins, amount: 10, meta }], [[coins, MAX_STACK - 2, meta]]);
    f.collect();
    assert.deepEqual(f.farm.deathbank, [{ id: coins, amount: 8, meta }]);
    const held = f.inventory.getValidItems().find(item => item.getId() === coins);
    assert.deepEqual(held.getMeta(), meta);
    held.getMeta().charges.remaining = 1;
    assert.equal(f.farm.deathbank[0].meta.charges.remaining, 3);
});
