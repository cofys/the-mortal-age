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
function prepare(type = 'COMPOST') {
    const player = new Player(null), sender = new Proxy({}, { get: () => () => sender });
    player.getPacketSender = () => sender; player.sendMessage = () => {};
    const patch = Data.CACHE.patches.find(p => p.type === type);
    const state = Patches.stateFor(player, patch), inventory = player.getInventory();
    const add = (name, noted = false) => {
        let id = Data.itemId(name); assert.ok(id > 0, name);
        if (noted) { id = core.CacheDefinitions.getItem(id).note; assert.ok(id > 0, `${name} note`); }
        inventory.add(new core.Item(id), false);
        Services.binAction(player, patch, '', id);
        return id;
    };
    return { player, patch, state, inventory, add, bin: () => state.bin };
}
test('cotton bolls produce regular compost in both bin sizes', () => {
    for (const [type, capacity] of [['COMPOST', 15], ['BIG_COMPOST', 30]]) {
        const f = prepare(type);
        for (let i = 0; i < capacity; i++) f.add('Cotton boll');
        assert.equal(f.bin().count, capacity, type);
        assert.equal(f.bin().tier, 1, type);
        assert.equal(f.inventory.getAmount(Data.itemId('Cotton boll')), 0, type);
    }
});
test('half coconuts produce supercompost in both bin sizes', () => {
    for (const [type, capacity] of [['COMPOST', 15], ['BIG_COMPOST', 30]]) {
        const f = prepare(type);
        for (let i = 0; i < capacity; i++) f.add('Half coconut');
        assert.equal(f.bin().count, capacity, type);
        assert.equal(f.bin().super, capacity, type);
        assert.equal(f.bin().tier, 2, type);
    }
});
test('mixing a cotton boll into otherwise supercompostable contents produces regular compost', () => {
    const f = prepare();
    for (let i = 0; i < 14; i++) f.add('Half coconut');
    f.add('Cotton boll');
    assert.equal(f.bin().count, 15);
    assert.equal(f.bin().super, 14);
    assert.equal(f.bin().tier, 1);
});
test('noted produce remains untouched and never increments either bin', () => {
    for (const type of ['COMPOST', 'BIG_COMPOST']) {
        const f = prepare(type);
        for (const name of ['Potato', 'Watermelon', 'Cotton boll', 'Half coconut', 'Guam leaf']) {
            const id = f.add(name, true);
            assert.equal(f.inventory.getAmount(id), 1, `${type}: ${name}`);
            assert.equal(f.bin().count, 0, `${type}: ${name}`);
        }
    }
});
test('a noted compost potion cannot upgrade a finished bin or turn into an unnoted dose', () => {
    const f = prepare();
    Services.binAction(f.player, f.patch, '');
    Object.assign(f.bin(), { count: 15, open: true, closedAt: Date.now() - 100 * 60_000 });
    const id = f.add('Compost potion(4)', true);
    assert.equal(f.bin().tier, 1);
    assert.equal(f.inventory.getAmount(id), 1);
    assert.equal(f.inventory.getAmount(Data.itemId('Compost potion(3)')), 0);
});
test('existing ingredient tiers, excluded items and full-bin capacity remain effective', () => {
    for (const [name, tier] of [['Potato', 1], ['Watermelon', 2], ['Tomato', 4]]) {
        const f = prepare();
        f.add(name); assert.equal(f.bin().tier, tier, name);
    }
    const f = prepare();
    for (const name of ['Cactus spine', 'Magic logs', 'Nightshade']) {
        const id = f.add(name); assert.equal(f.inventory.getAmount(id), 1, name);
        assert.equal(f.bin().count, 0, name);
    }
    for (let i = 0; i < 16; i++) f.add('Potato');
    assert.equal(f.bin().count, 15);
    assert.equal(f.inventory.getAmount(Data.itemId('Potato')), 1);
});
