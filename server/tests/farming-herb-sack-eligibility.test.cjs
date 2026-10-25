const assert = require('node:assert/strict');
const { test, before } = require('node:test');
require('../dist/Server').Server.installProductionPathResolver();
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { PluginManager } = require('../dist/plugins/PluginManager');
const { Player } = require('../dist/game/entity/impl/player/Player');
let core, Data, Guild;
before(async () => {
    await CachePipeline.initialize(require('node:path').resolve(__dirname, '..'));
    core = PluginManager.getCoreApi();
    require('../plugins/skills/farming/Core.Farming').init({ core });
    Data = require('../plugins/skills/farming/Data.Farming');
    Guild = require('../plugins/skills/farming/Guild.Farming');
    Data.initializeFarmingData();
});
function prepare(name = 'Herb sack') {
    const player = new Player(null), sender = new Proxy({}, { get: () => () => sender });
    player.getPacketSender = () => sender; player.sendMessage = () => {};
    player.getSkillManager().setCurrentLevel(core.Skill.HERBLORE, 99, false);
    player.getInventory().add(new core.Item(Data.itemId(name)), false);
    return { player, sack: player.getInventory().forSlot(0), inventory: player.getInventory(),
        stored() { return this.sack.getMetaValue('farming:stored') ?? {}; } };
}
test('goutweed is refused by both open and closed herb sacks without changing storage', () => {
    for (const name of ['Herb sack', 'Open herb sack']) {
        const f = prepare(name);
        assert.equal(Guild.storeCrop(f.player, f.sack, Data.CROPS.get('GOUTWEED').produce, 1), 0, name);
        assert.deepEqual(f.stored(), {}, name);
    }
});
test('Fill stores every normal grimy herb, including huasca, while leaving goutweed in inventory', () => {
    const f = prepare(), goutweed = Data.CROPS.get('GOUTWEED').produce;
    const herbs = [...Data.CROPS.values()].filter(c => c.type === 'HERB'
        && core.CacheDefinitions.getItem(c.produce).name.startsWith('Grimy '));
    assert.equal(herbs.length, 15);
    f.inventory.add(new core.Item(goutweed), false);
    for (const herb of herbs) f.inventory.add(new core.Item(herb.produce), false);
    Guild.storageAction({ player: f.player, itemId: f.sack.getId(), slot: 0, option: 'Fill' });
    assert.equal(f.inventory.getAmount(goutweed), 1);
    assert.equal(f.stored()[goutweed], undefined);
    for (const herb of herbs) {
        assert.equal(f.stored()[herb.produce], 1, herb.key);
        assert.equal(f.inventory.getAmount(herb.produce), 0, herb.key);
    }
});
test('using goutweed on a sack leaves the item untouched', () => {
    const f = prepare(), goutweed = Data.CROPS.get('GOUTWEED').produce;
    f.inventory.add(new core.Item(goutweed), false);
    const event = { player: f.player, usedItemId: goutweed, usedItemSlot: 1,
        usedWithItemId: f.sack.getId(), usedWithItemSlot: 0 };
    Guild.storagePair(event);
    assert.equal(event.handled, true);
    assert.equal(f.inventory.getAmount(goutweed), 1);
    assert.deepEqual(f.stored(), {});
});
test('clean herbs, noted herbs and coral remain excluded', () => {
    const f = prepare(), guam = Data.CROPS.get('GUAM').produce;
    const note = core.CacheDefinitions.getItem(guam).note;
    assert.ok(note > 0);
    for (const id of [Data.itemId('Guam leaf'), note, Data.CROPS.get('ELKHORN_CORAL').produce])
        assert.equal(Guild.storeCrop(f.player, f.sack, id, 1), 0, id);
    assert.deepEqual(f.stored(), {});
});
test('normal herb capacity and seed-box storage are unchanged', () => {
    const f = prepare(), guam = Data.CROPS.get('GUAM');
    assert.equal(Guild.storeCrop(f.player, f.sack, guam.produce, 35), 30);
    assert.equal(Guild.storeCrop(f.player, f.sack, guam.produce, 1), 0);
    const seeds = prepare('Seed box');
    for (const crop of [guam, Data.CROPS.get('ELKHORN_CORAL')])
        assert.equal(Guild.storeCrop(seeds.player, seeds.sack, crop.seed, 2), 2, crop.key);
});
