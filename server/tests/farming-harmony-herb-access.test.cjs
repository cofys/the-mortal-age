const assert = require('node:assert/strict');
const { test, before } = require('node:test');
require('../dist/Server').Server.installProductionPathResolver();
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { PluginManager } = require('../dist/plugins/PluginManager');
const { Player } = require('../dist/game/entity/impl/player/Player');
let core, Data, Model, Patches, hooks, harmony;
before(async () => {
    await CachePipeline.initialize(require('node:path').resolve(__dirname, '..'));
    core = PluginManager.getCoreApi();
    require('../plugins/skills/farming/Core.Farming').init({ core });
    Data = require('../plugins/skills/farming/Data.Farming');
    Model = require('../plugins/skills/farming/Model.Farming');
    Patches = require('../plugins/skills/farming/Patches.Farming');
    Data.initializeFarmingData();
    harmony = Data.CACHE.patches.find(p => p.type === 'HERB' && p.x === 3789 && p.y === 2837);
    assert.ok(harmony);
    hooks = {};
    Patches.attach(new Proxy({}, { get: (_, name) => (...args) => {
        if (['onObjectInteraction', 'onItemOnObject', 'onSpellOnObject'].includes(name)) hooks[name] = args[0];
    } }));
});
function prepare(t, { complete = false, crop = 'GUAM', patch = harmony, denied = false } = {}) {
    const player = new Player(null), messages = [], queries = [], bits = new Map();
    const sender = new Proxy({}, { get: (_, name) => name === 'getVarbit' ? id => bits.get(id) ?? 0
        : name === 'sendVarbit' ? (id, value) => { bits.set(id, value); return sender; } : () => sender });
    player.getPacketSender = () => sender; player.sendMessage = text => messages.push(text); player.performAnimation = () => {};
    player.getClickDelay = () => ({ elapsedTime: () => true, reset() {} });
    player.getSkillManager().setCurrentLevel(core.Skill.FARMING, 99, false);
    player.moveTo(new core.Location(patch.x, patch.y, patch.z));
    t.mock.method(core.MapObjects, 'get', () => null);
    t.mock.method(core.ObjectDefinition, 'forPlayer', () => ({ getInteractions: () => ['Inspect'] }));
    t.mock.method(core.PluginManager, 'emitCustomEvent', (name, request) => {
        if (name === 'diary:is-complete') { queries.push([request.diary, request.tier]); if (complete !== null) request.complete = complete; }
        if (name === 'farming:can-use-patch' && denied) request.allowed = false;
    });
    const seed = Data.CROPS.get(crop).seed;
    player.getInventory().add(new core.Item(seed), false).add(new core.Item(Data.itemId('Seed dibber')), false);
    const event = () => ({ player, object: { getId: () => patch.id },
        location: { x: patch.x, y: patch.y, z: patch.z }, clickType: 1, itemId: seed, itemSlot: 0,
        spellWidget: -1, spellItemId: -1 });
    const clear = () => {
        const farm = { offset: 0, patches: {}, tools: {} };
        farm.patches[Data.patchKey(patch)] = Model.emptyPatch(Date.now(), farm);
        player.setAttribute(Patches.FARM_ATTRIBUTE, farm);
    };
    return { player, seed, messages, queries, event, clear,
        state: () => player.getAttribute(Patches.FARM_ATTRIBUTE)?.patches[Data.patchKey(patch)] };
}
test('locked Harmony patch rejects object, item and spell routes before creating Farming state', t => {
    for (const hook of ['onObjectInteraction', 'onItemOnObject', 'onSpellOnObject']) {
        const f = prepare(t), event = f.event();
        hooks[hook](event);
        assert.equal(event.handled, true, hook);
        assert.equal(f.player.getAttribute(Patches.FARM_ATTRIBUTE), undefined, hook);
        assert.equal(f.player.getInventory().getAmount(f.seed), 1, hook);
        assert.deepEqual(f.queries, [['morytania', 'elite']], hook);
    }
});
test('an unanswered diary query fails closed at the locked patch', t => {
    const f = prepare(t, { complete: null });
    hooks.onItemOnObject(f.event());
    assert.equal(f.state(), undefined);
    assert.equal(f.player.getInventory().getAmount(f.seed), 1);
});
test('completed elite Morytania Diary allows ordinary herb planting', t => {
    const f = prepare(t, { complete: true });
    f.clear();
    hooks.onItemOnObject(f.event());
    assert.equal(f.state().crop, 'GUAM');
    assert.equal(f.player.getInventory().getAmount(f.seed), 0);
});
test('ordinary herb patches still accept goutweed without a Harmony diary query', t => {
    const patch = Data.CACHE.patches.find(p => p.type === 'HERB' && p !== harmony);
    const f = prepare(t, { crop: 'GOUTWEED', patch });
    f.clear();
    hooks.onItemOnObject(f.event());
    assert.equal(f.state().crop, 'GOUTWEED');
    assert.equal(f.player.getInventory().getAmount(f.seed), 0);
    assert.deepEqual(f.queries, []);
});
test('external patch restrictions still apply after the diary gate succeeds', t => {
    const f = prepare(t, { complete: true, denied: true });
    hooks.onItemOnObject(f.event());
    assert.equal(f.state(), undefined);
    assert.equal(f.player.getInventory().getAmount(f.seed), 1);
});
test('Harmony herbs survive every disease roll online and after save/load, while ordinary herbs sicken', () => {
    const now = Date.UTC(2026, 9, 24), matureAt = now + 100 * Model.MINUTE;
    const ordinary = Data.CACHE.patches.find(p => p.type === 'HERB' && p.x === 3058);
    for (const crop of ['GUAM', 'RANARR', 'TORSTOL']) {
        const farm = { offset: 0, patches: {}, tools: {} };
        for (const patch of [harmony, ordinary]) farm.patches[Data.patchKey(patch)] = {
            ...Model.emptyPatch(now, farm), crop,
            nextAt: Model.nextGrowth(now, Data.CROPS.get(crop).minutes, farm.offset)
        };
        const stepped = JSON.parse(JSON.stringify(farm)), persisted = JSON.parse(JSON.stringify(farm));
        Model.advanceFarm(farm, matureAt, () => 0);
        Model.advanceFarm(persisted, matureAt, () => 0);
        for (let at = now; at <= matureAt; at += Model.MINUTE) Model.advanceFarm(stepped, at, () => 0);
        assert.equal(farm.patches[Data.patchKey(harmony)].status, 'grown', crop);
        assert.equal(farm.patches[Data.patchKey(ordinary)].status, 'dead', crop);
        assert.deepEqual(stepped, farm, crop);
        assert.deepEqual(persisted, farm, crop);
    }
});
