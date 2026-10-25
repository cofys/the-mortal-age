const assert = require('node:assert/strict');
const { test, before } = require('node:test');
require('../dist/Server').Server.installProductionPathResolver();
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { PluginManager } = require('../dist/plugins/PluginManager');
const { Player } = require('../dist/game/entity/impl/player/Player');
let core, Data, Model, Patches, hooks, lletya;
before(async () => {
    await CachePipeline.initialize(require('node:path').resolve(__dirname, '..'));
    core = PluginManager.getCoreApi();
    require('../plugins/skills/farming/Core.Farming').init({ core });
    Data = require('../plugins/skills/farming/Data.Farming');
    Model = require('../plugins/skills/farming/Model.Farming');
    Patches = require('../plugins/skills/farming/Patches.Farming');
    Data.initializeFarmingData();
    lletya = Data.CACHE.patches.find(p => p.type === 'FRUIT_TREE' && p.x === 2346 && p.y === 3161);
    assert.ok(lletya);
    hooks = {};
    Patches.attach(new Proxy({}, { get: (_, name) => (...args) => {
        if (['onObjectInteraction', 'onItemOnObject', 'onSpellOnObject'].includes(name)) hooks[name] = args[0];
    } }));
});
function prepare(t, { started = false, crop = 'APPLE', patch = lletya, denied = false } = {}) {
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
        if (name === 'quest:is-started') { queries.push(request.key); if (started !== null) request.started = started; }
        if (name === 'farming:can-use-patch' && denied) request.allowed = false;
    });
    const seed = Data.CROPS.get(crop).sapling;
    player.getInventory().add(new core.Item(seed), false).add(new core.Item(Data.itemId('Spade')), false);
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
test('locked Lletya patch rejects object, item and spell routes before creating Farming state', t => {
    for (const hook of ['onObjectInteraction', 'onItemOnObject', 'onSpellOnObject']) {
        const f = prepare(t), event = f.event();
        hooks[hook](event);
        assert.equal(event.handled, true, hook);
        assert.equal(f.player.getAttribute(Patches.FARM_ATTRIBUTE), undefined, hook);
        assert.equal(f.player.getInventory().getAmount(f.seed), 1, hook);
        assert.deepEqual(f.queries, ['mournings_end_part_i'], hook);
    }
});
test('an unanswered quest query fails closed at the locked patch', t => {
    const f = prepare(t, { started: null });
    hooks.onItemOnObject(f.event());
    assert.equal(f.state(), undefined);
    assert.equal(f.player.getInventory().getAmount(f.seed), 1);
});
test('started Mourning quest allows fruit-tree planting', t => {
    const f = prepare(t, { started: true });
    f.clear();
    hooks.onItemOnObject(f.event());
    assert.equal(f.state().crop, 'APPLE');
    assert.equal(f.player.getInventory().getAmount(f.seed), 0);
});
test('external patch restrictions still apply after the quest gate succeeds', t => {
    const f = prepare(t, { started: true, denied: true });
    hooks.onItemOnObject(f.event());
    assert.equal(f.state(), undefined);
    assert.equal(f.player.getInventory().getAmount(f.seed), 1);
});
test('another fruit-tree patch accepts a sapling without querying the Lletya quest', t => {
    const patch = Data.CACHE.patches.find(p => p.type === 'FRUIT_TREE' && p !== lletya);
    const f = prepare(t, { patch });
    f.clear();
    hooks.onItemOnObject(f.event());
    assert.equal(f.state().crop, 'APPLE');
    assert.equal(f.player.getInventory().getAmount(f.seed), 0);
    assert.deepEqual(f.queries, []);
});
