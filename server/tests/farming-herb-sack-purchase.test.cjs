const assert = require('node:assert/strict');
const { test, before } = require('node:test');
require('../dist/Server').Server.installProductionPathResolver();
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { PluginManager } = require('../dist/plugins/PluginManager');
const { Player } = require('../dist/game/entity/impl/player/Player');
let core, Data, Patches, Tithe;
before(async () => {
    await CachePipeline.initialize(require('node:path').resolve(__dirname, '..'));
    core = PluginManager.getCoreApi();
    require('../plugins/skills/farming/Core.Farming').init({ core });
    Data = require('../plugins/skills/farming/Data.Farming');
    Patches = require('../plugins/skills/farming/Patches.Farming');
    Tithe = require('../plugins/skills/farming/Tithe.Farming');
    Data.initializeFarmingData();
});
function prepare(t, { base = 58, current = base, points = 250, full = false } = {}) {
    const player = new Player(null), events = [], messages = [];
    const sender = new Proxy({}, { get: () => () => sender });
    player.getPacketSender = () => sender; player.sendMessage = text => messages.push(text);
    player.moveTo(new core.Location(1810, 3460, 0));
    player.getSkillManager().setMaxLevels(core.Skill.HERBLORE, base, false).setCurrentLevel(core.Skill.HERBLORE, current, false);
    assert.equal(player.getSkillManager().getMaxLevel(core.Skill.HERBLORE), base);
    if (full) player.getInventory().add(new core.Item(Data.itemId('Spade'), 28), false);
    const farm = { offset: 0, patches: {}, tools: {}, tithe: { points, score: 0 } };
    player.setAttribute(Patches.FARM_ATTRIBUTE, farm);
    let entries;
    t.mock.method(Patches, 'choose', (_player, options) => { entries = options; });
    t.mock.method(core.PluginManager, 'emitCustomEvent', (name, payload) => {
        if (['persistence:save', 'collection-log:obtain'].includes(name)) events.push({ name, payload });
    });
    Tithe.titheNpc({ player, npc: { getLocation: () => new core.Location(1810, 3460, 0) },
        definition: { getName: () => 'Farmer Gricoller' } });
    const buy = entries.find(([name]) => name.startsWith('Herb sack ('))?.[1];
    assert.equal(typeof buy, 'function');
    return { player, score: farm.tithe, events, messages, buy,
        sacks: () => player.getInventory().getAmount(Data.itemId('Herb sack')) };
}
test('boosting from base 57 to 58 cannot purchase a herb sack', t => {
    const f = prepare(t, { base: 57, current: 58 });
    f.buy();
    assert.equal(f.sacks(), 0);
    assert.equal(f.score.points, 250);
    assert.equal(f.events.length, 0);
});
test('base 58 meets the purchase gate even when the visible level is drained', t => {
    const f = prepare(t, { current: 57 });
    f.buy();
    assert.equal(f.sacks(), 1);
    assert.equal(f.score.points, 0);
    assert.deepEqual(f.events.map(event => event.name), ['persistence:save', 'collection-log:obtain']);
});
test('an unboosted level 58 purchase costs exactly 250 points', t => {
    const f = prepare(t, { points: 300 });
    f.buy();
    assert.equal(f.sacks(), 1);
    assert.equal(f.score.points, 50);
    assert.equal(f.events.filter(event => event.name === 'persistence:save').length, 1);
});
test('insufficient points and a full bag preserve points and emit no purchase events', t => {
    for (const options of [{ points: 249 }, { full: true }]) {
        const f = prepare(t, options), before = f.score.points;
        f.buy();
        assert.equal(f.sacks(), 0);
        assert.equal(f.score.points, before);
        assert.equal(f.events.length, 0);
    }
});
test('a boost applied after opening the reward menu cannot bypass the gate', t => {
    const f = prepare(t, { base: 57 });
    f.player.getSkillManager().setCurrentLevel(core.Skill.HERBLORE, 62, false);
    f.buy();
    assert.equal(f.sacks(), 0);
    assert.equal(f.score.points, 250);
    assert.equal(f.events.length, 0);
});
test('walking away before purchase preserves points', t => {
    const f = prepare(t);
    f.player.moveTo(new core.Location(3200, 3200, 0));
    f.buy();
    assert.equal(f.sacks(), 0);
    assert.equal(f.score.points, 250);
    assert.equal(f.events.length, 0);
});
