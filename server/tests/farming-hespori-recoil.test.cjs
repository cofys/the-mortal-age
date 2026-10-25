const assert = require('node:assert/strict');
const { before, test } = require('node:test');
require('../dist/Server').Server.installProductionPathResolver();
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { PluginManager } = require('../dist/plugins/PluginManager');
const { Player } = require('../dist/game/entity/impl/player/Player');
let core, Data, Patches, Hespori;
before(async () => {
    await CachePipeline.initialize(require('node:path').resolve(__dirname, '..'));
    core = PluginManager.getCoreApi();
    require('../plugins/skills/farming/Core.Farming').init({ core });
    Data = require('../plugins/skills/farming/Data.Farming');
    Patches = require('../plugins/skills/farming/Patches.Farming');
    Hespori = require('../plugins/skills/farming/Hespori.Farming');
    Data.initializeFarmingData();
});
test('waking a grown Farming Hespori sets recoil immunity on the boss, without changing its flowers', t => {
    const player = new Player(null), sender = new Proxy({}, { get: () => () => sender }), spawned = [];
    player.getPacketSender = () => sender; player.sendMessage = () => {};
    player.getInventory().add(new core.Item(Data.itemId('Spade')), false);
    t.mock.method(core.MapObjects, 'get', () => null);
    t.mock.method(core.PluginManager, 'spawnNpc', ({ id, x, y, z }) => {
        const npc = new core.NPC(id, new core.Location(x, y, z));
        npc.getCombat().attack = () => {};
        spawned.push(npc);
        return npc;
    });
    const patch = Data.CACHE.patches.find(p => p.type === 'HESPORI');
    Object.assign(Patches.stateFor(player, patch), { crop: 'HESPORI', status: 'grown' });
    t.after(() => { Hespori.hesporiLogout({ player }); player.getArea()?.leave(player, false); });
    Hespori.harvestHespori(player, patch);
    assert.equal(spawned.length, 5);
    assert.equal(spawned[0].getAttribute('combat:recoil-immune'), true);
    for (const flower of spawned.slice(1)) assert.notEqual(flower.getAttribute('combat:recoil-immune'), true);
});
