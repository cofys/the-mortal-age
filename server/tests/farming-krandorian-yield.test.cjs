const assert = require('node:assert/strict');
const { test, before } = require('node:test');
require('../dist/Server').Server.installProductionPathResolver();
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { PluginManager } = require('../dist/plugins/PluginManager');
let Data, Model, crop;
before(async () => {
    await CachePipeline.initialize(require('node:path').resolve(__dirname, '..'));
    require('../plugins/skills/farming/Core.Farming').init({ core: PluginManager.getCoreApi() });
    Data = require('../plugins/skills/farming/Data.Farming');
    Model = require('../plugins/skills/farming/Model.Farming');
    Data.initializeFarmingData();
    crop = Data.CROPS.get('KRANDORIAN');
});
test('Krandorian chance matches the published low endpoint and level-21 interpolation', () => {
    // Wiki calculator low=121, high=180: level21 rounds the interpolated numerator to133, then adds1.
    assert.equal(Model.saveLifeChance(crop, 1), 122 / 256);
    assert.equal(Model.saveLifeChance(crop, 21), 134 / 256);
    assert.equal(Model.saveLifeChance(crop, 50), 152 / 256);
});
test('Krandorian secateurs and Attas use the corrected endpoint in the existing boost order', () => {
    assert.equal(Model.saveLifeChance(crop, 21, true), 147 / 256);
    assert.equal(Model.saveLifeChance(crop, 21, true, false, 0, true), 154 / 256);
});
test('the published high endpoint and level cap remain unchanged', () => {
    assert.equal(Model.saveLifeChance(crop, 99), 181 / 256);
    assert.equal(Model.saveLifeChance(crop, 120), 181 / 256);
    assert.equal(Model.saveLifeChance(crop, 99, true), 199 / 256);
});
test('compost lives and neighbouring hops chances remain unchanged', () => {
    assert.deepEqual([0, 1, 2, 3].map(tier => Model.startingLives(crop, tier)), [3, 4, 5, 6]);
    assert.equal(Model.saveLifeChance(Data.CROPS.get('ASGARNIAN'), 1), 109 / 256);
    assert.equal(Model.saveLifeChance(Data.CROPS.get('WILDBLOOD'), 1), 129 / 256);
});
