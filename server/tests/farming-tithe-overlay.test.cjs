const assert = require('node:assert/strict');
const { before, test } = require('node:test');
require('../dist/Server').Server.installProductionPathResolver();
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { PluginManager } = require('../dist/plugins/PluginManager');
const { Player } = require('../dist/game/entity/impl/player/Player');
let core, Data, Patches, Tithe, overlay, hud;
const CROPS = ['Golovanova', 'Bologano', 'Logavano'];
before(async () => {
    await CachePipeline.initialize(require('node:path').resolve(__dirname, '..'));
    core = PluginManager.getCoreApi();
    require('../plugins/skills/farming/Core.Farming').init({ core });
    Data = require('../plugins/skills/farming/Data.Farming');
    Patches = require('../plugins/skills/farming/Patches.Farming');
    Tithe = require('../plugins/skills/farming/Tithe.Farming');
    Data.initializeFarmingData();
    overlay = core.CacheDefinitions.getInterfaceId('hosidius_strip_farming');
    hud = core.CacheDefinitions.getComponentId('toplevel_osrs_stretch:overlay_hud');
    assert.equal(overlay, 241);
    assert.equal(hud, (161 << 16) | 8);
});
function prepare(t, { crop = 0, seeds = 1, fruit = 0, score = 0, points = 0 } = {}) {
    const player = new Player(null), packets = [], mounts = [], closes = [];
    player.getSession = () => ({ sendClientPacket: packet => { packets.push(packet); return true; } });
    player.sendMessage = () => {};
    player.performAnimation = () => {};
    t.mock.method(player.getSkillManager(), 'addExperiences', () => player.getSkillManager());
    const sender = player.getPacketSender();
    const open = sender.sendSubInterface.bind(sender), close = sender.closeSubInterface.bind(sender);
    t.mock.method(sender, 'sendSubInterface', (...args) => { mounts.push(args); return open(...args); });
    t.mock.method(sender, 'closeSubInterface', (...args) => { closes.push(args); return close(...args); });
    t.mock.method(core.MapObjects, 'get', () => null);
    t.mock.method(core.ObjectManager, 'register', () => {});
    t.mock.method(core.ObjectManager, 'deregister', () => {});
    player.setAttribute(Patches.FARM_ATTRIBUTE, { offset: 0, patches: {}, tools: {}, tithe: { score, points } });
    const inventory = player.getInventory(), seedId = Data.itemId(CROPS[crop] + ' seed'), fruitId = Data.itemId(CROPS[crop] + ' fruit');
    if (seeds) inventory.add(new core.Item(seedId, seeds), false);
    if (fruit) inventory.add(new core.Item(fruitId, fruit), false);
    player.moveTo(new core.Location(1806, 3501, 0));
    const enter = () => Tithe.titheLogin({ player });
    const logout = () => Tithe.titheLogout({ player });
    t.after(logout);
    return { player, inventory, sender, packets, mounts, closes, enter, logout, seedId, fruitId,
        process: () => Tithe.titheProcess({ player }),
        deposit: () => Tithe.titheObject({ player, object: { getId: () => core.ObjectIdentifiers.SACK_16 } }) };
}
for (let crop = 0; crop < CROPS.length; crop++) test(`entry opens the native Tithe overlay with the ${CROPS[crop]} icon`, t => {
    const f = prepare(t, { crop, points: 101, score: 27 });
    f.enter();
    assert.equal(f.sender.isSubInterfaceOpen(overlay), true);
    assert.deepEqual(f.mounts, [[hud, overlay, 1]]);
    assert.equal(f.sender.getVarbit(4901), crop + 1);
    assert.equal(f.sender.getVarbit(4900), 27);
    assert.equal(f.sender.getVarbit(4893), 101);
    f.process();
    f.process();
    assert.equal(f.mounts.length, 1, 'ordinary ticks do not reopen the interface');
});
test('fruit-only relog selects its crop and restores saved batch and points', t => {
    const f = prepare(t, { crop: 2, seeds: 0, fruit: 3, points: 99, score: 75 });
    f.enter();
    assert.equal(f.sender.getVarbit(4901), 3);
    f.logout();
    assert.equal(f.sender.isSubInterfaceOpen(overlay), false);
    f.enter();
    assert.equal(f.sender.isSubInterfaceOpen(overlay), true);
    assert.equal(f.sender.getVarbit(4901), 3);
    assert.equal(f.sender.getVarbit(4900), 75);
    assert.equal(f.sender.getVarbit(4893), 99);
});
test('depositing fruit updates the client-driven count and points without replacing the overlay', t => {
    const f = prepare(t, { crop: 1, seeds: 0, fruit: 2, score: 98, points: 10 });
    f.enter();
    f.deposit();
    assert.equal(f.inventory.getAmount(f.fruitId), 0);
    assert.equal(f.sender.getVarbit(4900), 0);
    assert.equal(f.sender.getVarbit(4893), 13);
    assert.equal(f.sender.getVarbit(4901), 2, 'the chosen crop survives an empty inventory');
    assert.equal(f.mounts.length, 1);
});
test('planting the final seed preserves the selected fruit icon', t => {
    const f = prepare(t, { crop: 2 });
    f.inventory.add(new core.Item(Data.itemId('Seed dibber')), false);
    f.player.getSkillManager().setCurrentLevel(core.Skill.FARMING, 99, false);
    f.enter();
    const plot = Data.CACHE.scenery.find(p => p.id === core.ObjectIdentifiers.TITHE_PATCH && p.y >= 3485);
    Tithe.titheItem({ player: f.player, itemId: f.seedId, itemSlot: 0, location: { x: plot.x, y: plot.y, z: plot.z } });
    f.process();
    assert.equal(f.inventory.getAmount(f.seedId), 0);
    assert.equal(f.sender.getVarbit(4901), 3);
    assert.equal(f.sender.isSubInterfaceOpen(overlay), true);
});
test('leaving closes the owned overlay while retaining the minigame-unlocked flag', t => {
    const f = prepare(t);
    f.enter();
    f.player.moveTo(new core.Location(1804, 3501, 0));
    f.process();
    assert.equal(f.sender.isSubInterfaceOpen(overlay), false);
    assert.equal(f.sender.getVarbit(4909), 1);
    assert.deepEqual(f.closes, [[hud]]);
});
test('cleanup does not close another interface that replaced the Tithe HUD', t => {
    const f = prepare(t);
    f.enter();
    const other = core.CacheDefinitions.getInterfaceId('farming_view');
    f.sender.sendSubInterface(hud, other, 1);
    f.logout();
    assert.equal(f.sender.isSubInterfaceOpen(other), true);
    assert.deepEqual(f.closes, []);
});
