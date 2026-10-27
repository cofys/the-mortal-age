const assert = require('node:assert/strict');
const { test, before } = require('node:test');
require('../dist/Server').Server.installProductionPathResolver();
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { PluginManager } = require('../dist/plugins/PluginManager');
const { Player } = require('../dist/game/entity/impl/player/Player');
let core, Data, Patches, Services, hooks;
before(async () => {
    await CachePipeline.initialize(require('node:path').resolve(__dirname, '..'));
    core = PluginManager.getCoreApi();
    require('../plugins/skills/farming/Core.Farming').init({ core });
    Data = require('../plugins/skills/farming/Data.Farming');
    Patches = require('../plugins/skills/farming/Patches.Farming');
    Services = require('../plugins/skills/farming/Services.Farming');
    Data.initializeFarmingData();
    hooks = {};
    Patches.attach(new Proxy({}, { get: (_, name) => (...args) => {
        if (name === 'onItemOnObject') hooks.use = args[0];
        if (name === 'onCustomEvent' && args[0] === 'player:world-input') hooks.cancel = args[1];
        if (name === 'onPlayerLogout') hooks.logout ??= args[0];
    } }));
});
function prepare(t, type = 'COMPOST') {
    const player = new Player(null), animations = [], sounds = [], varbits = [];
    const sender = new Proxy({
        sendSound: (...args) => { sounds.push(args); return sender; },
        sendVarbit: (...args) => { varbits.push(args); return sender; },
    }, { get: (target, key) => target[key] ?? (() => sender) });
    player.performAnimation = animation => animations.push(animation);
    player.busy = () => false;
    player.getClickDelay = () => ({ elapsedTime: () => true, reset() {} });
    t.mock.method(core.MapObjects, 'get', () => null);
    t.after(() => hooks.cancel({ player }));
    player.getPacketSender = () => sender; player.sendMessage = () => {};
    const patch = Data.CACHE.patches.find(p => p.type === type);
    const state = Patches.stateFor(player, patch), inventory = player.getInventory();
    const tick = (count = 1) => { for (let i = 0; i < count; i++) { Patches.tick(); } };
    const stock = (name, count) => {
        const id = Data.itemId(name);
        for (let i = 0; i < count; i++) inventory.add(new core.Item(id), false);
        return id;
    };
    const use = id => {
        const event = { player, itemId: id, itemSlot: inventory.getSlotForItemId(id), object: { getId: () => patch.id },
            location: { x: patch.x, y: patch.y, z: patch.z } };
        hooks.use(event);
        assert.equal(event.handled, true);
    };
    const add = (name, noted = false) => {
        let id = Data.itemId(name); assert.ok(id > 0, name);
        if (noted) { id = core.CacheDefinitions.getItem(id).note; assert.ok(id > 0, `${name} note`); }
        inventory.add(new core.Item(id), false);
        Services.binAction(player, patch, '', id);
        tick(3);
        return id;
    };
    return { player, patch, state, inventory, add, tick, stock, use, animations, sounds, varbits, bin: () => state.bin };
}
test('cotton bolls produce regular compost in both bin sizes', t => {
    for (const [type, capacity] of [['COMPOST', 15], ['BIG_COMPOST', 30]]) {
        const f = prepare(t, type);
        for (let i = 0; i < capacity; i++) f.add('Cotton boll');
        assert.equal(f.bin().count, capacity, type);
        assert.equal(f.bin().tier, 1, type);
        assert.equal(f.inventory.getAmount(Data.itemId('Cotton boll')), 0, type);
    }
});
test('half coconuts produce supercompost in both bin sizes', t => {
    for (const [type, capacity] of [['COMPOST', 15], ['BIG_COMPOST', 30]]) {
        const f = prepare(t, type);
        for (let i = 0; i < capacity; i++) f.add('Half coconut');
        assert.equal(f.bin().count, capacity, type);
        assert.equal(f.bin().super, capacity, type);
        assert.equal(f.bin().tier, 2, type);
    }
});
test('mixing a cotton boll into otherwise supercompostable contents produces regular compost', t => {
    const f = prepare(t);
    for (let i = 0; i < 14; i++) f.add('Half coconut');
    f.add('Cotton boll');
    assert.equal(f.bin().count, 15);
    assert.equal(f.bin().super, 14);
    assert.equal(f.bin().tier, 1);
});
test('noted produce remains untouched and never increments either bin', t => {
    for (const type of ['COMPOST', 'BIG_COMPOST']) {
        const f = prepare(t, type);
        for (const name of ['Potato', 'Watermelon', 'Cotton boll', 'Half coconut', 'Guam leaf']) {
            const id = f.add(name, true);
            assert.equal(f.inventory.getAmount(id), 1, `${type}: ${name}`);
            assert.equal(f.bin().count, 0, `${type}: ${name}`);
        }
    }
});
test('a noted compost potion cannot upgrade a finished bin or turn into an unnoted dose', t => {
    const f = prepare(t);
    Services.binAction(f.player, f.patch, '');
    Object.assign(f.bin(), { count: 15, open: true, closedAt: Date.now() - 100 * 60_000 });
    const id = f.add('Compost potion(4)', true);
    assert.equal(f.bin().tier, 1);
    assert.equal(f.inventory.getAmount(id), 1);
    assert.equal(f.inventory.getAmount(Data.itemId('Compost potion(3)')), 0);
});
test('existing ingredient tiers, excluded items and full-bin capacity remain effective', t => {
    for (const [name, tier] of [['Potato', 1], ['Watermelon', 2], ['Tomato', 4]]) {
        const f = prepare(t);
        f.add(name); assert.equal(f.bin().tier, tier, name);
    }
    const f = prepare(t);
    for (const name of ['Cactus spine', 'Magic logs', 'Nightshade']) {
        const id = f.add(name); assert.equal(f.inventory.getAmount(id), 1, name);
        assert.equal(f.bin().count, 0, name);
    }
    for (let i = 0; i < 16; i++) f.add('Potato');
    assert.equal(f.bin().count, 15);
    assert.equal(f.inventory.getAmount(Data.itemId('Potato')), 1);
});

