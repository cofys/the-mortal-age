const assert = require('node:assert/strict');
const { test, before } = require('node:test');
require('../dist/Server').Server.installProductionPathResolver();
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { PluginManager } = require('../dist/plugins/PluginManager');
const { Player } = require('../dist/game/entity/impl/player/Player');
let core, Data, Patches, Services;
before(async () => {
    await CachePipeline.initialize(require('node:path').resolve(__dirname, '..'));
    core = PluginManager.getCoreApi();
    require('../plugins/skills/farming/Core.Farming').init({ core });
    Data = require('../plugins/skills/farming/Data.Farming');
    Patches = require('../plugins/skills/farming/Patches.Farming');
    Services = require('../plugins/skills/farming/Services.Farming');
    Data.initializeFarmingData();
});
function reward(t, { level = 99, xp = 0, seeds = false, roll = 0.99, crop = 'HEMP' } = {}) {
    const player = new Player(null), sender = new Proxy({}, { get: () => () => sender }), events = [];
    player.getPacketSender = () => sender; player.sendMessage = () => {};
    const skills = player.getSkillManager();
    skills.setExperiences(core.Skill.FARMING, xp, false).setCurrentLevels(core.Skill.FARMING, level, false);
    player.setAttribute(Patches.FARM_ATTRIBUTE, { offset: 0, patches: {}, tools: {}, disableHesporiSeeds: !seeds });
    t.mock.method(Math, 'random', () => roll);
    t.mock.method(core.PluginManager, 'emitCustomEvent', (name, request) => {
        if (name === 'farming:success') events.push(request);
    });
    Services.cropRewards(player, Data.CROPS.get(crop));
    assert.equal(events.length, 1);
    return { denominator: events[0].petChance, seeds: player.getInventory().getAmount(Data.itemId('Hespori seed')) };
}
test('Hemp emits the published Tangleroot denominator at planting level and level 99', t => {
    for (const level of [37, 99]) assert.equal(reward(t, { level }).denominator, 56208 - 25 * level);
});
test('visible boosts stay capped at 99 and the 200m experience perk is retained', t => {
    assert.equal(reward(t, { level: 115 }).denominator, 56208 - 25 * 99);
    assert.equal(reward(t, { xp: 200000000 }).denominator, (56208 - 25 * 99) / 15);
});
test('Hemp uses its published 1-in-112 derived Hespori seed boundary', t => {
    assert.equal(reward(t, { seeds: true, roll: 1 / 120 }).seeds, 1);
    assert.equal(reward(t, { seeds: true, roll: 1 / 112 }).seeds, 0);
});
test('other textile and neighboring hops keep their published pet parameters', t => {
    for (const [crop, base] of [['FLAX', 89933], ['COTTON', 56208], ['KRANDORIAN', 64238], ['WILDBLOOD', 56208]])
        assert.equal(reward(t, { crop }).denominator, base - 25 * 99, crop);
});
