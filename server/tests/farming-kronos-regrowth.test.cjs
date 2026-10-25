const assert = require('node:assert/strict');
const { test } = require('node:test');
require('../dist/game/World');
const { PluginManager } = require('../dist/plugins/PluginManager');
require('../plugins/skills/farming/Core.Farming').init({ core: PluginManager.getCoreApi() });
const Data = require('../plugins/skills/farming/Data.Farming');
const Model = require('../plugins/skills/farming/Model.Farming');
for (const key of ['APPLE', 'REDBERRIES', 'CACTUS', 'POTATO_CACTUS', 'RANARR', 'KRONOS'])
    Data.CROPS.set(key, { ...Data.CACHE.timing[key], key });
const now = Date.UTC(2026, 9, 24), anima = Data.CACHE.patches.find(p => p.type === 'ANIMA');
function prepare(cropKey = 'CACTUS', kronos = true) {
    const crop = Data.CROPS.get(cropKey), patch = Data.CACHE.patches.find(p => p.type === crop.type);
    const farm = { offset: 0, patches: {}, tools: {} };
    if (kronos) farm.patches[Data.patchKey(anima)] = { ...Model.emptyPatch(now, farm), crop: 'KRONOS',
        nextAt: now + 640 * Model.MINUTE };
    const state = { ...Model.emptyPatch(now, farm), crop: cropKey, stage: crop.stages, status: 'grown',
        checked: true, lives: 0, nextAt: Model.nextGrowth(now, crop.regrow, farm.offset) };
    farm.patches[Data.patchKey(patch)] = state;
    return { farm, patch, state };
}
function rolls(values) { let index = 0; return () => values[index++] ?? 0.99; }
test('Kronos accelerates fruit, berry and cactus regrowth by the selected skip count', () => {
    for (const crop of ['APPLE', 'REDBERRIES', 'CACTUS', 'POTATO_CACTUS']) {
        const f = prepare(crop);
        Model.advanceFarm(f.farm, f.state.nextAt, rolls([0, 0.99]));
        assert.equal(f.state.lives, 2, crop);
        assert.equal(f.state.status, 'grown', crop);
    }
});
test('regrowth shares Kronos skips with growing crops of the same cycle length', () => {
    const f = prepare(), patch = Data.CACHE.patches.find(p => p.type === 'HERB' && p.x === 3058);
    const herb = { ...Model.emptyPatch(now, f.farm), crop: 'RANARR', protected: true, nextAt: f.state.nextAt };
    f.farm.patches[Data.patchKey(patch)] = herb;
    let calls = 0;
    Model.advanceFarm(f.farm, f.state.nextAt, () => { calls++; return calls === 1 ? 0 : 0.99; });
    assert.equal(f.state.lives, 2);
    assert.equal(herb.stage, 2);
    assert.equal(calls, 2, 'one shared skip decision, not one per patch');
});
test('repeatable skips cannot regrow more produce than the patch can hold', () => {
    const f = prepare('POTATO_CACTUS');
    Model.advanceFarm(f.farm, f.state.nextAt, () => 0);
    assert.equal(f.state.lives, 6);
});
test('offline regrowth stops receiving skips when the anima plant dies', () => {
    const f = prepare('POTATO_CACTUS'), plant = f.farm.patches[Data.patchKey(anima)];
    plant.stage = 7; plant.nextAt = now + 10 * Model.MINUTE;
    plant.plantedAt = now - 7 * 640 * Model.MINUTE;
    Model.advanceFarm(f.farm, now + 10 * Model.MINUTE, rolls([0, 0.99]));
    assert.equal(f.state.lives, 3, 'two regrown at minute five, one at anima death');
    assert.equal(plant.status, 'dead');
});
test('offline, stepped and save/load regrowth reach identical state', () => {
    const f = prepare('POTATO_CACTUS'), stepped = JSON.parse(JSON.stringify(f.farm)), saved = JSON.parse(JSON.stringify(f.farm));
    const end = now + 20 * Model.MINUTE, sequence = [0, 0.99, 0.99, 0, 0.99, 0.99];
    Model.advanceFarm(f.farm, end, rolls(sequence));
    Model.advanceFarm(saved, end, rolls(sequence));
    const random = rolls(sequence);
    for (let at = now; at <= end; at += Model.MINUTE) Model.advanceFarm(stepped, at, random);
    assert.deepEqual(stepped, f.farm);
    assert.deepEqual(saved, f.farm);
});
test('overdue regrowth sees Kronos only after the seed was planted', () => {
    const f = prepare('POTATO_CACTUS');
    f.farm.patches[Data.patchKey(anima)].plantedAt = now + 7 * Model.MINUTE;
    Model.advanceFarm(f.farm, now + 20 * Model.MINUTE, rolls([0, 0.99]));
    assert.equal(f.state.lives, 5, 'one ordinary tick, then a doubled tick and two ordinary rolls');
});
test('ordinary regrowth retains its fast-forward behavior without anima', () => {
    const f = prepare('APPLE', false), end = now + 365 * 1440 * Model.MINUTE;
    Model.advanceFarm(f.farm, end, () => { throw new Error('ordinary regrowth must not roll Kronos'); });
    assert.equal(f.state.lives, 6);
    assert.ok(f.state.nextAt > end);
});
