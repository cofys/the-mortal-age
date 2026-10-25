const assert = require('node:assert/strict');
const { test, before } = require('node:test');
const { Server } = require('../dist/Server');
Server.installProductionPathResolver();
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { PluginManager } = require('../dist/plugins/PluginManager');
const { Player } = require('../dist/game/entity/impl/player/Player');
const FarmingCore = require('../plugins/skills/farming/Core.Farming');
let core, Data, Patches, Services, Model;
before(async () => {
    await CachePipeline.initialize(require('node:path').resolve(__dirname, '..'));
    core = PluginManager.getCoreApi(); FarmingCore.init({ core });
    Data = require('../plugins/skills/farming/Data.Farming');
    Patches = require('../plugins/skills/farming/Patches.Farming');
    Services = require('../plugins/skills/farming/Services.Farming');
    Model = require('../plugins/skills/farming/Model.Farming');
    Data.initializeFarmingData();
});
function prepare(t, key = 'OAK', { coins = 3000, checked = true } = {}) {
    const p = new Player(null), messages = [], varbits = new Map();
    p.setUsername('gardener-fixture');
    const sender = new Proxy({}, { get: (_, name) => name === 'getVarbit' ? id => varbits.get(id) ?? 0
        : name === 'sendVarbit' ? (id, value) => { varbits.set(id, value); return sender; } : () => sender });
    p.getPacketSender = () => sender; p.sendMessage = text => messages.push(text);
    const crop = Data.CROPS.get(key), patch = Data.CACHE.patches.find(p => p.type === crop.type);
    p.moveTo(new core.Location(patch.x, patch.y, patch.z));
    p.getInventory().add(new core.Item(core.ItemIdentifiers.COINS, coins), false);
    const farm = { offset: 0, patches: {}, tools: {} };
    const state = { ...Model.emptyPatch(Date.now(), farm), crop: key, stage: crop.stages, status: 'grown', checked, lives: 1 };
    farm.patches[Data.patchKey(patch)] = state; p.setAttribute(Patches.FARM_ATTRIBUTE, farm);
    let options;
    t.mock.method(Patches, 'choose', (_p, entries) => { options = entries; });
    t.mock.method(FarmingCore.MapObjects, 'get', () => null);
    const event = { player: p, npc: { getLocation: () => new core.Location(patch.x, patch.y, patch.z) },
        definition: { getName: () => 'Gardener', getActions: () => ['Talk-to', 'Pay'] }, clickType: 2 };
    Services.farmingNpc(event);
    assert.equal(event.handled, true);
    return { p, patch, state, farm, pay: () => options[0][1](), messages,
        coins: () => p.getInventory().getAmount(core.ItemIdentifiers.COINS),
        current: () => farm.patches[Data.patchKey(patch)] };
}
test('checked ordinary and fruit trees can be removed for exactly 200 real coins', t => {
    for (const crop of ['OAK', 'APPLE']) {
        const f = prepare(t, crop);
        f.pay();
        assert.equal(f.coins(), 2800, crop);
        assert.equal(f.current().crop, undefined, crop);
    }
});
test('Alexandra removes a checked redwood for exactly 2000 real coins', t => {
    const f = prepare(t, 'REDWOOD');
    f.pay();
    assert.equal(f.coins(), 1000);
    assert.equal(f.current().crop, undefined);
});
test('insufficient currency and unchecked trees leave inventory and patch intact', t => {
    for (const [crop, options] of [['OAK', { coins: 199 }], ['REDWOOD', { coins: 1999 }], ['OAK', { checked: false }]]) {
        const f = prepare(t, crop, options), before = f.coins();
        f.pay();
        assert.equal(f.coins(), before);
        assert.equal(f.current(), f.state);
    }
});
test('stale and repeated confirmations cannot charge twice or remove a replacement crop', t => {
    const f = prepare(t);
    f.pay(); f.pay();
    assert.equal(f.coins(), 2800);
    const replacement = { ...f.state };
    f.farm.patches[Data.patchKey(f.patch)] = replacement;
    f.pay();
    assert.equal(f.coins(), 2800);
    assert.equal(f.current(), replacement);
});
test('walking away before confirmation takes no currency and clears no crop', t => {
    const f = prepare(t);
    f.p.getLocation().setX(f.patch.x + 100);
    f.pay();
    assert.equal(f.coins(), 3000);
    assert.equal(f.current(), f.state);
});
