const assert = require('node:assert/strict');
const { test, before } = require('node:test');
require('../dist/Server').Server.installProductionPathResolver();
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { PluginManager } = require('../dist/plugins/PluginManager');
const { Player } = require('../dist/game/entity/impl/player/Player');
let core, Data, Model, Patches, hooks;
const CORALS = [['ELKHORN_CORAL', 85, 182], ['PILLAR_CORAL', 25, 180], ['UMBRAL_CORAL', -50, 178]];
before(async () => {
    await CachePipeline.initialize(require('node:path').resolve(__dirname, '..'));
    core = PluginManager.getCoreApi();
    require('../plugins/skills/farming/Core.Farming').init({ core });
    Data = require('../plugins/skills/farming/Data.Farming');
    Model = require('../plugins/skills/farming/Model.Farming');
    Patches = require('../plugins/skills/farming/Patches.Farming');
    Data.initializeFarmingData();
    hooks = {};
    Patches.attach(new Proxy({}, { get: (_, name) => (...args) => { hooks[name] = args[0]; } }));
});
test('all three coral species start with six lives, independently of compost', () => {
    for (const [key] of CORALS) for (const tier of [0, 1, 2, 3]) {
        assert.equal(Model.startingLives(Data.CROPS.get(key), tier), 6, `${key} tier ${tier}`);
    }
});
test('coral life-save chances use each published calculator endpoint', () => {
    for (const [key, low, high] of CORALS) {
        const crop = Data.CROPS.get(key);
        assert.equal(Model.saveLifeChance(crop, 99), (high + 1) / 256, key);
        assert.equal(Model.saveLifeChance(crop, 1), Math.max(0, (low + 1) / 256), key);
        // Independent level-requirement example using the Wiki's rounded interpolation.
        const expected = (1 + Math.floor((low * (99 - crop.level) + high * (crop.level - 1)) / 98 + 0.5)) / 256;
        assert.equal(Model.saveLifeChance(crop, crop.level), expected, key);
        assert.equal(Model.saveLifeChance(crop, 120), Model.saveLifeChance(crop, 99), key);
        assert.equal(Model.saveLifeChance(crop, 0), Model.saveLifeChance(crop, 1), key);
    }
});
test('saved mature coral keeps its remaining lives rather than being refilled on load', () => {
    const patch = Data.CACHE.patches.find(p => p.type === 'CORAL'), at = Date.UTC(2026, 9, 24);
    for (const [key] of CORALS) for (const lives of [1, 2, 3, 4]) {
        const farm = { offset: 0, patches: {}, tools: {} };
        farm.patches[Data.patchKey(patch)] = { ...Model.emptyPatch(at, farm), crop: key,
            status: 'grown', stage: Data.CROPS.get(key).stages, lives };
        const saved = JSON.parse(JSON.stringify(farm));
        Model.advanceFarm(saved, at + 365 * 1440 * Model.MINUTE, () => 0);
        assert.deepEqual(saved, farm, `${key} ${lives}`);
    }
});
test('secateurs and Attas affect coral while the herb-only cape bonus does not', () => {
    for (const [key, , high] of CORALS) {
        const crop = Data.CROPS.get(key);
        assert.equal(Model.saveLifeChance(crop, 99, true), (Math.floor(high * 1.1) + 1) / 256, key);
        assert.equal(Model.saveLifeChance(crop, 99, true, false, 0, true), (Math.floor(Math.floor(high * 1.1) * 1.05) + 1) / 256, key);
        assert.equal(Model.saveLifeChance(crop, 99, false, true), Model.saveLifeChance(crop, 99), key);
    }
});
test('coral completes with six lives identically online, offline and after JSON roundtrip', () => {
    const patch = Data.CACHE.patches.find(p => p.type === 'CORAL'), at = Date.UTC(2026, 9, 24);
    for (const [key] of CORALS) {
        const crop = Data.CROPS.get(key), farm = { offset: 0, patches: {}, tools: {} };
        const state = { ...Model.emptyPatch(at, farm), crop: key, protected: true, nextAt: Model.nextGrowth(at, crop.minutes, 0) };
        farm.patches[Data.patchKey(patch)] = state;
        const offline = structuredClone(farm), saved = JSON.parse(JSON.stringify(farm));
        const end = at + crop.minutes * crop.stages * Model.MINUTE;
        while (state.status !== 'grown') Model.advanceFarm(farm, state.nextAt, () => 0.999999);
        Model.advanceFarm(offline, end, () => 0.999999);
        Model.advanceFarm(saved, end, () => 0.999999);
        assert.equal(state.lives, 6, key);
        assert.deepEqual(offline, farm, key);
        assert.deepEqual(saved, farm, key);
    }
});
test('six failed life-save rolls produce six coral before clearing the patch', t => {
    t.mock.method(core.ObjectDefinition, 'forPlayer', () => ({ getInteractions: () => ['Collect'] }));
    t.mock.method(core.MapObjects, 'get', () => null);
    t.mock.method(require('../plugins/skills/farming/Services.Farming'), 'cropRewards', () => {});
    t.mock.method(Math, 'random', () => 0.999999);
    const patch = Data.CACHE.patches.find(p => p.type === 'CORAL');
    for (const [key] of CORALS) {
        const player = new Player(null), bits = new Map();
        const sender = new Proxy({}, { get: (_, name) => name === 'getVarbit' ? id => bits.get(id) ?? 0
            : name === 'sendVarbit' ? (id, value) => { bits.set(id, value); return sender; } : () => sender });
        player.getPacketSender = () => sender; player.sendMessage = () => {}; player.performAnimation = () => {};
        player.busy = () => false; player.getClickDelay = () => ({ elapsedTime: () => true, reset() {} });
        player.moveTo(new core.Location(patch.x, patch.y, patch.z));
        const crop = Data.CROPS.get(key), farm = { offset: 0, patches: {}, tools: {} };
        farm.patches[Data.patchKey(patch)] = { ...Model.emptyPatch(Date.now(), farm), crop: key,
            status: 'grown', stage: crop.stages, lives: Model.startingLives(crop, 0) };
        player.setAttribute(Patches.FARM_ATTRIBUTE, farm);
        const pick = () => hooks.onObjectInteraction({ player, object: { getId: () => patch.id },
            location: { x: patch.x, y: patch.y, z: patch.z }, clickType: 1 });
        for (let i = 0; i < 6; i++) pick();
        assert.equal(player.getInventory().getAmount(crop.produce), 6, key);
        assert.equal(farm.patches[Data.patchKey(patch)].crop, undefined, key);
        pick();
        assert.equal(player.getInventory().getAmount(crop.produce), 6, key);
    }
});
