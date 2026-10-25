const assert = require('node:assert/strict');
const { test, before } = require('node:test');
require('../dist/Server').Server.installProductionPathResolver();
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { PluginManager } = require('../dist/plugins/PluginManager');
const { Player } = require('../dist/game/entity/impl/player/Player');
let core, Data, Guild;
const MAX_STACK = 2147483647;
before(async () => {
    await CachePipeline.initialize(require('node:path').resolve(__dirname, '..'));
    core = PluginManager.getCoreApi();
    require('../plugins/skills/farming/Core.Farming').init({ core });
    Data = require('../plugins/skills/farming/Data.Farming');
    Guild = require('../plugins/skills/farming/Guild.Farming');
    Data.initializeFarmingData();
});
function prepare() {
    const player = new Player(null), messages = [];
    const sender = new Proxy({}, { get: () => () => sender });
    player.getPacketSender = () => sender; player.sendMessage = text => messages.push(text);
    const herb = Data.itemId('Grimy guam leaf'), id = Data.itemId('Herb box');
    player.getInventory().add(new core.Item(id, 1, { 'farming:rewards': Array.from({ length: 7 }, () => ({ id: herb, count: 1 })) }), false);
    const box = player.getInventory().forSlot(0), bank = player.getBank(0);
    const take = (option = 'Bank-all') => Guild.rewardItem({ player, itemId: box.getId(), slot: 0, option });
    return { player, box, bank, herb, take, messages, inventory: player.getInventory(),
        rewards: () => box.getMetaValue('farming:rewards') };
}
test('a capped bank stack leaves every herb and the unopened box intact', () => {
    const f = prepare();
    f.bank.add(new core.Item(f.herb, MAX_STACK), false);
    f.take();
    assert.equal(f.bank.getAmount(f.herb), MAX_STACK);
    assert.equal(f.box.getId(), Data.itemId('Herb box'));
    assert.equal(f.rewards().length, 7);
});
test('Bank-all keeps remaining rewards and opens the box after a partial transfer', () => {
    const f = prepare();
    f.bank.add(new core.Item(f.herb, MAX_STACK - 1), false);
    f.take();
    assert.equal(f.bank.getAmount(f.herb), MAX_STACK);
    assert.equal(f.rewards().length, 6);
    assert.equal(f.box.getId(), Data.itemId('Open herb box'));
    f.take();
    assert.equal(f.rewards().length, 6);
    f.bank.deleteNumber(f.herb, 6);
    f.take();
    assert.equal(f.bank.getAmount(f.herb), MAX_STACK);
    assert.equal(f.inventory.getAmount(Data.itemId('Open herb box')), 0);
});
test('a full bank with metadata-incompatible herbs cannot consume a reward', () => {
    const f = prepare(), spade = Data.itemId('Spade');
    const items = Array.from({ length: f.bank.capacity() }, (_, slot) => new core.Item(spade, 1, { slot }));
    items[0] = new core.Item(f.herb, MAX_STACK, { source: 'fixture' });
    f.bank.setItems(items);
    f.take();
    assert.equal(f.rewards().length, 7);
    assert.equal(f.box.getId(), Data.itemId('Herb box'));
    assert.deepEqual(f.bank.forSlot(0).getMeta(), { source: 'fixture' });
});
test('successful Bank-all returns all seven herbs and removes the exhausted box', () => {
    const f = prepare();
    f.take();
    assert.equal(f.bank.getAmount(f.herb), 7);
    assert.equal(f.inventory.getAmount(Data.itemId('Herb box')), 0);
    assert.equal(f.inventory.getAmount(Data.itemId('Open herb box')), 0);
});
test('Take-all also updates the box variant after an inventory fills partway through', () => {
    const f = prepare();
    f.inventory.add(new core.Item(Data.itemId('Spade'), 26), false);
    f.take('Take-all');
    assert.equal(f.inventory.getAmount(f.herb), 1);
    assert.equal(f.rewards().length, 6);
    assert.equal(f.box.getId(), Data.itemId('Open herb box'));
});
test('a full inventory leaves an untouched box unopened and keeps every reward', () => {
    const f = prepare();
    f.inventory.add(new core.Item(Data.itemId('Spade'), 27), false);
    f.take('Take-one');
    assert.equal(f.inventory.getAmount(f.herb), 0);
    assert.equal(f.rewards().length, 7);
    assert.equal(f.box.getId(), Data.itemId('Herb box'));
});
test('a Seed pack retains an entire stacked reward that will not fit, then resumes without loss', () => {
    const f = prepare(), seed = Data.CROPS.get('GUAM').seed;
    f.box.setId(Data.itemId('Seed pack'));
    f.box.setMetaValue('farming:rewards', [{ id: seed, count: 5 }, { id: seed, count: 2 }]);
    f.bank.add(new core.Item(seed, MAX_STACK - 4), false);
    f.take();
    assert.equal(f.bank.getAmount(seed), MAX_STACK - 4);
    assert.deepEqual(f.rewards(), [{ id: seed, count: 5 }, { id: seed, count: 2 }]);
    assert.equal(f.box.getId(), Data.itemId('Seed pack'));
    f.bank.deleteNumber(seed, 3);
    f.take();
    assert.equal(f.bank.getAmount(seed), MAX_STACK);
    assert.equal(f.inventory.getAmount(Data.itemId('Seed pack')), 0);
});
