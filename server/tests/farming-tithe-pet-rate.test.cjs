const assert = require('node:assert/strict');
const { test, before } = require('node:test');
require('../dist/Server').Server.installProductionPathResolver();
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { PluginManager } = require('../dist/plugins/PluginManager');
const { Player } = require('../dist/game/entity/impl/player/Player');
let core, Data, Patches, Tithe, Pets, petId;
const events = new Map(), BASE = 7494389;
before(async () => {
    await CachePipeline.initialize(require('node:path').resolve(__dirname, '..'));
    core = PluginManager.getCoreApi();
    require('../plugins/skills/farming/Core.Farming').init({ core });
    Data = require('../plugins/skills/farming/Data.Farming');
    Patches = require('../plugins/skills/farming/Patches.Farming');
    Tithe = require('../plugins/skills/farming/Tithe.Farming');
    Data.initializeFarmingData();
    Pets = require('../plugins/npcs/Pets.plugin');
    Pets.register(new Proxy({ core,
        getWorld: () => ({ sendMessage() {} }),
        getRegionManager: () => ({ blocked: () => true }),
        getItemOnGroundManager: () => ({ registerNonGlobal() {}, registerLocation() {} }),
        onCustomEvent: (name, handler) => events.set(name, handler),
        emitCustomEvent: (name, request) => events.get(name)?.(request),
    }, { get: (target, name) => target[name] ?? (() => {}) }));
    petId = Pets.__internals.PETS.find(p => p.enumName === 'TANGLEROOT').itemId;
});
function prepare(t, { level = 34, current = level, xp = 0, roll = 0.99 } = {}) {
    const player = new Player(null), sender = new Proxy({}, { get: () => () => sender }), petEvents = [];
    player.setUsername('tithe-pet-rate-fixture');
    player.getPacketSender = () => sender; player.sendMessage = () => {}; player.performAnimation = () => {};
    player.setAttribute('pets:current', { isRegistered: () => true, getId: () => -1 });
    player.setAttribute(Patches.FARM_ATTRIBUTE, { offset: 0, patches: {}, tools: {} });
    const skills = player.getSkillManager();
    skills.setExperiences(core.Skill.FARMING, xp, false).setMaxLevels(core.Skill.FARMING, level, false)
        .setCurrentLevels(core.Skill.FARMING, current, false);
    t.mock.method(skills, 'addExperiences', () => skills);
    t.mock.method(core.MapObjects, 'get', () => null);
    t.mock.method(core.ObjectManager, 'register', () => {});
    t.mock.method(core.ObjectManager, 'deregister', () => {});
    t.mock.method(core.PluginManager, 'emitCustomEvent', (name, request) => {
        if (name === 'farming:success') petEvents.push(request);
        events.get(name)?.(request);
    });
    t.mock.method(Math, 'random', () => roll);
    let now = Date.UTC(2026, 9, 24);
    t.mock.method(Date, 'now', () => now);
    const inventory = player.getInventory(), seed = Data.itemId('Golovanova seed');
    inventory.add(new core.Item(seed), false).add(new core.Item(Data.itemId('Seed dibber')), false)
        .add(new core.Item(Data.itemId('Watering can(8)')), false);
    const can = inventory.forSlot(2);
    player.moveTo(new core.Location(1806, 3501, 0));
    Tithe.titheLogin({ player });
    t.after(() => Tithe.titheLogout({ player }));
    const plot = Data.CACHE.scenery.find(p => p.id === core.ObjectIdentifiers.TITHE_PATCH && p.y >= 3485);
    const location = { x: plot.x, y: plot.y, z: plot.z };
    Tithe.titheItem({ player, itemId: seed, itemSlot: 0, location });
    assert.equal(inventory.getAmount(seed), 0);
    for (let stage = 0; stage < 3; stage++) {
        Tithe.titheItem({ player, itemId: can.getId(), itemSlot: 2, location });
        now += 60_000;
        Tithe.titheProcess({ player });
    }
    const harvest = () => Tithe.titheObject({ player, object: { getId: () => core.ObjectIdentifiers.TITHE_PATCH }, location });
    return { player, inventory, petEvents, harvest, fruit: Data.itemId('Golovanova fruit') };
}
test('the exact published Tithe base rejects a roll accepted by the rounded old denominator', t => {
    const level = 34, roll = (1 / (BASE - level * 25) + 1 / (7494000 - level * 25)) / 2;
    const f = prepare(t, { level, roll });
    f.harvest();
    assert.equal(f.inventory.getAmount(f.fruit), 1);
    assert.equal(f.inventory.getAmount(petId), 0);
    assert.equal(f.petEvents.length, 1);
});
test('Tithe receives the canonical 200m-XP fifteenfold pet perk', t => {
    const f = prepare(t, { level: 99, xp: 200000000, roll: 1 / 1000000 });
    f.harvest();
    assert.equal(f.inventory.getAmount(f.fruit), 1);
    assert.equal(f.inventory.getAmount(petId), 1);
});
test('canonical pet handling preserves the base-level boundary even with a visible Farming boost', t => {
    const chance = 1 / (BASE - 34 * 25);
    const passing = prepare(t, { level: 34, current: 99, roll: chance - Number.EPSILON });
    passing.harvest(); assert.equal(passing.inventory.getAmount(petId), 1);
    const failing = prepare(t, { level: 34, current: 99, roll: chance });
    failing.harvest(); assert.equal(failing.inventory.getAmount(petId), 0);
});
test('a failed fruit grant never rolls a pet, and a successful harvest cannot be repeated', t => {
    const f = prepare(t, { roll: 0 });
    while (f.inventory.getFreeSlots()) f.inventory.add(new core.Item(Data.itemId('Spade')), false);
    f.harvest();
    assert.equal(f.petEvents.length, 0);
    f.inventory.deleteNumber(Data.itemId('Spade'), 2);
    f.harvest();
    assert.equal(f.inventory.getAmount(f.fruit), 1);
    assert.equal(f.petEvents.length, 1);
    f.harvest();
    assert.equal(f.petEvents.length, 1);
});
