const assert = require('node:assert/strict');
const { test, before } = require('node:test');
require('../dist/Server').Server.installProductionPathResolver();
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { PluginManager } = require('../dist/plugins/PluginManager');
const { Player } = require('../dist/game/entity/impl/player/Player');
let core, Data, Services;
before(async () => {
    await CachePipeline.initialize(require('node:path').resolve(__dirname, '..'));
    core = PluginManager.getCoreApi();
    require('../plugins/skills/farming/Core.Farming').init({ core });
    Data = require('../plugins/skills/farming/Data.Farming');
    Services = require('../plugins/skills/farming/Services.Farming');
    Data.initializeFarmingData();
});
function prepare(name = 'Weeds', { amount = 3, filler = 0, falador = false, noted = false } = {}) {
    const player = new Player(null), messages = [];
    const sender = new Proxy({}, { get: () => () => sender });
    player.getPacketSender = () => sender; player.sendMessage = text => messages.push(text);
    const id = Data.itemId(name), note = core.CacheDefinitions.getItem(id).note;
    const used = noted ? note : id, inventory = player.getInventory();
    inventory.add(new core.Item(used, amount), false);
    if (filler) inventory.add(new core.Item(Data.itemId('Spade'), filler), false);
    const event = { player, itemId: used, slot: inventory.getSlotForItemId(used),
        target: { getLocation: () => new core.Location(falador ? 3055 : 2810, falador ? 3300 : 3464, 0) },
        definition: { getName: () => 'Tool Leprechaun' } };
    return { id, note, inventory, messages, exchange: () => Services.farmingItemOnNpc(event) };
}
test('the leprechaun converts all weeds to their cache-backed bank notes', () => {
    const f = prepare();
    assert.ok(f.note > 0);
    f.exchange();
    assert.equal(f.inventory.getAmount(f.id), 0);
    assert.equal(f.inventory.getAmount(f.note), 3);
});
test('weeds noting can reuse space freed from a full inventory', () => {
    const f = prepare('Weeds', { amount: 27, filler: 1 });
    assert.equal(f.inventory.getFreeSlots(), 0);
    f.exchange();
    assert.equal(f.inventory.getAmount(f.id), 0);
    assert.equal(f.inventory.getAmount(f.note), 27);
    assert.equal(f.inventory.getAmount(Data.itemId('Spade')), 1);
});
test('Falador leprechaun accepts weeds while keeping its cabbage refusal', () => {
    const weeds = prepare('Weeds', { falador: true });
    weeds.exchange();
    assert.equal(weeds.inventory.getAmount(weeds.note), 3);
    const cabbage = prepare('Cabbage', { falador: true });
    cabbage.exchange();
    assert.equal(cabbage.inventory.getAmount(cabbage.id), 3);
    assert.equal(cabbage.inventory.getAmount(cabbage.note), 0);
});
test('noted weeds are left unchanged', () => {
    const f = prepare('Weeds', { noted: true });
    f.exchange();
    assert.equal(f.inventory.getAmount(f.note), 3);
    assert.equal(f.inventory.getAmount(f.id), 0);
});
test('logs remain ineligible, while ordinary crop and branch noting still work', () => {
    for (const name of ['Oak logs', 'Potato', 'Willow branch']) {
        const f = prepare(name);
        f.exchange();
        assert.equal(f.inventory.getAmount(f.id), name === 'Oak logs' ? 3 : 0, name);
        assert.equal(f.inventory.getAmount(f.note), name === 'Oak logs' ? 0 : 3, name);
    }
});