test('one item use fills either bin automatically at the captured two-tick cadence', t => {
    for (const [type, initial, capacity] of [['COMPOST', 0, 15], ['BIG_COMPOST', 16, 30]]) {
        const f = prepare(t, type), id = f.stock('Orange', 20);
        Services.binAction(f.player, f.patch, '');
        f.bin().count = initial;
        f.use(id);
        f.tick();
        assert.equal(f.animations.length, 0);
        assert.equal(f.bin().count, initial);
        f.tick();
        assert.equal(f.animations.length, 1);
        assert.deepEqual(f.sounds[0], [2441, 1, 0]);
        assert.equal(f.bin().count, initial);
        f.tick();
        assert.equal(f.bin().count, initial + 1);
        f.tick();
        assert.equal(f.bin().count, initial + 1);
        f.tick();
        assert.equal(f.bin().count, initial + 2);
        f.tick(60);
        assert.equal(f.bin().count, capacity);
        assert.equal(f.inventory.getAmount(id), 20 - (capacity - initial));
        assert.equal(f.bin().tier, 1);
        assert.equal(f.varbits.at(-1)[1], Services.binValue(f.patch, f.state));
    }
});
test('filling stops when the selected ingredient runs out and leaves other produce alone', t => {
    const f = prepare(t), id = f.stock('Pineapple', 3), other = f.stock('Orange', 1);
    f.use(id); f.tick(20);
    assert.equal(f.bin().count, 3);
    assert.equal(f.bin().super, 3);
    assert.equal(f.bin().tier, 2);
    assert.equal(f.inventory.getAmount(id), 0);
    assert.equal(f.inventory.getAmount(other), 1);
});
test('movement, world input, logout, busy state and death cancel pending deposits', t => {
    for (const interrupt of [
        f => f.player.moveTo(new core.Location(3000, 3000, 0)),
        f => hooks.cancel({ player: f.player }),
        f => hooks.logout({ player: f.player }),
        f => { f.player.busy = () => true; },
        f => { f.player.getHitpoints = () => 0; },
    ]) {
        const f = prepare(t), id = f.stock('Orange', 3);
        f.use(id); f.tick(3);
        assert.equal(f.bin().count, 1);
        interrupt(f); f.tick(20);
        assert.equal(f.bin().count, 1);
        assert.equal(f.inventory.getAmount(id), 2);
    }
});
test('removed ingredients and closed or replaced bins cannot receive a queued deposit', t => {
    for (const interrupt of [
        f => f.inventory.deleteNumber(Data.itemId('Orange'), 3),
        f => { f.bin().closedAt = Date.now(); },
        f => { f.bin().open = true; },
        f => { f.state.bin = { ...f.bin() }; },
    ]) {
        const f = prepare(t), id = f.stock('Orange', 3);
        f.use(id); f.tick(2);
        interrupt(f); f.tick(20);
        assert.equal(f.bin().count, 0);
    }
});

test('bin phases count game ticks even with early, delayed or catch-up ticks', t => {
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    const f = prepare(t), id = f.stock('Orange', 4);
    f.use(id);
    for (const [index, elapsed] of [599, 1, 1400, 0, 599, 1, 2000, 0, 1].entries()) {
        now += elapsed;
        f.tick();
        const tick = index + 1;
        assert.equal(f.bin().count, Math.min(4, Math.floor((tick - 1) / 2)), `deposit tick ${tick}`);
        assert.equal(f.animations.length, Math.min(4, Math.floor(tick / 2)), `animation tick ${tick}`);
    }
    assert.equal(f.inventory.getAmount(id), 0);
});
