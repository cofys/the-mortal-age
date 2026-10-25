const assert = require('node:assert/strict');
const { test, before } = require('node:test');
require('../dist/Server').Server.installProductionPathResolver();
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { PluginManager } = require('../dist/plugins/PluginManager');
const { Player } = require('../dist/game/entity/impl/player/Player');
let core, Data, Model, Patches, interact;
const CROPS = [['FLAX', 140, 194, 150, 173], ['HEMP', 120, 178, 142, 163], ['COTTON', 82, 142, 126, 144]];
before(async () => {
    await CachePipeline.initialize(require('node:path').resolve(__dirname, '..'));
    core = PluginManager.getCoreApi();
    require('../plugins/skills/farming/Core.Farming').init({ core });
    Data = require('../plugins/skills/farming/Data.Farming');
    Model = require('../plugins/skills/farming/Model.Farming');
    Patches = require('../plugins/skills/farming/Patches.Farming');
    Data.initializeFarmingData();
    Patches.attach(new Proxy({}, { get: (_, name) => (...args) => {
        if (name === 'onObjectInteraction') interact = args[0];
    } }));
});
test('flax, hemp and cotton use their published low/high endpoints and required-level interpolation', () => {
    for (const [key, low, high, required] of CROPS) {
        const crop = Data.CROPS.get(key);
        assert.equal(Model.saveLifeChance(crop, 1), (low + 1) / 256, key);
        assert.equal(Model.saveLifeChance(crop, 99), (high + 1) / 256, key);
        assert.equal(Model.saveLifeChance(crop, crop.level), required / 256, key);
    }
});
test('secateurs followed by Attas apply to each published textile endpoint pair', () => {
    for (const [key, , , , boosted] of CROPS) {
        const crop = Data.CROPS.get(key);
        assert.equal(Model.saveLifeChance(crop, crop.level, true, false, 0, true), boosted / 256, key);
        assert.equal(Model.saveLifeChance(crop, crop.level, false, true), Model.saveLifeChance(crop, crop.level), key);
    }
});
test('textile level clamping and compost harvest lives remain unchanged', () => {
    for (const [key, low, high] of CROPS) {
        const crop = Data.CROPS.get(key);
        assert.equal(Model.saveLifeChance(crop, 0), (low + 1) / 256, key);
        assert.equal(Model.saveLifeChance(crop, 120), (high + 1) / 256, key);
        assert.deepEqual([0, 1, 2, 3].map(tier => Model.startingLives(crop, tier)), [3, 4, 5, 6], key);
    }
});
test('established hops endpoint pairs retain their existing probabilities', () => {
    assert.equal(Model.saveLifeChance(Data.CROPS.get('BARLEY'), 1), 104 / 256);
    assert.equal(Model.saveLifeChance(Data.CROPS.get('JUTE'), 99), 181 / 256);
    assert.equal(Model.saveLifeChance(Data.CROPS.get('WILDBLOOD'), 1), 129 / 256);
});
test('actual harvesting uses the corrected life-save chances at each textile planting level', t => {
    t.mock.method(core.ObjectDefinition, 'forPlayer', () => ({ getInteractions: () => ['Pick'] }));
    t.mock.method(core.MapObjects, 'get', () => null);
    const patch = Data.CACHE.patches.find(p => p.type === 'HOPS');
    for (const [key, roll, remaining] of [['FLAX', 0.5, 3], ['HEMP', 0.53, 3], ['COTTON', 0.55, 2]]) {
        t.mock.method(Math, 'random', () => roll);
        const player = new Player(null), bits = new Map();
        const sender = new Proxy({}, { get: (_, name) => name === 'getVarbit' ? id => bits.get(id) ?? 0
            : name === 'sendVarbit' ? (id, value) => { bits.set(id, value); return sender; } : () => sender });
        player.getPacketSender = () => sender; player.sendMessage = () => {}; player.performAnimation = () => {};
        player.busy = () => false; player.getClickDelay = () => ({ elapsedTime: () => true, reset() {} });
        player.moveTo(new core.Location(patch.x, patch.y, patch.z));
        player.getInventory().add(new core.Item(Data.itemId('Spade')), false);
        const crop = Data.CROPS.get(key), farm = { offset: 0, patches: {}, tools: {} };
        player.getSkillManager().setCurrentLevel(core.Skill.FARMING, crop.level, false);
        const state = { ...Model.emptyPatch(Date.now(), farm), crop: key, status: 'grown', stage: crop.stages, lives: 3 };
        farm.patches[Data.patchKey(patch)] = state;
        player.setAttribute(Patches.FARM_ATTRIBUTE, farm);
        interact({ player, object: { getId: () => patch.id }, location: { x: patch.x, y: patch.y, z: patch.z }, clickType: 1 });
        assert.equal(player.getInventory().getAmount(crop.produce), 1, key);
        assert.equal(state.lives, remaining, key);
    }
});
