const assert = require('node:assert/strict');
const { test, before } = require('node:test');
require('../dist/Server').Server.installProductionPathResolver();
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { PluginManager } = require('../dist/plugins/PluginManager');
const { Player } = require('../dist/game/entity/impl/player/Player');
let core, Data, Model, Patches, hooks, troll;
before(async () => {
    await CachePipeline.initialize(require('node:path').resolve(__dirname, '..'));
    core = PluginManager.getCoreApi();
    require('../plugins/skills/farming/Core.Farming').init({ core });
    Data = require('../plugins/skills/farming/Data.Farming');
    Model = require('../plugins/skills/farming/Model.Farming');
    Patches = require('../plugins/skills/farming/Patches.Farming');
    Data.initializeFarmingData();
    troll = Data.CACHE.patches.find(p => p.type === 'HERB' && p.x === 2826 && p.y === 3694);
    assert.ok(troll);
    hooks = {};
    Patches.attach(new Proxy({}, { get: (_, name) => (...args) => {
        if (['onObjectInteraction', 'onItemOnObject', 'onSpellOnObject'].includes(name)) hooks[name] = args[0];
    } }));
});
function prepare(t, { complete = false, crop = 'GUAM', patch = troll, denied = false } = {}) {
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
        if (name === 'quest:is-complete') { queries.push(request.key); if (complete !== null) request.complete = complete; }
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
test('locked Troll patch rejects object, item and spell routes before creating Farming state', t => {
    for (const hook of ['onObjectInteraction', 'onItemOnObject', 'onSpellOnObject']) {
        const f = prepare(t), event = f.event();
        hooks[hook](event);
        assert.equal(event.handled, true, hook);
        assert.equal(f.player.getAttribute(Patches.FARM_ATTRIBUTE), undefined, hook);
        assert.equal(f.player.getInventory().getAmount(f.seed), 1, hook);
        assert.deepEqual(f.queries, ['my_arms_big_adventure'], hook);
    }
});
test('an unanswered quest query fails closed at the locked patch', t => {
    const f = prepare(t, { complete: null });
    hooks.onItemOnObject(f.event());
    assert.equal(f.state(), undefined);
    assert.equal(f.player.getInventory().getAmount(f.seed), 1);
});
test('completed My Arm quest allows ordinary herb planting', t => {
    const f = prepare(t, { complete: true });
    f.clear();
    hooks.onItemOnObject(f.event());
    assert.equal(f.state().crop, 'GUAM');
    assert.equal(f.player.getInventory().getAmount(f.seed), 0);
});
test('regular goutweed is refused at Troll Stronghold without consuming the tuber', t => {
    const f = prepare(t, { complete: true, crop: 'GOUTWEED' });
    f.clear();
    hooks.onItemOnObject(f.event());
    assert.equal(f.state()?.crop, undefined);
    assert.equal(f.player.getInventory().getAmount(f.seed), 1);
});
test('ordinary herb patches still accept goutweed without a Troll quest query', t => {
    const patch = Data.CACHE.patches.find(p => p.type === 'HERB' && p !== troll);
    const f = prepare(t, { crop: 'GOUTWEED', patch });
    f.clear();
    hooks.onItemOnObject(f.event());
    assert.equal(f.state().crop, 'GOUTWEED');
    assert.equal(f.player.getInventory().getAmount(f.seed), 0);
    assert.deepEqual(f.queries, []);
});
test('external patch restrictions still apply after the quest gate succeeds', t => {
    const f = prepare(t, { complete: true, denied: true });
    hooks.onItemOnObject(f.event());
    assert.equal(f.state(), undefined);
    assert.equal(f.player.getInventory().getAmount(f.seed), 1);
});
