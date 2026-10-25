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
function reward(t, { level = 99, xp = 0, seeds = false, roll = 0.99, crop = 'LIMPWURT' } = {}) {
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
test('Limpwurt does not award a seed on a roll that only its obsolete 1-in-449 rate would win', t => {
    assert.equal(reward(t, { seeds: true, roll: 1 / 500 }).seeds, 0);
});
test('the published 1-in-562 boundary is unchanged by Farming level', t => {
    for (const level of [26, 99]) {
        assert.equal(reward(t, { level, seeds: true, roll: 1 / 562 - Number.EPSILON }).seeds, 1, String(level));
        assert.equal(reward(t, { level, seeds: true, roll: 1 / 562 }).seeds, 0, String(level));
    }
});
test('Limpwurt retains its existing correct flower Tangleroot base and 200m perk', t => {
    for (const level of [26, 99]) assert.equal(reward(t, { level }).denominator, 281040 - 25 * level);
    assert.equal(reward(t, { xp: 200000000 }).denominator, (281040 - 25 * 99) / 15);
});
test('ordinary flowers, the barley exceptions and sweetcorn retain their seed-rate boundaries', t => {
    for (const [crop, denominator] of [['MARIGOLD', 562], ['BARLEY', 244], ['HAMMERSTONE', 244], ['SWEETCORN', 449]]) {
        assert.equal(reward(t, { crop, seeds: true, roll: 1 / denominator - Number.EPSILON }).seeds, 1, crop);
        assert.equal(reward(t, { crop, seeds: true, roll: 1 / denominator }).seeds, 0, crop);
    }
});
