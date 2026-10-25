const assert = require('node:assert/strict');
const { before, test } = require('node:test');
require('../dist/Server').Server.installProductionPathResolver();
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { PluginManager } = require('../dist/plugins/PluginManager');
const { Player } = require('../dist/game/entity/impl/player/Player');
let core, Data, Guild, Common;
before(async () => {
    await CachePipeline.initialize(require('node:path').resolve(__dirname, '..'));
    core = PluginManager.getCoreApi();
    require('../plugins/skills/farming/Core.Farming').init({ core });
    Data = require('../plugins/skills/farming/Data.Farming');
    Guild = require('../plugins/skills/farming/Guild.Farming');
    Common = require('../plugins/skills/herblore/Common.Herblore');
    Common.init({ core });
    Data.initializeFarmingData();
});
function fixture(t, herbs, free = 1, name = 'Herb sack') {
    const player = new Player(null), sender = new Proxy({}, { get: () => () => sender });
    player.getPacketSender = () => sender; player.sendMessage = () => {};
    t.mock.method(core.PluginManager, 'emitCustomEvent', (name, event) => {
        if (name === 'herblore:clean') Common.answerClean(event);
    });
    const inventory = player.getInventory(), id = Data.itemId(name);
    inventory.add(new core.Item(id, 1, { 'farming:stored': Object.fromEntries(herbs.map(([name, n]) => [Data.itemId(name), n])) }), false);
    for (let i = 0; i < 27 - free; i++) inventory.add(new core.Item(Data.itemId('Spade')), false);
    const sack = inventory.forSlot(0);
    return { inventory, stored: () => sack.getMetaValue('farming:stored'), empty: () => Guild.storageAction({ player, slot: 0, itemId: id, option: 'Empty' }) };
}
test('Empty prioritizes Toadflax over Irit despite item-ID order, for both sack variants', t => {
    for (const sack of ['Herb sack', 'Open herb sack']) {
        const f = fixture(t, [['Grimy irit leaf', 2], ['Grimy toadflax', 2]], 1, sack);
        f.empty();
        assert.equal(f.inventory.getAmount(Data.itemId('Grimy toadflax')), 1);
        assert.equal(f.inventory.getAmount(Data.itemId('Grimy irit leaf')), 0);
        assert.deepEqual(f.stored(), { [Data.itemId('Grimy irit leaf')]: 2, [Data.itemId('Grimy toadflax')]: 1 });
    }
});
test('Empty uses Herblore levels: Huasca precedes Snapdragon although its Farming level is higher', t => {
    const f = fixture(t, [['Grimy snapdragon', 1], ['Grimy huasca', 1]]);
    f.empty();
    assert.equal(f.inventory.getAmount(Data.itemId('Grimy huasca')), 1);
    assert.deepEqual(f.stored(), { [Data.itemId('Grimy snapdragon')]: 1 });
});
test('Empty exhausts a lower-level herb before advancing and resumes after space is freed', t => {
    const f = fixture(t, [['Grimy irit leaf', 1], ['Grimy toadflax', 2]], 2);
    f.empty();
    assert.equal(f.inventory.getAmount(Data.itemId('Grimy toadflax')), 2);
    assert.deepEqual(f.stored(), { [Data.itemId('Grimy irit leaf')]: 1 });
    f.inventory.deleteNumber(Data.itemId('Grimy toadflax'), 1);
    f.empty();
    assert.equal(f.inventory.getAmount(Data.itemId('Grimy irit leaf')), 1);
    assert.deepEqual(f.stored(), {});
});
test('a full inventory leaves every stored herb unchanged', t => {
    const f = fixture(t, [['Grimy toadflax', 2]], 0);
    f.empty();
    assert.deepEqual(f.stored(), { [Data.itemId('Grimy toadflax')]: 2 });
});
test('the canonical clean-herb query reports the cleaning level without changing its clean ID', () => {
    const request = { grimyId: Data.itemId('Grimy huasca') };
    Common.answerClean(request);
    assert.equal(request.clean, Data.itemId('Huasca'));
    assert.equal(request.level, 58);
});
