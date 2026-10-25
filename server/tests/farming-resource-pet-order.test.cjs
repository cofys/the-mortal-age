const assert = require('node:assert/strict');
const { test, before } = require('node:test');
require('../dist/Server').Server.installProductionPathResolver();
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { PluginManager } = require('../dist/plugins/PluginManager');
const { Player } = require('../dist/game/entity/impl/player/Player');
let core, Data, Patches, Services, Pets, petId;
const events = new Map();
before(async () => {
    await CachePipeline.initialize(require('node:path').resolve(__dirname, '..'));
    core = PluginManager.getCoreApi();
    require('../plugins/skills/farming/Core.Farming').init({ core });
    Data = require('../plugins/skills/farming/Data.Farming');
    Patches = require('../plugins/skills/farming/Patches.Farming');
    Services = require('../plugins/skills/farming/Services.Farming');
    Data.initializeFarmingData();
    Pets = require('../plugins/npcs/Pets.plugin');
    const api = new Proxy({ core,
        getWorld: () => ({ sendMessage() {} }),
        getRegionManager: () => ({ blocked: () => true }),
        getItemOnGroundManager: () => ({ registerNonGlobal() {}, registerLocation() {} }),
        onCustomEvent: (name, handler) => events.set(name, handler),
        emitCustomEvent: (name, request) => events.get(name)?.(request),
    }, { get: (target, name) => target[name] ?? (() => {}) });
    Pets.register(api);
    petId = Pets.__internals.PETS.find(p => p.enumName === 'TANGLEROOT').itemId;
    assert.ok(petId > 0);
    assert.ok(events.has('farming:success'));
});
function prepare(t, { filler = 27, disabled = false, rolls = [0, 0] } = {}) {
    const player = new Player(null), messages = [], sender = new Proxy({}, { get: () => () => sender });
    player.setUsername('farming-pet-order-fixture');
    player.getPacketSender = () => sender; player.sendMessage = text => messages.push(text);
    player.setAttribute('pets:current', { isRegistered: () => true, getId: () => -1 });
    player.setAttribute(Patches.FARM_ATTRIBUTE, { offset: 0, patches: {}, tools: {}, disableHesporiSeeds: disabled });
    const inventory = player.getInventory(), seed = Data.itemId('Hespori seed');
    inventory.add(new core.Item(Data.itemId('Spade'), filler), false);
    let index = 0;
    t.mock.method(Math, 'random', () => rolls[index++] ?? 0);
    t.mock.method(core.PluginManager, 'emitCustomEvent', (name, request) => events.get(name)?.(request));
    t.mock.method(core.ItemOnGroundManager, 'registers', () => {});
    return { player, inventory, seed, messages,
        reward: (crop = 'RANARR') => Services.cropRewards(player, Data.CROPS.get(crop)),
        ownsPet: () => Pets.__internals.getOwnedPetItems(player).includes(petId) };
}
test('a winning resource keeps the last slot while Tangleroot is registered for Probita', t => {
    const f = prepare(t);
    f.reward();
    assert.equal(f.inventory.getAmount(f.seed), 1);
    assert.equal(f.inventory.getAmount(petId), 0);
    assert.equal(f.ownsPet(), true);
    assert.ok(f.messages.some(text => text.includes('Probita')));
});
test('with two slots both the seed and pet are delivered normally', t => {
    const f = prepare(t, { filler: 26 });
    f.reward();
    assert.equal(f.inventory.getAmount(f.seed), 1);
    assert.equal(f.inventory.getAmount(petId), 1);
    assert.equal(f.ownsPet(), true);
});
test('Arno seed opt-out does not suppress Tangleroot delivery', t => {
    const f = prepare(t, { disabled: true });
    f.reward();
    assert.equal(f.inventory.getAmount(f.seed), 0);
    assert.equal(f.inventory.getAmount(petId), 1);
});
test('Hespori itself still rolls Tangleroot without rewarding another Hespori seed', t => {
    const f = prepare(t);
    f.reward('HESPORI');
    assert.equal(f.inventory.getAmount(f.seed), 0);
    assert.equal(f.inventory.getAmount(petId), 1);
});
test('when the seed roll loses, a winning pet can use the remaining slot', t => {
    const f = prepare(t, { rolls: [0.99, 0] });
    f.reward();
    assert.equal(f.inventory.getAmount(f.seed), 0);
    assert.equal(f.inventory.getAmount(petId), 1);
});
