const assert = require('node:assert/strict');
const { test, before } = require('node:test');
require('../dist/Server').Server.installProductionPathResolver();
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { PluginManager } = require('../dist/plugins/PluginManager');
const { Player } = require('../dist/game/entity/impl/player/Player');
let core, Data, Patches, Services;
before(async () => {
    await CachePipeline.initialize(require('node:path').resolve(__dirname, '..'));
    core = PluginManager.getCoreApi();
    require('../plugins/skills/farming/Core.Farming').init({ core });
    Data = require('../plugins/skills/farming/Data.Farming');
    Patches = require('../plugins/skills/farming/Patches.Farming');
    Services = require('../plugins/skills/farming/Services.Farming');
    Data.initializeFarmingData();
});
function prepare(stored = {}) {
    const player = new Player(null), sender = new Proxy({}, { get: () => () => sender });
    player.getPacketSender = () => sender; player.sendMessage = () => {};
    const farm = Patches.farmFor(player), inventory = player.getInventory();
    for (const [name, count] of Object.entries(stored)) farm.tools[Data.itemId(name)] = count;
    const definition = { getName: () => 'Tool Leprechaun', getActions: () => ['Deposit-all'] };
    const npc = { getLocation: () => player.getLocation(), getDefinition: () => definition };
    const deposit = (name, count = 1, noted = false) => {
        const id = Data.itemId(name), used = noted ? core.CacheDefinitions.getItem(id).note : id;
        assert.ok(used > 0);
        inventory.add(new core.Item(used, count), false);
        Services.farmingItemOnNpc({ player, target: npc, definition, itemId: used, slot: inventory.getSlotForItemId(used) });
        return used;
    };
    return { player, inventory, farm, deposit, count: name => farm.tools[Data.itemId(name)] ?? 0,
        depositAll: () => Services.farmingNpc({ player, npc, definition, clickType: 1 }) };
}
test('stored magic secateurs refuse normal and noted normal secateurs without consuming them', () => {
    for (const noted of [false, true]) {
        const f = prepare({ 'Magic secateurs': 1 }), used = f.deposit('Secateurs', 1, noted);
        assert.equal(f.inventory.getAmount(used), 1);
        assert.equal(f.count('Secateurs'), 0);
        assert.equal(f.count('Magic secateurs'), 1);
    }
});
test('stored normal secateurs refuse magic secateurs without consuming them', () => {
    const f = prepare({ Secateurs: 1 }), used = f.deposit('Magic secateurs');
    assert.equal(f.inventory.getAmount(used), 1);
    assert.equal(f.count('Secateurs'), 1);
    assert.equal(f.count('Magic secateurs'), 0);
});
test('same-variant deposits retain the existing 100-item cap', () => {
    const normal = prepare({ Secateurs: 80 }), note = normal.deposit('Secateurs', 50, true);
    assert.equal(normal.count('Secateurs'), 100);
    assert.equal(normal.inventory.getAmount(note), 30);
    const magic = prepare({ 'Magic secateurs': 99 }), id = magic.deposit('Magic secateurs', 2);
    assert.equal(magic.count('Magic secateurs'), 100);
    assert.equal(magic.inventory.getAmount(id), 1);
});
test('a zero-count previous variant does not prevent switching stored secateurs', () => {
    const f = prepare({ Secateurs: 0 }), used = f.deposit('Magic secateurs');
    assert.equal(f.count('Magic secateurs'), 1);
    assert.equal(f.inventory.getAmount(used), 0);
});
test('Deposit-all leaves the conflicting variant carried while storing unrelated tools', () => {
    const f = prepare();
    f.inventory.add(new core.Item(Data.itemId('Secateurs')), false);
    f.inventory.add(new core.Item(Data.itemId('Magic secateurs')), false);
    f.inventory.add(new core.Item(Data.itemId('Rake'), 2), false);
    f.depositAll();
    assert.equal(f.count('Secateurs'), 1);
    assert.equal(f.count('Magic secateurs'), 0);
    assert.equal(f.inventory.getAmount(Data.itemId('Magic secateurs')), 1);
    assert.equal(f.count('Rake'), 2);
});
