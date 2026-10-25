const assert = require('node:assert/strict');
const { test, before } = require('node:test');
require('../dist/Server').Server.installProductionPathResolver();
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { PluginManager } = require('../dist/plugins/PluginManager');
const { Player } = require('../dist/game/entity/impl/player/Player');
let core, Data, Patches, Hespori;
before(async () => {
    await CachePipeline.initialize(require('node:path').resolve(__dirname, '..'));
    core = PluginManager.getCoreApi();
    require('../plugins/skills/farming/Core.Farming').init({ core });
    Data = require('../plugins/skills/farming/Data.Farming');
    Patches = require('../plugins/skills/farming/Patches.Farming');
    Hespori = require('../plugins/skills/farming/Hespori.Farming');
    Data.initializeFarmingData();
});
function prepare(t, { coins = 30000, paid = false } = {}) {
    const player = new Player(null), messages = [];
    const sender = new Proxy({}, { get: () => () => sender });
    player.getPacketSender = () => sender;
    player.sendMessage = text => messages.push(text);
    player.moveTo(new core.Location(1232, 3728, 0));
    if (coins) player.getInventory().add(new core.Item(core.ItemIdentifiers.COINS, coins), false);
    const item = Data.itemId('Spade');
    const farm = { offset: 0, patches: {}, tools: {}, deathbank: [{ id: item, amount: 1 }], deathbankPaid: paid };
    player.setAttribute(Patches.FARM_ATTRIBUTE, farm);
    let entries;
    t.mock.method(Patches, 'choose', (_player, options) => { entries = options; });
    const event = { player, npc: { getLocation: () => new core.Location(1232, 3728, 0) },
        definition: { getName: () => 'Arno', getActions: () => ['Talk-to', 'Collect'] }, clickType: 2 };
    Hespori.hesporiNpc(event);
    assert.equal(event.handled, true);
    return { player, farm, item, messages, collect: () => entries[0][1](),
        coins: () => player.getInventory().getAmount(core.ItemIdentifiers.COINS) };
}
test('Arno accepts exactly 25000 ordinary coins and returns the stored item', t => {
    const f = prepare(t);
    f.collect();
    assert.equal(f.coins(), 5000);
    assert.equal(f.farm.deathbankPaid, true);
    assert.equal(f.farm.deathbank.length, 0);
    assert.equal(f.player.getInventory().getAmount(f.item), 1);
    f.collect();
    assert.equal(f.coins(), 5000);
});
test('insufficient ordinary coins preserve both currency and stored items', t => {
    const f = prepare(t, { coins: 24999 });
    f.collect();
    assert.equal(f.coins(), 24999);
    assert.equal(f.farm.deathbankPaid, false);
    assert.equal(f.farm.deathbank.length, 1);
    assert.equal(f.player.getInventory().getAmount(f.item), 0);
});
test('an exact fee balance is accepted and consumes the entire coin stack', t => {
    const f = prepare(t, { coins: 25000 });
    f.collect();
    assert.equal(f.coins(), 0);
    assert.equal(f.farm.deathbankPaid, true);
    assert.equal(f.player.getInventory().getAmount(f.item), 1);
    assert.equal(f.farm.deathbank.length, 0);
});
test('an already paid retrieval needs no additional coins', t => {
    const f = prepare(t, { coins: 0, paid: true });
    f.collect();
    assert.equal(f.coins(), 0);
    assert.equal(f.player.getInventory().getAmount(f.item), 1);
    assert.equal(f.farm.deathbank.length, 0);
});
test('leaving Arno before confirmation takes no payment or items', t => {
    const f = prepare(t);
    f.player.moveTo(new core.Location(3200, 3200, 0));
    f.collect();
    assert.equal(f.coins(), 30000);
    assert.equal(f.farm.deathbankPaid, false);
    assert.equal(f.farm.deathbank.length, 1);
});
