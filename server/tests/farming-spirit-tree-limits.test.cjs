const assert = require('node:assert/strict');
const { test, before } = require('node:test');
require('../dist/Server').Server.installProductionPathResolver();
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { PluginManager } = require('../dist/plugins/PluginManager');
const { Player } = require('../dist/game/entity/impl/player/Player');
let core, Data, Model, Patches, itemOnObject;
before(async () => {
    await CachePipeline.initialize(require('node:path').resolve(__dirname, '..'));
    core = PluginManager.getCoreApi();
    require('../plugins/skills/farming/Core.Farming').init({ core });
    Data = require('../plugins/skills/farming/Data.Farming');
    Model = require('../plugins/skills/farming/Model.Farming');
    Patches = require('../plugins/skills/farming/Patches.Farming');
    Data.initializeFarmingData();
    Patches.attach(new Proxy({}, { get: (_, name) => (...args) => {
        if (name === 'onItemOnObject') itemOnObject = args[0];
    } }));
});
function prepare(t, { base = 83, current = base, existing = 0, spade = true } = {}) {
    const player = new Player(null), bits = new Map();
    const sender = new Proxy({}, { get: (_, name) => name === 'getVarbit' ? id => bits.get(id) ?? 0
        : name === 'sendVarbit' ? (id, value) => { bits.set(id, value); return sender; } : () => sender });
    player.getPacketSender = () => sender; player.sendMessage = () => {}; player.performAnimation = () => {};
    player.getClickDelay = () => ({ elapsedTime: () => true, reset() {} });
    player.getSkillManager().setMaxLevels(core.Skill.FARMING, base, false).setCurrentLevel(core.Skill.FARMING, current, false);
    t.mock.method(core.MapObjects, 'get', () => null);
    const crop = Data.CROPS.get('SPIRIT_TREE'), patches = Data.CACHE.patches.filter(p => p.type === 'SPIRIT_TREE');
    assert.ok(patches.length >= 5);
    const target = patches.at(-1), farm = { offset: 0, patches: {}, tools: {} };
    for (const patch of patches.slice(0, existing)) farm.patches[Data.patchKey(patch)] = {
        ...Model.emptyPatch(Date.now(), farm), crop: crop.key, status: 'grown', stage: crop.stages, checked: true, lives: 1 };
    const state = Model.emptyPatch(Date.now(), farm);
    farm.patches[Data.patchKey(target)] = state;
    player.setAttribute(Patches.FARM_ATTRIBUTE, farm);
    player.moveTo(new core.Location(target.x, target.y, target.z));
    if (spade) player.getInventory().add(new core.Item(Data.itemId('Spade')), false);
    player.getInventory().add(new core.Item(crop.sapling), false);
    const plant = () => itemOnObject({ player, object: { getId: () => target.id },
        location: { x: target.x, y: target.y, z: target.z }, itemId: crop.sapling,
        itemSlot: player.getInventory().getSlotForItemId(crop.sapling) });
    return { player, farm, state, plant, crop, saplings: () => player.getInventory().getAmount(crop.sapling) };
}
test('2026 spirit tree thresholds allow a second at88, third at93 and fourth at96', t => {
    for (const [level, existing] of [[83, 0], [88, 1], [93, 2], [96, 3], [99, 4]]) {
        const f = prepare(t, { base: level, existing });
        f.plant();
        assert.equal(f.state.crop, 'SPIRIT_TREE', `${level}/${existing}`);
        assert.equal(f.saplings(), 0);
        assert.equal(f.player.getInventory().getAmount(Data.itemId('Plant pot')), 1);
    }
});
test('levels immediately below each threshold refuse an extra tree without consuming the sapling', t => {
    for (const [level, existing] of [[87, 1], [92, 2], [95, 3], [98, 4]]) {
        const f = prepare(t, { base: level, existing });
        f.plant();
        assert.equal(f.state.crop, undefined, `${level}/${existing}`);
        assert.equal(f.saplings(), 1);
        assert.equal(f.player.getInventory().getAmount(Data.itemId('Plant pot')), 0);
    }
});
test('temporary boosts can meet every spirit tree planting threshold', t => {
    for (const [base, current, existing] of [[82, 83, 0], [83, 88, 1], [88, 93, 2], [93, 96, 3], [96, 99, 4]]) {
        const f = prepare(t, { base, current, existing });
        f.plant();
        assert.equal(f.state.crop, 'SPIRIT_TREE', `${base}->${current}/${existing}`);
        assert.equal(f.saplings(), 0);
    }
});
test('a drained level cannot use the higher base-level allowance', t => {
    const f = prepare(t, { base: 99, current: 88, existing: 2 });
    f.plant();
    assert.equal(f.state.crop, undefined);
    assert.equal(f.saplings(), 1);
});
test('the minimum planting level and spade requirements still protect the sapling', t => {
    for (const options of [{ base: 82 }, { base: 99, spade: false }]) {
        const f = prepare(t, options);
        f.plant();
        assert.equal(f.state.crop, undefined);
        assert.equal(f.saplings(), 1);
    }
});
