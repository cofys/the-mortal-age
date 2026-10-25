const assert = require('node:assert/strict');
const { test, before } = require('node:test');
require('../dist/Server').Server.installProductionPathResolver();
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { PluginManager } = require('../dist/plugins/PluginManager');
const { Player } = require('../dist/game/entity/impl/player/Player');
let core, Data, Patches, Services;
const MAX_STACK = 2147483647;
before(async () => {
    await CachePipeline.initialize(require('node:path').resolve(__dirname, '..'));
    core = PluginManager.getCoreApi();
    require('../plugins/skills/farming/Core.Farming').init({ core });
    Data = require('../plugins/skills/farming/Data.Farming');
    Patches = require('../plugins/skills/farming/Patches.Farming');
    Services = require('../plugins/skills/farming/Services.Farming');
    Data.initializeFarmingData();
});
function prepare(t, { filler = 0, seeds = 0, disabled = false, roll = 0 } = {}) {
    const player = new Player(null), messages = [], dropped = [], petRolls = [];
    const sender = new Proxy({}, { get: () => () => sender });
    player.getPacketSender = () => sender; player.sendMessage = text => messages.push(text);
    player.setAttribute(Patches.FARM_ATTRIBUTE, { offset: 0, patches: {}, tools: {}, disableHesporiSeeds: disabled });
    const inventory = player.getInventory(), id = Data.itemId('Hespori seed');
    if (seeds) inventory.add(new core.Item(id, seeds), false);
    if (filler) inventory.add(new core.Item(Data.itemId('Spade'), filler), false);
    t.mock.method(Math, 'random', () => roll);
    t.mock.method(core.ItemOnGroundManager, 'registers', (...args) => dropped.push(args));
    t.mock.method(core.PluginManager, 'emitCustomEvent', (name, request) => {
        if (name === 'farming:success') petRolls.push(request);
    });
    return { player, inventory, id, messages, dropped, petRolls,
        reward: (key = 'RANARR') => Services.cropRewards(player, Data.CROPS.get(key)),
        found: () => messages.filter(text => text.includes('find a Hespori seed')) };
}
test('a full inventory gets no seed or ground fallback, while the pet roll remains eligible', t => {
    const f = prepare(t, { filler: 28 });
    f.reward();
    assert.equal(f.inventory.getAmount(f.id), 0);
    assert.equal(f.dropped.length, 0);
    assert.equal(f.found().length, 0);
    assert.equal(f.petRolls.length, 1);
});
test('a full inventory can still receive one seed into an existing non-capped stack', t => {
    const f = prepare(t, { filler: 27, seeds: 10 });
    f.reward();
    assert.equal(f.inventory.getAmount(f.id), 11);
    assert.equal(f.dropped.length, 0);
    assert.equal(f.found().length, 1);
});
test('capped seed stacks do not report a reward with or without spare slots', t => {
    for (const filler of [0, 27]) {
        const f = prepare(t, { filler, seeds: MAX_STACK });
        f.reward();
        assert.equal(f.inventory.getAmount(f.id), MAX_STACK);
        assert.equal(f.dropped.length, 0);
        assert.equal(f.found().length, 0);
    }
});
test('a winning roll with room grants one seed and its success message', t => {
    const f = prepare(t);
    f.reward();
    assert.equal(f.inventory.getAmount(f.id), 1);
    assert.equal(f.found().length, 1);
    assert.equal(f.dropped.length, 0);
});
test('a failed inventory grant cannot announce or drop a seed', t => {
    const f = prepare(t);
    t.mock.method(Patches, 'give', () => false);
    f.reward();
    assert.equal(f.found().length, 0);
    assert.equal(f.dropped.length, 0);
});
test('disabled seeds and Hespori itself keep the pet event but never award another seed', t => {
    for (const [options, crop] of [[{ disabled: true }, 'RANARR'], [{}, 'HESPORI']]) {
        const f = prepare(t, options);
        f.reward(crop);
        assert.equal(f.inventory.getAmount(f.id), 0);
        assert.equal(f.petRolls.length, 1);
        assert.equal(f.found().length, 0);
    }
});
test('a losing seed roll does not grant or announce a seed', t => {
    const f = prepare(t, { roll: 0.99 });
    f.reward();
    assert.equal(f.inventory.getAmount(f.id), 0);
    assert.equal(f.found().length, 0);
    assert.equal(f.dropped.length, 0);
});
