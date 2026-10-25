const assert = require('node:assert/strict');
const { test } = require('node:test');
require('../dist/game/World');
const { PluginManager } = require('../dist/plugins/PluginManager');
require('../plugins/skills/farming/Core.Farming').init({ core: PluginManager.getCoreApi() });
const Data = require('../plugins/skills/farming/Data.Farming');
const Model = require('../plugins/skills/farming/Model.Farming');
for (const key of ['RANARR', 'KRONOS']) Data.CROPS.set(key, { ...Data.CACHE.timing[key], key });
const herb = Data.CACHE.patches.find(p => p.type === 'HERB' && p.x === 3058);
const second = Data.CACHE.patches.find(p => p.type === 'HERB' && p.x === 2813);
const anima = Data.CACHE.patches.find(p => p.type === 'ANIMA');
const now = Date.UTC(2026, 9, 24), at = Model.nextGrowth(now, 20, 0);
function prepare({ protectedCrop = false, two = false } = {}) {
    const farm = { offset: 0, patches: {}, tools: {} };
    farm.patches[Data.patchKey(anima)] = { ...Model.emptyPatch(now, farm), crop: 'KRONOS', nextAt: Model.nextGrowth(now, 640, 0) };
    for (const patch of two ? [herb, second] : [herb]) farm.patches[Data.patchKey(patch)] = {
        ...Model.emptyPatch(now, farm), crop: 'RANARR', nextAt: at, protected: protectedCrop
    };
    return farm;
}
function rolls(values) {
    let index = 0;
    return () => values[index++] ?? 0.99;
}
const state = (farm, patch = herb) => farm.patches[Data.patchKey(patch)];
test('a skipped cycle stops at the first stage that becomes diseased', () => {
    const farm = prepare();
    Model.advanceFarm(farm, at, rolls([0, 0, 0.99, 0]));
    assert.equal(state(farm).status, 'diseased');
    assert.equal(state(farm).stage, 1);
    assert.equal(state(farm).nextAt, Model.nextGrowth(at, 40, 0));
});
test('a later skipped stage makes its own disease roll', () => {
    const farm = prepare();
    Model.advanceFarm(farm, at, rolls([0, 0, 0.99, 0.99, 0]));
    assert.equal(state(farm).status, 'diseased');
    assert.equal(state(farm).stage, 2);
});
test('enough Kronos skips to mature cannot bypass disease in an earlier stage', () => {
    const farm = prepare();
    Model.advanceFarm(farm, at, rolls([0, 0, 0, 0.99, 0]));
    assert.equal(state(farm).status, 'diseased');
    assert.equal(state(farm).stage, 1);
    assert.equal(state(farm).lives, 0);
});
test('the skip count is shared while disease outcomes remain per patch', () => {
    const farm = prepare({ two: true });
    Model.advanceFarm(farm, at, rolls([0, 0.99, 0, 0.99, 0.99]));
    assert.equal(state(farm).status, 'diseased');
    assert.equal(state(farm).stage, 1);
    assert.equal(state(farm, second).status, 'growing');
    assert.equal(state(farm, second).stage, 2);
});
test('protected crops still skip normally and mature with the original harvest lives', () => {
    const farm = prepare({ protectedCrop: true });
    Model.advanceFarm(farm, at, rolls([0, 0, 0, 0.99]));
    assert.equal(state(farm).stage, 4);
    assert.equal(state(farm).status, 'grown');
    assert.equal(state(farm).lives, 3);
});
test('Kronos disease and death agree for offline, stepped and saved growth', () => {
    const farm = prepare(), stepped = JSON.parse(JSON.stringify(farm)), persisted = JSON.parse(JSON.stringify(farm));
    const sequence = [0, 0, 0.99, 0], end = at + 80 * Model.MINUTE;
    Model.advanceFarm(farm, end, rolls(sequence));
    Model.advanceFarm(persisted, end, rolls(sequence));
    const random = rolls(sequence);
    for (let time = now; time <= end; time += Model.MINUTE) Model.advanceFarm(stepped, time, random);
    assert.equal(state(farm).status, 'dead');
    assert.equal(state(farm).stage, 1);
    assert.deepEqual(stepped, farm);
    assert.deepEqual(persisted, farm);
});
test('anima itself never consumes a Kronos skip or disease roll', () => {
    const farm = prepare();
    delete farm.patches[Data.patchKey(herb)];
    let calls = 0;
    Model.advanceFarm(farm, state(farm, anima).nextAt, () => { calls++; return 0; });
    assert.equal(state(farm, anima).stage, 1);
    assert.equal(calls, 0);
});
